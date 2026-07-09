import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useI18n } from '../contexts/I18nContext'
import { supabase } from '../lib/supabase'

/**
 * OAuth コールバック。PKCE フローの code 交換は supabase-js の
 * detectSessionInUrl が自動処理するため、ここではセッション確立を待って
 * トップへ戻すだけ。ただし Supabase が失敗した時は URL のクエリに
 * error / error_code / error_description が返ってくるので、それを検知して
 * 汎用 or 固有メッセージを出す（identity_already_exists など）。
 */
export function AuthCallbackPage() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const [failure, setFailure] = useState<null | { code: string; description: string }>(null)

  useEffect(() => {
    // OAuth 失敗時は Supabase が /auth/callback?error=...&error_code=...&error_description=... で返す。
    // linkIdentity で identity_already_exists のケースがサイレント失敗になる問題への対処。
    const params = new URLSearchParams(window.location.search)
    const errorCode = params.get('error_code')
    const errorDescription = params.get('error_description') ?? ''
    if (errorCode) {
      setFailure({ code: errorCode, description: errorDescription })
      return
    }

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
      if (!done) setFailure({ code: 'timeout', description: '' })
    }, 10000)
    return () => {
      sub.subscription.unsubscribe()
      clearTimeout(timeout)
    }
  }, [navigate])

  if (failure) {
    const message =
      failure.code === 'identity_already_exists'
        ? t('authCallback.identityAlreadyExists')
        : failure.code === 'timeout'
          ? t('authCallback.timeout')
          : t('authCallback.generic', { detail: failure.description || failure.code })
    return (
      <div className="content" style={{ textAlign: 'center', paddingTop: 80 }}>
        <p style={{ whiteSpace: 'pre-line' }}>{message}</p>
        <button className="cta" onClick={() => navigate('/', { replace: true })}>
          {t('authCallback.backToTop')}
        </button>
      </div>
    )
  }

  return (
    <div className="content" style={{ textAlign: 'center', paddingTop: 80 }}>
      <p>{t('authCallback.processing')}</p>
    </div>
  )
}
