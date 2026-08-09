import { useEffect, useState } from 'react'
import { useI18n } from '../contexts/I18nContext'

export function OfflineBanner() {
  const { t } = useI18n()
  // 初回 render はSSRと一致させ、実際の接続状態はeffectで取り込む。
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    const goOffline = () => setOffline(true)
    const goOnline = () => setOffline(false)
    if ('onLine' in navigator) setOffline(!navigator.onLine)
    window.addEventListener('offline', goOffline)
    window.addEventListener('online', goOnline)
    return () => {
      window.removeEventListener('offline', goOffline)
      window.removeEventListener('online', goOnline)
    }
  }, [])

  if (!offline) return null
  return (
    <div className="offline-banner" role="status" aria-live="polite">
      {t('offline.message')}
    </div>
  )
}
