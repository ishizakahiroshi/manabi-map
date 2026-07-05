import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

if (!url || !anonKey) {
  throw new Error(
    'Supabase の接続情報が設定されていません。web/.env.local に VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY を設定してください（web/.env.example 参照）。',
  )
}

export const supabase = createClient(url, anonKey, {
  auth: {
    flowType: 'pkce',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})

/** Supabase Custom OIDC Provider の identifier（LINE） */
export const LINE_PROVIDER = 'custom:line'
