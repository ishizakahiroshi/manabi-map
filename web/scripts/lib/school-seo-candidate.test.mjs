import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { stageSchoolCandidate } from './school-candidate.mjs'
import { canonicalSchoolSourceJSON } from './school-source.mjs'
import { createSeoDataReader } from './school-seo-candidate.mjs'

const payloadPath = 'schools-1111111111.json.gz'
async function fixture(t, url = `/${payloadPath}`) {
  const root = await fs.mkdtemp(join(tmpdir(), 'synthetic-seo-guard-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const candidate = join(root, 'candidate'), dist = join(root, 'dist')
  const createdAt = '2026-09-27T00:00:00Z'
  const files = [{ path: 'web/synthetic.mjs', sha256: '0'.repeat(64) }]
  await stageSchoolCandidate({ outputRoot: candidate, inputPaths: [], protectedRoot: join(root, 'protected'),
    metadata: { datasetVersion: 'synthetic', sourceVersion: 'synthetic', generatedAt: createdAt, source: { snapshotSha256: '0'.repeat(64), manifestSha256: '1'.repeat(64), contentSha256: '2'.repeat(64) } },
    generator: { files, sha256: createHash('sha256').update(canonicalSchoolSourceJSON(files)).digest('hex') },
    build: async (stage) => {
      await fs.writeFile(join(stage, 'schools-manifest.json'), JSON.stringify({ generatedAt: createdAt, ...(url === null ? {} : { url }) }))
      await fs.writeFile(join(stage, payloadPath), gzipSync('{"synthetic":true}'))
    },
  })
  await fs.mkdir(dist)
  for (const file of ['schools-manifest.json', payloadPath]) await fs.copyFile(join(candidate, file), join(dist, file))
  return { root, candidate, dist, args: [`--synthetic-candidate=${candidate}`] }
}

test('normal SEO retains 1000 guard and legacy schools.json reading', async (t) => {
  const { dist } = await fixture(t)
  await fs.writeFile(join(dist, 'schools.json'), '{"legacy":true}')
  const reader = await createSeoDataReader(['--dist', dist], dist)
  assert.equal(reader.minimumExpected, 1000)
  assert.equal(await reader.readData('schools.json', 'utf8'), '{"legacy":true}')
  for (const args of [['--synthetic-candidate'], ['--synthetic-candidate=a', '--synthetic-candidate=b'], ['--synthetic-candidate=']]) await assert.rejects(createSeoDataReader(args, dist))
})

test('synthetic SEO refuses missing URL, unlisted URL, traversal and legacy fallback', async (t) => {
  for (const url of [null, '/schools-2222222222.json.gz', '/../schools.json', '/schools.json']) {
    const { args, dist } = await fixture(t, url)
    await fs.writeFile(join(dist, 'schools.json'), '{"notReceiptBound":true}')
    await assert.rejects(createSeoDataReader(args, dist), /receipt-bound canonical schools URL/)
  }
})

test('small SEO reads only receipt-bound data including each dataset/detail/pref input', async (t) => {
  const { args, dist } = await fixture(t)
  const reader = await createSeoDataReader(args, dist)
  assert.equal(reader.minimumExpected, 1)
  assert.deepEqual(await reader.readData(payloadPath), await fs.readFile(join(dist, payloadPath)))
  for (const path of ['api/v1/dataset.json', 'school-data/id.json', 'school-data/pref-index-tokyo.json', 'schools.json']) {
    await assert.rejects(reader.readData(path), /missing from the receipt/)
  }
  await fs.writeFile(join(dist, payloadPath), 'changed after initial validation')
  await assert.rejects(reader.readData(payloadPath), /differs/)
  await assert.rejects(createSeoDataReader(args, dist), /differs/)
})

test('small SEO refuses non-synthetic receipt', async (t) => {
  const { candidate, args, dist } = await fixture(t)
  const receiptPath = join(candidate, 'candidate-manifest.json')
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8')); receipt.synthetic = false
  await fs.writeFile(receiptPath, canonicalSchoolSourceJSON(receipt) + '\n')
  await assert.rejects(createSeoDataReader(args, dist), /unsupported receipt scope/)
})
