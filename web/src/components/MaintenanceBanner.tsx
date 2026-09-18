import { useEffect, useState } from 'react'
import { useI18n } from '../contexts/I18nContext'
import { useMaintenanceMode } from '../hooks/useMaintenanceMode'
import { MAINTENANCE_REFETCH_MIN_INTERVAL_MS } from '../lib/maintenance'

/**
 * メンテナンスモード（アプリ内読み取り専用）バナー。
 *
 * 全ページ共通で表示するため App.tsx の共通 UI 領域に置く。
 * OfflineBanner と同じ画面最上部に固定表示する（オレンジ基調・警告色）。
 *
 * 表示条件は app_config の runtime フラグ、または
 * `VITE_MAINTENANCE_MODE=1` の緊急保険（詳細は `web/src/hooks/useMaintenanceMode.tsx`）。
 *
 * 切替の伝達が途切れている間（`liveUpdates` が false）は、いま出している表示が
 * 古いかもしれないことも併せて出す。ON / OFF のどちらでも古くなりうるので、
 * メンテナンス中でなくてもこの 1 文だけを出すことがある。
 */
export function MaintenanceBanner() {
  const { t } = useI18n()
  const { isOn, liveUpdates } = useMaintenanceMode()
  // 初回 render は SSR と一致させ、伝達が途切れているかどうかは effect で取り込む。
  const [stale, setStale] = useState(false)

  useEffect(() => {
    if (liveUpdates) {
      setStale(false)
      return
    }
    // 起動直後の待ちと一瞬の切れ目で点滅させないよう、読み直しの最小間隔と同じだけ待つ。
    // 待っている間に復帰すれば cleanup で取り消され、利用者には何も出ない。
    const timer = window.setTimeout(() => setStale(true), MAINTENANCE_REFETCH_MIN_INTERVAL_MS)
    return () => window.clearTimeout(timer)
  }, [liveUpdates])

  const lines: string[] = []
  if (isOn) lines.push(t('maintenance.banner'))
  if (stale) lines.push(t('maintenance.stale'))
  if (lines.length === 0) return null

  return (
    <div className="maintenance-banner" role="status" aria-live="polite">
      {lines.join(' ')}
    </div>
  )
}
