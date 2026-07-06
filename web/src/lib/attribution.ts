/**
 * 地図タイル provider ごとの attribution テキストを集約する。
 * Protomaps 化（[[pending_map-and-geocoding-migration]]）時はここだけ差し替える。
 */
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright'
export const OSM_ATTRIBUTION_TEXT = '© OpenStreetMap contributors'
export const OSM_ATTRIBUTION_HTML = `© <a href="${OSM_COPYRIGHT_URL}">OpenStreetMap contributors</a>`
