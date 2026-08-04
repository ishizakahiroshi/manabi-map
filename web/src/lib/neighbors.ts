// Node（scripts/gen-seo-pages.mjs）から type stripping で直 import されるため、
// 相対 import は拡張子付き必須（Node ESM は specifier を書き換えない）。
import { haversine } from './haversine.ts'

// 「この高校の近くにある高校」の選定・表示ロジック（docs/local/plan_seo-growth-strategy_c4 C1）。
//
// React 側（SchoolDetailSheet）と Node ビルドスクリプト
// （scripts/gen-seo-pages.mjs が .ts のまま import する。Node 22.18+ の
// type stripping 前提・erasableSyntaxOnly）で共有される。静的 HTML と
// JS mount 後で校名・距離が食い違うと信頼を落とすため、この 1 実装だけを使う。
//
// 並び順は直線距離の近い順のみ。偏差値順・倍率順のソートは実装しない
// （ランキングサイト化の禁止線・docs/local/plan_seo-growth-strategy.md §やらないこと）。

export interface NeighborSchool {
  id: string
  prefecture: string
  city: string | null
  latitude: number
  longitude: number
}

export interface NeighborHit<T extends NeighborSchool> {
  school: T
  distanceKm: number
}

/** 表示リストの上限。同一市区町村は全件が原則だが、政令市（横浜市 91 校等）で
 * ページが学校名簿化するのを防ぐため、子 plan の設計値「1 校あたり 8〜15 本」の
 * 上限に合わせて近い順 15 校で打ち切る（市区町村の全校一覧は県ハブが担う）。 */
export const NEIGHBOR_MAX_COUNT = 15
/** 同一市区町村で足りないときに距離補完で目指す合計校数。 */
export const NEIGHBOR_FILL_TARGET = 8
/** 距離補完の上限距離（km）。 */
export const NEIGHBOR_FILL_MAX_KM = 10
/** 過疎地・離島のフォールバック: 上限距離を外して最低この校数まで出す。 */
export const NEIGHBOR_MIN_COUNT = 3

/**
 * 市区町村の同一判定キー。実データの県名二重接頭辞（「東京都東京都町田市」等）を
 * 剥がして比較する。区表記（「横浜市中区」）はそのまま別グループ扱い
 * （より局所的な同一判定になる方向なので許容し、距離補完が残りを埋める）。
 */
export function neighborCityKey(school: Pick<NeighborSchool, 'prefecture' | 'city'>): string | null {
  const pref = school.prefecture ?? ''
  let rest = school.city ?? ''
  while (pref && rest.startsWith(pref)) rest = rest.slice(pref.length)
  return rest ? `${school.prefecture}|${rest}` : null
}

/** 近隣校リストの項目に出す所在地表記。県外の学校は県名を冠する。 */
export function neighborPlaceLabel(
  subject: Pick<NeighborSchool, 'prefecture'>,
  neighbor: Pick<NeighborSchool, 'prefecture' | 'city'>,
): string {
  const pref = neighbor.prefecture ?? ''
  let city = neighbor.city ?? ''
  while (pref && city.startsWith(pref)) city = city.slice(pref.length)
  if (!city) return pref
  return neighbor.prefecture === subject.prefecture ? city : `${pref}${city}`
}

/**
 * 近隣校を選ぶ。
 * 1. 同一都道府県・同一市区町村の高校（近い順・最大 NEIGHBOR_MAX_COUNT）
 * 2. NEIGHBOR_FILL_TARGET 校に満たなければ、市区町村外から直線距離
 *    NEIGHBOR_FILL_MAX_KM km 以内を近い順に補完（県境をまたいでよい）
 * 3. それでも NEIGHBOR_MIN_COUNT 校未満（過疎地・離島）なら上限距離を外して補完
 * 返り値は直線距離の近い順（同距離は id で安定化）。
 */
export function selectNeighbors<T extends NeighborSchool>(
  subject: T,
  all: readonly T[],
): NeighborHit<T>[] {
  const here = { lat: subject.latitude, lng: subject.longitude }
  const subjectCity = neighborCityKey(subject)

  const sameCity: NeighborHit<T>[] = []
  const others: NeighborHit<T>[] = []
  for (const school of all) {
    if (school.id === subject.id) continue
    if (school.latitude == null || school.longitude == null) continue
    const hit = {
      school,
      distanceKm: haversine(here, { lat: school.latitude, lng: school.longitude }),
    }
    if (subjectCity != null && neighborCityKey(school) === subjectCity) sameCity.push(hit)
    else others.push(hit)
  }

  const byDistance = (a: NeighborHit<T>, b: NeighborHit<T>) =>
    a.distanceKm - b.distanceKm || (a.school.id < b.school.id ? -1 : a.school.id > b.school.id ? 1 : 0)
  sameCity.sort(byDistance)
  others.sort(byDistance)

  const picked = sameCity.slice(0, NEIGHBOR_MAX_COUNT)
  for (const hit of others) {
    // others は距離昇順なので、上限距離を超えたら以降も全て圏外。
    if (picked.length >= NEIGHBOR_FILL_TARGET || hit.distanceKm > NEIGHBOR_FILL_MAX_KM) break
    picked.push(hit)
  }
  if (picked.length < NEIGHBOR_MIN_COUNT) {
    const pickedIds = new Set(picked.map((hit) => hit.school.id))
    for (const hit of others) {
      if (picked.length >= NEIGHBOR_MIN_COUNT) break
      if (pickedIds.has(hit.school.id)) continue
      picked.push(hit)
    }
  }
  picked.sort(byDistance)
  return picked
}
