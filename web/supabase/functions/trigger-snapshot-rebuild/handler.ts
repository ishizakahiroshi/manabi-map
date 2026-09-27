const ALLOWED_ORIGINS = new Set(['https://manabi-map.app', 'https://school.manabi-map.app', 'http://localhost:5173', 'http://127.0.0.1:5173'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATES = new Set(['received', 'claimed', 'adopted', 'generated', 'publication_confirmed', 'blocked', 'rejected'])

async function boundedJson(body: ReadableStream<Uint8Array> | null, cap: number, signal: AbortSignal): Promise<unknown> {
  if (!body) throw new Error('missing body')
  const reader = body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      if (signal.aborted) throw new Error('deadline')
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > cap) throw new Error('body limit')
      chunks.push(value)
    }
    if (signal.aborted) throw new Error('deadline')
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } finally { signal.removeEventListener('abort', cancel); cancel() }
}

export function createPublicationIntakeHandler(options: { supabaseUrl?: string; anonKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
  const fetchImpl = options.fetchImpl ?? fetch
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get('origin') ?? ''
    const allowed = !origin || ALLOWED_ORIGINS.has(origin) || /^https:\/\/[a-z0-9-]+\.manabi-map\.pages\.dev$/i.test(origin)
    const cors = { 'Access-Control-Allow-Origin': allowed && origin ? origin : 'https://manabi-map.app',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' }
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
    if (!allowed) return json(403, { error: 'origin not allowed' })
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' })
    let base: URL
    try {
      base = new URL(options.supabaseUrl ?? '')
      if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash || !options.anonKey) throw new Error('config')
    } catch { return json(500, { error: 'server is not configured' }) }
    const authorization = req.headers.get('authorization') ?? ''
    if (!/^Bearer [^\s]{1,8192}$/i.test(authorization)) return json(401, { error: 'authentication required' })
    const controller = new AbortController()
    let expired = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<Response>(resolve => {
      timer = setTimeout(() => { expired = true; controller.abort(); resolve(json(504, { error: 'intake timed out' })) }, options.timeoutMs ?? 10000)
    })
    const operation = async () => {
      let input: { request_id?: unknown; expected_generation?: unknown }
      try {
        input = await boundedJson(req.body, 4096, controller.signal) as typeof input
        if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',') !== 'expected_generation,request_id' ||
          typeof input.request_id !== 'string' || !UUID.test(input.request_id) || typeof input.expected_generation !== 'string' || !/^[0-9a-f]{64}$/.test(input.expected_generation)) throw new Error('input')
      } catch { return json(400, { error: 'invalid request' }) }
      if (expired) return json(504, { error: 'intake timed out' })
      // The RPC checks auth.uid() and admin membership with the caller's bearer token.
      try {
        const response = await fetchImpl(`${base.origin}/rest/v1/rpc/request_school_publication`, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: authorization, apikey: options.anonKey!, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p_request_id: input.request_id, p_expected_generation: input.expected_generation }) })
        if (expired) { void response.body?.cancel().catch(() => {}); return json(504, { error: 'intake timed out' }) }
        if (!response.ok) { void response.body?.cancel().catch(() => {}); return json(response.status === 401 ? 401 : 403, { error: 'intake was not accepted' }) }
        const rows = await boundedJson(response.body, 16384, controller.signal)
        if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.request_id !== input.request_id || !STATES.has(rows[0]?.state)) return json(502, { error: 'invalid intake receipt' })
        return json(202, { request_id: rows[0].request_id, state: rows[0].state })
      } catch { return json(502, { error: 'intake unavailable' }) }
    }
    try { return await Promise.race([operation(), timeout]) } finally { clearTimeout(timer) }
  }
}
