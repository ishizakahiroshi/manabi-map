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
import { portal, renderEntryPage } from '../../apex-portal/portal.mjs'

const portalRoot = fileURLToPath(new URL('../../apex-portal/', import.meta.url))
test('portal uses independent brand/service settings and no unpublished links', async () => {
  const template = await fs.readFile(join(portalRoot, 'index.html'), 'utf8')
  const html = renderEntryPage(template)
  assert.ok(html.includes('まなびマップ'))
  assert.ok(!html.includes('href="https://'))
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

test('historical synthetic chunks are explicit, hash checked and collision safe', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'synthetic-legacy-assets-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = join(root, 'previous'), destination = join(root, 'apex')
  await fs.mkdir(join(source, 'assets'), { recursive: true }); await fs.mkdir(destination)
  const bytes = Buffer.from('/* synthetic previous deployment */')
  const manifest = { format: 'synthetic-legacy-assets', synthetic: true, artifacts: [{ path: 'assets/previous-hash.js', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }
  await fs.writeFile(join(source, 'assets/previous-hash.js'), bytes)
  await fs.writeFile(join(source, 'legacy-assets.json'), JSON.stringify(manifest))
  assert.equal((await retainLegacyAssets(source, destination)).retained, 1)
  await retainLegacyAssets(source, destination)
  await fs.writeFile(join(destination, 'assets/previous-hash.js'), 'collision')
  await assert.rejects(retainLegacyAssets(source, destination), /collision/)
  await fs.writeFile(join(source, 'assets/previous-hash.js'), 'tampered')
  await assert.rejects(retainLegacyAssets(source, destination), /inventory differs/)
})
