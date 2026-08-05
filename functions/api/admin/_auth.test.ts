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
      ADMIN_USER_ID: SYNTHETIC_ADMIN_ID,
      ...envOverrides,
    },
  }
}

test('requireAdminUser rejects a request without a bearer token', async () => {
  const result = await requireAdminUser(context(null))
  assert.equal(result instanceof Response, true)
  assert.equal((result as Response).status, 404)
})

test('requireAdminUser rejects a valid token for a different user', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => new Response(JSON.stringify({ id: SYNTHETIC_OTHER_ID }), { status: 200 })

  const result = await requireAdminUser(context('synthetic-user-token'))
  assert.equal(result instanceof Response, true)
  assert.equal((result as Response).status, 404)
})

test('requireAdminUser accepts the configured synthetic admin and uses anon apikey', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let request: Request | undefined
  globalThis.fetch = async (input, init) => {
    request = new Request(input, init)
    return new Response(JSON.stringify({ id: SYNTHETIC_ADMIN_ID }), { status: 200 })
  }

  const result = await requireAdminUser(context('synthetic-user-token'))
  assert.deepEqual(result, { userId: SYNTHETIC_ADMIN_ID })
  assert.equal(request?.headers.get('apikey'), 'synthetic-anon-key')
  assert.equal(request?.headers.get('authorization'), 'Bearer synthetic-user-token')
})

test('requireAdminUser fails closed when the anon key is missing', async () => {
  const result = await requireAdminUser(context('synthetic-user-token', { SUPABASE_ANON_KEY: '' }))
  assert.equal(result instanceof Response, true)
  assert.equal((result as Response).status, 404)
})
