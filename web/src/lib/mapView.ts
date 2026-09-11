import { ACTIVE_REGION } from './region'
import type { HomeLocation } from '../types/school'

/**
 * 地図の初期表示を端末に覚えるキー。
 *
 * 覚えるのは「設定地点の座標」と「通学圏のズーム段階」だけで、見ていた場所は覚えない
 * （地図を開いたら自分の周りが出る、という約束は変えない）。
 * 通学圏の広さは設定地点と学校の分布だけで決まる（lib/geo.ts homeViewRadiusKm）ので、
 * 同じ端末・同じ設定地点なら毎回同じズーム段階に着地する。
 * これを覚えておくと、全国データ（0.8MB）が届くまでのあいだ z5 の全国表示を挟まずに済み、
 * 1 度も見られないまま捨てられるタイルが無くなる（plan_data-usage-audit.md C3 案 A）。
 */
const HOME_ZOOM_KEY = 'mm.map_home_zoom'

/** localStorage に入れる形。座標は「どの設定地点に対するズームか」の照合用 */
export interface StoredHomeZoom {
  lat: number
  lng: number
  zoom: number
}

/** Leaflet 側の tileLayer maxZoom と揃える（MapPage の addOsmTileLayer） */
const MAX_ZOOM = 18
const MIN_ZOOM = 1

/** 座標の一致判定。mm.home は小数 3 桁へ丸めて保存されるので厳密比較でよいが、余裕を持たせる */
function sameCoordinate(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6
}

/** localStorage の値を検証する純粋関数。壊れた JSON・範囲外のズームは地図へ渡さない。 */
export function parseStoredHomeZoom(raw: string | null): StoredHomeZoom | null {
  try {
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const candidate = value as Partial<StoredHomeZoom>
    const { lat, lng, zoom } = candidate
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    if (lat! < -90 || lat! > 90 || lng! < -180 || lng! > 180) return null
    if (!Number.isInteger(zoom) || zoom! < MIN_ZOOM || zoom! > MAX_ZOOM) return null
    return { lat: lat!, lng: lng!, zoom: zoom! }
  } catch {
    return null
  }
}

/** 覚えたズームが、いまの設定地点に対して使えるか */
export function matchesHome(stored: StoredHomeZoom | null, home: HomeLocation | null): boolean {
  if (!stored || !home) return false
  return sameCoordinate(stored.lat, home.lat) && sameCoordinate(stored.lng, home.lng)
}

/** 地図の初期表示。restored=true は「自分の推測で寄せた」ことを表す */
export interface InitialMapView {
  lat: number
  lng: number
  zoom: number
  restored: boolean
}

/** 全国表示（設定地点が無い人が最後に見る画面そのもの） */
export function nationalMapView(): InitialMapView {
  return {
    lat: ACTIVE_REGION.mapCenter.lat,
    lng: ACTIVE_REGION.mapCenter.lng,
    zoom: ACTIVE_REGION.mapZoom,
    restored: false,
  }
}

/**
 * 保存値から初期表示を決める純粋関数（テスト用に localStorage を外に出してある）。
 * 設定地点と、その地点に対するズーム段階の両方がそろった時だけ通学圏へ寄せる。
 */
export function resolveInitialMapView(
  home: HomeLocation | null,
  stored: StoredHomeZoom | null,
): InitialMapView {
  if (!home || !matchesHome(stored, home)) return nationalMapView()
  return { lat: home.lat, lng: home.lng, zoom: stored!.zoom, restored: true }
}

/** localStorage から覚えたズームを読む（読めない環境では null） */
export function loadStoredHomeZoom(): StoredHomeZoom | null {
  try {
    return parseStoredHomeZoom(localStorage.getItem(HOME_ZOOM_KEY))
  } catch {
    return null
  }
}

/** 通学圏へ寄せた時のズーム段階を覚える。書けない環境では覚えないだけで、動作は変わらない */
export function rememberHomeZoom(home: HomeLocation, zoom: number): void {
  if (!Number.isFinite(zoom)) return
  const value: StoredHomeZoom = {
    lat: home.lat,
    lng: home.lng,
    zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom))),
  }
  try {
    localStorage.setItem(HOME_ZOOM_KEY, JSON.stringify(value))
  } catch {
    /* localStorage 不可の環境では覚えない（次回また全国表示を挟むだけ） */
  }
}
