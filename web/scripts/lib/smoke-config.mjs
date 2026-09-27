import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

// 通信や認証を行わず、疎通検査に必要な2キーだけを返す。
// 生成器と同じ優先順位: .env < .env.local < 実行環境。
export function loadSmokeConfig({ env = process.env, webRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const directory = env.MANABI_MAP_ENV_DIR || webRoot
  const allowed = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']
  const values = {}
  for (const filename of ['.env', '.env.local']) {
    let parsed
    try {
      parsed = parseEnv(readFileSync(join(directory, filename), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') continue
      // パーサやOSのエラーに設定値を含めない。
      throw new Error(`Cannot read smoke configuration (${filename})`)
    }
    for (const key of allowed) if (parsed[key] !== undefined) values[key] = parsed[key]
  }
  for (const key of allowed) if (env[key] !== undefined) values[key] = env[key]
  if (!values.VITE_SUPABASE_URL || !values.VITE_SUPABASE_ANON_KEY) {
    throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required for the explicit smoke run')
  }
  return { url: values.VITE_SUPABASE_URL, anonKey: values.VITE_SUPABASE_ANON_KEY }
}
