// Every env name the Pages Functions read must be declared for each Worker target in workers/<target>/env.json:
// either a secret registered on the Worker (web/scripts/workers-publish.mjs `secrets`) or deliberately unset
// with a reason. Bindings from the Wrangler template (ASSETS) are not env names.
// The shape of env.json is checked by validateEnvContract (workers-package.mjs), the same check the package
// build and verify use; the package carries env.json and deploy refuses a version whose bindings differ from it.
// Why: on 2026-09-29 the high-school Worker was created without the Supabase secrets, the byte-for-byte
// observation of 11,721 files still passed, and /api/admin/* returned 404 so admins could not open /dashboard.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { TARGETS, readTarget } from './workers-package.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const NAME = /^[A-Z][A-Z0-9_]*$/

/** Upper-case names read from an `env` object: env.NAME, env?.NAME, env['NAME'] and `{ NAME } = env`. */
export function envNamesIn(source) {
  const names = new Set()
  for (const match of source.matchAll(/\benv\s*(?:\?\.|\.)\s*([A-Z][A-Z0-9_]*)\b/g)) names.add(match[1])
  for (const match of source.matchAll(/\benv\s*(?:\?\.)?\[\s*(['"`])([A-Z][A-Z0-9_]*)\1\s*\]/g)) names.add(match[2])
  for (const match of source.matchAll(/\{([^{}]*)\}\s*=\s*(?:[A-Za-z_$][\w$]*\.)?env\b/g)) {
    for (const part of match[1].split(',')) {
      const key = part.split(':')[0].split('=')[0].trim()
      if (NAME.test(key)) names.add(key)
    }
  }
  return names
}

async function functionsEnvNames(root) {
  const names = new Set()
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) await visit(full)
      else if (/\.(?:ts|js|mjs)$/.test(entry.name) && !/\.test\.[a-z]+$/.test(entry.name)) {
        for (const name of envNamesIn(await fs.readFile(full, 'utf8'))) names.add(name)
      }
    }
  }
  await visit(root)
  return names
}

test('envNamesIn finds dotted, optional, bracketed and destructured reads', () => {
  const source = [
    'const a = context.env.ALPHA_KEY',
    'const b = env?.BETA',
    "const c = env['GAMMA_1']",
    'const { DELTA, EPSILON: renamed, ZETA = "x" } = context.env',
    'const lower = env.notAnEnvName',
    'const other = environment.OMEGA',
  ].join('\n')
  assert.deepEqual([...envNamesIn(source)].sort(), ['ALPHA_KEY', 'BETA', 'DELTA', 'EPSILON', 'GAMMA_1', 'ZETA'])
})

test('every Worker target declares each env name the Functions read', async () => {
  const read = await functionsEnvNames(join(repoRoot, 'functions'))
  // The scan must reach the admin Functions; an empty set would make every contract pass.
  assert.ok(read.has('SUPABASE_URL') && read.has('MAINTENANCE_MODE'), 'functions/ scan found no known env names')
  for (const [target, spec] of Object.entries(TARGETS)) {
    // readTarget validates workers/<target>/env.json with validateEnvContract, and refuses one for an assets-only target.
    const { template, env: contract } = await readTarget(target, repoRoot)
    if (!spec.worker) {
      assert.equal(contract, null, `${target} is assets-only and must not have env.json`)
      continue
    }
    const bindings = new Set([template.assets.binding])
    const declared = new Set([...contract.secrets, ...Object.keys(contract.unset)])
    const used = [...read].filter((name) => !bindings.has(name)).sort()
    assert.deepEqual(used.filter((name) => !declared.has(name)), [],
      `${target}: functions/ reads env names that workers/${target}/env.json does not declare (add them to secrets, or to unset with a reason)`)
    assert.deepEqual([...declared].filter((name) => !read.has(name)).sort(), [],
      `${target}: workers/${target}/env.json declares names that functions/ no longer reads`)
  }
})
