import assert from 'node:assert/strict'
import test from 'node:test'

import { hasSharedLocationQuery, isSpaRoute, onRequest } from './_middleware.ts'

function makeContext(
  pathname: string,
  maintenance = '1',
  options: { method?: string; nextStatus?: number; shellStatus?: number } = {},
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
