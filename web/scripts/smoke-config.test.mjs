import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSmokeConfig } from './lib/smoke-config.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'school-smoke-config-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('uses only the selected directory and the two permitted values with file precedence', (t) => {
  const root = fixture(t)
  const selected = join(root, 'selected')
  mkdirSync(selected)
  writeFileSync(join(root, '.env.local'), 'VITE_SUPABASE_URL=https://wrong.example.com\nVITE_SUPABASE_ANON_KEY=wrong')
  writeFileSync(join(selected, '.env'), 'VITE_SUPABASE_URL=https://example.com\nVITE_SUPABASE_ANON_KEY=base\nIGNORED=private')
  writeFileSync(join(selected, '.env.local'), '# comment\nVITE_SUPABASE_ANON_KEY="synthetic=="')
  assert.deepEqual(loadSmokeConfig({ webRoot: root, env: { MANABI_MAP_ENV_DIR: selected } }),
    { url: 'https://example.com', anonKey: 'synthetic==' })
})

test('supports the default directory and explicit environment overrides', (t) => {
  const root = fixture(t)
  writeFileSync(join(root, '.env.local'), 'VITE_SUPABASE_URL=https://example.com\nVITE_SUPABASE_ANON_KEY=file')
  assert.deepEqual(loadSmokeConfig({ webRoot: root, env: { VITE_SUPABASE_ANON_KEY: 'override' } }),
    { url: 'https://example.com', anonKey: 'override' })
})

test('accepts environment-only input and fails closed without exposing partial values', (t) => {
  const root = fixture(t)
  assert.deepEqual(loadSmokeConfig({ webRoot: root, env: { VITE_SUPABASE_URL: 'https://example.com', VITE_SUPABASE_ANON_KEY: 'synthetic' } }),
    { url: 'https://example.com', anonKey: 'synthetic' })
  assert.throws(() => loadSmokeConfig({ webRoot: root, env: { VITE_SUPABASE_ANON_KEY: 'do-not-log-this' } }),
    (error) => /are required/.test(error.message) && !error.message.includes('do-not-log-this'))
})
