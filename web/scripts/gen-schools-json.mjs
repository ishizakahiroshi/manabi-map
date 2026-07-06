import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
  '*, school_departments(id, school_id, name, course_type), school_deviation_values(department_id, value, is_active)'
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

const outputPath = join(webRoot, 'public', 'schools.json')
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(rows)}\n`)

console.log(`wrote ${rows.length} schools to ${outputPath}`)
