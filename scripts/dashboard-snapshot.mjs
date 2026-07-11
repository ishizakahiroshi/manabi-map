#!/usr/bin/env node
/**
 * Store a five-day rolling window of dashboard metrics in Supabase.
 * Secrets are supplied only through the environment (GitHub Actions secrets).
 */
import { createSign } from 'node:crypto'

const DRY_RUN = process.argv.includes('--dry-run')
const REQUIRED_ENV = [
  'GSC_SA_KEY', 'CF_ANALYTICS_TOKEN', 'CF_ACCOUNT_ID', 'CF_SITE_TAG',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
]

for (const name of REQUIRED_ENV) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`)
}

const gscServiceAccount = JSON.parse(process.env.GSC_SA_KEY)
const supabaseUrl = process.env.SUPABASE_URL.replace(/\/$/, '')
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
})

function tokyoDate(offsetDays) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + offsetDays)
  return dayFormatter.format(date)
}

const dates = Array.from({ length: 5 }, (_, index) => tokyoDate(index - 5))
const startDate = dates[0]
const endDate = dates.at(-1)

function toInteger(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0
}

function toNumber(value, digits = 2) {
  const factor = 10 ** digits
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * factor) / factor : null
}

function base64url(value) {
  return Buffer.from(value).toString('base64url')
}

async function googleAccessToken() {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = base64url(JSON.stringify({
    iss: gscServiceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claim}`)
  signer.end()
  const assertion = `${header}.${claim}.${signer.sign(gscServiceAccount.private_key, 'base64url')}`
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion,
    }),
  })
  if (!response.ok) throw new Error(`GSC token exchange failed (${response.status})`)
  const body = await response.json()
  if (typeof body.access_token !== 'string') throw new Error('GSC token response did not include access_token')
  return body.access_token
}

async function gscQuery(accessToken, body) {
  const siteUrl = encodeURIComponent('sc-domain:manabi-map.app')
  const response = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${siteUrl}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ startDate, endDate, type: 'web', ...body }),
    },
  )
  if (!response.ok) throw new Error(`GSC Search Analytics request failed (${response.status})`)
  return response.json()
}

async function fetchGsc() {
  const token = await googleAccessToken()
  const [dailyResult, queryRows, pageRows] = await Promise.all([
    gscQuery(token, { dimensions: ['date'] }),
    Promise.all(dates.map(async (date) => ({
      date,
      rows: (await gscQuery(token, { startDate: date, endDate: date, dimensions: ['query'], rowLimit: 50 })).rows ?? [],
    }))),
    Promise.all(dates.map(async (date) => ({
      date,
      rows: (await gscQuery(token, { startDate: date, endDate: date, dimensions: ['page'], rowLimit: 50 })).rows ?? [],
    }))),
  ])
  const daily = new Map((dailyResult.rows ?? []).map((row) => [row.keys?.[0], {
    gsc_clicks: toInteger(row.clicks),
    gsc_impressions: toInteger(row.impressions),
    gsc_avg_position: toNumber(row.position),
  }]))
  return {
    daily,
    queries: queryRows.flatMap(({ date, rows }) => rows.map((row) => ({
      snapshot_date: date, query: row.keys?.[0] ?? '', clicks: toInteger(row.clicks),
      impressions: toInteger(row.impressions), ctr: toNumber(row.ctr, 4), position: toNumber(row.position),
    })).filter((row) => row.query)),
    pages: pageRows.flatMap(({ date, rows }) => rows.map((row) => ({
      snapshot_date: date, page: row.keys?.[0] ?? '', clicks: toInteger(row.clicks),
      impressions: toInteger(row.impressions), ctr: toNumber(row.ctr, 4), position: toNumber(row.position),
    })).filter((row) => row.page)),
  }
}

function cfFilter(startDay = startDate, endDay = endDate) {
  const start = `${startDay}T00:00:00Z`
  const end = `${endDay}T23:59:59Z`
  return `{AND:[{datetime_geq:${JSON.stringify(start)}},{datetime_leq:${JSON.stringify(end)}},{siteTag:${JSON.stringify(process.env.CF_SITE_TAG)}},{bot:0}]}`
}

async function cfGroups(dimension, orderBy = 'count_DESC', limit = 500, startDay, endDay) {
  const dimensions = dimension ? `dimensions { ${dimension} }` : ''
  const query = `query { viewer { accounts(filter: {accountTag:${JSON.stringify(process.env.CF_ACCOUNT_ID)}}) { rumPageloadEventsAdaptiveGroups(filter:${cfFilter(startDay, endDay)}, limit:${limit}, orderBy:[${orderBy}]) { count sum { visits } ${dimensions} } } } }`
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.CF_ANALYTICS_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query }),
  })
  if (!response.ok) throw new Error(`Cloudflare Analytics request failed (${response.status})`)
  const body = await response.json()
  if (body.errors?.length) throw new Error(`Cloudflare Analytics query failed: ${body.errors[0].message}`)
  return body.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups ?? []
}

async function fetchCloudflare() {
  const warnings = []
  const dailyRows = await cfGroups('date', 'date_ASC', 10)
  const daily = new Map(dailyRows.map((row) => [row.dimensions?.date, {
    cf_visits: toInteger(row.sum?.visits), cf_pageviews: toInteger(row.count),
  }]).filter(([date]) => date))
  const referers = []
  const dims = []
  // 期間集計を保存すると日次スナップショットを合計した際に重複するため、内訳も日別に保存する。
  for (const date of dates) {
    try {
      const rows = await cfGroups('refererHost', 'count_DESC', 50, date, date)
      for (const row of rows) if (row.dimensions?.refererHost) referers.push({ snapshot_date: date, referer: row.dimensions.refererHost, visits: toInteger(row.sum?.visits) })
    } catch (error) { warnings.push(`Cloudflare referer ${date} skipped: ${error.message}`) }
    for (const [dimType, field] of Object.entries({ country: 'countryName', browser: 'userAgentBrowser', os: 'userAgentOS', device: 'deviceType' })) {
      try {
        const rows = await cfGroups(field, 'count_DESC', 50, date, date)
        for (const row of rows) { const dimValue = row.dimensions?.[field]; if (dimValue) dims.push({ snapshot_date: date, dim_type: dimType, dim_value: dimValue, visits: toInteger(row.sum?.visits) }) }
      } catch (error) { warnings.push(`Cloudflare ${dimType} ${date} skipped: ${error.message}`) }
    }
  }
  return {
    daily,
    referers,
    dims,
    warnings,
  }
}

async function fetchSitemapPageCount() {
  const response = await fetch('https://manabi-map.app/sitemap.xml')
  if (!response.ok) throw new Error(`Sitemap request failed (${response.status})`)
  return (await response.text()).match(/<loc>/g)?.length ?? 0
}

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${supabaseUrl}${path}`, {
    ...options,
    headers: {
      apikey: supabaseServiceRoleKey,
      authorization: `Bearer ${supabaseServiceRoleKey}`,
      ...options.headers,
    },
  })
  if (!response.ok) throw new Error(`Supabase ${path} failed (${response.status})`)
  return response.status === 204 ? null : response.json()
}

async function upsert(table, rows, conflictColumns) {
  if (rows.length === 0) return
  if (DRY_RUN) {
    console.log(`dry-run: ${table} ${rows.length} rows`)
    return
  }
  await supabaseRequest(`/rest/v1/${table}?on_conflict=${encodeURIComponent(conflictColumns)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  })
}

async function main() {
  const failures = []
  const daily = new Map(dates.map((date) => [date, { snapshot_date: date }]))
  let gsc
  let cloudflare

  try {
    gsc = await fetchGsc()
    for (const [date, values] of gsc.daily) Object.assign(daily.get(date), values)
    await upsert('dash_gsc_queries', gsc.queries, 'snapshot_date,query')
    await upsert('dash_gsc_pages', gsc.pages, 'snapshot_date,page')
  } catch (error) {
    failures.push(`GSC: ${error.message}`)
  }
  try {
    cloudflare = await fetchCloudflare()
    for (const [date, values] of cloudflare.daily) Object.assign(daily.get(date), values)
    await upsert('dash_cf_referers', cloudflare.referers, 'snapshot_date,referer')
    await upsert('dash_cf_dims', cloudflare.dims, 'snapshot_date,dim_type,dim_value')
    for (const warning of cloudflare.warnings) console.warn(warning)
  } catch (error) {
    failures.push(`Cloudflare: ${error.message}`)
  }
  try {
    const pageCount = await fetchSitemapPageCount()
    for (const date of dates) daily.get(date).sitemap_page_count = pageCount
  } catch (error) {
    failures.push(`sitemap: ${error.message}`)
  }
  try {
    const result = await supabaseRequest('/rest/v1/rpc/dash_app_counts', { method: 'POST' })
    const counts = Array.isArray(result) ? result[0] : result
    if (!counts) throw new Error('dash_app_counts returned no row')
    // 累積値は当日の観測値だけを保存する。過去日を現在値で上書きすると日次差分が壊れる。
    Object.assign(daily.get(endDate), {
      app_users_total: toInteger(counts.users_total), app_users_line: toInteger(counts.users_line),
      app_users_anon: toInteger(counts.users_anon), favorites_total: toInteger(counts.favorites_total),
      notes_total: toInteger(counts.notes_total), home_points_total: toInteger(counts.home_points_total),
    })
  } catch (error) {
    failures.push(`Supabase app metrics: ${error.message}`)
  }

  await upsert('dash_daily', [...daily.values()], 'snapshot_date')
  console.log(`${DRY_RUN ? 'dry-run complete' : 'snapshot complete'}: ${startDate} to ${endDate}`)
  if (failures.length) {
    for (const failure of failures) console.error(failure)
    process.exitCode = 1
  }
}

await main()
