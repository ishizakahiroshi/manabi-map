import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useI18n } from '../contexts/I18nContext'
import { useFamilyShare } from '../hooks/useFamilyShare'

const PENDING_KEY = 'mm.pending_family_invite'

/**
 * 同一 token の accept をモジュール単位で共有する。
 * React StrictMode の二重マウントで「1 回目成功・2 回目 already used → error 表示」を防ぐ。
 */
const acceptInFlight = new Map<string, Promise<string>>()

type JoinStatus = 'idle' | 'accepting' | 'done' | 'error' | 'need-login' | 'no-token'

/**
 * 家族グループ招待の受諾ページ（/family/join?token=...）。
 * - ログイン済みなら即受諾 → /favorites へ。
 * - 未ログイン（匿名含む）なら LINE / Google ログインを促す。ログインは
 *   /auth/callback → トップへ戻る仕様のため、トークンは localStorage に退避し、
 *   ログイン後にこのリンクを再度開けば受諾できる旨を案内する。
 */
export function FamilyJoinPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { session, kind, signInLINE, signInGoogle } = useAuth()
  const { acceptInvite } = useFamilyShare()
  const { t } = useI18n()
  const [status, setStatus] = useState<JoinStatus>('idle')

  // URL から取得できなければ localStorage の退避分（ログイン往復後）を使う
  const token = params.get('token') || localStorage.getItem(PENDING_KEY) || ''

  useEffect(() => {
    if (!token) {
      setStatus('no-token')
      return
    }
    try {
      localStorage.setItem(PENDING_KEY, token)
    } catch { /* localStorage 不可環境では往復リカバリは諦める */ }

    if (!session) {
      setStatus('need-login')
      return
    }
    // 匿名ログインでも受諾自体は成立するが、共有は実ログインが前提。
    // ここでは session があれば受諾を試みる（匿名→後で連携でも引き継がれる）。
    let cancelled = false
    setStatus('accepting')
    void (async () => {
      try {
        let pending = acceptInFlight.get(token)
        if (!pending) {
          pending = acceptInvite(token).finally(() => {
            // 成功後も短時間残して StrictMode の再マウントに耐える
            setTimeout(() => acceptInFlight.delete(token), 5000)
          })
          acceptInFlight.set(token, pending)
        }
        await pending
        try { localStorage.removeItem(PENDING_KEY) } catch { /* noop */ }
        if (cancelled) return
        setStatus('done')
        setTimeout(() => navigate('/favorites', { replace: true }), 1200)
      } catch (err) {
        acceptInFlight.delete(token)
        if (cancelled) return
        console.error('accept invite failed:', (err as Error)?.message)
        setStatus('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token, session, acceptInvite, navigate])

  const doLogin = useCallback(
    async (provider: 'line' | 'google') => {
      try {
        if (provider === 'line') await signInLINE()
        else await signInGoogle()
      } catch {
        setStatus('error')
      }
    },
    [signInLINE, signInGoogle],
  )

  return (
    <main
      id="main-content"
      className="content"
      tabIndex={-1}
      style={{ textAlign: 'center', paddingTop: 64, paddingLeft: 20, paddingRight: 20 }}
    >
      <h2 className="detail-title" style={{ marginBottom: 16 }}>
        {t('family.inviteTitle')}
      </h2>

      {status === 'no-token' && (
        <>
          <p>{t('family.inviteBad')}</p>
          <button className="cta" onClick={() => navigate('/', { replace: true })}>
            {t('family.backTop')}
          </button>
        </>
      )}

      {status === 'accepting' && <p>{t('family.accepting')}</p>}

      {status === 'done' && <p>{t('family.accepted')}</p>}

      {status === 'error' && (
        <>
          <p>{t('family.acceptFail')}</p>
          <button className="cta" onClick={() => navigate('/', { replace: true })}>
            {t('family.backTop')}
          </button>
        </>
      )}

      {status === 'need-login' && (
        <>
          <p className="login-note">{t('family.needLoginJoin')}</p>
          {kind === 'anon' && <p className="login-caution">{t('family.anonJoin')}</p>}
          <button className="login-line" onClick={() => void doLogin('line')} style={{ marginTop: 8 }}>
            <span className="li-icon">💚</span>
            <span className="li-tx">{t('family.lineLogin')}</span>
          </button>
          <button className="login-google" onClick={() => void doLogin('google')}>
            <span className="li-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 48 48" role="img" aria-label={t('common.google')}>
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
              </svg>
            </span>
            <span className="li-tx">{t('family.googleLogin')}</span>
          </button>
        </>
      )}
    </main>
  )
}