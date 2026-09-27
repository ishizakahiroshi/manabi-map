import test from 'node:test'
import assert from 'node:assert/strict'
import { createPagesAssetUploader, pagesAssetHash } from './school-pages-assets.mjs'

const accountId = 'a'.repeat(32), project = 'synthetic-school'
const files = () => new Map([['index.html', Buffer.from('<p>synthetic</p>')], ['data/a.json', Buffer.from('{}')]])
const json = (result) => new Response(JSON.stringify({ success: true, errors: [], result }), { headers: { 'content-type': 'application/json' } })
function mock({ cached = false, intercept } = {}) {
  const calls = [], present = new Set()
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options })
    const replacement = intercept?.(url, options, calls.length)
    if (replacement !== undefined) return replacement
    if (url.endsWith('/upload-token')) return json({ jwt: 'synthetic-jwt' })
    const body = JSON.parse(options.body)
    if (url.endsWith('/check-missing')) return json(cached ? [] : body.hashes.filter((hash) => !present.has(hash)))
    if (url.endsWith('/upload')) { for (const item of body) present.add(item.key); return json(null) }
    if (url.endsWith('/upsert-hashes')) return json(null)
    throw new Error('unexpected endpoint')
  }
  return { calls, fetchImpl }
}
const run = (fetchImpl, options = {}) => createPagesAssetUploader({ apiToken: 'synthetic-api-token', fetchImpl, ...options })

test('Pages hash matches the published BLAKE3 empty vector and includes extension', () => {
  // https://github.com/BLAKE3-team/BLAKE3/blob/master/test_vectors/test_vectors.json
  assert.equal(pagesAssetHash('empty', Buffer.alloc(0)), 'af1349b9f5f9a1a6a0404dea36dcc949')
  assert.notEqual(pagesAssetHash('a.json', Buffer.from('{}')), pagesAssetHash('a.txt', Buffer.from('{}')))
})
test('uploads exact immutable bytes with scoped credentials, then verifies presence', async () => {
  const { calls, fetchImpl } = mock(), input = files()
  const task = run(fetchImpl)({ accountId, project, files: input })
  input.get('index.html').fill(0); input.clear()
  const manifest = await task
  assert.deepEqual(Object.keys(manifest), ['/index.html', '/data/a.json'])
  assert.equal(calls.length, 5)
  assert.equal(calls[0].headers.Authorization, 'Bearer synthetic-api-token')
  for (const call of calls.slice(1)) assert.equal(call.headers.Authorization, 'Bearer synthetic-jwt')
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, 'https://api.cloudflare.com')
    assert.equal(call.redirect, 'error')
    assert.equal(call.signal.aborted, true)
  }
  const upload = JSON.parse(calls[2].body)
  assert.equal(Buffer.from(upload[0].value, 'base64').toString(), '<p>synthetic</p>')
  assert.equal(upload[0].metadata.contentType, 'text/html; charset=utf-8')
  assert.equal(upload[0].base64, true)
  assert.equal(upload[0].key, manifest['/index.html'])
  assert.ok(!calls.some((call) => call.url.includes('/deployments')))
})
test('existing content is never reuploaded and identical files share a key', async () => {
  const { calls, fetchImpl } = mock({ cached: true })
  const manifest = await run(fetchImpl)({ accountId, project, files: new Map([['a.txt', Buffer.from('same')], ['b.txt', Buffer.from('same')]]) })
  assert.equal(manifest['/a.txt'], manifest['/b.txt'])
  assert.equal(JSON.parse(calls[1].body).hashes.length, 1)
  assert.equal(calls.length, 4)
})
test('generated municipality Unicode paths retain their exact manifest key', async () => {
  const { fetchImpl } = mock()
  const manifest = await run(fetchImpl)({ accountId, project, files: new Map([['学校/合成市/index.html', Buffer.from('<p>合成</p>')]]) })
  assert.equal(Object.keys(manifest)[0], '/学校/合成市/index.html')
})
test('unsafe paths, binding files, oversize content and targets reject before network', async () => {
  const { calls, fetchImpl } = mock()
  for (const path of ['../a', '/a', 'a\\b', '.env', 'a/.env', '_worker.js', '_headers', '_redirects', '_routes.json']) {
    await assert.rejects(run(fetchImpl)({ accountId, project, files: new Map([[path, Buffer.from('x')]]) }))
  }
  await assert.rejects(run(fetchImpl, { maxTotalBytes: 1 })({ accountId, project, files: files() }))
  await assert.rejects(run(fetchImpl)({ accountId: '../secret', project, files: files() }))
  assert.equal(calls.length, 0)
})
test('unknown and repeated missing hashes fail before any upload', async () => {
  for (const result of [['unknown'], ['same', 'same']]) {
    const { calls, fetchImpl } = mock({ intercept: (url) => url.endsWith('/check-missing') ? json(result) : undefined })
    await assert.rejects(run(fetchImpl)({ accountId, project, files: files() }), /deployment was not requested/)
    assert.equal(calls.length, 2)
  }
})
test('API failures discard secret diagnostics and never progress to upsert', async () => {
  const { calls, fetchImpl } = mock({ intercept: (url) => url.endsWith('/upload') ? Promise.reject(new Error('private-token-value')) : undefined })
  await assert.rejects(run(fetchImpl)({ accountId, project, files: files() }), (error) => {
    assert.equal(error.message, 'Pages asset upload failed; deployment was not requested')
    assert.equal(error.cause, undefined)
    return true
  })
  assert.equal(calls.length, 3)
})
test('post-upload presence failure cannot return a manifest', async () => {
  const { fetchImpl } = mock({ intercept: (url, options, count) => count === 5 ? json(['missing']) : undefined })
  await assert.rejects(run(fetchImpl)({ accountId, project, files: files() }))
})
test('header and body stalls terminate within the deadline even when fetch ignores abort', async () => {
  for (const fetchImpl of [() => new Promise(() => {}), async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } })]) {
    const start = Date.now()
    await assert.rejects(run(fetchImpl, { timeoutMs: 30 })({ accountId, project, files: files() }))
    assert.ok(Date.now() - start < 1000)
  }
})
test('pre-aborted caller makes no request', async () => {
  const { calls, fetchImpl } = mock()
  await assert.rejects(run(fetchImpl)({ accountId, project, files: files(), signal: AbortSignal.abort() }))
  assert.equal(calls.length, 0)
})
test('oversize streaming response is cancelled without trusting Content-Length', async () => {
  let cancelled = false
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(256)) },
    cancel() { cancelled = true },
  }), { headers: { 'content-type': 'application/json' } })
  await assert.rejects(run(fetchImpl, { maxResponseBytes: 128 })({ accountId, project, files: files() }))
  assert.equal(cancelled, true)
})
