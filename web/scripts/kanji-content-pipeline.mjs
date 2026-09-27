/** Run with the existing tsx runtime. No network, default input, or default output. */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync, lstatSync, unlinkSync, rmdirSync, openSync, closeSync, fstatSync } from 'node:fs'
import { resolve, dirname, relative, isAbsolute, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { TextDecoder } from 'node:util'
import { canonicalJson, normalizeInput, contentCounts, diffInputs } from '../src/kanji/data/pipeline.ts'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const bridge = join(repo, 'scripts/local-data/kanji_content_manifest.py')
const producerPaths = ['scripts/local-data/kanji_content_manifest.py', 'scripts/local-data/source_manifest.py',
  'web/scripts/kanji-content-pipeline.mjs', 'web/src/kanji/data/pipeline.ts',
  'web/src/kanji/data/types.ts', 'web/src/kanji/data/validate.ts'].sort()
const sha = (raw) => createHash('sha256').update(raw).digest('hex')
const inside = (parent, child) => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..' + '/') && !rel.startsWith('..' + '\\') && rel !== '..' && !isAbsolute(rel)) }

// JSON.parse silently discards duplicate keys. Detect them before schema validation.
export function parseJson(raw) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)
  JSON.parse(text) // Syntax check before the token walk.
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)
  let i = 0
  function walk() {
    const token = tokens[i++]
    if (token === '{') {
      const seen = new Set()
      while (tokens[i] !== '}') {
        const key = JSON.parse(tokens[i++])
        if (seen.has(key)) throw new Error('Duplicate JSON key')
        seen.add(key); i++; walk()
        if (tokens[i] === ',') i++
      }
      i++
    } else if (token === '[') {
      while (tokens[i] !== ']') { walk(); if (tokens[i] === ',') i++ }
      i++
    }
  }
  walk()
  return JSON.parse(text)
}

function callBridge(python, request) {
  const result = spawnSync(python, ['-B', bridge], { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, windowsHide: true })
  if (result.error || result.status !== 0) throw new Error('Common manifest bridge failed: ' + (result.error?.message ?? result.stderr.trim()))
  return JSON.parse(result.stdout)
}

const encoded = (files) => Object.fromEntries(Object.entries(files).map(([path, raw]) => [path, Buffer.from(raw).toString('base64')]))
const codeFiles = () => producerPaths.map((path) => ({ path, sha256: sha(readFileSync(join(repo, path))) }))

export function verifyCandidate(bundle, python) {
  const names = readdirSync(bundle).sort()
  const expected = ['dataset.json', 'diff.json', 'manifest.json', ...(names.includes('previous.json') ? ['previous.json'] : [])].sort()
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error('Incomplete or unexpected candidate files')
  const files = Object.fromEntries(names.map((name) => {
    if (!lstatSync(join(bundle, name)).isFile()) throw new Error('Candidate files must be regular files, not links')
    return [name, readFileSync(join(bundle, name))]
  }))
  const manifest = parseJson(files['manifest.json'])
  delete files['manifest.json']
  const next = normalizeInput(parseJson(files['dataset.json']))
  const previous = files['previous.json'] ? normalizeInput(parseJson(files['previous.json'])) : null
  if (!files['dataset.json'].equals(Buffer.from(canonicalJson(next)))
    || (previous && !files['previous.json'].equals(Buffer.from(canonicalJson(previous))))
    || !files['diff.json'].equals(Buffer.from(canonicalJson(diffInputs(previous, next))))) {
    throw new Error('Candidate content or diff is not canonical/reproducible')
  }
  callBridge(python, { operation: 'verify', manifest, artifacts: encoded(files) })
  return { valid: true, counts: contentCounts(next), contentSha256: sha(files['dataset.json']), codeSha256: manifest.code.sha256 }
}

export function prepareCandidate({ input, previous, output, scratchRoot, python, createdAt }) {
  const root = realpathSync(scratchRoot)
  const repository = realpathSync(repo)
  const target = resolve(output)
  // Output must be a direct, new child of an explicit existing scratch directory outside this repository.
  if (inside(repository, root) || realpathSync(dirname(target)) !== root || basename(target).startsWith('.')) {
    throw new Error('Output must be a new direct child of an external scratch root')
  }
  const producerBefore = codeFiles()
  const next = normalizeInput(parseJson(readFileSync(input)))
  const old = previous ? normalizeInput(parseJson(readFileSync(previous))) : null
  const files = { 'dataset.json': canonicalJson(next), 'diff.json': canonicalJson(diffInputs(old, next)) }
  if (old) files['previous.json'] = canonicalJson(old)
  const manifest = callBridge(python, { operation: 'create', artifacts: encoded(files), counts: contentCounts(next),
    codeFiles: producerBefore, createdAt: createdAt ?? new Date().toISOString() })
  if (canonicalJson(producerBefore) !== canonicalJson(codeFiles())) throw new Error('Producer changed during generation')
  // Exclusive reservation. An existing directory (even empty) is never overwritten or cleaned up.
  mkdirSync(target)
  const identity = lstatSync(target)
  const written = []
  function writeOwned(name, text) {
    const fd = openSync(join(target, name), 'wx')
    try {
      // Register ownership before writing: a failed write may already have created partial bytes.
      const stat = fstatSync(fd)
      written.push({ name, dev: stat.dev, ino: stat.ino })
      writeFileSync(fd, text)
    } finally { closeSync(fd) }
  }
  try {
    for (const [name, text] of Object.entries(files)) {
      writeOwned(name, text)
    }
    // Manifest is the last file; verification rejects an interrupted partial candidate.
    writeOwned('manifest.json', canonicalJson(manifest))
    return verifyCandidate(target, python)
  } catch (error) {
    // Only clean our exact directory and known files; never follow a replacement link or recursive delete.
    try {
      const current = lstatSync(target)
      if (current.dev === identity.dev && current.ino === identity.ino && current.isDirectory() && !current.isSymbolicLink()) {
        for (const file of written.reverse()) {
          const path = join(target, file.name)
          const stat = lstatSync(path)
          if (stat.isFile() && stat.dev === file.dev && stat.ino === file.ino) unlinkSync(path)
        }
        rmdirSync(target)
      }
    } catch { /* Leave uncertain ownership/incomplete output for inspection, never recursively remove it. */ }
    throw error
  }
}

function main(args) {
  const [operation, ...rest] = args
  const allowed = operation === 'prepare' ? ['input', 'previous', 'output', 'scratch-root', 'python', 'created-at'] : ['bundle', 'python']
  if (!['prepare', 'verify'].includes(operation)) throw new Error('Usage: prepare --input JSON --output NEW_DIR --scratch-root DIR --python EXE [--previous JSON] [--created-at ISO] | verify --bundle DIR --python EXE')
  const options = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].slice(2)
    if (!rest[i].startsWith('--') || !allowed.includes(key) || Object.hasOwn(options, key) || !rest[i + 1]) throw new Error('Invalid or duplicate CLI option')
    options[key] = rest[i + 1]
  }
  for (const key of operation === 'prepare' ? ['input', 'output', 'scratch-root', 'python'] : ['bundle', 'python']) {
    if (!options[key]) throw new Error('Missing --' + key)
  }
  const result = operation === 'verify' ? verifyCandidate(options.bundle, options.python)
    : prepareCandidate({ ...options, scratchRoot: options['scratch-root'], createdAt: options['created-at'] })
  process.stdout.write(JSON.stringify(result) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1 }
}
