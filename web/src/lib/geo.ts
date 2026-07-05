import type { HomeLocation } from '../types/school'

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

/** 直線距離から自転車の粗い所要分（15km/h ≒ × 4 min/km） */
export function estimateBikeMinutes(distanceKm: number): number {
  return Math.max(1, Math.round(distanceKm * 4))
}

/** 直線距離から徒歩の粗い所要分（5km/h ≒ × 12 min/km） */
export function estimateWalkMinutes(distanceKm: number): number {
  return Math.max(1, Math.round(distanceKm * 12))
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

export function parsePostal(v: string): HomeLocation | null {
  const clean = v.replace(/[^0-9]/g, '')
  if (clean.length < 3 || clean.length > 7) return null
  if (!/^[\d\-－ー]+$/.test(v.trim())) return null
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
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
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

export function shortLabel(s: string): string {
  return (s || '').split(',').slice(0, 2).join(',').replace(/群馬県/, '') || s
}

export function googleMapsRoute(home: HomeLocation, school: { latitude: number; longitude: number }): string {
  return `https://www.google.com/maps/dir/${home.lat},${home.lng}/${school.latitude},${school.longitude}`
}
