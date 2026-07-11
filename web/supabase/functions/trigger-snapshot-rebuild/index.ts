const ALLOWED_ORIGIN_EXACT = new Set([
  'https://manabi-map.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
])

function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? ''
  // 本番・ローカル dev・Cloudflare Pages プレビュー（*.manabi-map.pages.dev）のみ許可
  const allow =
    ALLOWED_ORIGIN_EXACT.has(origin) ||
    /^https:\/\/[a-z0-9-]+\.manabi-map\.pages\.dev$/i.test(origin)
      ? origin
      : 'https://manabi-map.app'
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

function json(body: Record<string, unknown>, status = 200, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, cors)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const deployHookUrl = Deno.env.get('CLOUDFLARE_PAGES_DEPLOY_HOOK_URL')

  if (!supabaseUrl || !anonKey || !serviceRoleKey || !deployHookUrl) {
    return json({ error: 'server is not configured' }, 500, cors)
  }

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return json({ error: 'authentication required' }, 401, cors)
  }

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      Authorization: authHeader,
      apikey: anonKey,
    },
  })

  if (!userRes.ok) return json({ error: 'authentication required' }, 401, cors)
  const user = await userRes.json() as { id?: string }
  if (!user.id) return json({ error: 'authentication required' }, 401, cors)

  const adminRes = await fetch(
    `${supabaseUrl}/rest/v1/admin_users?user_id=eq.${encodeURIComponent(user.id)}&select=user_id`,
    {
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
      },
    },
  )

  if (!adminRes.ok) return json({ error: 'admin check failed' }, 500, cors)
  const admins = await adminRes.json() as Array<{ user_id: string }>
  if (admins.length === 0) return json({ error: 'admin required' }, 403, cors)

  const hookRes = await fetch(deployHookUrl, { method: 'POST' })
  if (!hookRes.ok) {
    return json({ error: 'deploy hook failed', status: hookRes.status }, 502, cors)
  }

  return json({ ok: true }, 200, cors)
})
