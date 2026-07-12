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
 */
export function MaintenanceBanner() {
  const { t } = useI18n()
  const { isOn } = useMaintenanceMode()
  if (!isOn) return null
  return (
    <div className="maintenance-banner" role="status" aria-live="polite">
      {t('maintenance.banner')}
    </div>
  )
}
