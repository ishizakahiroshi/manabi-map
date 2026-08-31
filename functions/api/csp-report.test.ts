import assert from 'node:assert/strict'
import test from 'node:test'

import { extractSafeCspReport, onRequest, onRequestPost } from './csp-report.ts'

function context(body: string, headers: HeadersInit = {}) {
  return { request: new Request('https://synthetic.example.test/api/csp-report', { method: 'POST', headers, body }) }
}

async function captureWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const originalWarn = console.warn
  const warnings: string[] = []
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '))
  try {
    return { result: await fn(), warnings }
  } finally {
    console.warn = originalWarn
  }
}

test('accepts raw and csp-report wrapped payloads while allowlisting fields', async () => {
  const raw = JSON.stringify({
    'document-uri': ['https://user:pass', 'synthetic.example/family/join?token=query-secret#fragment-secret']
      .join(String.fromCharCode(64)),
    referrer: '',
    'blocked-uri': 'https://synthetic.example/script.js?token=blocked-secret#secret',
    'violated-directive': 'script-src-elem',
    unexpected: 'do-not-log-this',
  })
  const wrapped = JSON.stringify({
    'csp-report': {
      'source-file': 'https://synthetic.example/app.js?token=source-secret#secret',
      'effective-directive': 'style-src',
      disposition: 'report',
      'status-code': 200,
    },
    unexpected: 'do-not-log-this-either',
  })

  const first = await captureWarnings(() => onRequestPost(context(raw)))
  const second = await captureWarnings(() => onRequestPost(context(wrapped)))

  assert.equal(first.result.status, 204)
  assert.equal(second.result.status, 204)
  assert.equal(first.warnings.length, 1)
  assert.equal(second.warnings.length, 1)
  assert.match(first.warnings[0], /"documentUri":"https:\/\/synthetic\.example\/family\/join"/)
  assert.match(first.warnings[0], /"referrer":""/)
  assert.match(first.warnings[0], /script-src-elem/)
  assert.match(second.warnings[0], /"sourceFile":"https:\/\/synthetic\.example\/app\.js"/)
  assert.match(second.warnings[0], /style-src/)
  for (const warning of [...first.warnings, ...second.warnings]) {
    assert.doesNotMatch(warning, /secret|unexpected|pass/)
  }
})

test('extracts only safe values and rejects malformed schema', () => {
  assert.deepEqual(extractSafeCspReport({
    documentURL: ['https://user:pass', 'synthetic.example/path?token=secret#fragment']
      .join(String.fromCharCode(64)),
    blockedURL: 'inline',
    lineNumber: 12,
  }), {
    documentUri: 'https://synthetic.example/path',
    blockedUri: 'inline',
    lineNumber: 12,
  })
  assert.equal(extractSafeCspReport({ unexpected: 'secret' }), null)
  assert.equal(extractSafeCspReport({ 'csp-report': 'secret' }), null)
  assert.equal(extractSafeCspReport({ 'violated-directive': { secret: true } }), null)
})

test('does not log invalid JSON, invalid schema, or oversized body', async () => {
  const invalidJson = await captureWarnings(() => onRequestPost(context('invalid-json-with-secret')))
  const invalidSchema = await captureWarnings(() => onRequestPost(context(JSON.stringify({ unexpected: 'schema-secret' }))))
  const oversized = await captureWarnings(() => onRequestPost(context('x'.repeat(32_769))))
  const earlyOversized = await captureWarnings(() => onRequestPost(context('body-secret', { 'content-length': '32769' })))

  assert.equal(invalidJson.result.status, 204)
  assert.equal(invalidSchema.result.status, 204)
  assert.equal(oversized.result.status, 413)
  assert.equal(earlyOversized.result.status, 413)
  assert.deepEqual(invalidJson.warnings, ['csp-report: invalid JSON'])
  assert.deepEqual(invalidSchema.warnings, ['csp-report: invalid schema'])
  assert.deepEqual(oversized.warnings, [])
  assert.deepEqual(earlyOversized.warnings, [])
  assert.equal(invalidJson.warnings.some((warning) => warning.includes('secret')), false)
  assert.equal(invalidSchema.warnings.some((warning) => warning.includes('secret')), false)
})

test('accepts an allowlisted report at the exact 32 KiB boundary', async () => {
  const empty = JSON.stringify({
    'document-uri': 'https://synthetic.example/path?token=secret',
    padding: '',
  })
  const body = JSON.stringify({
    'document-uri': 'https://synthetic.example/path?token=secret',
    padding: 'x'.repeat(32_768 - empty.length),
  })
  assert.equal(new TextEncoder().encode(body).byteLength, 32_768)

  const response = await captureWarnings(() => onRequestPost(context(body)))
  assert.equal(response.result.status, 204)
  assert.deepEqual(response.warnings, ['csp-report {"documentUri":"https://synthetic.example/path"}'])
})

test('keeps the method boundary and does not inspect non-POST bodies', async () => {
  const result = await onRequest({
    request: new Request('https://synthetic.example.test/api/csp-report', {
      method: 'GET',
    }),
  })
  assert.equal(result.status, 405)
  assert.equal(result.headers.get('allow'), 'POST')
})
