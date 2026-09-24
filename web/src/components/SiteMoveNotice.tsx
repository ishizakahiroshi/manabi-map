import { useApp } from '../contexts/AppContext'
import { useI18n } from '../contexts/I18nContext'
import { SITE_MOVE } from '../data/site-move'
import { useSiteMoveNotice } from '../hooks/useSiteMoveNotice'
import { formatSwitchDateLabel } from '../lib/siteMove'

/*
 * 学校サイトの住所の移転（manabi-map.app → school.manabi-map.app）のお知らせ。
 * plan_school-subdomain-move.md C2。どれを出すかは web/src/lib/siteMove.ts が決める。
 *
 * どちらの部品も初回描画では何も出さない（useSiteMoveNotice がマウント後に決める）ので、
 * プリレンダーした HTML と hydration の初回描画は一致する。
 */

function useNoticeVars(switchDate: string | null) {
  const { locale } = useI18n()
  return {
    date: switchDate ? formatSwitchDateLabel(switchDate, locale) : '',
    oldHost: SITE_MOVE.oldHost,
    newHost: SITE_MOVE.newHost,
  }
}

/**
 * 予告 2（旧住所・LINE / Google でログインしている人）とお知らせ 3（新住所・全員）。
 * MaintenanceBanner と同じく App.tsx の共通の枠に置き、画面の上に重ねる。閉じたら出さない。
 */
export function SiteMoveBanner() {
  const { t } = useI18n()
  const { notice, switchDate, dismiss } = useSiteMoveNotice()
  const vars = useNoticeVars(switchDate)
  if (notice !== 'account-before' && notice !== 'after') return null

  const prefix = notice === 'after' ? 'siteMove.after' : 'siteMove.accountBefore'
  return (
    <div className="site-move-banner" role="status" aria-live="polite">
      <p className="site-move-banner-text">
        <b>{t(`${prefix}Title`, vars)}</b> {t(`${prefix}Body`, vars)}
      </p>
      <button
        type="button"
        className="site-move-banner-close"
        onClick={dismiss}
        aria-label={t('siteMove.dismiss')}
      >
        ×
      </button>
    </div>
  )
}

/**
 * 予告 1（旧住所・ゲストでお気に入りかメモか私の記録を持つ人）。マイページとお気に入りの上に出す。
 * 見逃すとデータを失うので閉じるボタンは付けない。連携は既存の LoginSheet（ゲストなら linkLINE /
 * linkGoogle で引き継ぐ）へつなぐ。
 */
export function SiteMoveGuestNotice({ hasUserData }: { hasUserData: boolean }) {
  const { t } = useI18n()
  const { setLoginOpen } = useApp()
  const { notice, switchDate } = useSiteMoveNotice(hasUserData)
  const vars = useNoticeVars(switchDate)
  if (notice !== 'guest-before') return null

  return (
    <div className="site-move-guest" role="note">
      <p className="site-move-guest-title">{t('siteMove.guestBeforeTitle', vars)}</p>
      <p className="site-move-guest-body">{t('siteMove.guestBeforeBody', vars)}</p>
      <button type="button" className="sb-login" onClick={() => setLoginOpen(true)}>
        🔗 {t('nav.linkData')}
      </button>
    </div>
  )
}
