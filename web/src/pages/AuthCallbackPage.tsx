import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

/**
 * OAuth コールバック。PKCE フローの code 交換は supabase-js の
 * detectSessionInUrl が自動処理するため、ここではセッション確立を待って
 * トップへ戻すだけ。
 */
export function AuthCallbackPage() {
  const navigate = useNavigate()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let done = false
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (done) return
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        done = true
        navigate('/', { replace: true })
      }
    })
    // 既にセッションがある場合（リロード等）も戻す
    void supabase.auth.getSession().then(({ data }) => {
      if (!done && data.session) {
        done = true
        navigate('/', { replace: true })
      }
    })
    const timeout = setTimeout(() => {
      if (!done) setFailed(true)
    }, 10000)
    return () => {
      sub.subscription.unsubscribe()
      clearTimeout(timeout)
    }
  }, [navigate])

  return (
    <div className="content" style={{ textAlign: 'center', paddingTop: 80 }}>
      {failed ? (
        <>
          <p>ログイン処理に失敗しました。</p>
          <button className="cta" onClick={() => navigate('/', { replace: true })}>
            トップに戻る
          </button>
        </>
      ) : (
        <p>ログイン処理中です…</p>
      )}
    </div>
  )
}
