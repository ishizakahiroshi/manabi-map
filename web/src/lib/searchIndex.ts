/**
 * 統合検索用の軽量索引（市区町村・校名）のローダーとマッチング。
 *
 * トップの統合検索は schools.json 全体（数 MB）を読まない。
 * gen-schools-json.mjs が生成する hash 付きの軽量 JSON
 * （city-index-*.json / school-name-index-*.json）を manifest 経由で取り、
 * モジュールスコープにキャッシュする（検索欄フォーカス時の遅延読込を想定）。
 */

export interface CityIndexEntry {
  pref: string
  prefSlug: string
  /** 表示用の市区町村名（町村は郡付き。県ページのアンカー id と一致する） */
  city: string
  /** ひらがな読み（かな入力対応。総務省 全国地方公共団体コード表由来） */
  kana: string
  count: number
}

export interface SchoolIndexEntry {
  id: string
  name: string
  kana: string | null
  pref: string
  city: string | null
  lat: number | null
  lng: number | null
}

export interface SearchIndexes {
  cities: CityIndexEntry[]
  schools: SchoolIndexEntry[]
}

interface CompactSchoolEntry {
  i: string
  n: string
  k: string | null
  p: string
  c: string | null
  lat: number | null
  lng: number | null
}

async function fetchIndexes(): Promise<SearchIndexes> {
  const manifestRes = await fetch('/schools-manifest.json', { cache: 'no-store' })
  if (!manifestRes.ok) throw new Error(`manifest fetch failed: ${manifestRes.status}`)
  const manifest = (await manifestRes.json()) as { cityIndexUrl?: string; nameIndexUrl?: string }
  const cityUrl =
    typeof manifest.cityIndexUrl === 'string' && /^\/city-index-[0-9a-f]+\.json$/i.test(manifest.cityIndexUrl)
      ? manifest.cityIndexUrl
      : null
  const nameUrl =
    typeof manifest.nameIndexUrl === 'string' &&
    /^\/school-name-index-[0-9a-f]+\.json$/i.test(manifest.nameIndexUrl)
      ? manifest.nameIndexUrl
      : null
  if (!cityUrl || !nameUrl) throw new Error('search index urls are missing in manifest')
  const [cityRes, nameRes] = await Promise.all([fetch(cityUrl), fetch(nameUrl)])
  if (!cityRes.ok) throw new Error(`city index fetch failed: ${cityRes.status}`)
  if (!nameRes.ok) throw new Error(`name index fetch failed: ${nameRes.status}`)
  const cities = (await cityRes.json()) as CityIndexEntry[]
  const compact = (await nameRes.json()) as CompactSchoolEntry[]
  const schools = compact.map((e) => ({
    id: e.i,
    name: e.n,
    kana: e.k,
    pref: e.p,
    city: e.c,
    lat: e.lat,
    lng: e.lng,
  }))
  return { cities, schools }
}

let indexesPromise: Promise<SearchIndexes> | null = null

/** 索引を（初回だけ）取得する。失敗時はキャッシュを捨てて次回に再試行できるようにする。 */
export function loadSearchIndexes(): Promise<SearchIndexes> {
  if (!indexesPromise) {
    indexesPromise = fetchIndexes().catch((err) => {
      indexesPromise = null
      throw err
    })
  }
  return indexesPromise
}

const SMALL_KANA: Record<string, string> = {
  ぁ: 'あ', ぃ: 'い', ぅ: 'う', ぇ: 'え', ぉ: 'お',
  っ: 'つ', ゃ: 'や', ゅ: 'ゆ', ょ: 'よ', ゎ: 'わ',
  ゕ: 'か', ゖ: 'け',
}

/**
 * かな検索向けの正規化。カタカナ→ひらがな、小書き→並字、空白除去。
 * 総務省表の読みは「なかのじよう」のように小書きを使わない表記があるため、
 * 「なかのじょう」入力でも当たるよう両辺を並字へ寄せる。
 */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[ぁぃぅぇぉっゃゅょゎゕゖ]/g, (c) => SMALL_KANA[c])
    .replace(/[\s　]+/g, '')
}

/** 市区町村候補（漢字 or 読みの部分一致・前方一致を優先）。 */
export function matchCities(cities: CityIndexEntry[], query: string, limit: number): CityIndexEntry[] {
  const raw = query.trim()
  if (!raw) return []
  const n = normalizeForMatch(raw)
  const starts: CityIndexEntry[] = []
  const includes: CityIndexEntry[] = []
  for (const c of cities) {
    const kana = normalizeForMatch(c.kana)
    const cityN = normalizeForMatch(c.city)
    const prefCityN = normalizeForMatch(`${c.pref}${c.city}`)
    if (cityN.startsWith(n) || kana.startsWith(n)) starts.push(c)
    else if (cityN.includes(n) || kana.includes(n) || prefCityN.includes(n)) includes.push(c)
    if (starts.length >= limit) break
  }
  return [...starts, ...includes].slice(0, limit)
}

/** 校名候補（校名・ふりがな・都道府県・市区町村の部分一致）。 */
export function matchSchools(schools: SchoolIndexEntry[], query: string, limit: number): SchoolIndexEntry[] {
  const raw = query.trim()
  if (!raw) return []
  const n = normalizeForMatch(raw)
  const results: SchoolIndexEntry[] = []
  for (const s of schools) {
    const hay = normalizeForMatch(`${s.name}${s.kana ?? ''}${s.pref}${s.city ?? ''}`)
    if (hay.includes(n)) {
      results.push(s)
      if (results.length >= limit) break
    }
  }
  return results
}
