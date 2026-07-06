/**
 * 地図タイル provider / ジオコーダ provider ごとの attribution（出典）表記を集約する。
 * タイルソースは env `VITE_TILE_SOURCE`（'osm' | 'protomaps'）、ジオコーダは
 * `VITE_GEOCODER`（'gsi' | 'nominatim'）で切替わる。表示側はここの生成関数を参照する。
 */

// --- OpenStreetMap（生タイル・ODbL 出典。Protomaps 経由でも OSM 出典は必須） ---
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright'
export const OSM_ATTRIBUTION_TEXT = '© OpenStreetMap contributors'
export const OSM_ATTRIBUTION_HTML = `© <a href="${OSM_COPYRIGHT_URL}">OpenStreetMap contributors</a>`

// --- Protomaps（PMTiles ベクタタイル。ODbL により OSM クレジット併記） ---
export const PROTOMAPS_URL = 'https://protomaps.com'
export const PROTOMAPS_ATTRIBUTION_HTML =
  `<a href="${PROTOMAPS_URL}">Protomaps</a> © <a href="${OSM_COPYRIGHT_URL}">OpenStreetMap contributors</a>`

export type TileSource = 'osm' | 'protomaps'

/** タイルソース別の attribution HTML（Leaflet layer の attribution へ渡す） */
export function tileAttributionHtml(source: TileSource): string {
  return source === 'protomaps' ? PROTOMAPS_ATTRIBUTION_HTML : OSM_ATTRIBUTION_HTML
}

// --- ジオコーダ出典（住所検索の出典表記。UI 近傍 or 法務ページで表示） ---
/** 国土地理院コンテンツ利用規約（PDL1.0） */
export const GSI_TERMS_URL = 'https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html'
export const GSI_SEARCH_CREDIT_TEXT = '住所検索: 国土地理院'
export const GSI_SEARCH_CREDIT_HTML =
  `住所検索: <a href="${GSI_TERMS_URL}">国土地理院</a>`
export const NOMINATIM_SEARCH_CREDIT_TEXT = '住所検索: OpenStreetMap / Nominatim'
export const NOMINATIM_SEARCH_CREDIT_HTML =
  `住所検索: <a href="${OSM_COPYRIGHT_URL}">OpenStreetMap</a> / Nominatim`

export type Geocoder = 'gsi' | 'nominatim'

/** ジオコーダ別の出典テキスト（プレーン） */
export function geocoderCreditText(geocoder: Geocoder): string {
  return geocoder === 'gsi' ? GSI_SEARCH_CREDIT_TEXT : NOMINATIM_SEARCH_CREDIT_TEXT
}

/** ジオコーダ別の出典 HTML（リンク付き） */
export function geocoderCreditHtml(geocoder: Geocoder): string {
  return geocoder === 'gsi' ? GSI_SEARCH_CREDIT_HTML : NOMINATIM_SEARCH_CREDIT_HTML
}
