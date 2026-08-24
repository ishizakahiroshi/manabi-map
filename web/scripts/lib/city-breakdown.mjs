/**
 * 市区町村ページの meta description に入れる「その市区町村でしか成り立たない数字」。
 *
 * 1,265 ページが同一テンプレートだと検索結果の見え方が地域で変わらない
 * （docs/local/plan_city-page-local-context.md C3）。
 *
 * 学科は **チップと同じガード**（dept-groups-shared.mjs の hasReliableDeptData）を通す。
 * ここだけ独自判定にすると、description に学科があるのに画面には出ない事故になる。
 */

import {
  DEPT_GROUP_ORDER,
  decodeDeptGroups,
  hasReliableDeptData,
} from './dept-groups-shared.mjs'

/**
 * i18n/ja.ts の filter.dept と同じ文言。
 * チップと description で語が食い違うと、検索結果から来た人が画面上で同じ言葉を探せない。
 */
export const DEPT_LABELS = {
  general: '普通科',
  comprehensive: '総合学科',
  sciences_langs: '理数・国際',
  arts_sports: '芸術・体育',
  industrial: '工業',
  informatics: '情報',
  commercial: '商業',
  agriculture_marine: '農業・水産',
  home_welfare_nursing: '家庭・福祉・看護',
  other: 'その他',
}

/** 設置区分は公立 → 私立 → 国立 の固定順（チップの並びと同じ）。件数順にしない。 */
const OWNERSHIP_CHIP_LABELS = [
  ['public', '公立'],
  ['private', '私立'],
  ['national', '国立'],
]

/** 並べる学科系統の上限。全 1,265 ページで 115 字以内に収まる値（2026-08-25 実測）。 */
export const DESCRIPTION_DEPT_LIMIT = 4

function ownershipChipOf(ownership) {
  if (ownership === 'private') return 'private'
  if (ownership === 'national') return 'national'
  return 'public'
}

/**
 * @param entries CompactPrefSchool（o / ct / dg / ig）の配列。その市区町村の分だけ。
 * @returns 文末まで句点で閉じた文字列。出せる情報が無ければ空文字。
 */
export function cityBreakdownSentence(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return ''
  const parts = []

  const ownershipCounts = new Map()
  for (const entry of entries) {
    const key = ownershipChipOf(entry.o)
    ownershipCounts.set(key, (ownershipCounts.get(key) ?? 0) + 1)
  }
  const ownershipText = OWNERSHIP_CHIP_LABELS.filter(([key]) => ownershipCounts.get(key))
    .map(([key, label]) => `${label} ${ownershipCounts.get(key)} 校`)
    .join('・')
  if (ownershipText) parts.push(`${ownershipText}。`)

  if (hasReliableDeptData(entries)) {
    const deptCounts = new Map()
    for (const entry of entries) {
      for (const group of decodeDeptGroups(entry.dg)) {
        deptCounts.set(group, (deptCounts.get(group) ?? 0) + 1)
      }
    }
    const ranked = [...deptCounts.entries()].sort(
      (a, b) => b[1] - a[1] || DEPT_GROUP_ORDER.indexOf(a[0]) - DEPT_GROUP_ORDER.indexOf(b[0]),
    )
    if (ranked.length > 0) {
      const shown = ranked
        .slice(0, DESCRIPTION_DEPT_LIMIT)
        .map(([group, n]) => `${DEPT_LABELS[group]} ${n} 校`)
        .join('・')
      const suffix = ranked.length > DESCRIPTION_DEPT_LIMIT ? ' ほか' : ''
      parts.push(`学科は${shown}${suffix}。`)
    }
  }

  const integrated = entries.filter((entry) => entry.ig === true).length
  if (integrated > 0) parts.push(`中高一貫 ${integrated} 校。`)

  return parts.join('')
}

/**
 * 市区町村ページの meta description 全文。gen-seo-pages とテストで同じ実装を使う。
 *
 * 締めは「地図で場所を確認できます。」だけにする。旧文にあった
 * 「お気に入り保存・見学メモの家族共有ができる無料の学校選びサービスです。」を残すと
 * 22 字ぶん長くなり、名古屋市クラスのページで 120 字を超えて**内訳のほうが切られる**
 * （2026-08-25 実測。全 1,265 ページの最大 116 字 → 138 字）。
 * 地域固有の数字が先で、サービス説明は県ページ・トップに任せる。
 */
export const CITY_DESCRIPTION_TAIL = '地図で場所を確認できます。'

export function cityPageDescription(prefName, city, entries) {
  return (
    `${prefName}${city}にある高校 ${entries.length} 校の一覧。` +
    cityBreakdownSentence(entries) +
    CITY_DESCRIPTION_TAIL
  )
}
