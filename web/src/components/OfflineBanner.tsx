import { useEffect, useState } from 'react'
import { useI18n } from '../contexts/I18nContext'

export function OfflineBanner() {
  const { t } = useI18n()
  const [offline, setOffline] = useState(
    typeof navigator !== 'undefined' && 'onLine' in navigator ? !navigator.onLine : false,
  )

  useEffect(() => {
    const goOffline = () => setOffline(true)
    const goOnline = () => setOffline(false)
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