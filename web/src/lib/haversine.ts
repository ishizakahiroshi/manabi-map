// 直線距離（Haversine）の共有実装。
//
// このファイルは React 側（lib/geo.ts 経由）と Node ビルドスクリプト
// （scripts/gen-seo-pages.mjs が .ts のまま import する。Node 22.18+ の
// type stripping 前提・erasableSyntaxOnly）で共有される。
// 依存を一切持たない純関数だけを置くこと（region 等の値 import を足すと
// Node 直 import が拡張子解決で壊れる）。
// 静的 HTML と JS mount 後で距離が食い違うと信頼を落とすため、
// 距離計算はこの 1 実装だけを使う（docs/local/plan_seo-growth-strategy_c4 C1）。

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
