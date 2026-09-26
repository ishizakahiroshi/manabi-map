/** Public, runtime-loaded book ads. No product data or affiliate IDs belong here. */
export const BOOK_AD_MAX_BYTES = 64 * 1024
export const BOOK_AD_REFRESH_MS = 5 * 60 * 1000
export const PUBLIC_OWNERSHIPS = ['prefectural', 'municipal', 'union'] as const
export interface BookAd {
  id: string
  prefectureCode: string
  title: string
  publisher: string
  examYear: number
  enabled: boolean
  startsAt?: string
  endsAt?: string
  coverHtml?: string
  links: { store: 'amazon' | 'rakuten'; href: string }[]
}
export interface BookAdCatalog { version: 1; enabled: boolean; ads: BookAd[] }

export const isPrefectureCode = (value: unknown): value is string =>
  typeof value === 'string' && /^(0[1-9]|[1-3][0-9]|4[0-7])$/.test(value)

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit
    && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
}
export function allowedBookUrl(value: unknown, hosts: readonly string[]): value is string {
  if (!text(value, 8192) || /[\s<>"\\]/.test(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && hosts.includes(url.hostname)
  } catch { return false }
}

/** Accept the provider's small image-only snippet unchanged; never repair unsafe HTML. */
export function isSafeBookCover(html: unknown): html is string {
  if (typeof html !== 'string' || html.length > 12000) return false
  // A deliberately small grammar, not a general HTML sanitizer. Reject all other markup.
  const match = /^<a((?:\s+[a-z]+="[^"<>]*")+)\s*><img((?:\s+[a-z]+="[^"<>]*")+)\s*\/?>\s*<\/a>$/.exec(html)
  if (!match) return false
  const attributes = (source: string, allowed: string[]): Record<string, string> | null => {
    const result: Record<string, string> = {}
    for (const attr of source.matchAll(/\s+([a-z]+)="([^"<>]*)"/g)) {
      const [, name, raw] = attr
      if (!allowed.includes(name) || Object.hasOwn(result, name)) return null
      // Only the normal ampersand escaping used in supplied URLs is supported.
      if (/&(?:#|[a-zA-Z]+;)/.test(raw.replaceAll('&amp;', ''))) return null
      result[name] = raw.replaceAll('&amp;', '&')
    }
    return result
  }
  const a = attributes(match[1], ['href', 'target', 'rel', 'style'])
  const img = attributes(match[2], ['src', 'border', 'style', 'alt', 'title', 'width', 'height'])
  if (!a || !img || a.target !== '_blank'
    || !['nofollow noopener noreferrer', 'nofollow sponsored noopener'].includes(a.rel)) return false
  if (a.style !== undefined && a.style !== 'word-wrap:break-word;') return false
  if (!allowedBookUrl(a.href, ['hb.afl.rakuten.co.jp'])) return false
  if (!allowedBookUrl(img.src, ['hbb.afl.rakuten.co.jp'])) return false
  const source = new URL(img.src)
  if (source.searchParams.get('s') !== '128x128' || source.searchParams.get('t') !== 'pict') return false
  if (!allowedBookUrl(source.searchParams.get('pc'), ['thumbnail.image.rakuten.co.jp'])) return false
  if (img.style !== undefined && !/^margin:\s*2px;?$/.test(img.style)) return false
  if (img.border !== undefined && img.border !== '0') return false
  return ['width', 'height'].every(key => img[key] === undefined || /^(?:[1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$/.test(img[key]))
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

/** Reject the whole file on an invalid entry, so operator mistakes cannot silently publish. */
export function parseBookAdCatalog(value: unknown): BookAdCatalog {
  if (!object(value) || value.version !== 1 || typeof value.enabled !== 'boolean' || !Array.isArray(value.ads) || value.ads.length > 100) {
    throw new Error('Invalid book ad catalog')
  }
  const ids = new Set<string>()
  const ads = value.ads.map((entry): BookAd => {
    if (!object(entry) || !text(entry.id, 80) || !/^[a-z0-9-]+$/.test(entry.id) || ids.has(entry.id)
      || !isPrefectureCode(entry.prefectureCode) || !text(entry.title, 200) || !text(entry.publisher, 100)
      || !Number.isInteger(entry.examYear) || Number(entry.examYear) < 2000 || Number(entry.examYear) > 2100
      || typeof entry.enabled !== 'boolean'
      || (entry.startsAt !== undefined && !validDate(entry.startsAt))
      || (entry.endsAt !== undefined && !validDate(entry.endsAt))
      || (typeof entry.startsAt === 'string' && typeof entry.endsAt === 'string' && entry.startsAt >= entry.endsAt)
      || (entry.coverHtml !== undefined && !isSafeBookCover(entry.coverHtml))
      || !Array.isArray(entry.links) || entry.links.length !== 2) throw new Error('Invalid book ad entry')
    const links = entry.links.map((link, index): BookAd['links'][number] => {
      const store = index === 0 ? 'amazon' : 'rakuten'
      const hosts = store === 'amazon' ? ['www.amazon.co.jp', 'amazon.co.jp', 'amzn.to'] : ['hb.afl.rakuten.co.jp']
      if (!object(link) || link.store !== store || !allowedBookUrl(link.href, hosts)) throw new Error('Invalid book ad link')
      return { store, href: link.href }
    })
    ids.add(entry.id)
    // Explicit public fields only; never forward arbitrary operator metadata.
    return {
      id: entry.id, prefectureCode: entry.prefectureCode, title: entry.title, publisher: entry.publisher,
      examYear: entry.examYear as number, enabled: entry.enabled, links,
      ...(entry.startsAt === undefined ? {} : { startsAt: entry.startsAt as string }),
      ...(entry.endsAt === undefined ? {} : { endsAt: entry.endsAt as string }),
      ...(entry.coverHtml === undefined ? {} : { coverHtml: entry.coverHtml as string }),
    }
  })
  return { version: 1, enabled: value.enabled, ads }
}

export function activeBookAds(catalog: BookAdCatalog, prefectureCode: string, now = Date.now()): BookAd[] {
  if (!catalog.enabled) return []
  return catalog.ads.filter(ad => ad.enabled && ad.prefectureCode === prefectureCode
    && (!ad.startsAt || Date.parse(ad.startsAt) <= now) && (!ad.endsAt || now < Date.parse(ad.endsAt)))
}

export function eligibleForBookAd(school: {
  type: string; ownership: string; lifecycle_status_code?: string | null; recruitment_status_code?: string | null
}): boolean {
  return school.type === 'high_school' && (PUBLIC_OWNERSHIPS as readonly string[]).includes(school.ownership)
    && !['planned', 'closing', 'closed'].includes(school.lifecycle_status_code ?? '')
    && !['no_external_high_school_intake', 'stopped'].includes(school.recruitment_status_code ?? '')
}
