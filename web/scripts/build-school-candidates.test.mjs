import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, normalize, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { allowedCandidateSource, candidateEnvironment, checkedLegacyAssetSelection, legacyAssetSelection, parseCandidateArgs } from './build-school-candidates.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('candidate source allowlist excludes env, generated datasets, private config and dependencies', () => {
  for (const path of ['web/.env', 'web/.env.local', '.git/config', 'web/src/.secret.ts', 'web/data/credential.json', 'web/public/schools.json', 'web/node_modules/a/index.js', 'docs/local/plan.md', 'functions/_middleware.test.ts', 'functions/api/csp-report.test.ts', 'functions/api/admin/_auth.test.ts', 'functions/__tests__/helper.ts']) assert.equal(allowedCandidateSource(path), false, path)
  for (const path of ['web/src/App.tsx', 'web/src/index.css', 'web/scripts/gen-schools-json.mjs', 'web/data/site.json', 'web/data/brands.json', 'web/data/deployment-targets.json', 'functions/_middleware.ts', 'functions/_school-migration.ts']) assert.equal(allowedCandidateSource(path), true, path)
})

test('runtime Functions JSON dependency resolves inside the allowlisted source inventory', () => {
  const importer = 'functions/_school-migration.ts'
  const source = fs.readFileSync(join(repoRoot, importer), 'utf8')
  const imports = [...source.matchAll(/from\s+['"]([^'"]+\.json)['"]/g)].map((match) => match[1])
  assert.ok(imports.length > 0, 'the runtime Functions JSON dependency must be exercised')
  for (const relative of imports) {
    const target = normalize(join(dirname(importer), relative)).replaceAll('\\', '/')
    assert.equal(allowedCandidateSource(target), true, `${importer} -> ${target}`)
    assert.equal(fs.existsSync(join(repoRoot, target)), true)
  }
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

test('production legacy inventory CLI accepts only a complete matching path and pin set', () => {
  const common = ['--snapshot=a', '--manifest=b', '--output-root=c', '--legacy-assets=previous']
  const manifest = '--legacy-manifest=previous/legacy-assets.json'
  const hash = `--legacy-manifest-sha256=${'a'.repeat(64)}`
  const deployment = '--legacy-deployment-id=e18dfb79-5f4b-4ae3-b283-4ee15eb0b3b8'
  const options = parseCandidateArgs([...common, manifest, hash, deployment])
  assert.deepEqual(legacyAssetSelection(options), {
    source: 'previous', manifest: 'previous/legacy-assets.json',
    pins: { expectedManifestSha256: 'a'.repeat(64), expectedDeploymentId: 'e18dfb79-5f4b-4ae3-b283-4ee15eb0b3b8' },
  })
  assert.deepEqual(legacyAssetSelection(parseCandidateArgs(common)), {
    source: 'previous', manifest: join('previous', 'legacy-assets.json'), pins: {},
  })
  for (const suffix of [[manifest], [hash], [deployment], [manifest, hash], [manifest, deployment], [hash, deployment],
    ['--legacy-manifest=other/legacy-assets.json', hash, deployment],
    [manifest, '--legacy-manifest-sha256=ABC', deployment],
    [manifest, hash, '--legacy-deployment-id=unknown'],
    [manifest, hash, deployment, deployment]]) {
    assert.throws(() => parseCandidateArgs([...common, ...suffix]))
  }
  assert.throws(() => parseCandidateArgs(['--snapshot=a', '--manifest=b', '--output-root=c', manifest, hash, deployment]))
})

test('legacy manifest preflight rejects production without pins and synthetic with production pins', async (t) => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'school-legacy-cli-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const source = join(root, 'previous')
  await fsp.mkdir(source)
  const manifest = join(source, 'legacy-assets.json')
  const deploymentId = 'e18dfb79-5f4b-4ae3-b283-4ee15eb0b3b8'
  const productionBytes = Buffer.from(JSON.stringify({ format: 'production-legacy-assets', version: 1, deploymentId }))
  const pins = { 'legacy-assets': source, 'legacy-manifest': manifest,
    'legacy-manifest-sha256': createHash('sha256').update(productionBytes).digest('hex'), 'legacy-deployment-id': deploymentId }
  await fsp.writeFile(manifest, productionBytes)
  await assert.rejects(checkedLegacyAssetSelection({ 'legacy-assets': source }), /matching explicit pin mode/)
  assert.deepEqual((await checkedLegacyAssetSelection(pins)).pins, {
    expectedManifestSha256: pins['legacy-manifest-sha256'], expectedDeploymentId: deploymentId,
  })
  await assert.rejects(checkedLegacyAssetSelection({ ...pins, 'legacy-manifest-sha256': '0'.repeat(64) }), /pin differs/)
  await assert.rejects(checkedLegacyAssetSelection({ ...pins, 'legacy-deployment-id': '0'.repeat(8) + '-0000-0000-0000-000000000000' }), /pin differs/)
  assert.equal((await checkedLegacyAssetSelection(pins)).inventoryVersion, 1)
  const v2Bytes = Buffer.from(JSON.stringify({ format: 'production-legacy-assets', version: 2, anchorDeploymentId: deploymentId }))
  await fsp.writeFile(manifest, v2Bytes)
  const v2Pins = { ...pins, 'legacy-manifest-sha256': createHash('sha256').update(v2Bytes).digest('hex') }
  assert.equal((await checkedLegacyAssetSelection(v2Pins)).inventoryVersion, 2)
  await assert.rejects(checkedLegacyAssetSelection({ ...v2Pins, 'legacy-deployment-id': '0'.repeat(8) + '-0000-0000-0000-000000000000' }), /pin differs/)
  await assert.rejects(checkedLegacyAssetSelection(pins), /pin differs/)
  await fsp.writeFile(manifest, JSON.stringify({ format: 'synthetic-legacy-assets' }))
  await assert.rejects(checkedLegacyAssetSelection(pins), /matching explicit pin mode/)
  assert.deepEqual((await checkedLegacyAssetSelection({ 'legacy-assets': source })).pins, {})
})
