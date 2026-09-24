import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'

const SUPABASE_URL = 'https://synthetic-project.example.test'
const SERVICE_ROLE_KEY = 'synthetic-service-role-key'
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const SYNTHETIC_ENV = {
  GSC_SA_KEY: JSON.stringify({ client_email: 'snapshot@synthetic.example.com', private_key: privateKey }),
  CF_ANALYTICS_TOKEN: 'synthetic-cf-token',
  CF_ACCOUNT_ID: 'synthetic-account-id',
  CF_SITE_TAG: 'synthetic-site-tag',
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
}
const APP_COUNTS = {
  users_total: 7, users_line: 2, users_anon: 3, favorites_total: 11, notes_total: 5, home_points_total: 4,
}

let runCount = 0

// 本体はトップレベルで main() を実行するので、環境変数と fetch を合成値へ差し替えてから、
// 毎回別の URL で import し直して 1 回分のスナップショットを走らせる。外へは通信しない。
async function runSnapshot(t, usageResponse) {
  const savedEnv = Object.fromEntries(Object.keys(SYNTHETIC_ENV).map((name) => [name, process.env[name]]))
  const originalFetch = globalThis.fetch
  const rpcCalls = []
  const upserts = []
  const errors = []
  Object.assign(process.env, SYNTHETIC_ENV)
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input)
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'synthetic-access-token' })
    if (url.startsWith('https://searchconsole.googleapis.com/')) return Response.json({ rows: [] })
    if (url === 'https://api.cloudflare.com/client/v4/graphql') {
      return Response.json({ data: { viewer: { accounts: [{ rumPageloadEventsAdaptiveGroups: [] }] } } })
    }
    if (url === 'https://manabi-map.app/sitemap.xml') {
      return new Response('<urlset><url><loc>https://synthetic.example.test/</loc></url></urlset>')
    }
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/rpc/`)) {
      const name = url.slice(`${SUPABASE_URL}/rest/v1/rpc/`.length)
      rpcCalls.push({ name, method: init.method, apikey: init.headers?.apikey })
      if (name === 'dash_app_counts') return Response.json([APP_COUNTS])
      if (name === 'dash_supabase_usage_metrics') return usageResponse()
      return Response.json({ code: 'PGRST202' }, { status: 404 })
    }
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/`) && init.method === 'POST') {
      const target = new URL(url)
      upserts.push({
        table: target.pathname.replace('/rest/v1/', ''),
        onConflict: target.searchParams.get('on_conflict'),
        rows: JSON.parse(init.body),
      })
      return new Response(null, { status: 201 })
    }
    throw new Error(`unexpected fetch in test: ${url}`)
  }
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'warn', () => {})
  t.mock.method(console, 'error', (message) => { errors.push(String(message)) })
  try {
    runCount += 1
    await import(`./dashboard-snapshot.mjs?run=${runCount}`)
  } finally {
    globalThis.fetch = originalFetch
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  const exitCode = process.exitCode
  process.exitCode = undefined
  const dailyRows = upserts.filter((upsert) => upsert.table === 'dash_daily').flatMap((upsert) => upsert.rows)
  const usageUpserts = upserts.filter((upsert) => upsert.table === 'dash_supabase_usage')
  return { rpcCalls, dailyRows, usageUpserts, errors, exitCode }
}

test('stores Supabase usage for the same day as the app counts, apart from dash_daily', async (t) => {
  const run = await runSnapshot(t, () => Response.json([{ db_size_bytes: 123456789, auth_users_signed_in_30d: 42 }]))

  assert.deepEqual(run.errors, [])
  assert.notEqual(run.exitCode, 1)
  const call = run.rpcCalls.find((rpc) => rpc.name === 'dash_supabase_usage_metrics')
  assert.equal(call?.method, 'POST')
  assert.equal(call?.apikey, SERVICE_ROLE_KEY)

  const appRow = run.dailyRows.find((row) => 'app_users_total' in row)
  assert.ok(appRow, 'dash_daily should still receive the app counts')
  assert.equal(appRow.snapshot_date, run.dailyRows.map((row) => row.snapshot_date).sort().at(-1))
  assert.equal(run.usageUpserts.length, 1)
  assert.equal(run.usageUpserts[0].onConflict, 'snapshot_date')
  assert.deepEqual(run.usageUpserts[0].rows, [
    { snapshot_date: appRow.snapshot_date, db_size_bytes: 123456789, auth_users_signed_in_30d: 42 },
  ])
  assert.equal(run.dailyRows.some((row) => 'db_size_bytes' in row || 'auth_users_signed_in_30d' in row), false)
})

test('keeps the rest of the snapshot when the usage RPC is not deployed yet', async (t) => {
  const run = await runSnapshot(t, () => Response.json(
    { code: 'PGRST202', message: 'synthetic: function not found' }, { status: 404 },
  ))

  assert.equal(run.exitCode, 1)
  assert.equal(run.usageUpserts.length, 0)
  assert.equal(run.dailyRows.some((row) => row.app_users_total === APP_COUNTS.users_total), true)
  assert.equal(run.errors.some((message) => message.startsWith('Supabase usage metrics:')), true)
})

test('does not store zeros when the usage RPC returns an incomplete row', async (t) => {
  const run = await runSnapshot(t, () => Response.json([{ db_size_bytes: 123456789 }]))

  assert.equal(run.exitCode, 1)
  assert.equal(run.usageUpserts.length, 0)
  assert.equal(run.errors.some((message) => message.includes('dash_supabase_usage_metrics returned no complete row')), true)
})
