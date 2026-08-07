/**
 * /guide/ の本文ファイルと静的 head を結ぶ正本。
 * Node の gen-seo-pages.mjs からも import するため、React 依存を置かない。
 *
 * title / description は静的ページの head 用（プリレンダーは既定言語＝日本語）。
 * navLabel / navLabelEn はアプリ内の導線ラベルで、site-footer-links.json と同じく
 * 言語ごとの実体をここに持つ（コンポーネントに文字列を直書きしない）。
 */
export const GUIDES = [
  {
    slug: 'commute-time',
    title: '通学時間と通学範囲の考え方',
    navLabel: '通学の考え方',
    navLabelEn: 'Thinking about commute',
    description: '高校選びで通学時間を考えるときの確認ポイント。直線距離の目安と実際の経路の違い、親子で確かめたいことを整理します。',
  },
  {
    slug: 'school-visit',
    title: '学校見学・文化祭のチェックリスト',
    navLabel: '学校見学の準備',
    navLabelEn: 'Preparing for a visit',
    description: '学校見学や文化祭で親子が確認したいことを、当日の動き方と見学メモの残し方に分けて整理します。',
  },
  {
    slug: 'deviation-with-care',
    title: '偏差値（編集推計）との付き合い方',
    navLabel: '数値との付き合い方',
    navLabelEn: 'Using the numbers with care',
    description: '偏差値を学校選びの唯一の答えにしないために、数値の限界と親子での使い方を整理します。',
  },
]

/** 表示言語に合わせた導線ラベル。ja 以外は英語ラベルへ寄せる。 */
export function guideNavLabel(guide: (typeof GUIDES)[number], locale: string): string {
  return locale === 'en' ? guide.navLabelEn : guide.navLabel
}

export const GUIDE_BY_SLUG = new Map(GUIDES.map((guide) => [guide.slug, guide]))
