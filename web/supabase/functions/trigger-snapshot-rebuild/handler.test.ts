import test from 'node:test'
import assert from 'node:assert/strict'
import { createPublicationIntakeHandler } from './handler.ts'
const id = '00000000-0000-4000-8000-000000000001'
const generation = 'a'.repeat(64)
function request(body: unknown = { request_id: id, expected_generation: generation }, origin = 'https://manabi-map.app') {
  return new Request('https://edge.invalid/intake', { method: 'POST', headers: { authorization: 'Bearer synthetic-user', origin }, body: JSON.stringify(body) })
}
const options = { supabaseUrl: 'https://synthetic.invalid', anonKey: 'synthetic-anon' }
test('publication intake preserves caller auth and registers without deploying', async () => {
  let calls = 0
  const handler = createPublicationIntakeHandler({ ...options, fetchImpl: async (url, init) => {
    calls++
    assert.equal(url, 'https://synthetic.invalid/rest/v1/rpc/request_school_publication')
    assert.equal(init?.redirect, 'error')
    assert.ok(init)
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer synthetic-user')
    assert.deepEqual(JSON.parse(init?.body as string), { p_request_id: id, p_expected_generation: generation })
    return Response.json([{ request_id: id, state: 'received' }])
  } })
  const result = await handler(request())
  assert.equal(result.status, 202)
  assert.deepEqual(await result.json(), { request_id: id, state: 'received' })
  assert.equal(calls, 1)
})
test('invalid, oversized, foreign-origin and old empty-body calls never reach RPC', async () => {
  let calls = 0
  const handler = createPublicationIntakeHandler({ ...options, fetchImpl: async () => { calls++; throw new Error('must not call') } })
  for (const body of [{}, { request_id: id, expected_generation: 'a'.repeat(10) }, { request_id: id, expected_generation: generation, hook: 'x' }, 'x'.repeat(5000)]) assert.equal((await handler(request(body))).status, 400)
  assert.equal((await handler(request(undefined, 'https://untrusted.invalid'))).status, 403)
  assert.equal(calls, 0)
})
test('upstream errors and invalid receipts never disclose bodies or report acceptance', async () => {
  for (const response of [new Response('private upstream diagnostic', { status: 403 }), Response.json([]), Response.json([{ request_id: id, state: 'unknown' }]), Response.json('x'.repeat(17000))]) {
    const handler = createPublicationIntakeHandler({ ...options, fetchImpl: async () => response })
    const result = await handler(request())
    assert.ok(result.status >= 400)
    assert.doesNotMatch(await result.text(), /private upstream diagnostic/)
  }
})
test('whole-operation timeout bounds and cancels a stalled response body', async () => {
  let cancelled = false
  const handler = createPublicationIntakeHandler({ ...options, timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true } })) })
  assert.equal((await handler(request())).status, 504)
  assert.equal(cancelled, true)
})
