import assert from 'node:assert/strict'
import test from 'node:test'
import { allowedCandidateSource, candidateEnvironment, parseCandidateArgs } from './build-school-candidates.mjs'

test('candidate source allowlist excludes env, generated datasets, private config and dependencies', () => {
  for (const path of ['web/.env', 'web/.env.local', '.git/config', 'web/src/.secret.ts', 'web/data/credential.json', 'web/public/schools.json', 'web/node_modules/a/index.js', 'docs/local/plan.md']) assert.equal(allowedCandidateSource(path), false, path)
  for (const path of ['web/src/App.tsx', 'web/src/index.css', 'web/scripts/gen-schools-json.mjs', 'web/data/site.json', 'functions/_middleware.ts']) assert.equal(allowedCandidateSource(path), true, path)
})

test('candidate environment cannot inherit real Vite values, env directory or Node preload', () => {
  const env = candidateEnvironment({ Path: 'runtime-path', SYSTEMROOT: 'runtime-root', VITE_SUPABASE_URL: 'real', VITE_SUPABASE_ANON_KEY: 'real', SUPABASE_SERVICE_ROLE_KEY: 'secret', NODE_OPTIONS: '--require=secret', MANABI_MAP_ENV_DIR: 'private' })
  assert.equal(env.Path, 'runtime-path')
  assert.equal(env.SYSTEMROOT, 'runtime-root')
  assert.equal(env.VITE_SUPABASE_URL, 'https://synthetic-school.supabase.invalid')
  assert.equal(env.VITE_SUPABASE_ANON_KEY, 'synthetic-public-placeholder')
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
  assert.equal(env.MANABI_MAP_ENV_DIR, undefined)
})

test('candidate CLI requires explicit single synthetic source pair and isolated output', () => {
  assert.deepEqual(parseCandidateArgs(['--snapshot=a', '--manifest=b', '--output-root=c']), { snapshot: 'a', manifest: 'b', 'output-root': 'c' })
  for (const args of [[], ['--snapshot=a'], ['--snapshot=a', '--manifest=b', '--output-root=c', '--snapshot=d'], ['--school-source=supabase'], ['--snapshot=', '--manifest=b', '--output-root=c']]) assert.throws(() => parseCandidateArgs(args))
})
