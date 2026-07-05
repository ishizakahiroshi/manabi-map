// Supabase ランタイム疎通スモークテスト（ローカル実行専用・CI 不使用）
// 実値は web/.env.local から読む。キー・トークンは一切標準出力に出さない。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const here = dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(join(here, '..', '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => l.split(/=(.*)/s).slice(0, 2)),
)

const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)

const results = []

// 1) schools 読み取り
{
  const { data, error, count } = await supabase
    .from('schools')
    .select('id', { count: 'exact', head: false })
    .limit(1)
  results.push(['schools select', error ? `NG: ${error.message}` : `OK (rows visible: ${count ?? data.length})`])
}

// 2) 匿名認証
{
  const { data, error } = await supabase.auth.signInAnonymously()
  if (error) {
    results.push(['anonymous sign-in', `NG: ${error.message}`])
  } else {
    results.push(['anonymous sign-in', `OK (is_anonymous: ${data.user?.is_anonymous})`])
    // 3) RLS 越しの favorites insert/delete（自分の行）
    const uid = data.user.id
    // 実在 school が無くても FK エラーで RLS 通過自体は確認できる
    const { error: insErr } = await supabase
      .from('user_school_favorites')
      .insert({ user_id: uid, school_id: '00000000-0000-0000-0000-000000000000', priority: 3 })
    results.push([
      'favorites insert (RLS)',
      insErr
        ? insErr.code === '23503'
          ? 'OK (RLS 通過・FK エラー = school 未投入のため想定どおり)'
          : `NG: ${insErr.code} ${insErr.message}`
        : 'OK (inserted)',
    ])
    await supabase.from('user_school_favorites').delete().eq('user_id', uid)
    // 4) 匿名ユーザー削除はクライアントから不可（service_role なし）なので残置される
    await supabase.auth.signOut()
  }
}

for (const [name, r] of results) console.log(`${name}: ${r}`)
