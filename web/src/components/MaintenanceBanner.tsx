import { useI18n } from '../contexts/I18nContext'
import { MAINTENANCE_MODE } from '../lib/maintenance'

/**
 * メンテナンスモード（アプリ内読み取り専用）バナー。
 *
 * 全ページ共通で表示するため App.tsx の共通 UI 領域に置く。
 * OfflineBanner と同じ画面最上部に固定表示する（オレンジ基調・警告色）。
 *
 * 表示条件は `VITE_MAINTENANCE_MODE=1`（詳細は `web/src/lib/maintenance.ts`）。
 */
export function MaintenanceBanner() {
  const { t } = useI18n()
  if (!MAINTENANCE_MODE) return null
  return (
    <div className="maintenance-banner" role="status" aria-live="polite">
      {t('maintenance.banner')}
    </div>
  )
}
