import { adminRows, daysParam, json, requireAdmin, since, type Context } from './_auth'

type RankedSourceRow = {
  [key: string]: string | number | null
  clicks: number
  impressions: number
  position: number | null
}

type RankedAggregate = {
  name: string
  clicks: number
  impressions: number
  positionWeighted: number
}

export async function ranked(context: Context, table: 'dash_gsc_queries' | 'dash_gsc_pages', key: 'query' | 'page') {
  const denied = await requireAdmin(context)
  if (denied) return denied

  try {
    const params = new URL(context.request.url).searchParams
    const limit = Math.min(50, Math.max(1, Number(params.get('limit')) || 8))
    const rows = await adminRows<RankedSourceRow>(
      context.env,
      table,
      `select=${key},clicks,impressions,position&snapshot_date=gte.${since(daysParam(context.request))}`,
    )
    const groups = new Map<string, RankedAggregate>()

    for (const row of rows) {
      const name = String(row[key])
      const current = groups.get(name) ?? { name, clicks: 0, impressions: 0, positionWeighted: 0 }
      const impressions = Number(row.impressions ?? 0)
      current.clicks += Number(row.clicks ?? 0)
      current.impressions += impressions
      current.positionWeighted += Number(row.position ?? 0) * impressions
      groups.set(name, current)
    }

    const result = [...groups.values()]
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, limit)
      .map((row) => ({
        [key]: row.name,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.impressions > 0 ? row.clicks / row.impressions : null,
        position: row.impressions > 0 ? row.positionWeighted / row.impressions : null,
      }))

    return json(result)
  } catch {
    return json({ error: 'internal' }, 500)
  }
}
