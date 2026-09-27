#!/usr/bin/env node
// Static declaration guard, NOT an SQL parser or proof of effective ACLs/RLS.
// Default: new worktree/untracked migrations relative to HEAD.
// --base REF [--head REF]: added paths since merge-base, read from head blobs.
// Existing migration edits are deliberately outside this check; never rewrite
// applied SQL to make it pass. Unsupported/dynamic DDL fails for explicit review.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const MIGRATIONS = 'web/supabase/migrations/'
const isMigration = (path) => path.startsWith(MIGRATIONS) && path.endsWith('.sql')
const word = (token, text) => token?.kind === 'word' && token.value === text

function tokenize(sql) {
  const tokens = []
  let i = 0
  while (i < sql.length) {
    if (/\s/.test(sql[i])) { i++; continue }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2)
      i = end < 0 ? sql.length : end + 1
      continue
    }
    if (sql.startsWith('/*', i)) {
      let depth = 1
      i += 2
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2 }
        else if (sql.startsWith('*/', i)) { depth--; i += 2 }
        else i++
      }
      if (depth) throw new Error('unterminated SQL comment')
      continue
    }
    const dollar = /^\$(?:[a-z_][a-z_0-9]*)?\$/i.exec(sql.slice(i))
    if (dollar) {
      const start = i + dollar[0].length
      const end = sql.indexOf(dollar[0], start)
      if (end < 0) throw new Error('unterminated dollar-quoted body')
      tokens.push({ kind: 'body', value: sql.slice(start, end) })
      i = end + dollar[0].length
      continue
    }
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++]
      let value = ''
      let closed = false
      while (i < sql.length) {
        if (sql[i] === quote) {
          i++
          if (sql[i] === quote) { value += quote; i++; continue }
          closed = true
          break
        }
        // Escape strings/U& identifiers need a fuller SQL parser. Do not guess.
        if (sql[i] === '\\') throw new Error('backslash-escaped SQL requires manual review')
        value += sql[i++]
      }
      if (!closed) throw new Error('unterminated quoted SQL')
      tokens.push({ kind: quote === '"' ? 'identifier' : 'string', value })
      continue
    }
    const identifier = /^[a-z_][a-z_0-9$]*/i.exec(sql.slice(i))
    if (identifier) {
      tokens.push({ kind: 'word', value: identifier[0].toLowerCase() })
      i += identifier[0].length
    } else tokens.push({ kind: 'symbol', value: sql[i++] })
  }
  return tokens
}

function tableName(tokens, offset) {
  const isIdentifier = (t) => t && ['word', 'identifier'].includes(t.kind)
  if (!isIdentifier(tokens[offset]) || tokens[offset + 1]?.value !== '.' || !isIdentifier(tokens[offset + 2])) {
    throw new Error('table names must be schema-qualified (for example public.example); search_path is not inferred')
  }
  if (tokens[offset + 3]?.value === '.') throw new Error('three-part table names require manual review')
  return { name: JSON.stringify([tokens[offset].value, tokens[offset + 2].value]), next: offset + 3 }
}

export function checkSql(sql) {
  const errors = []
  const tables = new Set()
  const grants = new Set()
  let temporaryTables = 0
  try {
    const statements = [[]]
    for (const token of tokenize(sql)) {
      if (token.value === ';' && token.kind === 'symbol') statements.push([])
      else statements.at(-1).push(token)
    }
    for (const tokens of statements) {
      if (!tokens.length) continue
      if (['do', 'call', 'execute', 'prepare'].some((k) => word(tokens[0], k))) {
        throw new Error('DO/CALL/EXECUTE/PREPARE can hide DDL; explicit static declarations/manual review required')
      }
      const definesRoutine = word(tokens[0], 'create') && tokens.slice(1, 5).some((t) => word(t, 'function') || word(t, 'procedure'))
      if (tokens.some((t) => (t.kind === 'body' || (definesRoutine && t.kind === 'string')) && /\b(?:create|grant|execute)\b/i.test(t.value))) {
        throw new Error('DDL/dynamic SQL in a quoted body requires manual review')
      }
      if (word(tokens[0], 'set') && tokens.some((t) => word(t, 'search_path'))) {
        throw new Error('SET search_path requires manual review; qualify table names instead')
      }
      if (tokens[0]?.value === '\\') throw new Error('psql commands require manual review')
      if (word(tokens[0], 'select') && word(tokens[1], 'into')) throw new Error('SELECT INTO requires explicit CREATE TABLE instead')
      if (word(tokens[0], 'select') && tokens.some((t) => word(t, 'into'))) throw new Error('SELECT INTO requires manual review')
      if (word(tokens[0], 'create')) {
        let i = 1
        let temporary = false
        if (word(tokens[i], 'global') || word(tokens[i], 'local')) i++
        if (word(tokens[i], 'temp') || word(tokens[i], 'temporary')) { temporary = true; i++ }
        else if (word(tokens[i], 'unlogged')) i++
        if (word(tokens[i], 'table')) {
          i++
          if (word(tokens[i], 'if') && word(tokens[i + 1], 'not') && word(tokens[i + 2], 'exists')) i += 3
          if (temporary) { temporaryTables++; continue }
          tables.add(tableName(tokens, i).name)
        } else if (word(tokens[i], 'schema') || word(tokens[i], 'foreign')) {
          throw new Error('CREATE SCHEMA/FOREIGN TABLE requires manual review for embedded table declarations')
        }
      }
      if (!word(tokens[0], 'grant')) continue
      // Find ON outside column privilege parentheses, not in an identifier/string.
      let depth = 0
      let on = -1
      for (let i = 1; i < tokens.length; i++) {
        if (tokens[i].value === '(') depth++
        if (tokens[i].value === ')') depth--
        if (!depth && word(tokens[i], 'on')) { on = i; break }
      }
      if (on < 0) continue // Role membership grant, not a table grant.
      let i = on + 1
      if (word(tokens[i], 'table')) i++
      else if (['all', 'schema', 'sequence', 'function', 'procedure', 'routine', 'database', 'language', 'tablespace', 'type', 'domain', 'foreign', 'parameter', 'large'].some((k) => word(tokens[i], k))) continue
      const tablePrivileges = ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger', 'maintain', 'all']
      const isIdentifier = (t) => t && ['word', 'identifier'].includes(t.kind)
      let privilege = 1
      if (on === 1) throw new Error('GRANT missing privilege')
      while (privilege < on) {
        if (!tablePrivileges.some((p) => word(tokens[privilege], p))) throw new Error('unsupported table GRANT privilege')
        const kind = tokens[privilege++].value
        if (kind === 'all' && word(tokens[privilege], 'privileges')) privilege++
        if (tokens[privilege]?.value === '(') {
          if (!['select', 'insert', 'update', 'references'].includes(kind)) throw new Error('unsupported column GRANT privilege')
          privilege++
          while (true) {
            if (!isIdentifier(tokens[privilege])) throw new Error('GRANT missing column name')
            privilege++
            if (tokens[privilege]?.value !== ',') break
            privilege++
          }
          if (tokens[privilege++]?.value !== ')') throw new Error('unclosed GRANT column list')
        }
        if (privilege === on) break
        if (tokens[privilege++]?.value !== ',' || privilege === on) throw new Error('malformed GRANT privilege list')
      }
      while (i < tokens.length) {
        const table = tableName(tokens, i)
        grants.add(table.name)
        i = table.next
        if (word(tokens[i], 'to')) {
          i++
          while (true) {
            if (word(tokens[i], 'group')) i++
            if (!isIdentifier(tokens[i]) || ['with', 'granted'].some((k) => word(tokens[i], k))) throw new Error('GRANT missing recipient')
            i++
            if (tokens[i]?.value !== ',') break
            i++
          }
          if (word(tokens[i], 'with') && word(tokens[i + 1], 'grant') && word(tokens[i + 2], 'option')) i += 3
          if (word(tokens[i], 'granted') && word(tokens[i + 1], 'by') && isIdentifier(tokens[i + 2])) i += 3
          if (i !== tokens.length) throw new Error('unsupported GRANT recipient/options')
          break
        }
        if (tokens[i]?.value !== ',') throw new Error('unsupported GRANT table list')
        i++
      }
    }
    for (const table of tables) {
      if (!grants.has(table)) errors.push(`missing same-file GRANT for ${JSON.parse(table).join('.')}`)
    }
  } catch (err) { errors.push(err.message) }
  return { errors, tables: tables.size, temporaryTables }
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

export function collectMigrations(cwd, { base, head = 'HEAD' } = {}) {
  const list = (text) => text.split('\0').filter(isMigration)
  if (base !== undefined) {
    // A new-branch push has no before commit. Refuse a silent empty scan.
    if (!base || /^0+$/.test(base)) throw new Error('base revision is missing (new branch); supply an explicit review base')
    const sha = (ref) => git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim()
    const headSha = sha(head)
    const baseSha = sha(base)
    const ancestor = git(cwd, ['merge-base', baseSha, headSha]).trim()
    const files = list(git(cwd, ['diff', '--no-renames', '--diff-filter=A', '--name-only', '-z', ancestor, headSha, '--', MIGRATIONS]))
    return files.map((path) => ({ path, sql: git(cwd, ['show', `${headSha}:${path}`]) }))
  }
  const files = new Set([
    ...list(git(cwd, ['diff', '--no-renames', '--diff-filter=A', '--name-only', '-z', 'HEAD', '--', MIGRATIONS])),
    ...list(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', MIGRATIONS])),
  ])
  return [...files].sort().map((path) => ({ path, sql: readFileSync(resolve(cwd, path), 'utf8') }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { base: { type: 'string' }, head: { type: 'string' } } })
    if (values.head && values.base === undefined) throw new Error('--head requires --base')
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim()
    const files = collectMigrations(root, values)
    let failures = 0
    let temporaryTables = 0
    for (const file of files) {
      const result = checkSql(file.sql)
      temporaryTables += result.temporaryTables
      for (const error of result.errors) { console.error(`${file.path}: ${error}`); failures++ }
    }
    console.log(`migration-grants: ${files.length} added migration(s), ${failures} issue(s), ${temporaryTables} temporary table(s) excluded; declarations only, not effective ACL validation`)
    if (failures) process.exitCode = 1
  } catch (err) {
    // Git failures may include command internals. No SQL/environment values in output.
    console.error(`migration-grants: ${err.status !== undefined ? 'cannot resolve/read git comparison; check base/head and checkout depth' : err.message}`)
    process.exitCode = 1
  }
}
