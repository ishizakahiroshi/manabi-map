// 市区町村の正規化・並び順の共有ロジック（Node ビルドスクリプト用）。
//
// 正典データ: web/data/municipalities.json / web/data/prefectures.json
// （総務省「全国地方公共団体コード」から docs/local/convert-soumu-codes.py で生成）。
//
// schools データの city 値は表記が揺れている:
//   - 町村は「利根郡みなかみ町」のように郡付き（総務省表は「みなかみ町」で郡なし）
//   - 政令指定都市は「横浜市」と「横浜市中区」が混在
//   - null / 県名の接頭辞付き / 「羽村」のような欠損表記もある
// ここで「市区町村グループ」（県ページの見出し単位・市区町村索引の単位）へ正規化する。
// 並び順は市区町村コード順 → 同一市区町村内は五十音順に固定する。
// 偏差値順・倍率順のソートは実装しない（ランキングサイト化の禁止線・
// docs/local/plan_seo-growth-strategy.md §やらないこと）。

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** web ルート配下の data/*.json を読む。 */
export async function loadCivicData(webRoot) {
  const prefText = await readFile(join(webRoot, 'data', 'prefectures.json'), 'utf8')
  const muniText = await readFile(join(webRoot, 'data', 'municipalities.json'), 'utf8')
  const prefectures = JSON.parse(prefText).prefectures
  const municipalities = JSON.parse(muniText).municipalities
  const muniByPref = new Map()
  for (const m of municipalities) {
    const list = muniByPref.get(m.pref) ?? []
    list.push(m)
    muniByPref.set(m.pref, list)
  }
  return { prefectures, municipalities, muniByPref }
}

/** 「利根郡みなかみ町」→「みなかみ町」（総務省表の表記へ）。郡が無ければそのまま。 */
function stripGun(name) {
  const m = name.match(/^(.{1,10}?郡)(.+)$/)
  return m ? m[2] : name
}

/** 政令指定都市の区表記「横浜市中区」→「横浜市」。特別区（千代田区等）は該当しない。 */
function wardToCity(name) {
  const m = name.match(/^(.+市).+区$/)
  return m ? m[1] : name
}

/** 県名接頭辞を除去する。実データに「東京都東京都町田市…」のような二重接頭辞があるため繰り返し剥がす。 */
function stripPrefPrefix(value, pref) {
  let rest = value
  if (pref) {
    while (rest.startsWith(pref)) rest = rest.slice(pref.length)
  }
  return rest
}

/**
 * school 1 件を市区町村グループへ解決する。
 * 返り値: { label, code, kana } | null（解決不能）
 * - label は表示用（データ側の郡付き表記を尊重。address 由来のときも郡を付ける）
 * - code は総務省 6 桁コード（並び順用）・kana はひらがな（検索索引用）
 */
export function resolveCityGroup(school, muniByPref) {
  const munis = muniByPref.get(school.prefecture) ?? []
  const pref = school.prefecture ?? ''

  // 1) city 値から解決（県名接頭辞除去 → 政令市の区を市へ → まず表記そのまま、外れたら郡なし表記で照合）
  const rawCity = stripPrefPrefix(school.city ?? '', pref)
  if (rawCity) {
    const normalized = wardToCity(rawCity)
    // 「蒲郡市」「大和郡山市」「小郡市」のように市名自体に「郡」を含む市を郡除去で壊さないため、
    // 表記そのままの完全一致を先に試し、外れたときだけ郡付き町村とみなして郡を剥がす。
    // 同名町村が同一県内に複数ある場合（北海道の泊村等）はコード順の先頭を採る。
    // 現状の収録校ではこの曖昧さで実害が出る校は無い（高校の無い村同士）。
    const hit =
      munis.find((m) => m.name === normalized) ??
      munis.find((m) => m.name === stripGun(normalized))
    if (hit) return { label: normalized, code: hit.code, kana: hit.kana }
  }

  // 2) address から解決（city が null・「羽村」のような欠損表記のフォールバック）。
  //    address は「<県><郡?><市区町村>…」の完全表記想定。郡付きで label を組み立てる。
  const rest = stripPrefPrefix(school.address ?? '', pref)
  if (rest) {
    // 「府中市」と「府中町」のような前方一致の紛れを避けるため常に最長一致で選ぶ。
    const longestAt = (text) => {
      let best = null
      for (const m of munis) {
        if (text.startsWith(m.name) && (!best || m.name.length > best.name.length)) best = m
      }
      return best
    }
    // まず先頭からそのまま照合する（「蒲郡市」を郡抽出で「蒲郡」+「市…」に割らないため、
    // 郡抽出より先に試すことが必須）。外れたら郡付き町村とみなして郡の後ろで照合する。
    const direct = longestAt(rest)
    if (direct) return { label: direct.name, code: direct.code, kana: direct.kana }
    const gunMatch = rest.match(/^(.{1,10}?郡)/)
    if (gunMatch) {
      const gun = gunMatch[1]
      const hit = longestAt(rest.slice(gun.length))
      if (hit) return { label: `${gun}${hit.name}`, code: hit.code, kana: hit.kana }
    }
  }

  return null
}

/** 解決不能校の受け皿グループ（各県ページの末尾に置く）。 */
export const UNRESOLVED_CITY_LABEL = 'その他'

/**
 * 市区町村ページの URL パス。
 *
 * **`src/lib/prefIndex.ts` の `cityPagePath` と同一の形にすること。**
 * canonical・sitemap・BreadcrumbList の item・React 側リンクがすべてこの表記で
 * 一致している必要がある（ズレると自 URL 不一致で verify:static が落ちる）。
 */
export function cityPagePath(prefSlug, city) {
  return `/pref/${prefSlug}/${encodeURIComponent(city)}/`
}

/**
 * pref-index から市区町村ごとの掲載校数を、コード順（cities の並び）で作る。
 *
 * **`src/lib/prefIndex.ts` の `buildCityCounts` と同一の結果になること。**
 * ここで作った値をプリレンダー HTML に埋め、ブラウザ側は同じ関数の TS 版で
 * 再計算する。食い違うと hydration が壊れる。
 */
export function buildCityCounts(prefIndex) {
  const counts = new Map()
  for (const entry of prefIndex.schools) {
    if (entry.c == null) continue
    counts.set(entry.c, (counts.get(entry.c) ?? 0) + 1)
  }
  return prefIndex.cities
    .filter((city) => counts.has(city))
    .map((city) => ({ c: city, n: counts.get(city) }))
}

/**
 * 県内の学校を市区町村グループへ分ける。
 * 返り値: [{ label, code, kana, schools }] を市区町村コード順で。
 * 解決不能校は末尾の「その他」グループ。グループ内は五十音順（name_kana → name）。
 */
export function groupSchoolsByCity(schools, muniByPref) {
  const groups = new Map()
  for (const school of schools) {
    const resolved = resolveCityGroup(school, muniByPref)
    const key = resolved?.label ?? UNRESOLVED_CITY_LABEL
    const group = groups.get(key) ?? {
      label: key,
      code: resolved?.code ?? null,
      kana: resolved?.kana ?? null,
      schools: [],
    }
    group.schools.push(school)
    groups.set(key, group)
  }
  const collator = new Intl.Collator('ja')
  const sorted = [...groups.values()].sort((a, b) => {
    if (a.code == null && b.code == null) return 0
    if (a.code == null) return 1
    if (b.code == null) return -1
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0
  })
  for (const group of sorted) {
    group.schools.sort((a, b) =>
      collator.compare(a.name_kana ?? a.name, b.name_kana ?? b.name),
    )
  }
  return sorted
}
