import { adminRows, daysParam, json, requireAdmin, since, type Context } from './_auth'
type Daily = { snapshot_date: string; gsc_clicks: number | null; gsc_impressions: number | null; gsc_avg_position: number | null; cf_visits: number | null; app_users_total: number | null; favorites_total: number | null }
export const onRequestGet = async (context: Context) => {
  const denied = await requireAdmin(context); if (denied) return denied
  try {
    const days = daysParam(context.request); const rows = await adminRows<Daily>(context.env, 'dash_daily', `select=*&snapshot_date=gte.${since(days * 2)}&order=snapshot_date.asc`)
    const current = rows.slice(-days), previous = rows.slice(-days * 2, -days)
    const last = current.at(-1) ?? {}; const prev = previous.at(-1) ?? {}
    const delta = (key: keyof Daily) => Number(last[key] ?? 0) - Number(prev[key] ?? 0)
    return json({ tiles: { clicks: last.gsc_clicks ?? 0, impressions: last.gsc_impressions ?? 0, avgPosition: last.gsc_avg_position ?? null, visits: last.cf_visits ?? 0, usersTotal: last.app_users_total ?? 0, favoritesTotal: last.favorites_total ?? 0, delta: { clicks: delta('gsc_clicks'), impressions: delta('gsc_impressions'), visits: delta('cf_visits'), usersTotal: delta('app_users_total') } }, series: { dates: current.map((r) => r.snapshot_date), clicks: current.map((r) => r.gsc_clicks ?? 0), impressions: current.map((r) => r.gsc_impressions ?? 0), visits: current.map((r) => r.cf_visits ?? 0), newUsers: current.map((r, i) => Math.max(0, Number(r.app_users_total ?? 0) - Number(current[i - 1]?.app_users_total ?? r.app_users_total ?? 0))) } })
  } catch { return json({ error: 'internal' }, 500) }
}
