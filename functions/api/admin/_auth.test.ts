import assert from 'node:assert/strict'
import test from 'node:test'

import { requireAdminUser } from './_auth.ts'

const SYNTHETIC_ADMIN_ID = '00000000-0000-4000-8000-000000000001'
const SYNTHETIC_OTHER_ID = '00000000-0000-4000-8000-000000000002'

function context(token: string | null, envOverrides: Record<string, string> = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : undefined
  return {
    request: new Request('https://synthetic.example.test/api/admin/me', { headers }),
    env: {
      SUPABASE_URL: 'https://synthetic-project.example.test',
      SUPABASE_ANON_KEY: 'synthetic-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-role-key',
      ...envOverrides,
    },
  }
}

test('requireAdminUser rejects a request without a bearer token', async () => {
  const result = await requireAdminUser(context(null))
  assert.equal(result instanceof Response, true)
  assert.equal((result as Response).status, 404)
})

test('requireAdminUser rejects an invalid user session', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => new Response('invalid token', { status: 401 })

  const result = await requireAdminUser(context('synthetic-user-token'))
  assert.equal(result instanceof Response, true)
  assert.equal((result as Response).status, 404)
})

test('requireAdminUser rejects a valid non-admin session from is_admin RPC', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const requests: Request[] = []
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    requests.push(request)
    return request.url.endsWith('/auth/v1/user')
      ? new Response(JSON.stringify({ id: SYNTHETIC_OTHER_ID }), { status: 200 })
      : new Response('false', { status: 200 })
  }

  const result = await requireAdminUser(context('synthetic-user-token'))
  assert.equal(result instanceof Response, true)
  assert.equal((result as Response).status, 404)
  assert.equal(requests.length, 2)
  assert.equal(requests[1].url, 'https://synthetic-project.example.test/rest/v1/rpc/is_admin')
  assert.equal(requests[1].headers.get('apikey'), 'synthetic-anon-key')
  assert.equal(requests[1].headers.get('authorization'), 'Bearer synthetic-user-token')
})

test('requireAdminUser accepts the admin_users-backed RPC result without an ADMIN_USER_ID setting', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const requests: Request[] = []
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    requests.push(request)
    return request.url.endsWith('/auth/v1/user')
      ? new Response(JSON.stringify({ id: SYNTHETIC_ADMIN_ID }), { status: 200 })
      : new Response('true', { status: 200 })
  }

  const result = await requireAdminUser(context('synthetic-user-token'))
  assert.deepEqual(result, { userId: SYNTHETIC_ADMIN_ID })
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, 'https://synthetic-project.example.test/auth/v1/user')
  assert.equal(requests[0].headers.get('apikey'), 'synthetic-anon-key')
  assert.equal(requests[0].headers.get('authorization'), 'Bearer synthetic-user-token')
  assert.equal(requests[1].headers.get('apikey'), 'synthetic-anon-key')
  assert.equal(requests[1].headers.get('authorization'), 'Bearer synthetic-user-token')
  assert.equal(requests[1].headers.get('content-type'), 'application/json')
  assert.equal(await requests[1].text(), '{}')
})

test('requireAdminUser fails closed when the is_admin RPC is unavailable', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (input) => String(input).endsWith('/auth/v1/user')
    ? new Response(JSON.stringify({ id: SYNTHETIC_ADMIN_ID }), { status: 200 })
    : new Response('missing function', { status: 404 })

  const result = await requireAdminUser(context('synthetic-user-token'))
  assert.equal(result instanceof Response, true)
  assert.equal((result as Response).status, 404)
})

test('requireAdminUser fails closed when the anon key is missing', async () => {
  const result = await requireAdminUser(context('synthetic-user-token', { SUPABASE_ANON_KEY: '' }))
  assert.equal(result instanceof Response, true)
  assert.equal((result as Response).status, 404)
})
