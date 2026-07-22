/**
 * 塾アフィリ広告枠の案件データ（§7.5 / CLAUDE.md「広告ポリシー Non-negotiable」準拠）。
 *
 * 掲載できるのは 進路・教育系（学習塾 / 予備校 / 通信制高校・通信教育 / 模試 / 大学・専門学校）のみ。
 * AdSense 等の無差別ネットワーク案件・進路無関係の案件は絶対に追加しない。
 *
 * v0.1.4 時点では ASP 審査待ちのため、下記はすべて「ダミー案件」。
 * 承認後に baseUrl とタイトル・説明を実案件に差し替える運用。
 */

/** 表示対象地域。'nation'=全国 / 'kanto'=関東 / 'gunma' 等の県コード / 個別県名 */
export type AdScope = 'nation' | 'kanto' | 'gunma' | (string & {})

/** 掲載箇所（UI 上の位置。UTM の utm_medium にも使う） */
export type AdPlacement = 'school-detail' | 'home' | 'map' | 'favorites'

/** 案件カテゴリ */
export type AdCategory =
  | 'juku'              // 学習塾・個別指導
  | 'school'            // 私立高校・通信制高校・大学・専門学校 の学校広告
  | 'tsuushin_kyouiku'  // 通信教育
  | 'moshi'             // 模試

export interface AdSlotItem {
  id: string
  category: AdCategory
  /** 掲載箇所（同じ案件を複数箇所に出したい場合は placements で拡張する） */
  placement: AdPlacement
  /** カード上部の小バッジ文言（原則 "PR" を推奨） */
  label: string
  title: string
  description: string
  ctaText: string
  /** ASP 提供のリンク元 URL（UTM は表示時に自動付与） */
  baseUrl: string
  /** 表示対象スコープ */
  scope: AdScope
  /** ISO 日付（YYYY-MM-DD）。掲載開始日 */
  startDate: string
  /** ISO 日付。無ければ無期限 */
  endDate?: string
}

/**
 * 初期案件（すべてダミー）。
 * ASP（A8 / もしも / afb / アクセストレード 等）の承認が下り次第、
 * baseUrl と本文を差し替えて実案件化する。
 */
/**
 * ダミー案件セット。すべて掲載レイアウト確認用で、遷移先は法務ページの広告表示節。
 * ASP 承認後に baseUrl と title / description / ctaText を実案件へ差し替える。
 * 増減させる場合も v0.1.4 段階では「進路・教育系」のカテゴリを守ること。
 */
export const AD_SLOTS: AdSlotItem[] = [
  {
    id: 'dummy-juku-school-detail-v014',
    category: 'juku',
    placement: 'school-detail',
    label: 'PR',
    title: '志望校対策の学習塾を探す（サンプル）',
    description:
      '志望校ごとに強い塾・個別指導を比較できます。※こちらは掲載レイアウト確認用のダミーです（実際の広告リンクではありません）。',
    ctaText: '塾情報を見る',
    baseUrl: 'https://manabi-map.app/legal/privacy#ads',
    scope: 'nation',
    startDate: '2026-07-06',
  },
  {
    id: 'dummy-juku-home-v014',
    category: 'juku',
    placement: 'home',
    label: 'PR',
    title: 'お子様の学習を支える塾情報（サンプル）',
    description:
      '学習塾・個別指導・オンライン教室を進路検討と合わせて比較できます。※掲載レイアウト確認用のダミーです。',
    ctaText: '塾を探す',
    baseUrl: 'https://manabi-map.app/legal/privacy#ads',
    scope: 'nation',
    startDate: '2026-07-06',
  },
  {
    id: 'dummy-school-map-v014',
    category: 'school',
    // 地図画面のボトムシート撤去（v0.3.4）に伴い、school-detail へ寄せた。
    // 'map' placement は型・枠定義としては残すが、現状これを使う案件は無い。
    placement: 'school-detail',
    label: 'PR',
    title: '公立高校 過去問集（サンプル）',
    description:
      '志望校対策に。過去数年分＋解説付きの学習教材を掲載予定。※掲載レイアウト確認用のダミーです。',
    ctaText: '見る',
    baseUrl: 'https://manabi-map.app/legal/privacy#ads',
    scope: 'nation',
    startDate: '2026-07-06',
  },
  {
    id: 'dummy-tsuushin-favorites-v014',
    category: 'tsuushin_kyouiku',
    placement: 'favorites',
    label: 'PR',
    title: '通信教育・模試情報（サンプル）',
    description:
      '志望校対策の通信教育・模試を比較できます。※掲載レイアウト確認用のダミーです。',
    ctaText: '見る',
    baseUrl: 'https://manabi-map.app/legal/privacy#ads',
    scope: 'nation',
    startDate: '2026-07-06',
  },
]

/** ID で案件を取り出す（見つからなければ undefined） */
export function findAdSlot(id: string): AdSlotItem | undefined {
  return AD_SLOTS.find((s) => s.id === id)
}

/** 掲載箇所（+ 任意で県）で案件を絞り込む */
export function slotsForPlacement(placement: AdPlacement, prefecture?: string): AdSlotItem[] {
  return AD_SLOTS
    .filter((s) => s.placement === placement)
    .filter((s) => isSlotVisibleFor(s, prefecture))
}

const KANTO_PREFECTURES = new Set([
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
])

const PREF_KEY_TO_NAME: Record<string, string> = {
  gunma: '群馬県',
  saitama: '埼玉県',
  tokyo: '東京都',
  kanagawa: '神奈川県',
  chiba: '千葉県',
  tochigi: '栃木県',
  ibaraki: '茨城県',
}

/** slot.scope がその学校の所在県で表示対象かを判定 */
export function isSlotVisibleFor(slot: AdSlotItem, prefecture: string | undefined): boolean {
  if (!prefecture) return slot.scope === 'nation'
  if (slot.scope === 'nation') return true
  if (slot.scope === 'kanto') return KANTO_PREFECTURES.has(prefecture)
  const mapped = PREF_KEY_TO_NAME[slot.scope]
  if (mapped) return mapped === prefecture
  return slot.scope === prefecture
}
