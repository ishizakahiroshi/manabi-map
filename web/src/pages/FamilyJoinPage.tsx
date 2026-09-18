import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { useI18n } from '../contexts/I18nContext'
import { useFamilyShare } from '../hooks/useFamilyShare'
import { supabase } from '../lib/supabase'
import { OAuthButton } from '../components/OAuthButton'

const PENDING_KEY = 'mm.pending_family_invite'
const PENDING_TTL_MS = 10 * 60 * 1000

interface PendingInvite {
  token: string
  userId: string | null
  savedAt: number
}

type InviteUrlSource = 'fragment' | 'query'

interface UrlInvite {
  token: string
  source: InviteUrlSource
}

let memoryPendingInvite: PendingInvite | null = null

function parsePendingInviteValue(value: unknown, now: number): PendingInvite | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<PendingInvite>
  if (
    typeof candidate.token !== 'string' || !candidate.token ||
    (typeof candidate.userId !== 'string' && candidate.userId !== null) ||
    typeof candidate.savedAt !== 'number' || !Number.isFinite(candidate.savedAt) ||
    now - candidate.savedAt > PENDING_TTL_MS || now < candidate.savedAt
  ) return null
  return { token: candidate.token, userId: candidate.userId ?? null, savedAt: candidate.savedAt }
}

/** 招待トークンを短時間だけ保持し、保存時の実ユーザーと紐付ける。 */
export function parsePendingInvite(raw: string | null, now = Date.now()): PendingInvite | null {
  if (!raw) return null
  try {
    return parsePendingInviteValue(JSON.parse(raw), now)
  } catch {
    return null
  }
}

/** fragmentの新形式を優先し、旧query形式は発行済みlinkの互換読取だけ許可する。 */
export function readInviteFromUrl(search: string, hash: string): UrlInvite | null {
  const fragmentToken = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get('token')
  if (fragmentToken) return { token: fragmentToken, source: 'fragment' }
  const queryToken = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('token')
  if (queryToken) return { token: queryToken, source: 'query' }
  return null
}

/** 招待tokenをpendingへ退避した後、URLからtokenだけを除去する。 */
export function stripInviteTokenFromUrl(source: InviteUrlSource): void {
  if (typeof window === 'undefined') return
  try {
    const current = new URL(window.location.href)
    current.searchParams.delete('token')
    if (source === 'fragment') current.hash = ''
    window.history.replaceState(window.history.state, '', `${current.pathname}${current.search}${current.hash}`)
  } catch {
    // URL/history が利用できない環境では、pending保存だけを維持する。
  }
}

function pendingBelongsToUser(pending: PendingInvite, currentUserId: string | null): boolean {
  return pending.userId === null || pending.userId === currentUserId
}

function readPendingToken(currentUserId: string | null): string {
  const memoryPending = parsePendingInviteValue(memoryPendingInvite, Date.now())
  if (memoryPending && pendingBelongsToUser(memoryPending, currentUserId)) return memoryPending.token
  memoryPendingInvite = null
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    const pending = parsePendingInvite(raw)
    if (!pending || !pendingBelongsToUser(pending, currentUserId)) {
      if (raw) localStorage.removeItem(PENDING_KEY)
      return ''
    }
    memoryPendingInvite = pending
    return pending.token
  } catch {
    return ''
  }
}

function savePendingToken(token: string, userId: string | null): void {
  const pending = { token, userId, savedAt: Date.now() }
  memoryPendingInvite = pending
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending))
  } catch { /* localStorage 不可環境では往復リカバリを諦める */ }
}

function clearPendingToken(): void {
  memoryPendingInvite = null
  try { localStorage.removeItem(PENDING_KEY) } catch { /* noop */ }
}

/**
 * 受諾前に「どのグループへの招待か」だけを引く（受諾はしない）。
 * 招待トークンを持つ本人が、参加先の名前を見てから決められるようにするための読み取り。
 */
export async function fetchInviteGroupName(token: string): Promise<string> {
  const { data, error } = await supabase.rpc('preview_family_invite', { p_token: token })
  if (error) throw error
  return typeof data === 'string' ? data : ''
}

type JoinStatus =
  | 'idle'
  | 'checking'
  | 'confirm'
  | 'accepting'
  | 'done'
  | 'error'
  | 'invalid'
  | 'need-login'
  | 'no-token'

/**
 * 家族グループ招待の受諾ページ（/family/join#token=...）。
 * - リンクを開いただけでは受諾しない。参加先のグループ名を表示し、
 *   「参加する」を押したときだけ受諾 RPC を発行する（誤タップ・自動遷移での参加を防ぐ）。
 * - 未ログイン（匿名含む）なら LINE / Google ログインを促す。ログインは
 *   /auth/callback → トップへ戻る仕様のため、トークンは localStorage に退避し、
 *   ログイン後にこのリンクを再度開けば受諾できる旨を案内する。
 */
export function FamilyJoinPage() {
  const navigate = useNavigate()
  const routerLocation = useLocation()
  const { session, kind, signInLINE, signInGoogle } = useAuth()
  const { acceptInvite } = useFamilyShare()
  const { t } = useI18n()
  const [status, setStatus] = useState<JoinStatus>('idle')
  const [groupName, setGroupName] = useState('')

  // fragmentを優先し、旧queryは互換読取だけにする。URLから取得できなければ
  // localStorage / memoryの退避分（ログイン往復後）を使う。
  const durableUserId = kind === 'anon' ? null : session?.user.id ?? null
  const urlInvite = readInviteFromUrl(routerLocation.search, routerLocation.hash)
  const urlInviteSource = urlInvite?.source ?? null
  const token = urlInvite?.token || readPendingToken(durableUserId)

  useEffect(() => {
    if (!token) {
      setStatus('no-token')
      return
    }
    // 匿名セッションの UUID はログイン往復で変わり得るため、実ログイン時だけ
    // user_id と紐付ける。実ユーザーの切替時は readPendingToken が破棄する。
    savePendingToken(token, durableUserId)
    if (urlInviteSource) stripInviteTokenFromUrl(urlInviteSource)

    // 招待は実ログイン済みの家族だけが受諾できる。匿名ユーザーは認証済みでも
    // DB RPC が拒否するため、先に明示的なログイン導線へ戻す。
    if (!session || kind === 'anon') {
      setStatus('need-login')
      return
    }
    // ここでは参加先の名前を読むだけで、受諾はしない（受諾は confirmJoin だけが行う）。
    let cancelled = false
    setStatus('checking')
    void (async () => {
      try {
        const name = await fetchInviteGroupName(token)
        if (cancelled) return
        setGroupName(name)
        setStatus('confirm')
      } catch (err) {
        if (cancelled) return
        console.error('preview invite failed:', (err as Error)?.message)
        // 受諾していないので、使えない招待トークンは端末に残さない。
        clearPendingToken()
        setStatus('invalid')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token, durableUserId, session, kind, urlInviteSource])

  /** 「参加する」を押したときだけ受諾 RPC を発行する。 */
  const confirmJoin = useCallback(async () => {
    if (!token) return
    setStatus('accepting')
    try {
      await acceptInvite(token)
      setStatus('done')
      setTimeout(() => navigate('/favorites', { replace: true }), 1200)
    } catch (err) {
      console.error('accept invite failed:', (err as Error)?.message)
      setStatus('error')
    } finally {
      // 成功・失敗を問わず、受諾処理が終わったトークンを端末に残さない。
      clearPendingToken()
    }
  }, [token, acceptInvite, navigate])

  /** 参加しない選択。退避したトークンも捨てて、リンクを開く前の状態に戻す。 */
  const declineJoin = useCallback(() => {
    clearPendingToken()
    navigate('/', { replace: true })
  }, [navigate])

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

      {status === 'invalid' && (
        <>
          <p>{t('family.inviteUnavailable')}</p>
          <button className="cta" onClick={() => navigate('/', { replace: true })}>
            {t('family.backTop')}
          </button>
        </>
      )}

      {status === 'checking' && <p>{t('family.checkingInvite')}</p>}

      {status === 'confirm' && (
        <>
          <p>{t('family.confirmJoin', { group: groupName || t('family.unnamedGroup') })}</p>
          <p className="login-note">{t('family.confirmNote')}</p>
          <button className="cta" onClick={() => void confirmJoin()}>
            {t('family.confirmAccept')}
          </button>
          <button className="cta secondary" onClick={declineJoin}>
            {t('family.confirmDecline')}
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
          <OAuthButton provider="line" label={t('family.lineLogin')} onClick={() => void doLogin('line')} className="oauth-button-first" />
          <OAuthButton provider="google" label={t('family.googleLogin')} onClick={() => void doLogin('google')} />
        </>
      )}
    </main>
  )
}
