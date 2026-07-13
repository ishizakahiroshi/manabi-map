import { adminRows, json, requireAdmin, requireAdminUser, type Context } from './_auth'

interface AppConfigRow {
  key: string
  value: unknown
  updated_at: string
  updated_by: string | null
}

interface MaintenanceRequest {
  on?: unknown
}

function toState(row: AppConfigRow | undefined) {
  const value = row?.value
  const on = Boolean(value && typeof value === 'object' && (value as { on?: unknown }).on === true)
  return {
    on,
    updatedAt: row?.updated_at ?? '',
    updatedBy: row?.updated_by ?? null,
  }
}

export const onRequestGet = async (context: Context) => {
  const denied = await requireAdmin(context)
  if (denied) return denied
  try {
    const rows = await adminRows<AppConfigRow>(
      context.env,
      'app_config',
      'select=key,value,updated_at,updated_by&key=eq.maintenance_mode',
    )
    if (rows.length === 0) return json({ error: 'maintenance config missing' }, 500)
    return json(toState(rows[0]))
  } catch {
    return json({ error: 'internal' }, 500)
  }
}

export const onRequestPost = async (context: Context) => {
  const admin = await requireAdminUser(context)
  if (admin instanceof Response) return admin

  let body: MaintenanceRequest
  try {
    body = await context.request.json() as MaintenanceRequest
  } catch {
    return json({ error: 'invalid json' }, 400)
  }
  if (!body || typeof body !== 'object' || typeof body.on !== 'boolean') {
    return json({ error: 'on must be boolean' }, 400)
  }

  const url = context.env.SUPABASE_URL?.replace(/\/$/, '')
  const key = context.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return json({ error: 'internal' }, 500)

  try {
    const response = await fetch(`${url}/rest/v1/app_config?key=eq.maintenance_mode`, {
      method: 'PATCH',
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        prefer: 'return=representation',
      },
      body: JSON.stringify({
        value: { on: body.on },
        updated_at: new Date().toISOString(),
        updated_by: admin.userId,
      }),
    })
    if (!response.ok) return json({ error: 'update failed' }, 500)
    const rows = await response.json() as AppConfigRow[]
    if (!Array.isArray(rows) || rows.length === 0) return json({ error: 'maintenance config missing' }, 500)
    return json(toState(rows[0]))
  } catch {
    return json({ error: 'internal' }, 500)
  }
}
