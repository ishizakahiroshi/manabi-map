import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkSql, collectMigrations } from './check-migration-grants.mjs'

const valid = 'create table public.example (id int); grant select on public.example to anon;'

test('requires same-file declarations for each permanent table', () => {
  assert.deepEqual(checkSql(valid).errors, [])
  assert.match(checkSql('create table public.example(id int);').errors[0], /missing.*public.example/)
  assert.match(checkSql('create table public.example(id int); grant select on public.other to anon;').errors[0], /missing/)
  assert.match(checkSql(`${valid} create table public.other(id int);`).errors[0], /public.other/)
})

test('supports quoted identifiers, multiple targets and column privileges', () => {
  const sql = `CREATE UNLOGGED TABLE IF NOT EXISTS "public"."Example" (id int);
    create table public.other (id int);
    GRANT SELECT, UPDATE (id) ON TABLE public."Example", public.other TO authenticated;`
  assert.deepEqual(checkSql(sql).errors, [])
  assert.match(checkSql('create table public."Example"(id int); grant select on public.example to anon;').errors[0], /missing/)
})

test('comments and strings cannot satisfy declarations; nested comments are supported', () => {
  const sql = `-- create table public.fake(id int);
    /* outer /* grant select on public.example to anon; */ comment */
    create table public.example(id int);
    select 'grant select on public.example to anon;';`
  assert.equal(checkSql(sql).tables, 1)
  assert.match(checkSql(sql).errors[0], /missing/)
  assert.deepEqual(checkSql(`/* fake */ ${valid} -- trailing`).errors, [])
})

test('non-table grants and schema-wide grants do not count for named tables', () => {
  for (const grant of [
    'grant anon to authenticated;', 'grant usage on schema public to anon;',
    'grant select on all tables in schema public to anon;',
    'grant execute on function public.example() to anon;',
  ]) assert.match(checkSql(`create table public.example(id int); ${grant}`).errors[0], /missing/)
})

test('temporary tables are explicitly excluded; CTAS and partitions still need grants', () => {
  const result = checkSql('create temporary table scratch(id int);')
  assert.deepEqual(result.errors, [])
  assert.equal(result.temporaryTables, 1)
  assert.match(checkSql('create table public.example as select 1 as id;').errors[0], /missing/)
  assert.match(checkSql('create table public.example partition of public.parent for values in (1);').errors[0], /missing/)
})

test('unsupported, dynamic, ambiguous and malformed SQL fails explicitly', () => {
  for (const sql of [
    'create table example(id int); grant select on example to anon;',
    'set search_path = private; select 1;', 'do $$ begin execute \'create table public.example(id int)\'; end $$;',
    'call procedure_name();', 'execute statement_name;', 'select 1 into public.example;',
    'create schema sample create table example(id int);', 'create foreign table public.example(id int);',
    'create function public.fn() returns void as $$ begin execute command; end $$ language plpgsql;',
    "create function public.fn() returns void as 'create table public.example(id int);' language sql;",
    '\\include other.sql', '/* unfinished', "select 'unfinished", 'select $$unfinished',
    'create table public.example(id int); grant select on public.example;',
    'create table public.example(id int); grant execute on public.example to anon;',
    'create table public.example(id int); grant on public.example to authenticated;',
    'create table public.example(id int); grant select on public.example to;',
    'create table public.example(id int); grant select on public.example to ,;',
    'create table public.example(id int); grant select, on public.example to anon;',
    'create table public.example(id int); grant select on public.example to anon,;',
  ]) assert.ok(checkSql(sql).errors.length, sql)
})

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'synthetic-migration-grants-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const git = (args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Synthetic Test', GIT_AUTHOR_EMAIL: 'synthetic-test',
      GIT_COMMITTER_NAME: 'Synthetic Test', GIT_COMMITTER_EMAIL: 'synthetic-test' },
  }).trim()
  git(['init', '-q', '--initial-branch=main'])
  await mkdir(join(cwd, 'web/supabase/migrations'), { recursive: true })
  const write = (name, sql) => writeFile(join(cwd, 'web/supabase/migrations', name), sql)
  await write('old.sql', 'create table public.old(id int);')
  git(['add', '.'])
  git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-qm', 'synthetic base'])
  const base = git(['rev-parse', 'HEAD'])
  return { cwd, git, write, base }
}

test('local selection includes staged and untracked additions, excludes historical edits', async (t) => {
  const { cwd, git, write } = await fixture(t)
  await write('old.sql', 'create table public.changed(id int);')
  await write('staged.sql', 'create table public.staged(id int);')
  git(['add', 'web/supabase/migrations/staged.sql'])
  await write('staged.sql', valid) // local check reads latest worktree, not stale index
  await write('untracked.sql', valid)
  await write('ignored.txt', 'not SQL')
  const files = collectMigrations(cwd)
  assert.deepEqual(files.map((f) => f.path.split('/').at(-1)), ['staged.sql', 'untracked.sql'])
  assert.equal(files[0].sql, valid)
})

test('PR selection uses merge-base and head blobs, independent of checkout/worktree', async (t) => {
  const { cwd, git, write, base } = await fixture(t)
  git(['switch', '-qc', 'feature'])
  await write('new.sql', valid)
  git(['add', '.'])
  git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-qm', 'synthetic feature'])
  const head = git(['rev-parse', 'HEAD'])
  git(['switch', '-q', 'main'])
  await write('main-only.sql', 'create table public.main_only(id int);')
  git(['add', '.'])
  git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-qm', 'synthetic base advance'])
  const advancedBase = git(['rev-parse', 'HEAD'])
  await write('untracked.sql', 'create table public.untracked(id int);')
  const files = collectMigrations(cwd, { base: advancedBase, head })
  assert.deepEqual(files.map((f) => f.path), ['web/supabase/migrations/new.sql'])
  assert.equal(files[0].sql, valid)
  assert.equal(collectMigrations(cwd, { base, head }).length, 1)
  assert.throws(() => collectMigrations(cwd, { base: '0'.repeat(40), head }), /base revision/)
  assert.throws(() => collectMigrations(cwd, { base: 'nonexistent-synthetic-ref', head }))
})

test('CLI fails on a missing grant and unsupported SQL, without echoing SQL contents', async (t) => {
  const { cwd, write } = await fixture(t)
  const executable = fileURLToPath(new URL('./check-migration-grants.mjs', import.meta.url))
  const run = () => spawnSync(process.execPath, [executable], { cwd, encoding: 'utf8' })
  await write('new.sql', 'create table public.example(id int);')
  assert.equal(run().status, 1)
  await write('new.sql', valid)
  assert.equal(run().status, 0)
  await write('new.sql', "do $$ begin raise notice 'synthetic-private-content'; end $$;")
  const rejected = run()
  assert.equal(rejected.status, 1)
  assert.doesNotMatch(rejected.stdout + rejected.stderr, /synthetic-private-content/)
})
