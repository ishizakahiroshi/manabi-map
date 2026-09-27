import test from 'node:test'
import assert from 'node:assert/strict'
import { createSchoolPagesAdapter, schoolBindingsDigest, schoolPublicPath } from './school-release-adapter.mjs'
import { createPagesAssetUploader } from './school-pages-assets.mjs'
import { createSchoolFunctionsPackage, schoolDigest } from './school-functions-package.mjs'
import { createSchoolReleaseReceipt, runSchoolRelease } from './school-release.mjs'

const production = { compatibility_date: '2026-01-01', env_vars: {} }
function generation(name, options = {}) {
  const artifacts = new Map([
    ['schools-manifest.json', Buffer.from(JSON.stringify({ generation: name }))],
    ['api/v1/schools.json', Buffer.from(JSON.stringify({ generation: name }))],
  ])
  const files = new Map([...artifacts, ['index.html', Buffer.from(`<title>${name}</title>`)],
    ['_headers', Buffer.from('/*\n  X-Content-Type-Options: nosniff')],
    ['_routes.json', Buffer.from(JSON.stringify({ version: 1, include: ['/*'], exclude: ['/api/v1/*'] }))]])
  const observations = new Map(), redirectOrigins = []
  if (options.phases) {
    files.set('legacy.html', Buffer.from('stored artifact is not the redirect response body'))
    files.set('ended.html', Buffer.from('synthetic end of recovery'))
    const next = name === 'synthetic-new', origin = options.thirdOrigin ? 'https://outside.example.invalid' : 'https://high-school.example.invalid'
    observations.set('index.html', { path: next ? '/new-home' : '/old-home', status: next ? 410 : 200 })
    observations.set('legacy.html', { path: '/legacy', status: next ? 307 : 301,
      location: `${origin}/${next ? 'new' : 'old'}/#` })
    observations.set('ended.html', { path: '/ended', status: next ? 404 : 410 })
    redirectOrigins.push(origin)
  }
  const pkg = createSchoolFunctionsPackage({ files, observations, redirectOrigins,
    worker: Buffer.from('export default {fetch(){return new Response("synthetic")}}'),
    bindingsSha256: schoolBindingsDigest(production), sourceRevision: 'b'.repeat(40) })
  const raw = createSchoolReleaseReceipt({ generation: name, sourceSnapshotSha256: schoolDigest('source'),
    projectionGateSha256: schoolDigest('gate'), candidateRevision: 'b'.repeat(40), evidence: 'synthetic' }, artifacts)
  return { artifacts, raw, pin: { generation: name, receiptSha256: schoolDigest(raw), projectionGateSha256: schoolDigest('gate') },
    files, package: pkg, observations: pkg.snapshot(pkg.pin).observations }
}
function setup(options = {}) {
  const old = generation('synthetic-old', options), next = generation('synthetic-new', options), events = [], live = new Map([['apex', 'old-apex'], ['high-school', 'old-high-school']])
  const targets = { apex: { project: 'apex', origin: 'https://apex.example.invalid' },
    'high-school': { project: 'high-school', origin: 'https://high-school.example.invalid' } }
  const projects = new Map(Object.values(targets).map((t) => [t.project, { origin: t.origin, branch: 'release',
    next: { package: next.package, pin: next.package.pin }, previous: { deploymentId: `old-${t.project}`, package: old.package, pin: old.package.pin } }]))
  const reply = (result) => new Response(JSON.stringify({ success: true, errors: [], result }), { headers: { 'content-type': 'application/json' } })
  let checked = false, settling = false
  const fetchImpl = async (url, request) => {
    const u = new URL(url)
    if (u.hostname === 'api.cloudflare.com') {
      if (u.pathname.endsWith('/upload-token')) return reply({ jwt: 'synthetic-upload-token' })
      if (u.pathname.endsWith('/check-missing')) {
        const hashes = JSON.parse(request.body).hashes
        const result = checked ? [] : hashes
        checked = !checked
        return reply(result)
      }
      if (u.pathname.endsWith('/upsert-hashes') || u.pathname.endsWith('/assets/upload')) return reply(null)
      const match = /\/projects\/([^/]+)(.*)/.exec(u.pathname), project = match[1], suffix = match[2]
      events.push(`${request.method}:${project}:${suffix}`)
      if (options.oversizedAPI) return new Response('x'.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })
      if (!suffix && options.lateCanonical && settling) await new Promise((resolve) => setTimeout(resolve, 40))
      if (!suffix) return reply({ production_branch: 'release', source: null,
        deployment_configs: { production: options.bindingDrift ? {} : production }, canonical_deployment: { id: live.get(project) } })
      if (suffix === '/deployments') {
        assert.equal(request.body.get('branch'), 'release')
        assert.ok(request.body.get('_worker.js') instanceof Blob)
        const manifest = JSON.parse(request.body.get('manifest'))
        assert.ok(manifest['/index.html']); assert.equal(manifest['/_routes.json'], undefined)
        if (options.hang && project === 'high-school') {
          return new Promise((resolve) => setTimeout(() => { live.set(project, `new-${project}`); resolve(reply({ id: `new-${project}` })) }, 40))
        }
        live.set(project, `new-${project}`); return reply({ id: `new-${project}` })
      }
      if (suffix.endsWith('/rollback')) {
        const deploymentId = suffix.split('/')[2]; live.set(project, deploymentId); return reply({ id: deploymentId })
      }
      settling = true
      return reply({ id: suffix.split('/')[2], environment: 'production', latest_stage: {
        name: options.active ? 'build' : 'deploy', status: options.active ? 'active' : 'success', ended_on: options.active ? null : '2026-01-01T00:00:00Z' } })
    }
    const project = u.hostname.split('.')[0], deploymentId = live.get(project), source = deploymentId.startsWith('old-') ? old : next
    assert.equal(request.headers.authorization, undefined)
    assert.equal(request.redirect, 'manual')
    const path = Object.keys(source.observations).find((p) => source.observations[p].path === u.pathname), observation = source.observations[path]
    const bytes = observation.body === 'redirect' ? Buffer.from('opaque synthetic redirect response') : source.files.get(path)
    const location = options.badLocation && source === next ? 'https://outside.example.invalid/' : observation.location
    events.push(`${request.method}:public:${project}:${u.pathname}:${observation.status}`)
    return new Response(request.method === 'HEAD' ? null : bytes, { status: observation.status, headers: {
      'content-type': path.endsWith('.html') ? 'text/html' : 'application/json', 'access-control-allow-origin': '*',
      'content-length': String(bytes?.length ?? 0),
      ...(location ? { location } : {}),
      'cache-control': path === 'schools-manifest.json' ? 'no-store' : 'public,max-age=3600' } })
  }
  const adapter = createSchoolPagesAdapter({ accountId: 'a'.repeat(32), token: 'synthetic-test-token', projects,
    fetchImpl, requestTimeoutMs: options.hang ? 5 : 200,
    settlementTimeoutMs: options.active || options.lateCanonical ? 15 : 500, pollIntervalMs: 1,
    operationTimeoutMs: options.operationTimeout ? 40 : 300000,
    uploadAssets: options.realUploader ? createPagesAssetUploader({ apiToken: 'synthetic-test-token', fetchImpl }) : async ({ files }) => {
      assert.equal(files.has('_routes.json'), false)
      if (options.uploadConflict) live.set('high-school', 'other-session')
      if (options.operationTimeout) await new Promise((resolve) => setTimeout(resolve, 90))
      return Object.fromEntries([...files].map(([path, bytes]) => [`/${path}`, schoolDigest(bytes)]))
    } })
  return { adapter, events, live, targets, input: { ...next, previous: { ...old, deployments: { apex: 'old-apex', 'high-school': 'old-high-school' } },
    targets, order: ['high-school', 'apex'], adapter, maxSkewMs: 10000, clock: () => performance.now() } }
}

test('real REST request contract submits full distribution and settles both targets through core runner', async () => {
  const s = setup(), result = await runSchoolRelease(s.input)
  assert.equal(result.state, 'complete')
  assert.equal(s.events.filter((e) => e.endsWith(':/deployments') && e.startsWith('POST')).length, 2)
  assert.deepEqual(s.adapter.recoveryState(), { uncertainProjects: [], runningProjects: [] })
})

test('POST response timeout refuses rollback even when delayed request later makes generation live', async () => {
  const s = setup({ hang: true }), result = await runSchoolRelease(s.input)
  assert.equal(result.state, 'recovery-required')
  assert.ok(result.failedTargets.includes('high-school'))
  await new Promise((resolve) => setTimeout(resolve, 60))
  await assert.rejects(s.adapter.rollback(s.targets['high-school'], 'old-high-school'), /refused/)
  assert.equal(s.events.some((e) => e.endsWith('/rollback')), false)
  assert.equal(s.live.get('high-school'), 'new-high-school')
  assert.deepEqual(s.adapter.recoveryState().uncertainProjects, ['high-school'])
})

test('accepted active deployment cannot be treated as settled or raced by rollback', async () => {
  const s = setup({ active: true }), result = await runSchoolRelease(s.input)
  assert.equal(result.state, 'recovery-required')
  assert.equal(s.events.some((e) => e.endsWith('/rollback')), false)
})

test('binding drift stops before any deployment POST and errors do not contain token', async () => {
  const s = setup({ bindingDrift: true }), result = await runSchoolRelease(s.input)
  assert.equal(result.state, 'recovery-required')
  assert.equal(s.events.some((e) => e.startsWith('POST:')), false)
  assert.equal(JSON.stringify(result).includes('synthetic-test-token'), false)
})

test('full Direct Upload adapter integrates with release REST adapter using only mock HTTP', async () => {
  const s = setup({ realUploader: true })
  assert.equal((await runSchoolRelease(s.input)).state, 'complete')
})

test('external canonical change during asset upload is never overwritten or rolled back', async () => {
  const s = setup({ uploadConflict: true }), result = await runSchoolRelease(s.input)
  assert.equal(result.state, 'recovery-required')
  assert.equal(s.live.get('high-school'), 'other-session')
  assert.equal(s.events.some((e) => e.startsWith('POST:')), false)
})

test('Pages public HTML URLs use canonical extensionless and directory paths', () => {
  assert.equal(schoolPublicPath('index.html'), '/')
  assert.equal(schoolPublicPath('about/index.html'), '/about/')
  assert.equal(schoolPublicPath('maintenance.html'), '/maintenance')
  assert.equal(schoolPublicPath('pref/example/合成市/index.html'), '/pref/example/%E5%90%88%E6%88%90%E5%B8%82/')
})

test('a foreign deployment appearing after our settled deployment is never rolled back', async () => {
  const s = setup(), target = s.targets['high-school']
  await s.adapter.deploy(target, s.input.artifacts, JSON.parse(s.input.raw))
  s.live.set('high-school', 'other-session')
  await assert.rejects(s.adapter.rollback(target, 'old-high-school'), /mutation failed/)
  assert.equal(s.events.some((e) => e.endsWith('/rollback')), false)
  assert.equal(s.live.get('high-school'), 'other-session')
})

test('oversized control-plane response is rejected before any write with sanitized error', async () => {
  const s = setup({ oversizedAPI: true })
  await assert.rejects(runSchoolRelease(s.input), /^Error: School release: rollback preflight failed$/)
  assert.equal(s.events.some((e) => e.startsWith('POST:')), false)
})

test('late canonical confirmation cannot turn expired settlement into success', async () => {
  const s = setup({ lateCanonical: true }), result = await runSchoolRelease(s.input)
  assert.equal(result.state, 'recovery-required')
  assert.ok(s.adapter.recoveryState().uncertainProjects.includes('high-school'))
  assert.equal(s.events.some((e) => e.endsWith('/rollback')), false)
})

test('pinned old/new HTTP contracts accept redirects, 404 and 410 without following Location', async () => {
  const s = setup({ phases: true }), result = await runSchoolRelease(s.input)
  assert.equal(result.state, 'complete')
  assert.ok(s.events.includes('GET:public:high-school:/old-home:200'))
  assert.ok(s.events.includes('GET:public:high-school:/new-home:410'))
  assert.ok(s.events.includes('GET:public:high-school:/legacy:301'))
  assert.ok(s.events.includes('GET:public:high-school:/legacy:307'))
  assert.ok(s.events.includes('GET:public:high-school:/ended:404'))
})

test('unexpected redirect Location fails and rollback verifies previous mapping and status', async () => {
  const s = setup({ phases: true, badLocation: true }), result = await runSchoolRelease(s.input)
  assert.equal(result.state, 'rolled-back')
  assert.equal(s.live.get('high-school'), 'old-high-school')
  const rollbackIndex = s.events.findIndex((event) => event.endsWith('/rollback'))
  assert.ok(rollbackIndex > 0)
  assert.ok(s.events.slice(rollbackIndex).includes('GET:public:high-school:/old-home:200'))
  assert.ok(s.events.slice(rollbackIndex).includes('GET:public:high-school:/legacy:301'))
})

test('pinning a third redirect origin cannot expand adapter destination authority', () => {
  assert.throws(() => setup({ phases: true, thirdOrigin: true }), /operation refused/)
})

test('operation deadline stops after delayed upload and never issues a deployment POST', async () => {
  const s = setup({ operationTimeout: true }), result = await runSchoolRelease(s.input)
  assert.equal(result.state, 'recovery-required')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.ok(s.adapter.recoveryState().uncertainProjects.includes('high-school'))
  assert.equal(s.events.some((event) => event.startsWith('POST:')), false)
})
