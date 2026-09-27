import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { stageSchoolCandidate } from './lib/school-candidate.mjs'
import { canonicalSchoolSourceJSON } from './lib/school-source.mjs'
import { createSchoolPublicationStub, createQueueBoundSchoolPublicationStub, dryRunSchoolPublication, schoolCandidateIdentity, SCHOOL_PUBLICATION_STUB_DESTINATION } from './lib/school-publish-gate.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const pythonExecutable = process.platform === 'win32' ? 'python' : 'python3'
const execute = promisify(execFile)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const objectHash = (value) => hash(canonicalSchoolSourceJSON(value))
const schoolId = '10000000-0000-4000-8000-000000000001'
const otherId = '10000000-0000-4000-8000-000000000002'
const departmentId = '20000000-0000-4000-8000-000000000001'
const generatedAt = '2026-09-27T00:00:00Z'

async function fixture(t, version = 'synthetic-v1', changeDetail = () => {}, changeArtifacts = () => {}, source = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'synthetic-publication-gate-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const snapshotSha256 = hash(`synthetic snapshot ${version}`), contentSha256 = source.contentSha256 ?? hash(`synthetic content ${version}`)
  const sourceVersion = source.sourceVersion ?? version
  const index = {
    format: 'school-id-index-candidate', format_version: 1, state: 'candidate', synthetic: true,
    source: { schema_version: 3, dataset_version: version, source_version: sourceVersion,
      snapshot_sha256: snapshotSha256, snapshot_content_sha256: contentSha256 },
    previous_index_sha256: null, schools: [{ id: schoolId }], departments: [{ id: departmentId, school_id: schoolId }],
    diff: { added: { schools: [schoolId], departments: [departmentId] }, retained_absent: { schools: [], departments: [] } },
    counts: { schools: 1, departments: 1 },
  }
  index.index_sha256 = objectHash(index)
  const indexPath = join(root, 'index.json'), receiptPath = join(root, 'registration.json'), candidateRoot = join(root, 'candidate')
  await fs.writeFile(indexPath, JSON.stringify(index))
  const code = [
    'import json, sys', 'sys.path.insert(0, sys.argv[1])', 'import school_registry, school_id_index',
    'print(json.dumps(school_registry.simulate_registration(school_id_index.verify_index(sys.argv[2]))))',
  ].join('\n')
  const { stdout } = await execute(pythonExecutable, ['-B', '-c', code, join(repoRoot, 'scripts/local-data'), indexPath], { windowsHide: true })
  await fs.writeFile(receiptPath, stdout)
  const files = [{ path: 'web/scripts/synthetic-generator.mjs', sha256: hash('synthetic generator') }]
  await stageSchoolCandidate({ outputRoot: candidateRoot, inputPaths: [], protectedRoot: repoRoot,
    metadata: { datasetVersion: version, sourceVersion, generatedAt,
      source: { snapshotSha256, contentSha256, manifestSha256: hash(`synthetic manifest ${version}`) } },
    generator: { files, sha256: objectHash(files) },
    async build(stage) {
      await fs.mkdir(join(stage, 'school-data'))
      const full = { sourceCatalog: [], schools: [{ id: schoolId, latitude: 35, longitude: 139,
        is_active: true, official_url: 'https://example.invalid/synthetic-school', school_departments: [{ id: departmentId, school_id: schoolId }] }] }
      const detail = structuredClone(full)
      changeDetail(detail)
      const artifacts = {
        [`school-data/${schoolId}.json`]: detail,
        'schools-full.json.gz': full, 'schools-map.json.gz': structuredClone(full),
        'school-name-index.json': [{ i: schoolId }], 'city-index.json': [],
        'school-data/pref-synthetic.json': structuredClone(full),
        'school-data/pref-index-synthetic.json': { schools: [{ i: schoolId }] },
        'api/v1/schools.json': { generated_at: generatedAt, count: 1, schools: [{ id: schoolId }] },
        'api/v1/schools/synthetic.json': { generated_at: generatedAt, count: 1, schools: [{ id: schoolId }] },
        'api/v1/dataset.json': { generated_at: generatedAt, school_count: 1 }, 'api/v1/openapi.json': {},
        'schools-manifest.json': { generatedAt, url: '/schools-full.json.gz', mapUrl: '/schools-map.json.gz', count: 1, mapCount: 1,
          schoolDataCount: 1, nameIndexUrl: '/school-name-index.json', cityIndexUrl: '/city-index.json',
          prefDataUrls: { synthetic: '/school-data/pref-synthetic.json' }, prefIndexUrls: { synthetic: '/school-data/pref-index-synthetic.json' } },
      }
      changeArtifacts(artifacts)
      for (const [path, payload] of Object.entries(artifacts)) {
        await fs.mkdir(dirname(join(stage, path)), { recursive: true })
        const raw = JSON.stringify(payload)
        await fs.writeFile(join(stage, path), path.endsWith('.gz') ? gzipSync(raw) : raw)
      }
    },
  })
  return { candidateRoot, indexPath, receiptPath, pythonExecutable,
    expectedCandidate: await schoolCandidateIdentity(candidateRoot), destination: SCHOOL_PUBLICATION_STUB_DESTINATION }
}

async function changeReceipt(options, change) {
  const receipt = JSON.parse(await fs.readFile(options.receiptPath))
  change(receipt)
  receipt.registry_sha256 = objectHash({ schools: receipt.schools, departments: receipt.departments })
  delete receipt.receipt_sha256; receipt.receipt_sha256 = objectHash(receipt)
  await fs.writeFile(options.receiptPath, JSON.stringify(receipt))
}

test('synthetic registration and candidate identity pass a no-network dry-run', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('network forbidden') })
  const options = await fixture(t), result = await dryRunSchoolPublication(options)
  assert.equal(result.synthetic, true); assert.equal(result.state, 'ready')
  assert.deepEqual(result.candidate, options.expectedCandidate)
  assert.deepEqual(Object.keys(result.candidate).sort(), ['artifactsSha256', 'candidateManifestSha256', 'contentSha256', 'datasetVersion', 'snapshotSha256', 'sourceVersion'])
})

test('corrupt artifact is refused before a request becomes publishable', async (t) => {
  const options = await fixture(t)
  await fs.appendFile(join(options.candidateRoot, 'school-data', `${schoolId}.json`), ' ')
  await assert.rejects(dryRunSchoolPublication(options), /artifact bytes/)
})

test('different expected generation and extra identity fields are refused', async (t) => {
  const options = await fixture(t)
  await assert.rejects(dryRunSchoolPublication({ ...options, expectedCandidate: { ...options.expectedCandidate, sourceVersion: 'older' } }), /generation differs/)
  await assert.rejects(dryRunSchoolPublication({ ...options, expectedCandidate: { ...options.expectedCandidate, extra: true } }), /identity fields/)
})

test('valid index and registration from another generation are refused', async (t) => {
  const first = await fixture(t), second = await fixture(t, 'synthetic-v2')
  await assert.rejects(dryRunSchoolPublication({ ...first, indexPath: second.indexPath, receiptPath: second.receiptPath }), /ID index generation/)
})

test('candidate index alone is never accepted as registry registration', async (t) => {
  const options = await fixture(t)
  await assert.rejects(dryRunSchoolPublication({ ...options, receiptPath: options.indexPath }), /invalid synthetic registration/)
  await changeReceipt(options, (receipt) => { receipt.synthetic = false })
  await assert.rejects(dryRunSchoolPublication(options), /invalid synthetic registration/)
})

test('missing registered school and missing department are refused despite recomputed receipt hashes', async (t) => {
  const noSchool = await fixture(t), noDepartment = await fixture(t)
  await changeReceipt(noSchool, (receipt) => { receipt.schools = []; receipt.departments = [] })
  await changeReceipt(noDepartment, (receipt) => { receipt.departments = [] })
  for (const options of [noSchool, noDepartment]) await assert.rejects(dryRunSchoolPublication(options), /invalid synthetic registration/)
})

test('unregistered artifact IDs and changed department membership are refused', async (t) => {
  const unknownSchool = await fixture(t, 'synthetic-v1', (detail) => { detail.schools[0].id = otherId })
  const unknownDepartment = await fixture(t, 'synthetic-v1', (detail) => { detail.schools[0].school_departments[0].id = otherId })
  await assert.rejects(dryRunSchoolPublication(unknownSchool), /unregistered school/)
  await assert.rejects(dryRunSchoolPublication(unknownDepartment), /unregistered department/)
})

test('full/map/API/search and nested references reject unregistered IDs even with valid artifact hashes', async (t) => {
  for (const [path, mutate] of [
    ['schools-full.json.gz', (p) => { p.schools[0].id = otherId }],
    ['schools-map.json.gz', (p) => { p.schools[0].id = otherId }],
    ['api/v1/schools.json', (p) => { p.schools[0].id = otherId }],
    ['school-name-index.json', (p) => { p[0].i = otherId }],
    ['school-data/pref-index-synthetic.json', (p) => { p.schools[0].i = otherId }],
    ['schools-full.json.gz', (p) => { p.schools[0].school_deviation_values = [{ department_id: otherId }] }],
    ['schools-map.json.gz', (p) => { p.schools[0].school_departments[0].school_id = otherId }],
  ]) {
    const options = await fixture(t, 'synthetic-v1', () => {}, (artifacts) => mutate(artifacts[path]))
    await assert.rejects(dryRunSchoolPublication(options), /unregistered/)
  }
})

test('omitted detail, duplicate prefecture IDs and wrong API generation are refused', async (t) => {
  for (const mutate of [
    (artifacts) => { delete artifacts[`school-data/${schoolId}.json`] },
    (artifacts) => { artifacts['school-data/pref-synthetic.json'].schools.push(structuredClone(artifacts['school-data/pref-synthetic.json'].schools[0])) },
    (artifacts) => { artifacts['api/v1/schools.json'].generated_at = '2020-01-01T00:00:00Z' },
  ]) {
    const options = await fixture(t, 'synthetic-v1', () => {}, mutate)
    await assert.rejects(dryRunSchoolPublication(options), /differ|duplicate/)
  }
})

test('unapproved destination is refused without executing Python', async (t) => {
  const options = await fixture(t)
  for (const destination of ['https://example.invalid/deploy', 'stub://other', '', undefined]) {
    await assert.rejects(dryRunSchoolPublication({ ...options, destination, pythonExecutable: 'must-not-run' }), /destination/)
  }
})

test('failure keeps active version and queued request; same request retries idempotently', async (t) => {
  const first = await fixture(t), second = await fixture(t, 'synthetic-v2'), stub = createSchoolPublicationStub()
  const old = await stub.publish({ requestId: 'synthetic-request-v1', ...first })
  await assert.rejects(stub.publish({ requestId: 'synthetic-request-v2', ...second }, { fail: true }), /Synthetic publication failed/)
  assert.deepEqual(stub.inspect().active, old)
  assert.equal(stub.inspect().requests[1].state, 'publication_failed')
  const result = await stub.publish({ requestId: 'synthetic-request-v2', ...second })
  assert.equal(result.state, 'publication_confirmed'); assert.equal(result.synthetic, true)
  assert.equal(stub.inspect().requests[1].attempts, 2)
  assert.deepEqual(await stub.publish({ requestId: 'synthetic-request-v2', ...second }), result)
  assert.equal(stub.inspect().requests[1].attempts, 2)
  await assert.rejects(stub.publish({ requestId: 'synthetic-request-v2', ...first }), /request ID reused/)
})

test('previous version restore is re-gated and never changes registration receipts', async (t) => {
  const first = await fixture(t), second = await fixture(t, 'synthetic-v2'), stub = createSchoolPublicationStub()
  const registryBefore = await fs.readFile(second.receiptPath)
  await stub.publish({ requestId: 'v1', ...first }); await stub.publish({ requestId: 'v2', ...second })
  await assert.rejects(stub.restorePrevious({ requestId: 'v1' }), /new request ID/)
  assert.deepEqual(stub.inspect().active.candidate, second.expectedCandidate)
  await assert.rejects(stub.restorePrevious({ requestId: 'rollback' }, { fail: true }), /Synthetic publication failed/)
  assert.deepEqual(stub.inspect().active.candidate, second.expectedCandidate)
  const restored = await stub.restorePrevious({ requestId: 'rollback' })
  assert.deepEqual(restored.candidate, first.expectedCandidate)
  assert.deepEqual(await fs.readFile(second.receiptPath), registryBefore)
  await fs.appendFile(join(second.candidateRoot, 'schools-manifest.json'), ' ')
  await assert.rejects(stub.restorePrevious({ requestId: 'rollback-again' }), /artifact bytes/)
  assert.deepEqual(stub.inspect().active.candidate, first.expectedCandidate)
})

test('concurrent publication is refused and result inspection cannot mutate internal state', async (t) => {
  const options = await fixture(t), stub = createSchoolPublicationStub()
  const pending = stub.publish({ requestId: 'first', ...options })
  await assert.rejects(stub.publish({ requestId: 'second', ...options }), /another publication/)
  await pending
  const view = stub.inspect(); view.active.candidate.datasetVersion = 'tampered'
  assert.equal(stub.inspect().active.candidate.datasetVersion, 'synthetic-v1')
  await assert.rejects(stub.restorePrevious({ requestId: 'none' }), /no previous/)
})

// These bridge tests use a real source/queue receipt and small synthetic artifact
// fixtures. The full source-to-generated-bytes proof is the integration suite.
async function queueFixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'synthetic-permit-gate-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  async function run(body, data = null) {
    const code = [
      'import sys, json', 'from pathlib import Path', 'sys.path.insert(0, sys.argv[1])',
      'import school_review_queue as queue', 'root = Path(sys.argv[2])', 'data = json.loads(sys.argv[3])',
      'owner = queue.Actor("synthetic-owner", "submitter")',
      'reviewer = queue.Actor("synthetic-reviewer", "reviewer")',
      'worker = queue.Actor("synthetic-worker", "worker")', body,
    ].join('\n')
    const { stdout } = await execute(pythonExecutable, ['-B', '-c', code, join(repoRoot, 'scripts/local-data'), root, JSON.stringify(data)], { windowsHide: true })
    return JSON.parse(stdout)
  }
  const receipt = await run(`
from contextlib import closing
import store, store_school as school
import secrets
from school_intake_transfer import issue_envelope
from school_fixture import synthetic_payload
from school_source_apply import SourceAdapter
payload = synthetic_payload()
payload['tables'] = school.normalize_tables(payload['tables'])
with closing(store.connect(root / 'source.sqlite')) as db:
    school.import_rows(db, payload, fresh=True)
source = SourceAdapter(root / 'source.sqlite', synthetic=True)
base = source.generation()
q = queue.create_queue(root / 'queue.sqlite', base, synthetic=True)
row = payload['tables']['school_deviation_values'][0]
change = dict(school_id=row['school_id'], department_id=row['department_id'], field='deviation_value', value=61)
key = secrets.token_bytes(32)
(root / 'synthetic-key').write_bytes(key)
event = dict(event_id='reviewed-1', request_id='proposal', revision=1, subject_ref='synthetic-owner',
             school_id=change['school_id'], department_id=change['department_id'], kind='reviewed',
             consent=True, school_consent=True, payload=change)
(root / 'synthetic-event.json').write_text(json.dumps(event), encoding='utf-8')
q.ingest_transfer(issue_envelope(event, issuer='synthetic-intake', key_id='ephemeral', key=key),
                  trusted_keys={('synthetic-intake', 'ephemeral'): key})
q.plan_adoption('proposal', 'source-request', reviewer)
receipt = source.apply(**q.application_request('proposal'))
q.reconcile_application('proposal', root / 'source.sqlite', worker)
print(json.dumps(receipt))
`)
  const options = await fixture(t, receipt.target.dataset_version, undefined, undefined,
    { contentSha256: receipt.target.snapshot_content_sha256, sourceVersion: receipt.source_version })
  await run(`
q = queue.Queue(root / 'queue.sqlite')
q.generated('proposal', data, worker)
q.request_publication('proposal', 'publication', worker)
print('null')
`, options.expectedCandidate)
  const config = { queuePath: join(root, 'queue.sqlite'), pythonExecutable }
  async function withdraw() {
    return run(`
from school_intake_transfer import issue_envelope
q = queue.Queue(root / 'queue.sqlite')
key = (root / 'synthetic-key').read_bytes()
event = json.loads((root / 'synthetic-event.json').read_text(encoding='utf-8'))
event.update(event_id='withdrawn-2', revision=2, kind='withdrawn', consent=False, school_consent=False)
q.ingest_transfer(issue_envelope(event, issuer='synthetic-intake', key_id='ephemeral', key=key),
                  trusted_keys={('synthetic-intake', 'ephemeral'): key})
print(json.dumps(q.get('proposal')))
`)
  }
  return { run, withdraw, config, stub: createQueueBoundSchoolPublicationStub(config),
    request: { ...options, proposalId: 'proposal', requestId: 'publication' } }
}

test('queue permit withdrawn between issue and consume cannot change active JS state', async (t) => {
  const { withdraw, stub, request } = await queueFixture(t)
  let issued
  await assert.rejects(stub.publish(request, { beforeConsume: async (permit) => {
    issued = permit
    assert.equal(permit.state, 'issued')
    await withdraw()
  } }), /queue consent/)
  assert.ok(issued.permit_id)
  assert.equal(stub.inspect().active, null)
  await assert.rejects(stub.publish(request), /queue consent/)
})

test('consumed queue permit survives JS failure and restart but a withdrawal rejects successful replay', async (t) => {
  const { run, withdraw, stub, request, config } = await queueFixture(t)
  await assert.rejects(stub.publish(request, { fail: true }), /Synthetic publication failed/)
  assert.equal(stub.inspect().active, null)
  const restarted = createQueueBoundSchoolPublicationStub(config)
  const result = await restarted.publish(request)
  assert.ok(result.permit_id)
  assert.deepEqual(await restarted.publish(request), result)
  await run(`
q = queue.Queue(root / 'queue.sqlite')
q.confirm_publication('proposal', data, worker)
print('null')
`, result)
  const confirmed = await withdraw()
  assert.equal(confirmed.publication_state, 'revoked')
  await assert.rejects(restarted.publish(request), /queue consent/)
  await assert.rejects(createQueueBoundSchoolPublicationStub(config).publish(request), /queue consent/)
  // Withdrawal revokes the queue. It does not atomically erase an already
  // returned JS result or externally published bytes.
  assert.deepEqual(restarted.inspect().active, result)
})

test('queue-bound publish rejects reuse of a request with another proposal', async (t) => {
  const { stub, request } = await queueFixture(t)
  await stub.publish(request)
  await assert.rejects(stub.publish({ ...request, proposalId: 'other-proposal' }), /request ID reused/)
})
