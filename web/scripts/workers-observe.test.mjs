import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { buildWorkersPackage } from './workers-package.mjs'
import { expectedHeaders, observeWorkersPackage, parseHeadersFile, planObservation, publicUrl, workerFirst } from './workers-observe.mjs'
import { fakeHighSchoolCandidate, fakeRepo, HEADERS, tempRoot } from './workers-fixture.test-helper.mjs'

test('URL mapping and _headers matching follow the Pages observer', () => {
  assert.equal(publicUrl('index.html'), '/')
  assert.equal(publicUrl('school/a b/index.html'), '/school/a%20b/')
  assert.equal(publicUrl('guide.html'), '/guide')
  assert.equal(publicUrl('assets/x.js'), '/assets/x.js')
  const blocks = parseHeadersFile(HEADERS)
  assert.deepEqual(expectedHeaders(blocks, '/assets/x.js'), {
    'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'cache-control': 'public, max-age=31536000, immutable' })
  assert.deepEqual(expectedHeaders(parseHeadersFile('/*\n  X-A: 1\n/a/*\n  X-A: 2\n'), '/a/b'), { 'x-a': '1, 2' })
  assert.throws(() => parseHeadersFile('/*\n  ! X-A\n'))
  assert.equal(workerFirst(['/*', '!/assets/*'], '/school/a/'), true)
  assert.equal(workerFirst(['/*', '!/assets/*'], '/assets/x.js'), false)
  assert.equal(workerFirst(null, '/'), false)
})

async function packageFixture(t) {
  const root = await tempRoot(t)
  const repo = await fakeRepo(root)
  const candidate = await fakeHighSchoolCandidate(root)
  const output = join(root, 'package')
  const built = await buildWorkersPackage({ target: 'high-school', candidateRoot: candidate, outputRoot: output, repoRoot: repo })
  return { root, output, receiptSha256: built.receiptSha256 }
}

// A minimal stand-in for Workers static assets + the Pages middleware behaviour the contract expects.
function server({ dropHeaderOn = null, alterBodyOn = null } = {}, packageRoot) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const blocks = parseHeadersFile(await fs.readFile(join(packageRoot, 'assets/_headers'), 'utf8'))
    let file = null, status = 200, pathname = url.pathname
    if (['/auth/callback', '/map'].includes(pathname)) file = 'index.html'
    else if (pathname === '/') file = 'index.html'
    else if (pathname.endsWith('/')) file = `${decodeURIComponent(pathname.slice(1))}index.html`
    else file = decodeURIComponent(pathname.slice(1))
    let body
    try { body = await fs.readFile(join(packageRoot, 'assets', file)) } catch {
      try { body = await fs.readFile(join(packageRoot, 'assets', `${file}.html`)) } catch {
        status = 404; body = await fs.readFile(join(packageRoot, 'assets/404.html'))
      }
    }
    const headers = status === 404 ? {} : expectedHeaders(blocks, file === 'index.html' ? '/' : pathname)
    if (file === 'index.html' && pathname !== '/') headers['content-type'] = 'text/html; charset=utf-8'
    if (url.searchParams.has('lat') && url.searchParams.has('lng')) headers['x-robots-tag'] = 'noindex'
    if (dropHeaderOn === pathname) delete headers['x-frame-options']
    if (alterBodyOn === pathname) body = Buffer.from('changed')
    response.writeHead(status, headers)
    response.end(body)
  })
}

async function listen(t, instance) {
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => instance.close(resolve)))
  return `http://127.0.0.1:${instance.address().port}`
}

test('observation passes when every file, the 404 page and the shell routes match', async (t) => {
  const { root, output, receiptSha256 } = await packageFixture(t)
  const base = await listen(t, server({}, output))
  const outputPath = join(root, 'observation.json')
  const result = await observeWorkersPackage({ packageRoot: output, expectedReceiptSha256: receiptSha256, baseUrl: base, outputPath, versionId: 'v1', concurrency: 4 })
  assert.equal(result.status, 'passed')
  assert.equal(result.failed, 0)
  assert.deepEqual(result.byKind, { asset: 5, 'not-found': 1, shell: 1, 'shell-noindex': 1 })
  const saved = JSON.parse(await fs.readFile(outputPath, 'utf8'))
  assert.equal(saved.versionId, 'v1')
  assert.equal(saved.workerFirstRequests, 6)
})

test('observation records each failing path and reason instead of stopping', async (t) => {
  const { root, output, receiptSha256 } = await packageFixture(t)
  const base = await listen(t, server({ dropHeaderOn: '/school/example-1/', alterBodyOn: '/guide' }, output))
  const result = await observeWorkersPackage({ packageRoot: output, expectedReceiptSha256: receiptSha256, baseUrl: base,
    outputPath: join(root, 'observation.json'), concurrency: 2 })
  assert.equal(result.status, 'failed')
  assert.equal(result.failed, 2)
  assert.deepEqual(result.failuresByReason, { header: 1, body: 1 })
  const saved = JSON.parse(await fs.readFile(join(root, 'observation.json'), 'utf8'))
  assert.deepEqual(saved.failures.map((item) => item.path), ['/guide', '/school/example-1/'])
  assert.equal(saved.failures[1].problems[0].header, 'x-frame-options')
})

test('observation refuses non-https remote origins and an existing output', async (t) => {
  const { root, output, receiptSha256 } = await packageFixture(t)
  await assert.rejects(observeWorkersPackage({ packageRoot: output, expectedReceiptSha256: receiptSha256,
    baseUrl: 'http://example.test', outputPath: join(root, 'o.json') }), /https origin/)
  await fs.writeFile(join(root, 'exists.json'), '{}')
  await assert.rejects(observeWorkersPackage({ packageRoot: output, expectedReceiptSha256: receiptSha256,
    baseUrl: 'https://example.test', outputPath: join(root, 'exists.json') }), /already exists/)
})

test('plan includes _redirects rules as redirect probes', async (t) => {
  const { output, receiptSha256 } = await packageFixture(t)
  const receipt = JSON.parse(await fs.readFile(join(output, 'workers-package.json'), 'utf8'))
  assert.ok(receiptSha256)
  const plan = planObservation({ receipt, headersText: HEADERS, redirectsText: '/old /new 301\n',
    contract: { shellPath: null, shellRoutes: [], noindexRoutes: [] } })
  assert.deepEqual(plan.find((item) => item.kind === 'redirect'), { kind: 'redirect', path: '/old', status: 301, location: '/new', headers: {} })
  assert.throws(() => planObservation({ receipt, headersText: null, redirectsText: '/a/* /b 301\n',
    contract: { shellPath: null, shellRoutes: [], noindexRoutes: [] } }), /unsupported _redirects/)
})
