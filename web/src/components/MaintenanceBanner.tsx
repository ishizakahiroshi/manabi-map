import { useI18n } from '../contexts/I18nContext'
import { useMaintenanceMode } from '../hooks/useMaintenanceMode'

/**
 * メンテナンスモード（アプリ内読み取り専用）バナー。
 *
 * 全ページ共通で表示するため App.tsx の共通 UI 領域に置く。
 * OfflineBanner と同じ画面最上部に固定表示する（オレンジ基調・警告色）。
 *
 * 表示条件は app_config の runtime フラグ、または
 * `VITE_MAINTENANCE_MODE=1` の緊急保険（詳細は `web/src/hooks/useMaintenanceMode.tsx`）。
 *
 * 直近の読み直しに失敗している間（`lastReadFailed` が true）は、いま出している表示が
 * 古いかもしれないことも併せて出す。ON / OFF のどちらでも古くなりうるので、
 * メンテナンス中でなくてもこの 1 文だけを出すことがある。次に読めた時点で消える。
 */
export function MaintenanceBanner() {
  const { t } = useI18n()
  // lastReadFailed は読み込み（effect の中）が終わるまで false なので、初回 render は SSR と一致する。
  const { isOn, lastReadFailed } = useMaintenanceMode()

  const lines: string[] = []
  if (isOn) lines.push(t('maintenance.banner'))
  if (lastReadFailed) lines.push(t('maintenance.stale'))
  if (lines.length === 0) return null

  return (
    <div className="maintenance-banner" role="status" aria-live="polite">
      {lines.join(' ')}
    </div>
  )
}
