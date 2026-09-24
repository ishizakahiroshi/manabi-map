import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { SITE_MOVE } from '../data/site-move'
import {
  SITE_MOVE_DISMISS_KEYS,
  decideSiteMoveNotice,
  resolveSiteMoveDevEnv,
  type ActiveSiteMoveNotice,
  type SiteMoveDismissals,
  type SiteMoveNotice,
} from '../lib/siteMove'

/** マウント後に端末から読む値。初回描画では読まない（プリレンダーと一致させるため） */
interface SiteMoveEnv {
  hostname: string
  nowMs: number
  switchDate: string | null
  force: ActiveSiteMoveNotice | null
  dismissals: SiteMoveDismissals
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function readSiteMoveEnv(): SiteMoveEnv {
  const nowMs = Date.now()
  let hostname = window.location.hostname
  let switchDate = SITE_MOVE.switchDate
  let force: ActiveSiteMoveNotice | null = null

  // 開発サーバーでだけ、URL のクエリでホスト・切替日の見立てと強制表示を受け付ける。
  // import.meta.env.DEV はビルド時に false へ置き換わり、このブロックごと本番から消える。
  if (import.meta.env.DEV) {
    const dev = resolveSiteMoveDevEnv(window.location.search, SITE_MOVE, nowMs)
    if (dev) {
      if (dev.reset) {
        for (const key of Object.values(SITE_MOVE_DISMISS_KEYS)) {
          try { localStorage.removeItem(key) } catch { /* noop */ }
        }
      }
      hostname = dev.hostname ?? hostname
      switchDate = dev.switchDate
      force = dev.force
    }
  }

  return {
    hostname,
    nowMs,
    switchDate,
    force,
    dismissals: {
      accountBefore: readStorage(SITE_MOVE_DISMISS_KEYS['account-before']),
      after: readStorage(SITE_MOVE_DISMISS_KEYS.after),
    },
  }
}

export interface SiteMoveNoticeState {
  notice: SiteMoveNotice
  /** 文言に出す切替日（notice が none 以外のときは必ず入っている） */
  switchDate: string | null
  /** 予告 2・お知らせ 3 を閉じる。閉じた記録は端末に残し、次に開いても出さない */
  dismiss: () => void
}

/**
 * 住所の移転のお知らせのうち、いまどれを出すか（判定は web/src/lib/siteMove.ts）。
 *
 * 初回描画では必ず `none` を返す。ホスト名・時刻・localStorage はマウント後の effect で読み、
 * ログイン状態も AuthProvider が effect で取り込むので、プリレンダーした HTML と初回描画は一致する。
 *
 * @param hasUserData お気に入り・メモ・私の記録を 1 件以上持つか。予告 1 だけが見るので、
 *   予告 2・お知らせ 3 だけを出す場所では省略してよい
 */
export function useSiteMoveNotice(hasUserData = false): SiteMoveNoticeState {
  const { kind: userKind } = useAuth()
  const [env, setEnv] = useState<SiteMoveEnv | null>(null)

  useEffect(() => {
    setEnv(readSiteMoveEnv())
  }, [])

  const notice = useMemo<SiteMoveNotice>(() => {
    if (!env) return 'none'
    return decideSiteMoveNotice({
      hostname: env.hostname,
      nowMs: env.nowMs,
      config: { ...SITE_MOVE, switchDate: env.switchDate },
      userKind,
      hasUserData,
      dismissals: env.dismissals,
      force: env.force,
    })
  }, [env, userKind, hasUserData])

  const dismiss = useCallback(() => {
    if (!env?.switchDate) return
    if (notice !== 'account-before' && notice !== 'after') return
    const switchDate = env.switchDate
    try {
      localStorage.setItem(SITE_MOVE_DISMISS_KEYS[notice], switchDate)
    } catch {
      /* 書けない端末では、この画面のあいだだけ閉じる（次に開くとまた出る） */
    }
    setEnv((cur) => cur && {
      ...cur,
      dismissals: notice === 'after'
        ? { ...cur.dismissals, after: switchDate }
        : { ...cur.dismissals, accountBefore: switchDate },
    })
  }, [env, notice])

  return { notice, switchDate: env?.switchDate ?? null, dismiss }
}
