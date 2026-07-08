const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const deployHookUrl = Deno.env.get('CLOUDFLARE_PAGES_DEPLOY_HOOK_URL')

  if (!supabaseUrl || !anonKey || !serviceRoleKey || !deployHookUrl) {
    return json({ error: 'server is not configured' }, 500)
  }

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return json({ error: 'authentication required' }, 401)
  }

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      Authorization: authHeader,
      apikey: anonKey,
    },
  })

  if (!userRes.ok) return json({ error: 'authentication required' }, 401)
  const user = await userRes.json() as { id?: string }
  if (!user.id) return json({ error: 'authentication required' }, 401)

  const adminRes = await fetch(
    `${supabaseUrl}/rest/v1/admin_users?user_id=eq.${encodeURIComponent(user.id)}&select=user_id`,
    {
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
      },
    },
  )

  if (!adminRes.ok) return json({ error: 'admin check failed' }, 500)
  const admins = await adminRes.json() as Array<{ user_id: string }>
  if (admins.length === 0) return json({ error: 'admin required' }, 403)

  const hookRes = await fetch(deployHookUrl, { method: 'POST' })
  if (!hookRes.ok) {
    return json({ error: 'deploy hook failed', status: hookRes.status }, 502)
  }

  return json({ ok: true })
})
