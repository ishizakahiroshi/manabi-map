import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

if (!url || !anonKey) {
  throw new Error(
    'Supabase の接続情報が設定されていません。web/.env.local に VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY を設定してください（web/.env.example 参照）。',
  )
}

/**
 * 一過性の失敗（ネットワーク瞬断・5xx・レート制限）に 1 回だけリトライする fetch ラッパー。
 * 二重書き込みを避けるため、リトライ対象は冪等な GET / HEAD のみ（insert/update/delete の
 * POST/PATCH/DELETE は再送しない）。読み取り（学校データ・お気に入り等）の瞬断耐性を上げる。
 * 最終的に失敗したら通常どおり例外 or 非 ok レスポンスを返し、各 hook の error state に委ねる。
 */
async function retryingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase()
  const idempotent = method === 'GET' || method === 'HEAD'
  const retries = idempotent ? 1 : 0
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(input, init)
      if (res.ok || (res.status < 500 && res.status !== 429) || attempt === retries) return res
      lastErr = new Error('HTTP ' + res.status)
    } catch (err) {
      lastErr = err
      if (attempt === retries) throw err
    }
    await new Promise((r) => setTimeout(r, 600))
  }
  throw lastErr instanceof Error ? lastErr : new Error('fetch failed')
}

export const supabase = createClient(url, anonKey, {
  auth: {
    flowType: 'pkce',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  global: { fetch: retryingFetch },
})

/** Supabase Custom OIDC Provider の identifier（LINE） */
export const LINE_PROVIDER = 'custom:line'
