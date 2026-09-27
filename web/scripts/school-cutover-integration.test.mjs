// One synthetic source crosses the Python registry/queue and JS generation/gate.
// No production DB, deployment adapter or credentials are involved.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import test from 'node:test'
import { generateSchoolCandidate } from './gen-schools-json.mjs'
import { schoolCandidateIdentity, createSchoolPublicationStub, createQueueBoundSchoolPublicationStub, dryRunSchoolPublication } from './lib/school-publish-gate.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const pythonExecutable = process.env.PYTHON_EXECUTABLE || 'python'
const prelude = `import sys, json
from pathlib import Path
sys.path.insert(0, sys.argv[1])
root = Path(sys.argv[2])
import school_review_queue as queue
reviewer = queue.Actor('synthetic-reviewer', 'reviewer')
worker = queue.Actor('synthetic-worker', 'worker')
owner = queue.Actor('synthetic-owner', 'submitter')
proposal_id = (root / 'proposal-id.txt').read_text() if (root / 'proposal-id.txt').exists() else 'change-1'
def ingest(label):
    from school_intake_transfer import issue_envelope
    events = json.loads((root / 'intake-events.json').read_text())
    event = events[label]
    key = (root / 'synthetic-transfer-key').read_bytes()
    envelope = issue_envelope(event, issuer='synthetic-intake', key_id='test-key', key=key)
    q = queue.Queue(root / 'queue.sqlite')
    return q.ingest_transfer(envelope, trusted_keys={('synthetic-intake', 'test-key'): key})
`
function python(root, code, input = {}) {
  const result = spawnSync(pythonExecutable, ['-B', '-c', prelude + code, join(repo, 'scripts/local-data'), root], {
    encoding: 'utf8', input: JSON.stringify(input), windowsHide: true,
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}

test('snapshot -> registry -> durable queue -> gate -> failed/retried stub result uses one identity', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'school-cutover-synthetic-'))
  assert.ok(!resolve(root).startsWith(repo + '/'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  t.mock.method(globalThis, 'fetch', () => { throw new Error('network forbidden') })
  const source = python(root, `
from contextlib import closing, redirect_stdout
from types import SimpleNamespace
import io, store, store_school as school, school_fixture, school_id_index, school_registry
payload = school_fixture.synthetic_payload()
for row in payload['tables']['schools']:
    row['prefecture'] = '東京都'
    row['city'] = '千代田区'
    row['address'] = '合成住所'
payload['tables'] = school.normalize_tables(payload['tables'])
with closing(store.connect(root / 'source.sqlite')) as db:
    school.import_rows(db, payload, fresh=True)
with redirect_stdout(io.StringIO()):
    school.export_command(SimpleNamespace(db=root / 'source.sqlite', output=root / 'bundle'))
index = school_id_index.build_index(root / 'bundle')
receipt = school_registry.simulate_registration(index)
(root / 'index.json').write_text(json.dumps(index), encoding='utf-8')
(root / 'registration.json').write_text(json.dumps(receipt), encoding='utf-8')
print(json.dumps(index['source']))
`)
  const candidateRoot = join(root, 'candidate')
  await generateSchoolCandidate({ snapshotPath: join(root, 'bundle/snapshot.json'), manifestPath: join(root, 'bundle/manifest.json'), outputRoot: candidateRoot })
  const candidate = await schoolCandidateIdentity(candidateRoot)
  assert.equal(candidate.snapshotSha256, source.snapshot_sha256)
  assert.equal(candidate.contentSha256, source.snapshot_content_sha256)
  const options = { candidateRoot, indexPath: join(root, 'index.json'), receiptPath: join(root, 'registration.json'),
    pythonExecutable, expectedCandidate: candidate, destination: 'stub://school-publication' }
  assert.equal((await dryRunSchoolPublication(options)).state, 'ready')

  const pending = python(root, `
candidate = json.load(sys.stdin)
base = {'dataset_version': 'synthetic-before', 'snapshot_content_sha256': '0' * 64}
q = queue.create_queue(root / 'queue.sqlite', base, synthetic=True, source_mode='planning_stub')
index = json.loads((root / 'index.json').read_text())
payload = {'school_id': index['schools'][0]['id'], 'department_id': None, 'field': 'deviation_value', 'value': 51}
q.submit('proposal-1', base, payload, owner, legacy_status='applied')
assert q.get('proposal-1')['state'] == 'received'
q.review('proposal-1', reviewer)
target = {'dataset_version': candidate['datasetVersion'], 'snapshot_content_sha256': candidate['contentSha256']}
q.adopt('proposal-1', target, 'adoption-1', reviewer)
q.fail('proposal-1', 'generation', 'synthetic_generator_failure', worker)
q.generated('proposal-1', candidate, worker)
q.request_publication('proposal-1', 'publication-1', worker)
print(json.dumps(q.get('proposal-1')))
`, candidate)
  assert.equal(pending.state, 'publish_requested')
  const transport = createSchoolPublicationStub()
  await assert.rejects(transport.publish({ ...options, requestId: pending.request_id }, { fail: true }))
  assert.equal(transport.inspect().active, null)
  const restarted = python(root, `
q = queue.Queue(root / 'queue.sqlite')
q.fail('proposal-1', 'publication', 'synthetic_transport_failure', worker)
print(json.dumps(q.get('proposal-1')))
`)
  assert.equal(restarted.state, 'publish_requested')
  assert.equal(restarted.failures.length, 2)
  const receipt = await transport.publish({ ...options, requestId: restarted.request_id })
  const confirmed = python(root, `
q = queue.Queue(root / 'queue.sqlite')
receipt = json.load(sys.stdin)
wrong = dict(receipt, requestId='wrong-request')
try:
    q.confirm_publication('proposal-1', wrong, worker)
except ValueError:
    pass
else:
    raise AssertionError('foreign request accepted')
q.confirm_publication('proposal-1', receipt, worker)
q.confirm_publication('proposal-1', receipt, worker)
print(json.dumps(q.get('proposal-1')))
`, receipt)
  assert.equal(confirmed.state, 'publication_confirmed')
  assert.deepEqual(confirmed.candidate, candidate)
  assert.equal(confirmed.publication.synthetic, true)
  const withdrawn = python(root, `
q = queue.Queue(root / 'queue.sqlite')
q.set_consent('proposal-1', False, owner)
assert q.get('proposal-1')['state'] == 'publication_confirmed'
assert q.get('proposal-1')['needs_reevaluation'] is True
try:
    q.adopted_change('proposal-1')
except ValueError:
    pass
else:
    raise AssertionError('withdrawn projection accepted')
print(json.dumps(q.get('proposal-1')['publication']))
`)
  assert.deepEqual(withdrawn, receipt)
})

for (const pgIntake of [false, true]) test(
  pgIntake ? 'isolated PG intake -> authenticated transfer -> source -> publication -> withdrawal -> rereviewed correction'
    : 'actual source transaction reaches generated bytes, survives the queue gap, and resumes after correction',
  { skip: pgIntake && !process.env.SCHOOL_INTAKE_SCENARIO ? 'explicit isolated PG scenario required' : false }, async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'school-apply-synthetic-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  t.mock.method(globalThis, 'fetch', () => { throw new Error('network forbidden') })
  const source = python(root, `
from contextlib import closing
import store, store_school as school, school_fixture
from school_source_apply import SourceAdapter
import secrets
scenario = json.load(sys.stdin)
payload = school_fixture.synthetic_payload()
if scenario is None:
    row = payload['tables']['school_deviation_values'][0]
    def event(label, revision, kind, consent, value):
        return dict(event_id='synthetic-event-' + label, request_id='change-1', revision=revision,
                    subject_ref='synthetic-owner', school_id=row['school_id'], department_id=row['department_id'],
                    kind=kind, consent=consent, school_consent=consent,
                    payload=dict(school_id=row['school_id'], department_id=row['department_id'], field='deviation_value', value=value))
    scenario = dict(synthetic=True, events={
        'reviewed': event('reviewed', 3, 'reviewed', True, 61),
        'withdrawn': event('withdrawn', 4, 'withdrawn', False, 61),
        'revised': event('revised', 5, 'withdrawn', False, 52),
        'reconsented': event('reconsented', 6, 'consent', True, 52),
        'rereviewed': event('rereviewed', 7, 'reviewed', True, 52),
        'after_rereview_withdrawn': event('withdrawn-again', 8, 'withdrawn', False, 52),
    })
if scenario is not None:
    assert scenario['synthetic'] is True
    events = scenario['events']
    event = events['reviewed']
    old_school = payload['tables']['schools'][0]['id']
    old_department = payload['tables']['school_departments'][0]['id']
    remap = {old_school: event['school_id'], old_department: event['department_id']}
    for rows in payload['tables'].values():
        for row in rows:
            for key, value in row.items():
                if isinstance(value, str) and value in remap:
                    row[key] = remap[value]
    proposal_id = event['request_id']
    (root / 'proposal-id.txt').write_text(proposal_id)
    (root / 'intake-events.json').write_text(json.dumps(events))
    (root / 'synthetic-transfer-key').write_bytes(secrets.token_bytes(32))
for row in payload['tables']['schools']:
    row.update(prefecture='東京都', city='千代田区', address='合成住所')
payload['tables'] = school.normalize_tables(payload['tables'])
with closing(store.connect(root / 'source.sqlite')) as db:
    school.import_rows(db, payload, fresh=True)
adapter = SourceAdapter(root / 'source.sqlite', synthetic=True)
base = adapter.generation()
row = payload['tables']['school_deviation_values'][0]
change = dict(school_id=row['school_id'], department_id=row['department_id'], field='deviation_value', value=61)
q = queue.create_queue(root / 'queue.sqlite', base, synthetic=True)
ingest('reviewed')
ingest('reviewed')  # Authenticated exact duplicate after restart is idempotent.
q.plan_adoption(proposal_id, 'apply-1', reviewer)
request = q.application_request(proposal_id)
receipt = adapter.apply(**request)
# Process ends here: source is committed but the queue remains pending.
assert q.snapshot()['generation'] == base
assert adapter.generation() == receipt['target']
print(json.dumps(dict(base=base, target=receipt['target'], school_id=row['school_id'], department_id=row['department_id'], proposal_id=proposal_id, subject_ref=events['reviewed']['subject_ref'])))
`, pgIntake ? JSON.parse(await fs.readFile(process.env.SCHOOL_INTAKE_SCENARIO, 'utf8')) : null)
  const reconciled = python(root, `
from school_source_apply import SourceAdapter
q = queue.Queue(root / 'queue.sqlite')
request = q.application_request(proposal_id)
adapter = SourceAdapter(root / 'source.sqlite', synthetic=True)
first = adapter.read_receipt('apply-1')
assert adapter.apply(**request) == first
q.reconcile_application(proposal_id, root / 'source.sqlite', worker)
q.reconcile_application(proposal_id, root / 'source.sqlite', worker)
print(json.dumps(q.get(proposal_id)))
`)
  assert.equal(reconciled.state, 'adopted')
  assert.deepEqual(reconciled.target, source.target)
  assert.notDeepEqual(source.base, source.target)

  async function produce(label, expectedValue, previous = null) {
    const exported = python(root, `
from contextlib import redirect_stdout
from types import SimpleNamespace
import io, store_school as school, school_id_index, school_registry
params = json.load(sys.stdin)
label = params['label']
with redirect_stdout(io.StringIO()):
    school.export_command(SimpleNamespace(db=root / 'source.sqlite', output=root / label))
index = school_id_index.build_index(root / label)
previous = params['previous']
registration = school_registry.simulate_registration(index, previous)
(root / (label + '-index.json')).write_text(json.dumps(index), encoding='utf-8')
(root / (label + '-registration.json')).write_text(json.dumps(registration), encoding='utf-8')
snapshot = json.loads((root / label / 'snapshot.json').read_text(encoding='utf-8'))
print(json.dumps(dict(source=index['source'], registration=registration, deviations=snapshot['tables']['school_deviation_values'])))
`, { label, previous })
    assert.equal(exported.deviations.find((row) => row.department_id === source.department_id).value, expectedValue)
    const candidateRoot = join(root, `${label}-candidate`)
    await generateSchoolCandidate({ snapshotPath: join(root, label, 'snapshot.json'), manifestPath: join(root, label, 'manifest.json'), outputRoot: candidateRoot })
    const candidate = await schoolCandidateIdentity(candidateRoot)
    assert.equal(candidate.contentSha256, exported.source.snapshot_content_sha256)
    const manifest = JSON.parse(await fs.readFile(join(candidateRoot, 'candidate-manifest.json'), 'utf8'))
    for (const { path } of manifest.artifacts) {
      const bytes = await fs.readFile(join(candidateRoot, path))
      const text = (path.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8')
      for (const privateValue of [source.proposal_id, source.subject_ref, 'synthetic-only-pin', 'synthetic review']) {
        assert.ok(!text.includes(privateValue), `private intake content escaped into ${path}`)
      }
    }
    const detail = JSON.parse(await fs.readFile(join(candidateRoot, 'school-data', `${source.school_id}.json`), 'utf8'))
    assert.equal(detail.schools[0].school_deviation_values.find((row) => row.department_id === source.department_id).value, expectedValue)
    const options = { candidateRoot, indexPath: join(root, `${label}-index.json`), receiptPath: join(root, `${label}-registration.json`),
      pythonExecutable, expectedCandidate: candidate, destination: 'stub://school-publication' }
    assert.equal((await dryRunSchoolPublication(options)).state, 'ready')
    return { options, candidate, registration: exported.registration }
  }
  const first = await produce('after-apply', 61)
  python(root, `
q = queue.Queue(root / 'queue.sqlite')
q.generated(proposal_id, json.load(sys.stdin), worker)
q.request_publication(proposal_id, 'publish-1', worker)
print(json.dumps(q.get(proposal_id)['state']))
`, first.candidate)
  const transport = createQueueBoundSchoolPublicationStub({ queuePath: join(root, 'queue.sqlite'), pythonExecutable })
  await assert.rejects(transport.publish({ ...first.options, proposalId: source.proposal_id, requestId: 'publish-1' }, { fail: true }))
  python(root, `
q = queue.Queue(root / 'queue.sqlite')
q.fail(proposal_id, 'publication', 'synthetic_transport_failure', worker)
print(json.dumps(q.get(proposal_id)['state']))
`)
  const published = await transport.publish({ ...first.options, proposalId: source.proposal_id, requestId: 'publish-1' })
  python(root, `
q = queue.Queue(root / 'queue.sqlite')
q.confirm_publication(proposal_id, json.load(sys.stdin), worker)
if (root / 'intake-events.json').exists():
    ingest('withdrawn')
    ingest('withdrawn')
    assert ingest('reviewed')['consent'] is False  # Old exact replay returns current state.
else:
    q.set_consent(proposal_id, False, owner)
try:
    q.adopted_change(proposal_id)
except ValueError:
    pass
else:
    raise AssertionError('withdrawn source was usable')
print(json.dumps(q.get(proposal_id)['publication']))
`, published)
  const beforeRefusal = transport.inspect()
  await assert.rejects(transport.publish({ ...first.options, proposalId: source.proposal_id, requestId: 'publish-1' }))
  await assert.rejects(transport.publish({ ...first.options, proposalId: source.proposal_id, requestId: 'withdrawn-bypass' }))
  assert.deepEqual(transport.inspect(), beforeRefusal)
  const recovery = python(root, `
from school_source_apply import SourceAdapter
q = queue.Queue(root / 'queue.sqlite')
old = q.get(proposal_id)
change = dict(old['payload'], value=52)
if (root / 'intake-events.json').exists():
    ingest('revised')
    ingest('reconsented')
    try:
        q.request_reevaluation('recovery-1', 'apply-recovery-1', [change], 'synthetic-independent-correction', reviewer)
    except ValueError:
        pass
    else:
        raise AssertionError('reconsent replaced required rereview')
    ingest('rereviewed')
q.request_reevaluation('recovery-1', 'apply-recovery-1', [change], 'synthetic-independent-correction', reviewer)
request = q.application_request('recovery-1')
adapter = SourceAdapter(root / 'source.sqlite', synthetic=True)
adapter.apply(**request)
# Another source/queue commit gap. All generation must remain blocked.
try:
    q.generated(proposal_id, old['candidate'], worker)
except ValueError:
    pass
else:
    raise AssertionError('pending recovery accepted stale generation')
q = queue.Queue(root / 'queue.sqlite')
q.reconcile_application('recovery-1', root / 'source.sqlite', worker)
assert q.get(proposal_id)['publication'] == old['publication']
print(json.dumps(q.get('recovery-1')))
`)
  assert.equal(recovery.state, 'adopted')
  const second = await produce('after-recovery', 52, first.registration)
  assert.notEqual(second.candidate.contentSha256, first.candidate.contentSha256)
  assert.deepEqual(second.registration.schools, first.registration.schools)
  assert.deepEqual(second.registration.departments, first.registration.departments)
  python(root, `
q = queue.Queue(root / 'queue.sqlite')
params = json.load(sys.stdin)
for action in (
    lambda: q.generated(proposal_id, params['old'], worker),
    lambda: q.generated('recovery-1', params['old'], worker),
    lambda: q.confirm_publication(proposal_id, params['published'], worker),
):
    try:
        action()
    except ValueError:
        pass
    else:
        raise AssertionError('stale work resumed after recovery')
q.generated('recovery-1', params['new'], worker)
try:
    q.request_publication('recovery-1', 'publish-1', worker)
except ValueError:
    pass
else:
    raise AssertionError('old publication request reused')
q.request_publication('recovery-1', 'publish-recovery-1', worker)
print(json.dumps(q.get('recovery-1')['state']))
`, { old: first.candidate, new: second.candidate, published })
  await assert.rejects(transport.publish({ ...first.options, proposalId: source.proposal_id, requestId: 'publish-1' }))
  const resumed = await transport.publish({ ...second.options, proposalId: 'recovery-1', requestId: 'publish-recovery-1' })
  const confirmed = python(root, `
q = queue.Queue(root / 'queue.sqlite')
q.confirm_publication('recovery-1', json.load(sys.stdin), worker)
print(json.dumps(dict(current=q.get('recovery-1'), prior=q.get(proposal_id)['publication'])))
`, resumed)
  assert.equal(confirmed.current.state, 'publication_confirmed')
  assert.deepEqual(confirmed.prior, published)
  python(root, `
ingest('after_rereview_withdrawn')
q = queue.Queue(root / 'queue.sqlite')
assert q.get('recovery-1')['needs_reevaluation'] is True
print(json.dumps(q.get('recovery-1')['needs_reevaluation']))
`)
  await assert.rejects(transport.publish({ ...second.options, proposalId: 'recovery-1', requestId: 'publish-recovery-1' }))
})
