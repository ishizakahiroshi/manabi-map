import type { HomeLocation } from '../types/school'
import {
  regionViewbox,
  prefectureForPostal3,
  addressInRegion,
  latLngInRegion,
  namesForeignPrefecture,
} from './region'

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

/** 全角数字→半角、全角ハイフン/長音→半角、先頭〒を除去した文字列を返す（判定用の正規化） */
function normalizePostalInput(v: string): string {
  return v
    .trim()
    .replace(/^〒/, '')
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[－ー―‐−–—]/g, '-')
    .trim()
}

/**
 * 郵便番号入力を「アクティブなリージョン内の暫定代表地点」に解決する（同期・即応）。
 *
 * これは UI が入力直後に即座に反応するための *粗い* 着地点（県の中心付近）。
 * 正確な地点は geocodeSearch() が Nominatim（郵便番号対応）で引き直して上書きする。
 * リージョン外の郵便番号は圏外として null を返す（全国の郵便番号表は持たない）。
 */
export function parsePostal(v: string): HomeLocation | null {
  const normalized = normalizePostalInput(v)
  if (!normalized) return null
  if (!/^[\d-]+$/.test(normalized)) return null
  const clean = normalized.replace(/[^0-9]/g, '')
  if (clean.length < 3 || clean.length > 7) return null
  const p3 = parseInt(clean.slice(0, 3), 10)
  const pref = prefectureForPostal3(p3)
  if (!pref) return null
  return { label: pref.label, lat: pref.center.lat, lng: pref.center.lng }
}

/** 入力が（リージョン内かどうかに関わらず）郵便番号の形をしているか */
function looksLikePostal(v: string): boolean {
  const normalized = normalizePostalInput(v)
  if (!/^[\d-]+$/.test(normalized)) return false
  const clean = normalized.replace(/[^0-9]/g, '')
  return clean.length >= 3 && clean.length <= 7
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
 * OSM Nominatim フリー検索（住所 / 施設名 / 駅名 / 郵便番号）。
 * Usage Policy: 1 req/sec・識別可能な User-Agent/Referer 必須（ブラウザ fetch では
 * Referer が自動送信される）。呼び出し側で 400ms デバウンスすること。
 *
 * withRegion で viewbox によりアクティブなリージョンを優先する。
 * bounded=true なら範囲外を除外する（＝リージョンの中だけを返す）。
 */
export async function searchNominatim(
  q: string,
  opts: { bounded?: boolean; withRegion?: boolean } = {},
): Promise<GeocodeCandidate[]> {
  const { bounded = false, withRegion = true } = opts
  const regionParams = withRegion
    ? `&viewbox=${encodeURIComponent(regionViewbox())}&bounded=${bounded ? 1 : 0}`
    : ''
  const url =
    'https://nominatim.openstreetmap.org/search' +
    '?format=jsonv2&limit=5&countrycodes=jp&addressdetails=1' +
    `&accept-language=ja${regionParams}&q=${encodeURIComponent(q)}`
  // 一過性の失敗（瞬断・レート制限）に備えて 1 回だけ間を置いてリトライする。
  // それでも失敗したら throw して呼び出し側の searchError UI に委ねる（握りつぶさない）。
  const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const data = (await res.json()) as NominatimItem[]
  if (!Array.isArray(data)) return []
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
 * 注意: **駅名・商業施設名・郵便番号は引けない**（AddressSearch は住所 index のみ）。
 * それらは geocodeSearch() 側で Nominatim へ振り分ける。
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
    .slice(0, 8)
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
 * 候補がアクティブなリージョン内か。
 * 1) リージョン内の県名を明示 → 圏内
 * 2) リージョン外の県名を明示（例: 関東版の「静岡県」） → 圏外（bbox の端に地理的に入っても除外）
 * 3) 県名が読み取れない → bbox で地理判定
 */
function candidateInRegion(c: GeocodeCandidate): boolean {
  const text = c.label + ' ' + c.sub
  if (addressInRegion(text)) return true
  if (namesForeignPrefecture(text)) return false
  return latLngInRegion(c.lat, c.lng)
}

/** リージョン内の候補だけに絞る（圏内が 1 件も無いときだけ圏外もそのまま残す） */
function preferRegion(candidates: GeocodeCandidate[]): GeocodeCandidate[] {
  const inside = candidates.filter(candidateInRegion)
  return inside.length > 0 ? inside : candidates
}

/**
 * 使用中のジオコーダ provider。env `VITE_GEOCODER`（'gsi' | 'nominatim'）で切替。
 * **既定は 'gsi'**（国土地理院。Nominatim の autocomplete 禁止 policy 回避・日本住所精度）。
 * 'nominatim' を明示した時のみ従来の OSM Nominatim へ切り戻す。
 */
export const ACTIVE_GEOCODER: 'gsi' | 'nominatim' =
  (import.meta.env.VITE_GEOCODER as string | undefined) === 'nominatim' ? 'nominatim' : 'gsi'

/** 店名・ランドマークにありがちな語（複合クエリからの店名除去のヒント） */
const PLACE_NOISE = /電機|電器|家電|ストア|ショップ|モール|センター|イオン|ヤマダ|ケーズ|ビック|ヨドバシ|店$/

/**
 * 複合クエリ（「沼田 ヤマダ電機 群馬」など）を地名トークンに分解して
 * リージョン内で引き直す。店名らしいトークンと都道府県名を落とし、地名候補で
 * Nominatim(bounded) を叩く。Nominatim の 1 req/sec policy に配慮し呼び出しは最大 1 回。
 */
async function fallbackTokens(q: string): Promise<GeocodeCandidate[]> {
  const tokens = q.split(/[\s　]+/).filter((tk) => tk.length > 0)
  if (tokens.length < 2) return []
  // 都道府県名そのもの・店名ノイズを除いた地名候補を優先。無ければ店名ノイズだけ除いた最長語。
  const geoTokens = tokens.filter((tk) => !PLACE_NOISE.test(tk) && !addressInRegion(tk))
  const primary =
    geoTokens.sort((a, b) => b.length - a.length)[0] ??
    tokens.filter((tk) => !PLACE_NOISE.test(tk)).sort((a, b) => b.length - a.length)[0]
  if (!primary) return []
  return preferRegion(await searchNominatim(primary, { bounded: true }))
}

/**
 * provider 抽象。呼び出し側は provider を意識せずこれを使う。
 * アクティブなリージョン（いまは関東 1 都 6 県）に閉じた検索体験を提供する:
 *   - 郵便番号 → Nominatim（リージョン内）。GSI は郵便番号を引けないため
 *   - 駅名     → Nominatim（リージョン優先）。GSI は駅を引けないため
 *   - 住所地名 → GSI（日本住所精度）→ リージョン内フィルタ&優先。圏内が無ければ Nominatim へ
 *   - 複合語   → 上記で空なら地名トークンに分解して Nominatim(bounded) で着地
 * env で 'nominatim' 明示時は Nominatim 一本（従来互換・リージョン優先付き）。
 */
export async function geocodeSearch(q: string): Promise<GeocodeCandidate[]> {
  const query = q.trim()
  if (!query) return []

  // 郵便番号は GSI が引けないので Nominatim（リージョン内に限定）で解決する。
  if (looksLikePostal(query)) {
    return preferRegion(await searchNominatim(query, { bounded: true }))
  }

  // 駅名は GSI が引けないので Nominatim（リージョン優先）へ。
  if (/駅|Station/i.test(query)) {
    return preferRegion(await searchNominatim(query, { bounded: false }))
  }

  // env で Nominatim を明示している場合は一本化（リージョン優先）。
  if (ACTIVE_GEOCODER === 'nominatim') {
    const items = preferRegion(await searchNominatim(query, { bounded: false }))
    return items.length > 0 ? items : fallbackTokens(query)
  }

  // 既定: GSI で住所・地名を引き、リージョン内を優先。
  const gsi = preferRegion(await searchGsi(query))
  if (gsi.some(candidateInRegion)) return gsi

  // GSI が圏内候補を返せない（例:「沼田」で北海道しか返らない / 複合語で 0 件）。
  // Nominatim をリージョン内に限定して引き直し、それでも空なら地名トークン分解で着地。
  const nomi = preferRegion(await searchNominatim(query, { bounded: true }))
  if (nomi.some(candidateInRegion)) return nomi
  const fallback = await fallbackTokens(query)
  return fallback.length > 0 ? fallback : nomi.length > 0 ? nomi : gsi
}

export function shortLabel(s: string): string {
  return (s || '').split(',').slice(0, 2).join(',').replace(/群馬県/, '') || s
}

export function googleMapsRoute(home: HomeLocation, school: { latitude: number; longitude: number }): string {
  return `https://www.google.com/maps/dir/${home.lat},${home.lng}/${school.latitude},${school.longitude}`
}
