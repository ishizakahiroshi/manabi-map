/**
 * /guide/ の本文ファイルと静的 head を結ぶ正本。
 * Node の gen-seo-pages.mjs からも import するため、React 依存を置かない。
 */
export const GUIDES = [
  {
    slug: 'commute-time',
    title: '通学時間と通学範囲の考え方',
    navLabel: '通学の考え方',
    description: '高校選びで通学時間を考えるときの確認ポイント。直線距離の目安と実際の経路の違い、親子で確かめたいことを整理します。',
  },
  {
    slug: 'school-visit',
    title: '学校見学・文化祭のチェックリスト',
    navLabel: '学校見学の準備',
    description: '学校見学や文化祭で親子が確認したいことを、当日の動き方と見学メモの残し方に分けて整理します。',
  },
  {
    slug: 'deviation-with-care',
    title: '偏差値（編集推計）との付き合い方',
    navLabel: '数値との付き合い方',
    description: '偏差値を学校選びの唯一の答えにしないために、数値の限界と親子での使い方を整理します。',
  },
]

export const GUIDE_BY_SLUG = new Map(GUIDES.map((guide) => [guide.slug, guide]))
