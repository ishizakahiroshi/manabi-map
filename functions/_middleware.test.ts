import assert from 'node:assert/strict'
import test from 'node:test'

import { hasSharedLocationQuery, isSpaRoute, onRequest } from './_middleware.ts'
import { COMPATIBILITY_ENDPOINTS, MIGRATION_INVENTORY, validateMigrationInventory, type MigrationPhase } from './_school-migration.ts'

function makeContext(
  pathname: string,
  maintenance = '1',
  options: { method?: string; nextStatus?: number; shellStatus?: number; legacy?: boolean } = {},
) {
  const nextResponse = new Response('synthetic-next', { status: options.nextStatus ?? 200 })
  const assetPaths: string[] = []
  return {
    nextResponse,
    assetPaths,
    get assetPath() {
      return assetPaths.at(-1)
    },
    context: {
      request: new Request(`https://synthetic.example.test${pathname}`, {
        method: options.method ?? 'GET',
      }),
      env: {
        MAINTENANCE_MODE: maintenance,
        LEGACY_SCHOOL_SHELL: options.legacy ? '1' : undefined,
        ASSETS: {
          fetch: async (input: Request | string | URL) => {
            const assetPath = new URL(input.toString()).pathname
            assetPaths.push(assetPath)
            if (assetPath === '/maintenance.html') {
              return new Response('synthetic maintenance page')
            }
            return new Response('synthetic spa shell', {
              status: options.shellStatus ?? 200,
              headers: {
                'content-type': 'text/html; charset=utf-8',
                'x-synthetic-headers-rule': 'kept',
              },
            })
          },
        },
      },
      next: async () => nextResponse,
    },
  }
}

/** functions/_middleware.ts の SPA_ROUTES と対応（web/src/App.tsx の <Route> が正）*/
const SPA_ROUTE_PATHS = [
  '/map',
  '/search',
  '/favorites',
  '/compare',
  '/mypage',
  '/dashboard',
  '/auth/callback',
  '/family/join',
]

/** build 時に静的 HTML（SSR プリレンダー）を出しているので middleware で横取りしない */
const PRERENDERED_PATHS = [
  '/',
  '/school/12345/',
  '/schools/',
  '/pref/fukuoka/',
  '/pref/fukuoka/fukuoka-shi/',
  '/legal/terms/',
  '/about/',
  '/press/',
  '/data/',
  '/guide/synthetic-guide/',
]

test('maintenance mode lets legal SPA routes through', async () => {
  const fixture = makeContext('/legal/terms/')
  const result = await onRequest(fixture.context)
  assert.strictEqual(result, fixture.nextResponse)
  assert.equal(fixture.assetPath, undefined)
})

test('maintenance mode lets robots and static exceptions through', async () => {
  for (const pathname of [
    '/robots.txt',
    '/assets/app.js',
    '/favicon.ico',
    '/icon.svg',
    '/manifest.webmanifest',
  ]) {
    const fixture = makeContext(pathname)
    const result = await onRequest(fixture.context)
    assert.strictEqual(result, fixture.nextResponse, pathname)
    assert.equal(fixture.assetPath, undefined, pathname)
  }
})

test('maintenance mode does not replace API responses with HTML', async () => {
  const fixture = makeContext('/api/admin/me')
  const result = await onRequest(fixture.context)
  assert.strictEqual(result, fixture.nextResponse)
  assert.equal(fixture.assetPath, undefined)
})

test('maintenance mode serves maintenance HTML for app routes', async () => {
  const fixture = makeContext('/map')
  const result = await onRequest(fixture.context)
  assert.equal(result.status, 503)
  assert.equal(result.headers.get('retry-after'), '300')
  assert.equal(result.headers.get('cache-control'), 'no-store')
  assert.equal(result.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(await result.text(), 'synthetic maintenance page')
  assert.equal(fixture.assetPath, '/maintenance.html')
})

test('maintenance mode wins over the SPA fallback on every SPA route', async () => {
  for (const pathname of SPA_ROUTE_PATHS) {
    const fixture = makeContext(pathname)
    const result = await onRequest(fixture.context)
    assert.equal(result.status, 503, pathname)
    assert.equal(await result.text(), 'synthetic maintenance page', pathname)
    assert.equal(fixture.assetPath, '/maintenance.html', pathname)
  }
})

test('disabled maintenance mode always calls the normal handler', async () => {
  const fixture = makeContext('/school/12345/', '0')
  const result = await onRequest(fixture.context)
  assert.strictEqual(result, fixture.nextResponse)
  assert.equal(fixture.assetPath, undefined)
})

test('SPA routes are served as 200 with the index.html body', async () => {
  for (const pathname of SPA_ROUTE_PATHS) {
    const fixture = makeContext(pathname, '0')
    const result = await onRequest(fixture.context)
    assert.equal(result.status, 200, pathname)
    assert.equal(result.headers.get('content-type'), 'text/html; charset=utf-8', pathname)
    assert.equal(await result.text(), 'synthetic spa shell', pathname)
    // /index.html を直接取ると Pages のアセット正規化で 308 になるので `/` を取る
    assert.equal(fixture.assetPath, '/', pathname)
  }
})

test('SPA routes keep the headers of the served asset (_headers rules)', async () => {
  const fixture = makeContext('/map', '0')
  const result = await onRequest(fixture.context)
  assert.equal(result.headers.get('x-synthetic-headers-rule'), 'kept')
})

test('SPA routes ignore query strings and trailing slashes', async () => {
  for (const pathname of ['/map/', '/map?school=1', '/auth/callback?code=synthetic']) {
    const fixture = makeContext(pathname, '0')
    const result = await onRequest(fixture.context)
    assert.equal(result.status, 200, pathname)
    assert.equal(await result.text(), 'synthetic spa shell', pathname)
  }
})

test('位置つき共有 URL には noindex が付く（plan_map-location-share-url.md C1）', async () => {
  const shared = makeContext('/map?lat=35.681&lng=139.767&z=14', '0')
  const sharedResult = await onRequest(shared.context)
  assert.equal(sharedResult.status, 200)
  assert.equal(sharedResult.headers.get('x-robots-tag'), 'noindex')

  // 座標を持たない /map は今まで通りインデックス可のまま（検索からの入口を塞がない）
  for (const pathname of ['/map', '/map?school=1', '/map?z=14']) {
    const fixture = makeContext(pathname, '0')
    const result = await onRequest(fixture.context)
    assert.equal(result.status, 200, pathname)
    assert.equal(result.headers.get('x-robots-tag'), null, pathname)
  }
})

test('hasSharedLocationQuery は lat と lng の両方を要求する', () => {
  const has = (query: string) => hasSharedLocationQuery(new URLSearchParams(query))
  assert.equal(has('lat=35.681&lng=139.767&z=14'), true)
  assert.equal(has('lng=139.767&lat=35.681'), true)
  assert.equal(has('lat=35.681'), false)
  assert.equal(has('lng=139.767'), false)
  assert.equal(has('z=14&school=1'), false)
  assert.equal(has(''), false)
})

test('unknown URLs stay 404 instead of getting the SPA shell', async () => {
  for (const pathname of [
    '/nonexistent-xyz',
    '/map/extra',
    '/auth/nonexistent',
    '/family/nonexistent',
    '/mypage-typo',
  ]) {
    const fixture = makeContext(pathname, '0', { nextStatus: 404 })
    const result = await onRequest(fixture.context)
    assert.strictEqual(result, fixture.nextResponse, pathname)
    assert.equal(result.status, 404, pathname)
    assert.equal(fixture.assetPath, undefined, pathname)
  }
})

test('prerendered static routes are not intercepted by the SPA fallback', async () => {
  for (const pathname of [...PRERENDERED_PATHS, '/api/v1/dataset.json', '/assets/index-abc.js']) {
    const fixture = makeContext(pathname, '0')
    const result = await onRequest(fixture.context)
    assert.strictEqual(result, fixture.nextResponse, pathname)
    assert.equal(fixture.assetPath, undefined, pathname)
  }
})

test('non-read methods on SPA routes are passed through', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const fixture = makeContext('/map', '0', { method })
    const result = await onRequest(fixture.context)
    assert.strictEqual(result, fixture.nextResponse, method)
    assert.equal(fixture.assetPath, undefined, method)
  }
})

test('a failing shell fetch falls back to the normal handler', async () => {
  const fixture = makeContext('/map', '0', { nextStatus: 404, shellStatus: 500 })
  const result = await onRequest(fixture.context)
  assert.strictEqual(result, fixture.nextResponse)
  assert.equal(result.status, 404)
  assert.equal(fixture.assetPath, '/')
})

test('isSpaRoute matches the App.tsx routes and nothing else', () => {
  for (const pathname of SPA_ROUTE_PATHS) {
    assert.equal(isSpaRoute(pathname), true, pathname)
    assert.equal(isSpaRoute(`${pathname}/`), true, `${pathname}/`)
  }
  for (const pathname of [...PRERENDERED_PATHS, '/nonexistent-xyz', '/auth', '/family']) {
    assert.equal(isSpaRoute(pathname), false, pathname)
  }
})

test('legacy apex serves a dedicated shell and keeps the independent root untouched', async () => {
  for (const pathname of ['/auth/callback?code=synthetic', '/family/join?token=synthetic', '/family/join', '/mypage', '/favorites']) {
    const fixture = makeContext(pathname, '0', { legacy: true })
    const result = await onRequest(fixture.context)
    assert.equal(fixture.assetPath, '/legacy-school/')
    assert.equal(result.status, 200)
    assert.equal(result.headers.get('location'), null)
    assert.equal(result.headers.get('cache-control'), 'no-store')
    assert.equal(result.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(result.headers.get('x-robots-tag'), 'noindex')
  }
  for (const pathname of ['/', '/api/v1/schools.json', '/assets/previous-chunk.js', '/unknown']) {
    const fixture = makeContext(pathname, '0', { legacy: true, nextStatus: pathname === '/unknown' ? 404 : 200 })
    assert.strictEqual(await onRequest(fixture.context), fixture.nextResponse)
  }
})

test('legacy HEAD is bodyless, POST passes through and unavailable shell never becomes portal success', async () => {
  const head = makeContext('/auth/callback', '0', { legacy: true, method: 'HEAD' })
  assert.equal(await (await onRequest(head.context)).text(), '')
  const post = makeContext('/auth/callback', '0', { legacy: true, method: 'POST', nextStatus: 405 })
  assert.equal((await onRequest(post.context)).status, 405)
  const unavailable = makeContext('/auth/callback', '0', { legacy: true, shellStatus: 404, nextStatus: 404 })
  assert.equal((await onRequest(unavailable.context)).status, 404)
})

function migrationContext(path: string, options: { phase?: MigrationPhase; method?: string; maintenance?: boolean; inventory?: unknown; inventoryStatus?: number; shellStatus?: number; next?: () => Promise<Response> } = {}) {
  const phase = options.phase ?? 'candidate-rescue'
  const inventory = options.inventory ?? { format: 'synthetic-school-routes', phase,
    routes: ['/school/synthetic-id', '/pref/synthetic', '/pref/synthetic/%E5%90%88%E6%88%90', '/legal/terms'], assets: ['/legal/terms.md', '/portal.css'] }
  const paths: string[] = []
  let calls = 0
  return { paths, get calls() { return calls }, context: {
    request: new Request(`https://synthetic.example.test${path}`, { method: options.method ?? 'GET' }),
    env: { SCHOOL_MIGRATION_PHASE: phase, MAINTENANCE_MODE: options.maintenance ? '1' : '0', ASSETS: {
      fetch: async (input: Request | URL | string) => {
        const assetPath = new URL(input.toString()).pathname
        paths.push(assetPath)
        if (assetPath === MIGRATION_INVENTORY) return new Response(JSON.stringify(inventory), { status: options.inventoryStatus ?? 200 })
        if (assetPath === '/legacy-school/') return new Response('synthetic legacy shell', { status: options.shellStatus ?? 200, headers: { 'content-security-policy': "default-src 'self'" } })
        return new Response('fixed restart page without request values')
      },
    } },
    next: async () => { calls++; return options.next ? options.next() : new Response('existing endpoint', { status: 200 }) },
  } }
}

test('candidate moves only inventoried HTML and safe public query fields', async () => {
  for (const [path, target] of [
    ['/school/synthetic-id/?code=secret', '/school/synthetic-id'],
    ['/pref/synthetic/合成/', '/pref/synthetic/%E5%90%88%E6%88%90'],
    ['/map?lat=1&lng=2&z=3&school=synthetic&token=secret', '/map?lat=1&lng=2&z=3&school=synthetic'],
    ['/search?q=synthetic&code=secret&redirect=https://untrusted.invalid', '/search?q=synthetic'],
    ['/search?q=one&q=two', '/search'],
  ]) {
    const fixture = migrationContext(path)
    const response = await onRequest(fixture.context)
    assert.equal(response.status, 301, path)
    assert.equal(response.headers.get('location'), `https://high-school.manabi-map.app${target}#`, path)
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(fixture.calls, 0)
  }
  for (const path of ['/school/unknown', '/pref/unknown', '/legal/missing', '/school/synthetic-id/extra', '/school/a%2fb', '/school/%252e%252e', '/map//', '/unknown', '/api/admin/unknown']) {
    const fixture = migrationContext(path)
    assert.equal((await onRequest(fixture.context)).status, 404, path)
    assert.equal(fixture.calls, 0)
  }
})

test('candidate preserves old-origin rescue and expires it without forwarding secrets', async () => {
  for (const path of ['/auth/callback?code=secret', '/family/join?token=secret', '/mypage', '/favorites', '/compare', '/dashboard']) {
    const fixture = migrationContext(path)
    const response = await onRequest(fixture.context)
    assert.equal(response.status, 200, path)
    assert.equal(await response.text(), 'synthetic legacy shell')
    assert.equal(response.headers.get('location'), null)
    assert.equal(response.headers.get('content-security-policy'), "default-src 'self'")
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
  for (const path of ['/auth/callback?code=secret', '/family/join?token=secret', '/legacy-school/', '/school-recovery-ended.html']) {
    const response = await onRequest(migrationContext(path, { phase: 'candidate-retired' }).context)
    assert.equal(response.status, 410)
    assert.equal(response.headers.get('location'), null)
    assert.ok(!(await response.text()).includes('secret'))
  }
  assert.equal((await onRequest(migrationContext('/mypage', { phase: 'candidate-retired' }).context)).status, 301)
})

test('candidate compatibility allowlist retains existing auth and accepted write methods', async () => {
  for (const path of COMPATIBILITY_ENDPOINTS) {
    const method = path === '/api/csp-report' ? 'POST' : 'GET'
    const fixture = migrationContext(path, { method, next: async () => new Response('existing denied', { status: 404 }) })
    const denied = await onRequest(fixture.context)
    assert.equal(denied.status, 404, path)
    assert.equal(fixture.calls, 1, path)
    assert.equal(await denied.text(), 'existing denied')
    const ended = await onRequest(migrationContext(path, { method, phase: 'candidate-retired' }).context)
    assert.equal(ended.status, 410)
    assert.equal(ended.headers.get('content-type'), 'application/json')
    assert.deepEqual(await ended.json(), { error: 'legacy endpoint retired' })
  }
  const write = migrationContext('/api/admin/maintenance', { method: 'POST', maintenance: true })
  assert.equal((await onRequest(write.context)).status, 200)
  assert.equal(write.calls, 1)
  for (const path of ['/map', '/auth/callback', '/school/synthetic-id', '/api/admin/me']) {
    const fixture = migrationContext(path, { method: 'POST' })
    assert.equal((await onRequest(fixture.context)).status, 405, path)
    assert.equal(fixture.calls, 0)
  }
  for (const path of ['/api/admin/me/', '/api/admin/%6de']) assert.equal((await onRequest(migrationContext(path).context)).status, 404)
})

test('candidate maintenance explicitly pauses rescue, while retained data and APIs keep their contracts', async () => {
  const paused = await onRequest(migrationContext('/auth/callback?code=secret', { maintenance: true }).context)
  assert.equal(paused.status, 503)
  assert.equal(paused.headers.get('retry-after'), '300')
  assert.ok(!(await paused.text()).includes('secret'))
  for (const path of ['/', '/legal/terms.md', '/api/v1/schools.json']) {
    const fixture = migrationContext(path, { maintenance: true })
    assert.equal((await onRequest(fixture.context)).status, 200)
    assert.equal(fixture.calls, 1)
  }
  for (const options of [{ inventoryStatus: 404 }, { inventory: {} }, { shellStatus: 404 }]) {
    assert.equal((await onRequest(migrationContext('/auth/callback', options).context)).status, 503)
  }
  for (const options of [{}, { maintenance: true }, { phase: 'candidate-retired' as const }]) {
    assert.equal(await (await onRequest(migrationContext('/auth/callback', { ...options, method: 'HEAD' }).context)).text(), '')
  }
})

test('candidate inventory fails closed for mixed phase, broad routes, duplicates and unsafe paths', () => {
  const good = { format: 'synthetic-school-routes', phase: 'candidate-rescue', routes: ['/school/synthetic'], assets: ['/portal.css'] }
  for (const mutation of [
    { phase: 'candidate-retired' }, { routes: ['/auth/callback'] }, { routes: ['/school/synthetic', '/school/synthetic'] },
    { assets: ['/index.html'] }, { assets: ['/_headers'] }, { assets: ['/api/admin/me'] },
    { routes: ['/school/%2e%2e'] }, { routes: ['/school/synthetic?token=value'] }, { extra: true },
  ]) assert.throws(() => validateMigrationInventory({ ...good, ...mutation }, 'candidate-rescue'))
})
