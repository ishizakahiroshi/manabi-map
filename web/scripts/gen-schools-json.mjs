import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

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

const select =
  '*, school_departments(id, school_id, name, course_type, ui_group), school_deviation_values(department_id, value, is_active), school_admission_stats(id, department_id, year, capacity, applicants, examinees, admitted, note, source_url), predecessor_relationships:school_relationships!school_relationships_successor_school_id_fkey(id, relationship_type_code, effective_on, official_url, notes, predecessor:schools!school_relationships_predecessor_school_id_fkey(id, record_key, name, lifecycle_status_code, closed_on)), school_name_history(id, name, name_kana, valid_from, valid_to, official_url, notes)'
const pageSize = 1000
const rows = []

for (let from = 0; ; from += pageSize) {
  const to = from + pageSize - 1
  const { data, error } = await supabase
    .from('schools')
    .select(select)
    .eq('is_active', true)
    .order('prefecture', { ascending: true })
    .order('name', { ascending: true })
    .range(from, to)

  if (error) throw new Error(`schools の取得に失敗しました: ${error.message}`)

  rows.push(...(data ?? []))
  if (!data || data.length < pageSize) break
}

// 全校＋全入試を1クエリへ深くnestするとPostgRESTのstatement timeoutに達する。
// 募集単位は小さくページ分割して取得し、現行校と前身校へschool_idで結合する。
const admissionsBySchool = new Map()
const admissionPageSize = 250
for (let from = 0; ; from += admissionPageSize) {
  const { data, error } = await supabase
    .from('admission_recruitment_units')
    .select('school_id, id, unit_key, unit_kind_code, label, course_time, valid_from_year, valid_to_year, admission_recruitment_unit_departments(department_id), school_admission_selection_stats(id, year, selection_stage_code, selection_track_code, stage_label_raw, track_label_raw, selection_scope_raw, population_scope_raw, scope_key, map_role_code, is_ratio_comparable, capacity, applicants, examinees, admitted, exam_scope_raw, school_admission_stat_exam_components(component_code), school_admission_stat_quality_flags(metric_code, reason_code, note), school_admission_stat_sources(fact_kind_code, official_url, doc_title, published_at, source_page_or_table, quoted_evidence, last_verified_at, last_http_status))')
    .order('id', { ascending: true })
    .range(from, from + admissionPageSize - 1)
  if (error) throw new Error(`入試履歴取得に失敗しました: ${error.message}`)
  for (const unit of data ?? []) {
    const units = admissionsBySchool.get(unit.school_id) ?? []
    units.push(unit)
    admissionsBySchool.set(unit.school_id, units)
  }
  if (!data || data.length < admissionPageSize) break
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

// --- build hash 付き URL 化 -------------------------------------------------
// 内容から sha256 の先頭 10 桁を hash とし、`schools-<hash>.json` を出力する。
// あわせて `schools-manifest.json` を「常に fresh に取る」ポインタとして書き、
// フロント側は manifest → hash 付き URL の 2 段 fetch で反映ラグを解消する。
// 過去の hash 付き JSON は build 時に掃除して重複配信を防ぐ。
// 詳細: docs/local/plan_schools-json-cache-strategy.md
const publicDir = join(webRoot, 'public')
await mkdir(publicDir, { recursive: true })

const body = `${JSON.stringify(rows)}\n`
const hash = createHash('sha256').update(body).digest('hex').slice(0, 10)
const filename = `schools-${hash}.json`
const outputPath = join(publicDir, filename)

// 古い schools-*.json / schools.json を掃除（本 build で出力する分だけ残す）。
const existing = await readdir(publicDir)
for (const name of existing) {
  if (name === filename) continue
  if (name === 'schools.json' || /^schools-[0-9a-f]+\.json$/.test(name)) {
    await unlink(join(publicDir, name))
  }
}

await writeFile(outputPath, body)

const manifest = {
  url: `/${filename}`,
  hash,
  count: rows.length,
  generatedAt: new Date().toISOString(),
}
await writeFile(join(publicDir, 'schools-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`wrote ${rows.length} schools to ${outputPath} (manifest url=${manifest.url})`)
