import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { verifySchoolProjection, produceSchoolRelease } from './school-release-producer.mjs'
import { buildPublicSchoolRecords } from './public-api.mjs'

function fixture() {
  const schools = [{ id: 'synthetic-school', name: 'Synthetic School', prefecture: 'Synthetic Prefecture',
    official_url: 'https://school.example.invalid', is_active: true, type: 'high_school',
    school_deviation_values: [{ value: 99 }], private_note: 'must never enter API' }]
  const payload = { formatVersion: 2, schools, sourceCatalog: [] }, generatedAt = '2026-01-01T00:00:00Z'
  const publicRows = buildPublicSchoolRecords(schools, [], generatedAt)
  assert.equal(publicRows.length, 1)
  return { generatorSnapshot: Buffer.from(JSON.stringify(payload)), files: new Map([
    ['schools-manifest.json', Buffer.from(JSON.stringify({ generatedAt, url: '/schools-abcdef.json' }))],
    ['schools-abcdef.json', Buffer.from(JSON.stringify(payload))],
    ['api/v1/schools.json', Buffer.from(JSON.stringify({ api_version: 'v1', generated_at: generatedAt, count: 1, schools: publicRows }))],
    ['api/v1/schools/synthetic.json', Buffer.from(JSON.stringify({ api_version: 'v1', generated_at: generatedAt,
      prefecture: 'Synthetic Prefecture', count: 1, schools: publicRows }))],
  ]) }
}

test('producer field projection invokes shared allowlist and validates all API partitions', () => {
  const f = fixture()
  assert.equal(verifySchoolProjection(f).publicRecords, 1)
  for (const path of ['api/v1/schools.json', 'api/v1/schools/synthetic.json']) {
    const changed = fixture(), value = JSON.parse(changed.files.get(path))
    value.schools[0].private_note = 'synthetic private value'
    changed.files.set(path, Buffer.from(JSON.stringify(value)))
    assert.throws(() => verifySchoolProjection(changed), /mismatch/)
  }
})

test('source generation mismatch, absent partition and cross generation timestamps fail', () => {
  const changed = fixture(); changed.generatorSnapshot = Buffer.from(changed.generatorSnapshot.toString().replace('Synthetic School', 'Changed School'))
  assert.throws(() => verifySchoolProjection(changed), /mismatch/)
  const missing = fixture(); missing.files.delete('api/v1/schools/synthetic.json')
  assert.throws(() => verifySchoolProjection(missing), /mismatch/)
  const timestamp = fixture(), api = JSON.parse(timestamp.files.get('api/v1/schools.json'))
  api.generated_at = '2025-01-01T00:00:00Z'; timestamp.files.set('api/v1/schools.json', Buffer.from(JSON.stringify(api)))
  assert.throws(() => verifySchoolProjection(timestamp), /mismatch/)
})

test('projection success cannot bypass existing full static/internal-field gate', async (t) => {
  const f = fixture(), root = await fs.mkdtemp(join(tmpdir(), 'synthetic-producer-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const [path, bytes] of f.files) { await fs.mkdir(dirname(join(root, path)), { recursive: true }); await fs.writeFile(join(root, path), bytes) }
  await assert.rejects(produceSchoolRelease({ distDir: root, generatorSnapshot: f.generatorSnapshot,
    generation: 'synthetic-g1', candidateRevision: 'b'.repeat(40), evidence: 'synthetic' }), /field gate failed/)
})
