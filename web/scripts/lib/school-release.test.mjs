import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { createSchoolReleaseReceipt, validateSchoolRelease, runSchoolRelease } from './school-release.mjs'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
function generation(name, count = 2) {
  const artifacts = new Map([
    ['schools-manifest.json', Buffer.from(JSON.stringify({ synthetic: true, generation: name }))],
    ['api/v1/schools.json', Buffer.from(JSON.stringify({ synthetic: true, schools: [name] }))],
  ])
  for (let i = 2; i < count; i++) artifacts.set(`school-data/synthetic-${i}.json`, Buffer.from(JSON.stringify({ synthetic: i, generation: name })))
  const raw = createSchoolReleaseReceipt({ generation: name, sourceSnapshotSha256: hash(`source-${name}`),
    projectionGateSha256: hash(`gate-${name}`), candidateRevision: 'a'.repeat(40), evidence: 'synthetic' }, artifacts)
  return { raw, artifacts, pin: { generation: name, receiptSha256: hash(raw), projectionGateSha256: hash(`gate-${name}`) } }
}

function setup(options = {}) {
  const old = generation('synthetic-old', options.oldCount ?? 3), next = generation('synthetic-next', options.count ?? 5)
  const targets = { apex: { origin: 'https://portal.example.invalid', project: 'apex' },
    'high-school': { origin: 'https://school.example.invalid', project: 'high-school' } }
  const deployments = { apex: 'old-apex', 'high-school': 'old-high-school' }
  const live = new Map(Object.values(targets).map((t) => [t.project, deployments[t.project]]))
  const store = new Map(Object.values(deployments).map((id) => [id, old.artifacts]))
  const events = []
  let now = 0
  const adapter = {
    async current(target) { return live.get(target.project) },
    async read(target, path, method) {
      const id = live.get(target.project)
      events.push(`read:${id}:${method}:${path}`)
      const bytes = store.get(id).get(path)
      return { status: bytes ? 200 : 404, deploymentId: id,
        headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*',
          'cache-control': path === 'schools-manifest.json' ? 'no-store' : 'public, max-age=3600' },
        bytes: method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(bytes ?? '') }
    },
    async deploy(target, files) {
      events.push(`deploy:${target.project}`); now += 5
      const id = `next-${target.project}`
      store.set(id, files); live.set(target.project, id)
      return id
    },
    async rollback(target, id) { events.push(`rollback:${target.project}`); live.set(target.project, id) },
  }
  const input = { ...next, previous: { ...old, deployments }, targets, order: ['high-school', 'apex'],
    maxSkewMs: 100, adapter, clock: () => now }
  return { input, live, store, events, adapter, advance: (value) => { now += value } }
}

test('all receipt artifacts on both live origins need GET and HEAD, independent of fixture counts', async () => {
  const s = setup({ count: 17 })
  const result = await runSchoolRelease(s.input)
  assert.deepEqual(result, { state: 'complete', evidence: 'synthetic', generation: 'synthetic-next',
    deployments: { 'high-school': 'next-high-school', apex: 'next-apex' }, artifacts: 17, elapsedMs: 10 })
  assert.equal(s.events.filter((x) => x.startsWith('read:next-')).length, 17 * 2 * 2 * 2)
})

test('receipt rejects synthetic legacy format and changed pin without mutations', async () => {
  const s = setup()
  s.input.raw = Buffer.from('{"format":"school-source-candidate","synthetic":true}')
  await assert.rejects(runSchoolRelease(s.input), /pin/)
  assert.deepEqual(s.events, [])
})

test('receipt rejects duplicate JSON, unknown fields, path traversal and artifact omission', () => {
  const g = generation('synthetic-next')
  const valid = JSON.parse(g.raw)
  for (const mutate of [
    (r) => { r.private = true },
    (r) => { r.artifacts[0].path = '../source.json' },
    (r) => { r.artifacts.push(r.artifacts[0]) },
    (r) => { r.artifacts[0].size = -1 },
    (r) => { r.artifacts[0].path = 'api/v1/secret.json' },
    (r) => { r.artifacts = r.artifacts.slice(1) },
    (r) => { r.evidence = 'complete' },
  ]) {
    const changed = structuredClone(valid); mutate(changed)
    // Use creator's canonical encoding recursively via sorted-key helper.
    const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object'
      ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v)
    const raw = Buffer.from(`${canonical(changed)}\n`)
    assert.throws(() => validateSchoolRelease(raw, { ...g.pin, receiptSha256: hash(raw) }, g.artifacts))
  }
  const duplicate = Buffer.from(g.raw.toString().replace('"version":1', '"version":1,"version":1'))
  assert.throws(() => validateSchoolRelease(duplicate, { ...g.pin, receiptSha256: hash(duplicate) }), /canonical/)
})

test('preflight rejects broken rollback generation and duplicate targets without deployment', async () => {
  for (const corrupt of [
    (s) => { s.input.previous.artifacts.delete('api/v1/schools.json') },
    (s) => { s.input.targets.apex.origin = s.input.targets['high-school'].origin },
    (s) => { s.live.set('apex', 'unknown-deployment') },
    (s) => { s.input.maxSkewMs = 0 },
  ]) {
    const s = setup(); corrupt(s)
    await assert.rejects(runSchoolRelease(s.input))
    assert.equal(s.events.some((e) => /^(deploy|rollback):/.test(e)), false)
  }
})

test('second deployment rejection after mutation restores and verifies both old deployments', async () => {
  const s = setup(), deploy = s.adapter.deploy
  s.adapter.deploy = async (...args) => {
    const id = await deploy(...args)
    if (args[0].project === 'apex') throw new Error('sensitive adapter diagnostic')
    return id
  }
  const result = await runSchoolRelease(s.input)
  assert.equal(result.state, 'rolled-back')
  assert.equal(result.restoredGeneration, 'synthetic-old')
  assert.deepEqual(s.events.filter((e) => e.startsWith('rollback:')), ['rollback:apex', 'rollback:high-school'])
  assert.ok(!JSON.stringify(result).includes('sensitive'))
  assert.equal(s.live.get('apex'), 'old-apex')
})

for (const fault of ['missing', 'hash', 'mime', 'cors', 'cache', 'head', 'wrong-deployment']) {
  test(`${fault} observation prevents completion and restores both targets`, async () => {
    const s = setup(), read = s.adapter.read
    s.adapter.read = async (...args) => {
      const response = await read(...args)
      if (!response.deploymentId.startsWith('next-') || args[1] !== 'api/v1/schools.json') return response
      if (fault === 'missing') response.status = 404
      if (fault === 'hash') response.bytes = Buffer.from('tampered')
      if (fault === 'mime') response.headers['content-type'] = 'text/html'
      if (fault === 'cors') response.headers['access-control-allow-origin'] = 'https://other.example.invalid'
      if (fault === 'cache') response.headers['cache-control'] = 'private'
      if (fault === 'head' && args[2] === 'HEAD') response.bytes = Buffer.from('unexpected body')
      if (fault === 'wrong-deployment') response.deploymentId = 'another-deployment'
      return response
    }
    assert.equal((await runSchoolRelease(s.input)).state, 'rolled-back')
  })
}

test('skew budget overrun triggers rollback; no automatic retry of the new generation', async () => {
  const s = setup(); s.input.maxSkewMs = 2
  assert.equal((await runSchoolRelease(s.input)).state, 'rolled-back')
  assert.equal(s.events.filter((e) => e.startsWith('deploy:')).length, 1)
})

test('failed rollback is recovery-required even if another origin is healthy', async () => {
  const s = setup(), deploy = s.adapter.deploy, rollback = s.adapter.rollback
  s.adapter.deploy = async (...args) => { await deploy(...args); throw new Error('failed') }
  s.adapter.rollback = async (...args) => {
    if (args[0].project === 'high-school') throw new Error('failed rollback')
    return rollback(...args)
  }
  const result = await runSchoolRelease(s.input)
  assert.equal(result.state, 'recovery-required')
  assert.equal(result.restoredGeneration, null)
  assert.deepEqual(result.failedTargets, ['high-school'])
})

test('caller mutation during an await cannot change pinned candidate or rollback bytes', async () => {
  const s = setup(), current = s.adapter.current
  let changed = false
  s.adapter.current = async (...args) => {
    if (!changed) {
      changed = true
      for (const bytes of s.input.artifacts.values()) bytes.fill(0)
      s.input.previous.deployments.apex = 'attacker-id'
      s.input.order.reverse()
    }
    return current(...args)
  }
  assert.equal((await runSchoolRelease(s.input)).state, 'complete')
  assert.deepEqual(s.events.filter((e) => e.startsWith('deploy:')), ['deploy:high-school', 'deploy:apex'])
})

test('adapter target mutation cannot redirect later deployment or rollback calls', async () => {
  const s = setup(), current = s.adapter.current
  s.adapter.current = async (target) => {
    const result = await current(target)
    target.origin = 'https://other.example.invalid'; target.project = 'other'
    return result
  }
  assert.equal((await runSchoolRelease(s.input)).state, 'complete')
  assert.deepEqual(s.events.filter((e) => e.startsWith('deploy:')), ['deploy:high-school', 'deploy:apex'])
})

test('preflight adapter errors do not expose diagnostic data or start mutations', async () => {
  const s = setup()
  s.adapter.read = async () => { throw new Error('sensitive synthetic diagnostic') }
  await assert.rejects(runSchoolRelease(s.input), (error) => error.message === 'School release: rollback preflight failed')
  assert.equal(s.events.some((e) => /^(deploy|rollback):/.test(e)), false)
})
