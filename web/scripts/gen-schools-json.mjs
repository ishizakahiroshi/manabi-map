import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { createClient } from '@supabase/supabase-js'
import { loadCivicData, resolveCityGroup } from './lib/municipalities.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, '..')

async function readEnvFile(path) {
  try {
    const text = await readFile(path, 'utf8')
    return Object.fromEntries(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const [key, ...rest] = line.split('=')
          const value = rest.join('=').trim().replace(/^(['"])(.*)\1$/, '$2')
          return [key.trim(), value]
        }),
    )
  } catch (err) {
    if (err?.code === 'ENOENT') return {}
    throw err
  }
}

const env = {
  ...(await readEnvFile(join(webRoot, '.env'))),
  ...(await readEnvFile(join(webRoot, '.env.local'))),
  ...process.env,
}

const url = env.VITE_SUPABASE_URL
const anonKey = env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error(
    'VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY を web/.env.local か環境変数に設定してください。',
  )
}

const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
})

/**
 * Supabase の statement timeout（3 秒）は、DB のキャッシュが冷えていると
 * 深い nest の 1 ページだけで到達しうる。
 *
 * 2026-07-31 実測: 入試履歴の 1 ページ目が cold 3.17 秒 / warm 0.30 秒。
 * ローカルでは事前アクセスで warm だったため通り、Cloudflare の本番ビルドは
 * cold で当たって失敗した（v0.4.0 リリース時）。同じページを少し待って引き直せば
 * warm になって通るので、タイムアウト系のエラーは再試行する。
 */
async function runWithRetry(label, run, attempts = 4) {
  let lastMessage = ''
  for (let i = 1; i <= attempts; i += 1) {
    const { data, error } = await run()
    if (!error) return data ?? []
    lastMessage = error.message
    const retriable = /timeout|timed out|57014|fetch failed|ECONNRESET|502|503|504/i.test(error.message)
    if (!retriable || i === attempts) break
    const waitMs = 1500 * i
    console.error(`${label}: ${error.message} — ${waitMs}ms 待って再試行 (${i}/${attempts - 1})`)
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
  throw new Error(`${label}に失敗しました: ${lastMessage}`)
}

const select =
  '*, school_departments(id, school_id, name, course_type, ui_group), school_deviation_values(department_id, value, is_active), school_admission_stats(id, department_id, year, capacity, applicants, examinees, admitted, note, source_url), predecessor_relationships:school_relationships!school_relationships_successor_school_id_fkey(id, relationship_type_code, effective_on, official_url, notes, predecessor:schools!school_relationships_predecessor_school_id_fkey(id, record_key, name, lifecycle_status_code, closed_on)), school_name_history(id, name, name_kana, valid_from, valid_to, official_url, notes)'
// このページサイズは school_departments(school_id) の索引に依存する（migration 202607310101）。
// 索引が無いと embed が親 1 行ごとに全件走査になり、全国 47 都道府県（学科 7,798 行）では
// 250 件/ページでも 3.1 秒かかって Supabase の statement timeout（3 秒）に達する。
//
// 索引追加後も 1,000 件/ページでは 1 リクエスト 1.6〜2.9 秒と予算の大半を使ってしまうため
// 500 件に下げる（2026-07-31 実測）。件数が増えたらここを先に疑うこと。
const pageSize = 500
const rows = []

for (let from = 0; ; from += pageSize) {
  const to = from + pageSize - 1
  const data = await runWithRetry(`schools の取得（${from}〜${to}）`, () =>
    supabase
      .from('schools')
      .select(select)
      .eq('is_active', true)
      .order('prefecture', { ascending: true })
      .order('name', { ascending: true })
      .range(from, to),
  )

  rows.push(...data)
  if (data.length < pageSize) break
}

// 全校＋全入試を1クエリへ深くnestするとPostgRESTのstatement timeoutに達する。
// 募集単位は小さくページ分割して取得し、現行校と前身校へschool_idで結合する。
// ページングは OFFSET ではなく keyset（id の続きから取る）にする。
// OFFSET 方式だと深いページほど読み飛ばしコストが乗り、全国 47 都道府県のデータ量では
// offset=2000 以降が軒並み statement timeout になった（2026-07-31 実測。offset=0 は 0.7 秒、
// offset=2000 は 3 秒超で失敗）。keyset ならページ位置に関係なく一定時間で返る。
// ページサイズは cold の 1 ページ目が timeout に収まる大きさにする。
// 2026-07-31 実測（warm）: 250 件/ページで 1 ページ目 3.17 秒・2 ページ目以降 0.25〜0.62 秒。
// 1 ページ目だけ突出するのは巨大な子テーブル（出典 83,957 行等）への初回アクセスのため。
// 100 件へ下げて 1 ページ目の実測を約 1/3 にし、加えて runWithRetry で取りこぼしを拾う。
const admissionsBySchool = new Map()
const admissionPageSize = 100
let lastUnitId = null
let admissionPage = 0
for (;;) {
  admissionPage += 1
  const cursor = lastUnitId
  const data = await runWithRetry(`入試履歴の取得（page ${admissionPage}）`, () => {
    let query = supabase
      .from('admission_recruitment_units')
      .select('school_id, id, unit_key, unit_kind_code, label, course_time, valid_from_year, valid_to_year, admission_recruitment_unit_departments(department_id), school_admission_selection_stats(id, year, selection_stage_code, selection_track_code, stage_label_raw, track_label_raw, selection_scope_raw, population_scope_raw, scope_key, map_role_code, is_ratio_comparable, capacity, applicants, examinees, admitted, exam_scope_raw, school_admission_stat_exam_components(component_code), school_admission_stat_quality_flags(metric_code, reason_code, note), school_admission_stat_sources(fact_kind_code, official_url, doc_title, published_at, source_page_or_table, quoted_evidence, last_verified_at, last_http_status))')
      .order('id', { ascending: true })
      .limit(admissionPageSize)
    if (cursor !== null) query = query.gt('id', cursor)
    return query
  })
  for (const unit of data) {
    const units = admissionsBySchool.get(unit.school_id) ?? []
    units.push(unit)
    admissionsBySchool.set(unit.school_id, units)
  }
  if (data.length < admissionPageSize) break
  lastUnitId = data[data.length - 1].id
}
for (const row of rows) {
  row.admission_recruitment_units = admissionsBySchool.get(row.id) ?? []
  for (const relationship of row.predecessor_relationships ?? []) {
    if (relationship.predecessor) {
      relationship.predecessor.admission_recruitment_units =
        admissionsBySchool.get(relationship.predecessor.id) ?? []
    }
  }
}

// 指標別出典は学校・年度ごとに同じ公式資料を繰り返すため、そのままJSON化
// すると約46,000個の同型objectで単一ファイルがPages上限を超える。
// 静的配信だけsource objectをcatalog化し、各統計にはindexを持たせる。
// ブラウザ側で元objectへ復元するため、表示情報は一切落とさない。
const sourceCatalog = []
const sourceIndex = new Map()
function compactUnitSources(units) {
  for (const unit of units ?? []) {
    for (const stat of unit.school_admission_selection_stats ?? []) {
      stat.school_admission_stat_sources = (stat.school_admission_stat_sources ?? []).map((source) => {
        const key = JSON.stringify(source)
        let index = sourceIndex.get(key)
        if (index == null) {
          index = sourceCatalog.length
          sourceCatalog.push(source)
          sourceIndex.set(key, index)
        }
        return index
      })
    }
  }
}
for (const row of rows) {
  compactUnitSources(row.admission_recruitment_units)
  for (const relationship of row.predecessor_relationships ?? []) {
    compactUnitSources(relationship.predecessor?.admission_recruitment_units)
  }
}

// --- build hash 付き URL 化 -------------------------------------------------
// 内容から sha256 の先頭 10 桁を hash とし、`schools-<hash>.json` を出力する。
// あわせて `schools-manifest.json` を「常に fresh に取る」ポインタとして書き、
// フロント側は manifest → hash 付き URL の 2 段 fetch で反映ラグを解消する。
// 過去の hash 付き JSON は build 時に掃除して重複配信を防ぐ。
// 詳細: docs/local/plan_schools-json-cache-strategy.md
const publicDir = join(webRoot, 'public')
await mkdir(publicDir, { recursive: true })

const payload = { formatVersion: 2, sourceCatalog, schools: rows }
const body = `${JSON.stringify(payload)}\n`
const hash = createHash('sha256').update(body).digest('hex').slice(0, 10)
const filename = `schools-${hash}.json.gz`
const outputPath = join(publicDir, filename)

// --- 検索用の軽量索引 -------------------------------------------------------
// トップの統合検索は schools.json 全体を読まない（plan_seo-growth-strategy_c5 C3）。
// - 市区町村索引: 高校が 1 校以上ある市区町村。ふりがな付き（かな入力対応）で
//   市区町村コード順。地名候補 → 県ページ（/pref/<slug>/#<市区町村>）への導線に使う。
// - 校名索引: 全収録校の校名・ふりがな・所在地・座標のみ（検索欄フォーカス時に遅延読込）。
const { prefectures, muniByPref } = await loadCivicData(webRoot)
const prefBySlugName = new Map(prefectures.map((p) => [p.name, p]))

const cityGroups = new Map()
const unresolvedByPref = new Map()
for (const row of rows) {
  const resolved = resolveCityGroup(row, muniByPref)
  if (!resolved) {
    unresolvedByPref.set(row.prefecture, (unresolvedByPref.get(row.prefecture) ?? 0) + 1)
    continue
  }
  const key = `${row.prefecture}|${resolved.label}`
  const entry = cityGroups.get(key) ?? {
    pref: row.prefecture,
    prefSlug: prefBySlugName.get(row.prefecture)?.slug ?? null,
    city: resolved.label,
    kana: resolved.kana,
    code: resolved.code,
    count: 0,
  }
  entry.count += 1
  cityGroups.set(key, entry)
}
const cityIndex = [...cityGroups.values()]
  .filter((entry) => entry.prefSlug != null)
  .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
  .map(({ code: _code, ...entry }) => entry)

const nameIndex = rows.map((row) => ({
  i: row.id,
  n: row.name,
  k: row.name_kana ?? null,
  p: row.prefecture,
  c: resolveCityGroup(row, muniByPref)?.label ?? row.city ?? null,
  lat: row.latitude != null ? Number(row.latitude) : null,
  lng: row.longitude != null ? Number(row.longitude) : null,
}))

const cityIndexBody = `${JSON.stringify(cityIndex)}\n`
const cityIndexFilename = `city-index-${createHash('sha256').update(cityIndexBody).digest('hex').slice(0, 10)}.json`
const nameIndexBody = `${JSON.stringify(nameIndex)}\n`
const nameIndexFilename = `school-name-index-${createHash('sha256').update(nameIndexBody).digest('hex').slice(0, 10)}.json`

// 古い schools-*.json / 索引を掃除（本 build で出力する分だけ残す）。
const keep = new Set([filename, cityIndexFilename, nameIndexFilename])
const existing = await readdir(publicDir)
for (const name of existing) {
  if (keep.has(name)) continue
  if (
    name === 'schools.json' ||
    /^schools-[0-9a-f]+\.json(?:\.gz)?$/.test(name) ||
    /^city-index-[0-9a-f]+\.json$/.test(name) ||
    /^school-name-index-[0-9a-f]+\.json$/.test(name)
  ) {
    await unlink(join(publicDir, name))
  }
}

await writeFile(outputPath, gzipSync(body, { level: 9 }))
await writeFile(join(publicDir, cityIndexFilename), cityIndexBody)
await writeFile(join(publicDir, nameIndexFilename), nameIndexBody)

const manifest = {
  url: `/${filename}`,
  hash,
  count: rows.length,
  formatVersion: payload.formatVersion,
  compression: 'gzip',
  sourceCatalogCount: sourceCatalog.length,
  cityIndexUrl: `/${cityIndexFilename}`,
  cityIndexCount: cityIndex.length,
  nameIndexUrl: `/${nameIndexFilename}`,
  generatedAt: new Date().toISOString(),
}
await writeFile(join(publicDir, 'schools-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(
  `wrote ${rows.length} schools to ${outputPath} (manifest url=${manifest.url}, ` +
  `cityIndex=${cityIndex.length}, nameIndex=${nameIndex.length})`,
)

// 市区町村を解決できず県ページの「その他」へ落ちる校数。新県データ投入後にここが
// 跳ねたら city/address の表記異常（県名二重・欠損表記等）を疑うこと。
if (unresolvedByPref.size > 0) {
  const detail = [...unresolvedByPref.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([pref, count]) => `${pref}=${count}`)
    .join(', ')
  const total = [...unresolvedByPref.values()].reduce((a, b) => a + b, 0)
  console.warn(`city 未解決（「その他」行き）: ${total} 校 (${detail})`)
}
