import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { stageSchoolCandidate } from './school-candidate.mjs'
import { canonicalSchoolSourceJSON } from './school-source.mjs'
import { createApexCandidate, retainLegacyAssets, verifyCompatibilityGeneration } from './apex-candidate.mjs'
import { portal, renderEntryPage, renderRecoveryEnded } from '../../apex-portal/portal.mjs'
import { entrySupportFiles } from './entry-metadata.mjs'
import { onRequest } from '../../../functions/_middleware.ts'

const portalRoot = fileURLToPath(new URL('../../apex-portal/', import.meta.url))
test('portal uses independent brand/service settings and no unpublished links', async () => {
  const template = await fs.readFile(join(portalRoot, 'index.html'), 'utf8')
  const html = renderEntryPage(template)
  assert.ok(html.includes('まなびマップ'))
  assert.ok(!/<a\b[^>]*href="https:\/\//.test(html))
  const config = structuredClone(portal); config.brand = '<synthetic>'; config.services.school.published = true
  const published = renderEntryPage(template, config)
  assert.ok(published.includes('&lt;synthetic&gt;'))
  assert.ok(published.includes('href="https://high-school.manabi-map.app/"'))
  assert.ok(!published.includes('href="https://kanji.'))
})

test('same completed generation reaches both origins; partial update fails and restore recovers', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'synthetic-apex-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const candidate = join(root, 'generation'), high = join(root, 'high'), apex = join(root, 'apex')
  const files = [{ path: 'web/synthetic.mjs', sha256: '0'.repeat(64) }]
  const receipt = await stageSchoolCandidate({ outputRoot: candidate, inputPaths: [], protectedRoot: join(root, 'protected'),
    metadata: { datasetVersion: 'synthetic', sourceVersion: 'synthetic', generatedAt: '2026-09-28T00:00:00Z', source: { snapshotSha256: '0'.repeat(64), manifestSha256: '1'.repeat(64), contentSha256: '2'.repeat(64) } },
    generator: { files, sha256: createHash('sha256').update(canonicalSchoolSourceJSON(files)).digest('hex') },
    build: async (stage) => {
      await fs.mkdir(join(stage, 'api/v1'), { recursive: true })
      await fs.writeFile(join(stage, 'schools-manifest.json'), JSON.stringify({ generatedAt: '2026-09-28T00:00:00Z' }))
      await fs.writeFile(join(stage, 'api/v1/schools.json'), '{"synthetic":true}')
    } })
  await fs.cp(candidate, high, { recursive: true })
  await fs.writeFile(join(high, 'index.html'), '<html><head></head><body>school shell</body></html>')
  await fs.mkdir(join(high, 'assets')); await fs.writeFile(join(high, 'assets/previous-hash.js'), '/* synthetic old chunk */')
  await fs.mkdir(join(high, 'school/id'), { recursive: true }); await fs.writeFile(join(high, 'school/id/index.html'), 'SEO')
  await createApexCandidate({ highSchoolOutput: high, apexOutput: apex, portalRoot })
  const inventory = JSON.parse(await fs.readFile(join(apex, 'school-migration-candidate.json'), 'utf8'))
  assert.deepEqual(inventory.routes, ['/school/id'])
  assert.equal(inventory.phase, 'candidate-rescue')
  assert.ok(inventory.assets.includes('/assets/previous-hash.js'))
  assert.ok(!(await fs.readFile(join(apex, '404.html'), 'utf8')).includes('school shell'))
  assert.ok((await fs.readFile(join(apex, 'sitemap.xml'), 'utf8')).includes('<loc>https://manabi-map.app/</loc>'))
  assert.ok((await fs.readFile(join(apex, '_headers'), 'utf8')).includes('X-Robots-Tag: noindex'))
  assert.deepEqual(await fs.readFile(join(apex, 'assets/previous-hash.js')), await fs.readFile(join(high, 'assets/previous-hash.js')))
  assert.ok((await fs.readFile(join(apex, 'legacy-school/index.html'), 'utf8')).includes('legacy-school-shell'))
  await assert.rejects(fs.stat(join(apex, 'school/id/index.html')), { code: 'ENOENT' })
  assert.equal((await verifyCompatibilityGeneration(candidate, [apex, high])).artifactsSha256, receipt.artifactsSha256)
  await assert.rejects(verifyCompatibilityGeneration(candidate, [apex, apex]), /non-overlapping/)
  await assert.rejects(verifyCompatibilityGeneration(candidate, [candidate, high]), /non-overlapping/)
  const api = join(apex, 'api/v1/schools.json')
  await fs.writeFile(api, '{"synthetic":"next generation"}')
  await assert.rejects(verifyCompatibilityGeneration(candidate, [apex, high]), /generation differs/)
  await fs.copyFile(join(candidate, 'api/v1/schools.json'), api)
  await verifyCompatibilityGeneration(candidate, [apex, high])
  await fs.unlink(api)
  await assert.rejects(verifyCompatibilityGeneration(candidate, [apex, high]))
  await fs.copyFile(join(candidate, 'api/v1/schools.json'), api)
  await verifyCompatibilityGeneration(candidate, [apex, high])
})

test('entry metadata stays independent, non-indexable and escapes untrusted display names', () => {
  for (const origin of ['https://manabi-map.app', 'https://school.manabi-map.app']) {
    const files = entrySupportFiles({ origin, brand: '<synthetic>', description: 'Synthetic entry' })
    assert.match(files['404.html'], /&lt;synthetic&gt;/)
    assert.match(files['robots.txt'], /Disallow: \//)
    assert.match(files['_headers'], /noindex/)
    assert.match(files['llms.txt'], /移行候補/)
    assert.ok(files['sitemap.xml'].includes(`<loc>${origin}/</loc>`))
    assert.ok(!files['404.html'].includes('auth/callback'))
  }
  assert.throws(() => entrySupportFiles({ origin: 'https://synthetic.test/path', brand: 'Synthetic', description: 'test' }))
  assert.throws(() => entrySupportFiles({ origin: 'https://synthetic.test', brand: 'Synthetic\ninjected', description: 'test' }))
})

test('retirement notice neither promises rescue nor links to unverified destinations', async () => {
  const template = await fs.readFile(join(portalRoot, 'index.html'), 'utf8')
  const html = renderEntryPage(template, { ...portal, migrationPhase: 'candidate-retired' })
  assert.ok(!html.includes('href="/mypage"'))
  assert.ok(!html.includes('旧URLで手続きを続けられます'))
  const ended = renderRecoveryEnded()
  assert.ok(!/<a\b[^>]*href="https:\/\//.test(ended))
  assert.match(ended, /ゲストの保存情報が自動で移るわけではありません/)
  assert.ok(!ended.includes('<script'))
})

test('historical synthetic chunks are explicit, hash checked and collision safe', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'synthetic-legacy-assets-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = join(root, 'previous'), destination = join(root, 'apex')
  await fs.mkdir(join(source, 'assets'), { recursive: true }); await fs.mkdir(destination)
  await fs.writeFile(join(destination, 'school-migration-candidate.json'), JSON.stringify({ format: 'synthetic-school-routes', phase: 'candidate-rescue', routes: [], assets: [] }))
  const bytes = Buffer.from('/* synthetic previous deployment */')
  const manifest = { format: 'synthetic-legacy-assets', synthetic: true, artifacts: [{ path: 'assets/previous-hash.js', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }
  await fs.writeFile(join(source, 'assets/previous-hash.js'), bytes)
  await fs.writeFile(join(source, 'legacy-assets.json'), JSON.stringify(manifest))
  assert.equal((await retainLegacyAssets(source, destination)).retained, 1)
  const inventory = JSON.parse(await fs.readFile(join(destination, 'school-migration-candidate.json'), 'utf8'))
  assert.deepEqual(inventory.assets, ['/assets/previous-hash.js'])
  const response = await onRequest({ request: new Request('https://synthetic.example.test/assets/previous-hash.js'),
    env: { SCHOOL_MIGRATION_PHASE: 'candidate-rescue', ASSETS: { fetch: async () => new Response(JSON.stringify(inventory)) } },
    next: async () => new Response(await fs.readFile(join(destination, 'assets/previous-hash.js'))),
  })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), bytes.toString())
  await retainLegacyAssets(source, destination)
  await fs.writeFile(join(destination, 'assets/previous-hash.js'), 'collision')
  await assert.rejects(retainLegacyAssets(source, destination), /collision/)
  await fs.writeFile(join(source, 'assets/previous-hash.js'), 'tampered')
  await assert.rejects(retainLegacyAssets(source, destination), /inventory differs/)
})

test('production old assets require deployment and manifest pins before any copy', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinned-legacy-assets-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = join(root, 'previous'), destination = join(root, 'apex')
  await fs.mkdir(join(source, 'assets'), { recursive: true }); await fs.mkdir(join(destination, 'assets'), { recursive: true })
  const inventoryPath = join(destination, 'school-migration-candidate.json')
  await fs.writeFile(inventoryPath, JSON.stringify({ format: 'synthetic-school-routes', phase: 'candidate-rescue', routes: [], assets: [] }))
  const oldChunk = Buffer.from('/* old public chunk */'), oldIndex = Buffer.from('{"synthetic":true}')
  await fs.writeFile(join(source, 'assets/old-chunk.js'), oldChunk)
  await fs.writeFile(join(source, 'school-name-index-old.json'), oldIndex)
  const artifact = (path, bytes) => ({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  const deploymentId = 'e18dfb79-5f4b-4ae3-b283-4ee15eb0b3b8'
  const manifest = { format: 'production-legacy-assets', version: 1, project: 'manabi-map', deploymentId,
    artifacts: [artifact('assets/old-chunk.js', oldChunk), artifact('school-name-index-old.json', oldIndex)] }
  const manifestPath = join(source, 'legacy-assets.json'), raw = Buffer.from(JSON.stringify(manifest))
  await fs.writeFile(manifestPath, raw)
  const pins = { expectedDeploymentId: deploymentId, expectedManifestSha256: createHash('sha256').update(raw).digest('hex') }
  await assert.rejects(retainLegacyAssets(source, destination), /pin differs/)
  await assert.rejects(retainLegacyAssets(source, destination, { ...pins, expectedDeploymentId: '0'.repeat(36) }), /pin differs/)
  await assert.rejects(retainLegacyAssets(source, destination, { ...pins, expectedManifestSha256: '0'.repeat(64) }), /pin differs/)
  await assert.rejects(fs.stat(join(destination, 'assets/old-chunk.js')), { code: 'ENOENT' })
  const result = await retainLegacyAssets(source, destination, pins)
  assert.deepEqual(result, { synthetic: false, retained: 2, deploymentId })
  assert.deepEqual(JSON.parse(await fs.readFile(inventoryPath, 'utf8')).assets,
    ['/assets/old-chunk.js', '/school-name-index-old.json'])
  await retainLegacyAssets(source, destination, pins)
  await fs.writeFile(join(destination, 'assets/old-chunk.js'), 'changed destination')
  await assert.rejects(retainLegacyAssets(source, destination, pins), /collision/)
  await fs.writeFile(join(destination, 'assets/old-chunk.js'), oldChunk)
  await fs.writeFile(join(source, 'assets/old-chunk.js'), 'changed source')
  await assert.rejects(retainLegacyAssets(source, destination, pins), /inventory differs/)
  await fs.writeFile(join(source, 'assets/old-chunk.js'), oldChunk)
  await fs.writeFile(manifestPath, Buffer.concat([raw, Buffer.from('\n')]))
  await assert.rejects(retainLegacyAssets(source, destination, pins), /pin differs/)
})

test('production retention rejects duplicate paths and changed existing bytes before copying', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinned-legacy-collision-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = join(root, 'previous'), destination = join(root, 'apex')
  await fs.mkdir(join(source, 'assets'), { recursive: true }); await fs.mkdir(join(destination, 'assets'), { recursive: true })
  await fs.writeFile(join(destination, 'school-migration-candidate.json'), JSON.stringify({ format: 'synthetic-school-routes', phase: 'candidate-rescue', routes: [], assets: [] }))
  const first = Buffer.from('first'), second = Buffer.from('second')
  for (const [name, bytes] of [['a.js', first], ['b.js', second]]) await fs.writeFile(join(source, 'assets', name), bytes)
  const artifacts = [['a.js', first], ['b.js', second]].map(([name, bytes]) =>
    ({ path: `assets/${name}`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }))
  const deploymentId = 'e18dfb79-5f4b-4ae3-b283-4ee15eb0b3b8'
  const writeManifest = async (entries) => {
    const raw = Buffer.from(JSON.stringify({ format: 'production-legacy-assets', version: 1, project: 'manabi-map', deploymentId, artifacts: entries }))
    await fs.writeFile(join(source, 'legacy-assets.json'), raw)
    return { expectedDeploymentId: deploymentId, expectedManifestSha256: createHash('sha256').update(raw).digest('hex') }
  }
  let pins = await writeManifest(artifacts)
  await fs.writeFile(join(destination, 'assets/b.js'), 'collision')
  await assert.rejects(retainLegacyAssets(source, destination, pins), /collision/)
  await assert.rejects(fs.stat(join(destination, 'assets/a.js')), { code: 'ENOENT' })
  pins = await writeManifest([artifacts[0], { ...artifacts[0], path: 'assets/A.js' }])
  await assert.rejects(retainLegacyAssets(source, destination, pins), /Invalid legacy asset entry/)
})

test('v2 pins the current anchor and records a source deployment for every old asset', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'multi-deployment-assets-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = join(root, 'previous'), destination = join(root, 'apex')
  await fs.mkdir(join(source, 'assets'), { recursive: true }); await fs.mkdir(destination)
  const inventoryPath = join(destination, 'school-migration-candidate.json')
  await fs.writeFile(inventoryPath, JSON.stringify({ format: 'synthetic-school-routes', phase: 'candidate-rescue', routes: [], assets: [] }))
  const anchorDeploymentId = 'e18dfb79-5f4b-4ae3-b283-4ee15eb0b3b8'
  const olderDeploymentId = '35bfd306-c852-4b64-9885-1ad9b832fb17'
  const files = [['assets/current.js', Buffer.from('current'), anchorDeploymentId],
    ['assets/older.js', Buffer.from('older'), olderDeploymentId]]
  const artifacts = files.map(([path, bytes, sourceDeploymentId]) =>
    ({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sourceDeploymentId }))
  for (const [path, bytes] of files) await fs.writeFile(join(source, path), bytes)
  const manifestPath = join(source, 'legacy-assets.json')
  const writeManifest = async (entries) => {
    const raw = Buffer.from(JSON.stringify({ format: 'production-legacy-assets', version: 2, project: 'manabi-map', anchorDeploymentId, artifacts: entries }))
    await fs.writeFile(manifestPath, raw)
    return { expectedDeploymentId: anchorDeploymentId, expectedManifestSha256: createHash('sha256').update(raw).digest('hex') }
  }
  let pins = await writeManifest(artifacts)
  await assert.rejects(retainLegacyAssets(source, destination, { ...pins, expectedDeploymentId: olderDeploymentId }), /pin differs/)
  assert.deepEqual(await retainLegacyAssets(source, destination, pins),
    { synthetic: false, retained: 2, deploymentId: anchorDeploymentId, version: 2 })
  assert.deepEqual(JSON.parse(await fs.readFile(inventoryPath, 'utf8')).assets,
    ['/assets/current.js', '/assets/older.js'])
  pins = await writeManifest([{ path: artifacts[0].path, size: artifacts[0].size, sha256: artifacts[0].sha256 }])
  await assert.rejects(retainLegacyAssets(source, destination, pins), /Invalid legacy asset entry/)
  pins = await writeManifest([{ ...artifacts[0], sourceDeploymentId: 'not-an-id' }])
  await assert.rejects(retainLegacyAssets(source, destination, pins), /Invalid legacy asset entry/)
  pins = await writeManifest([artifacts[0], { ...artifacts[0], path: 'assets/CURRENT.js' }])
  await assert.rejects(retainLegacyAssets(source, destination, pins), /Invalid legacy asset entry/)
})

test('v2 aggregate byte cap rejects the manifest before reading any asset', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'multi-deployment-budget-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = join(root, 'previous'), destination = join(root, 'apex')
  await fs.mkdir(source); await fs.mkdir(destination)
  const anchorDeploymentId = 'e18dfb79-5f4b-4ae3-b283-4ee15eb0b3b8'
  const artifacts = Array.from({ length: 11 }, (_, i) => ({ path: `assets/old-${i}.js`, size: 25 * 1024 * 1024,
    sha256: '0'.repeat(64), sourceDeploymentId: anchorDeploymentId }))
  const raw = Buffer.from(JSON.stringify({ format: 'production-legacy-assets', version: 2, project: 'manabi-map', anchorDeploymentId, artifacts }))
  await fs.writeFile(join(source, 'legacy-assets.json'), raw)
  await assert.rejects(retainLegacyAssets(source, destination, { expectedDeploymentId: anchorDeploymentId,
    expectedManifestSha256: createHash('sha256').update(raw).digest('hex') }), /aggregate size exceeds 256 MiB/)
})
