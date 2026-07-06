import { useEffect, useState } from 'react'

/**
 * オフライン検知バナー（C5 フルエラー処理）。
 * navigator.onLine と online/offline イベントで接続断を検知し、画面上部に
 * 「オフラインです」の控えめなバナーを出す。復帰したら自動で消える。
 *
 * AppContext のトーストは一過性（1.6 秒で自動消去）で「継続中の状態」表示には
 * 向かないため、オフライン状態は専用の常設バナーで扱う。
 */
export function OfflineBanner() {
  // navigator.onLine は「回線断」までは検知できない場合もあるが、機内モード・
  // Wi-Fi 切断・ブラウザのオフライン化は拾える。誤検知しても実害は薄い案内文言にする。
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
      オフラインです。地図や学校情報の読み込みができない場合があります。
    </div>
  )
}
