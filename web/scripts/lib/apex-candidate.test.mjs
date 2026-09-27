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
