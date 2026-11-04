export interface Env {
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}
export interface Context { request: Request; env: Env }

export const notFound = () => new Response('Not Found', { status: 404 })

export async function requireAdminUser(context: Context): Promise<Response | { userId: string }> {
  const token = context.request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  const url = context.env.SUPABASE_URL?.replace(/\/$/, '')
  const anonKey = context.env.SUPABASE_ANON_KEY
  if (!token || !url || !anonKey) return notFound()
  try {
    const userResponse = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anonKey, authorization: `Bearer ${token}` },
    })
    if (!userResponse.ok) return notFound()
    const user = await userResponse.json() as { id?: unknown }
    if (typeof user.id !== 'string' || !user.id) return notFound()

    const adminResponse = await fetch(`${url}/rest/v1/rpc/is_admin`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    })
    if (!adminResponse.ok) return notFound()
    const isAdmin = await adminResponse.json()
    return isAdmin === true ? { userId: user.id } : notFound()
  } catch { return notFound() }
}

export async function requireAdmin(context: Context): Promise<Response | null> {
  const result = await requireAdminUser(context)
  return result instanceof Response ? result : null
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export async function adminRows<T>(env: Env, table: string, query: string): Promise<T[]> {
  const url = env.SUPABASE_URL?.replace(/\/$/, '')
  const key = env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('missing Supabase environment')
  const response = await fetch(`${url}/rest/v1/${table}?${query}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  })
  if (!response.ok) throw new Error(`Supabase read failed (${response.status})`)
  return response.json() as Promise<T[]>
}

export function daysParam(request: Request): 7 | 28 | 90 {
  const days = Number(new URL(request.url).searchParams.get('days'))
  return days === 7 || days === 28 || days === 90 ? days : 28
}

export function since(days: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - days + 1)
  return date.toISOString().slice(0, 10)
}
