import { useEffect, useState } from 'react'
import type { School } from '../types/school'
import { prefectureByName } from '../lib/prefecture'
import { activeBookAds, BOOK_AD_REFRESH_MS, eligibleForBookAd } from '../lib/bookAdCatalog'
import { fetchBookAdCatalog } from '../lib/bookAdSource'
import type { BookAd } from '../lib/bookAdCatalog'
import { BookAdSlot } from './BookAdSlot'

/** The SSR and hydration render both start empty. Only the selected prefecture is fetched. */
export function SchoolBookAd({ school }: { school: School }) {
  const code = eligibleForBookAd(school) ? prefectureByName(school.prefecture)?.code : undefined
  const [result, setResult] = useState<{ code: string; ad?: BookAd } | null>(null)

  useEffect(() => {
    if (!code) return
    let disposed = false
    let inFlight = false
    let controller: AbortController | undefined
    const refresh = async () => {
      if (inFlight) return
      inFlight = true
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 5000)
      try {
        const catalog = await fetchBookAdCatalog(code, controller.signal)
        if (!disposed) setResult({ code, ad: activeBookAds(catalog, code)[0] })
      } catch {
        if (!disposed) setResult({ code })
      } finally {
        clearTimeout(timeout)
        inFlight = false
      }
    }
    void refresh()
    const timer = setInterval(() => { if (!document.hidden) void refresh() }, BOOK_AD_REFRESH_MS)
    const onVisible = () => { if (!document.hidden) void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      disposed = true
      controller?.abort()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [code])

  const ad = result?.code === code ? result?.ad : undefined
  // Expiration is also reevaluated on any parent render, including switching schools.
  if (!code || !ad || !activeBookAds({ version: 1, enabled: true, ads: [ad] }, code).length) return null
  return <BookAdSlot ad={ad} schoolId={school.id} prefecture={school.prefecture} />
}
