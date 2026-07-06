import type { HomeLocation } from '../types/school'

/**
 * fetch の一過性失敗（ネットワーク瞬断・5xx・レート制限）に 1 回だけリトライする薄いラッパー。
 * ネットワーク例外（TypeError: Failed to fetch）と 5xx / 429 を再試行対象とし、
 * 4xx（=リクエスト自体の問題）は無駄打ちを避けて即返す。最終的に失敗したら
 * 例外 or 非 ok レスポンスを呼び出し側へそのまま返す（握りつぶさない）。
 */
async function fetchWithRetry(
  input: string,
  init?: RequestInit,
  retries = 1,
  delayMs = 600,
): Promise<Response> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(input, init)
      if (res.ok || (res.status < 500 && res.status !== 429)) return res
      lastErr = new Error('HTTP ' + res.status)
    } catch (err) {
      lastErr = err
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs))
  }
  throw lastErr instanceof Error ? lastErr : new Error('fetch failed')
}

/** 直線距離（Haversine・km） */
export function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371
  const toR = (x: number) => (x * Math.PI) / 180
  const dLat = toR(b.lat - a.lat)
  const dLng = toR(b.lng - a.lng)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

/** 概算通学時間（§12.2: 直線距離 × 1.3 ÷ 40km/h・車前提の粗い目安） */
export function estimateCommuteMinutes(distanceKm: number): number {
  return Math.round(((distanceKm * 1.3) / 40) * 60)
}

/** 直線距離から車の粗い所要分（× 1.5 min/km） */
export function estimateCarMinutes(distanceKm: number): number {
  return Math.max(1, Math.round(distanceKm * 1.5))
}

/** 直線距離から公共交通の粗い所要分（× 2.5 min/km） */
export function estimateTransitMinutes(distanceKm: number): number {
  return Math.max(1, Math.round(distanceKm * 2.5))
}

/** 直線距離から自転車の粗い所要分（× 5 min/km・道の迂回や登坂を考慮した現実寄り係数） */
export function estimateBikeMinutes(distanceKm: number): number {
  return Math.max(1, Math.round(distanceKm * 5))
}

/** 直線距離から徒歩の粗い所要分（× 15 min/km・道の迂回や登坂を考慮した現実寄り係数） */
export function estimateWalkMinutes(distanceKm: number): number {
  return Math.max(1, Math.round(distanceKm * 15))
}

/** 郵便番号 → 代表地点（群馬中心の簡易マップ・郵便番号先頭3桁） */
export const POSTAL_MAP: Record<string, HomeLocation> = {
  '370': { label: '高崎周辺', lat: 36.322, lng: 139.0033 },
  '371': { label: '前橋周辺', lat: 36.3907, lng: 139.0604 },
  '372': { label: '伊勢崎周辺', lat: 36.3213, lng: 139.1929 },
  '373': { label: '太田周辺', lat: 36.2911, lng: 139.3757 },
  '374': { label: '館林周辺', lat: 36.2437, lng: 139.5417 },
  '375': { label: '藤岡周辺', lat: 36.2593, lng: 139.0745 },
  '376': { label: '桐生周辺', lat: 36.4048, lng: 139.33 },
  '377': { label: '吾妻・渋川周辺', lat: 36.5, lng: 138.98 },
  '378': { label: '沼田周辺', lat: 36.6459, lng: 139.0442 },
  '379': { label: 'みなかみ・榛東周辺', lat: 36.6779, lng: 138.995 },
}

/** 全角数字→半角、全角ハイフン/長音→半角、先頭〒を除去した文字列を返す（判定用の正規化） */
function normalizePostalInput(v: string): string {
  return v
    .trim()
    .replace(/^〒/, '')
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[－ー―‐−–—]/g, '-')
    .trim()
}

export function parsePostal(v: string): HomeLocation | null {
  const normalized = normalizePostalInput(v)
  if (!normalized) return null
  if (!/^[\d-]+$/.test(normalized)) return null
  const clean = normalized.replace(/[^0-9]/g, '')
  if (clean.length < 3 || clean.length > 7) return null
  const p3 = clean.slice(0, 3)
  return POSTAL_MAP[p3] ?? null
}

export interface GeocodeCandidate {
  label: string
  sub: string
  icon: string
  lat: number
  lng: number
}

interface NominatimItem {
  display_name?: string
  lat: string
  lon: string
  category?: string
  class?: string
  type?: string
}

function categoryLabel(it: NominatimItem): { icon: string; label: string } {
  const c = it.category ?? it.class
  if (c === 'shop' || c === 'amenity' || c === 'tourism' || c === 'leisure') {
    return { icon: '🏪', label: '施設・お店' }
  }
  if (c === 'highway' || c === 'building' || c === 'place') {
    return { icon: '📍', label: '住所・地点' }
  }
  if (it.type === 'postcode' || /〒|\d{3}-?\d{4}/.test(it.display_name ?? '')) {
    return { icon: '✉️', label: '郵便番号' }
  }
  return { icon: '📍', label: c ?? '場所' }
}

/**
 * OSM Nominatim フリー検索（住所 / 施設名 / 駅名）。
 * Usage Policy: 1 req/sec・識別可能な User-Agent/Referer 必須（ブラウザ fetch では
 * Referer が自動送信される）。呼び出し側で 400ms デバウンスすること。
 */
export async function searchNominatim(q: string): Promise<GeocodeCandidate[]> {
  const url =
    'https://nominatim.openstreetmap.org/search' +
    '?format=jsonv2&limit=5&countrycodes=jp&addressdetails=1' +
    `&accept-language=ja&q=${encodeURIComponent(q)}`
  // 一過性の失敗（瞬断・レート制限）に備えて 1 回だけ間を置いてリトライする。
  // それでも失敗したら throw して呼び出し側の searchError UI に委ねる（握りつぶさない）。
  const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const data = (await res.json()) as NominatimItem[]
  return data.map((it) => {
    const name = it.display_name ?? ''
    const cat = categoryLabel(it)
    return {
      label: name.split(',').slice(0, 2).join(',') || name,
      sub: cat.label + (name.split(',').slice(2).join(',') ? ' ・ ' + name.split(',').slice(2).join(',') : ''),
      icon: cat.icon,
      lat: parseFloat(it.lat),
      lng: parseFloat(it.lon),
    }
  })
}

/**
 * 国土地理院 住所検索 API のレスポンス要素（素の Feature 配列で返る）。
 * coordinates は **[lng, lat] 順**（GeoJSON 準拠）である点に注意。
 * 分類情報（category/type）は無く、駅・地名には properties.dataSource が付く。
 */
interface GsiItem {
  geometry?: { coordinates?: [number, number]; type?: string }
  type?: string
  properties?: { addressCode?: string; title?: string; dataSource?: string }
}

/**
 * 国土地理院 AddressSearch フリー検索（住所・地名）。
 * 無料・無登録・API キー不要。国土地理院コンテンツ利用規約（PDL1.0）に基づき
 * 商用可・出典表記必須（attribution.ts の GSI クレジットで表示）。
 * 呼び出し側で 400ms デバウンスすること。
 *
 * 注意: **駅名・商業施設名は引けない**（AddressSearch は住所 index のみ。
 * 「東京駅」等の駅クエリは 東京→東 のような部分マッチで無関係な地名が返るため、
 * geocodeSearch() 側で "駅|Station" を含むクエリは Nominatim へ振り分ける）。
 */
export async function searchGsi(q: string): Promise<GeocodeCandidate[]> {
  const url =
    'https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(q)
  // Nominatim と同様、一過性の失敗（瞬断・レート制限）に 1 回だけリトライする。
  const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const data = (await res.json()) as GsiItem[]
  if (!Array.isArray(data)) return []
  return data
    .filter((it) => Array.isArray(it.geometry?.coordinates))
    .slice(0, 5)
    .map((it) => {
      // GSI は [lng, lat] 順。lat/lng へ取り違えなく展開する。
      const [lng, lat] = it.geometry!.coordinates as [number, number]
      const title = it.properties?.title ?? ''
      const isStation = !!it.properties?.dataSource
      return {
        label: title || q,
        sub: isStation ? '駅・地点' : '住所・地点',
        icon: isStation ? '🚉' : '📍',
        lat,
        lng,
      }
    })
}

/**
 * 使用中のジオコーダ provider。env `VITE_GEOCODER`（'gsi' | 'nominatim'）で切替。
 * **既定は 'gsi'**（国土地理院。Nominatim の autocomplete 禁止 policy 回避・日本住所精度）。
 * 'nominatim' を明示した時のみ従来の OSM Nominatim へ切り戻す。
 */
export const ACTIVE_GEOCODER: 'gsi' | 'nominatim' =
  (import.meta.env.VITE_GEOCODER as string | undefined) === 'nominatim' ? 'nominatim' : 'gsi'

/**
 * provider 抽象。呼び出し側は provider を意識せずこれを使う。
 * GSI 既定でも 駅名・"Station" を含むクエリだけは Nominatim へ振り分ける
 * （GSI AddressSearch は駅を引けず、東京駅→北海道東区のような誤マッチを返すため）。
 */
export async function geocodeSearch(q: string): Promise<GeocodeCandidate[]> {
  if (ACTIVE_GEOCODER === 'nominatim') return searchNominatim(q)
  if (/駅|Station/i.test(q)) return searchNominatim(q)
  return searchGsi(q)
}

export function shortLabel(s: string): string {
  return (s || '').split(',').slice(0, 2).join(',').replace(/群馬県/, '') || s
}

export function googleMapsRoute(home: HomeLocation, school: { latitude: number; longitude: number }): string {
  return `https://www.google.com/maps/dir/${home.lat},${home.lng}/${school.latitude},${school.longitude}`
}
