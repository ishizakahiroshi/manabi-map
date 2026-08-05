import assert from 'node:assert/strict'
import test from 'node:test'

import { onRequest } from './_middleware.ts'

function makeContext(pathname: string, maintenance = '1') {
  const nextResponse = new Response('synthetic-next', { status: 200 })
  let assetPath: string | undefined
  return {
    nextResponse,
    get assetPath() { return assetPath },
    context: {
      request: new Request(`https://synthetic.example.test${pathname}`),
      env: {
        MAINTENANCE_MODE: maintenance,
        ASSETS: {
          fetch: async (input: Request | string | URL) => {
            assetPath = new URL(input.toString()).pathname
            return new Response('synthetic maintenance page')
          },
        },
      },
      next: async () => nextResponse,
    },
  }
}

test('maintenance mode lets legal SPA routes through', async () => {
  const fixture = makeContext('/legal/terms/')
  const result = await onRequest(fixture.context)
  assert.strictEqual(result, fixture.nextResponse)
  assert.equal(fixture.assetPath, undefined)
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
  assert.equal(result.status, 200)
  assert.equal(await result.text(), 'synthetic maintenance page')
  assert.equal(fixture.assetPath, '/maintenance.html')
})

test('disabled maintenance mode always calls the normal handler', async () => {
  const fixture = makeContext('/map', '0')
  const result = await onRequest(fixture.context)
  assert.strictEqual(result, fixture.nextResponse)
  assert.equal(fixture.assetPath, undefined)
})
