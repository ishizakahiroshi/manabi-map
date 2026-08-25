/**
 * 学科系統（DeptUiGroup）の短縮コードと、市区町村 / 県ページで学科の軸を出してよいかの判定。
 * Node の生成器（gen-schools-json / gen-seo-pages）と React バンドルの両方から読む。
 *
 * **この 2 つを別々に実装しない。** 生成側（meta description）と表示側（チップ）でガードの
 * 判定が食い違うと、description には学科があるのに画面には出ない（またはその逆）になる。
 */

/**
 * ui_group → 1 文字コード。src/types/school.ts の DeptUiGroup 10 値と 1 対 1。
 *
 * 生文字列で持つと pref-index 47 県で +8.4%、1 文字なら +4.1%（2026-08-25 実測）。
 * 'unknown' は含めない。**学科が 1 件も無い学校は dg を持たない**（キーごと省く）ので、
 * 「コードが無い」ことが「学科情報なし」を表す。
 */
export const DEPT_GROUP_CODES = {
  general: 'g',
  comprehensive: 'c',
  sciences_langs: 's',
  arts_sports: 'r',
  industrial: 'i',
  informatics: 'n',
  commercial: 'm',
  agriculture_marine: 'a',
  home_welfare_nursing: 'h',
  other: 'o',
}

/** コード → ui_group。DEPT_GROUP_CODES から機械的に作る（手で二重管理しない）。 */
export const DEPT_GROUP_BY_CODE = Object.fromEntries(
  Object.entries(DEPT_GROUP_CODES).map(([group, code]) => [code, group]),
)

/**
 * チップの並び順。MapPage.tsx の DEPT_KEYS_ACADEMIC → DEPT_KEYS_SPECIALIZED と同じ
 * （plan_v0.2.0_taxonomy-mext.md D2「進路検討 想起順」）。同じ分類を 2 つの画面で
 * 違う順に並べない。
 */
export const DEPT_GROUP_ORDER = [
  'general',
  'comprehensive',
  'sciences_langs',
  'arts_sports',
  'industrial',
  'informatics',
  'commercial',
  'agriculture_marine',
  'home_welfare_nursing',
  'other',
]

/** school_departments[] → 重複排除済みの 1 文字コード配列（DEPT_GROUP_ORDER 順）。 */
export function encodeDeptGroups(departments) {
  if (!Array.isArray(departments)) return []
  const groups = new Set()
  for (const department of departments) {
    const code = DEPT_GROUP_CODES[department?.ui_group]
    if (code) groups.add(department.ui_group)
  }
  return DEPT_GROUP_ORDER.filter((group) => groups.has(group)).map(
    (group) => DEPT_GROUP_CODES[group],
  )
}

/** 1 文字コード配列 → ui_group 配列。未知のコードは黙って捨てる（前方互換）。 */
export function decodeDeptGroups(codes) {
  if (!Array.isArray(codes)) return []
  return codes.map((code) => DEPT_GROUP_BY_CODE[code]).filter(Boolean)
}

/**
 * 通信制のみの学校か。
 *
 * 通信制は単位制で学科の概念が薄く、school_departments が空なのは**データ欠損ではなく実態**。
 * ガードの分母に入れると通信制の多い市が不当に伏せられる
 * （宇都宮市: 分母に入れると 65% で伏せられるが、除けば 100%・2026-08-25 実測）。
 */
export function isCorrespondenceOnly(courseTimes) {
  const times = Array.isArray(courseTimes) && courseTimes.length ? courseTimes : ['fulltime']
  return (
    times.includes('correspondence') &&
    !times.includes('fulltime') &&
    !times.includes('parttime')
  )
}

/**
 * 学科の軸を出してよい下限。
 *
 * 学科データは県ごとに欠けている（京都 0/101・兵庫 5/220・大阪 59%・福岡 62%）。
 * 無条件に集計すると、神戸市 61 校が「商業 2 校・情報 1 校・工業 1 校」になり誤読を招く。
 * 補完そのものは plan_open-issues-triage.md P2-1 / C4 の担当で、ここでは伏せるだけ。
 */
export const DEPT_COVERAGE_MIN = 0.9

/**
 * この一覧で学科の軸を出してよいか。
 *
 * 分母は「通信制のみではない学校」。全国 1,265 市区町村ページのうち 1,145 枚（91%）が通る
 * （2026-08-25 実測）。分母 0（通信制しか無い市区町村）は false。
 *
 * @param entries CompactPrefSchool 相当（ct / dg を持つ）の配列
 */
export function hasReliableDeptData(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return false
  const denominator = entries.filter((entry) => !isCorrespondenceOnly(entry?.ct))
  if (denominator.length === 0) return false
  const covered = denominator.filter((entry) => (entry?.dg?.length ?? 0) > 0).length
  return covered / denominator.length >= DEPT_COVERAGE_MIN
}
