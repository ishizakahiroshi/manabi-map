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
  '*, school_departments(id, school_id, name, course_type, ui_group), school_deviation_values(department_id, value, is_active), school_admission_stats(id, department_id, year, capacity, applicants, examinees, admitted, note, source_url)'
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
