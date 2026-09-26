/**
 * 学校サイトの住所の移転（manabi-map.app → school.manabi-map.app）のお知らせ用の設定。
 *
 * docs/local/school/plan_school-subdomain-move.md の C2。サイトの住所そのもの（canonical・OGP 等）の
 * 設定とは別にしてある。こちらは「どのホストで、いつまで、どのお知らせを出すか」だけを持つ。
 *
 * **switchDate が null のあいだは、どのお知らせも出ない。** 切替日はユーザーが決めてから入れる（C3）。
 * 判定は web/src/lib/siteMove.ts の decideSiteMoveNotice。
 */
export interface SiteMoveConfig {
  /** 移転前のホスト名（予告 1・予告 2 を出す） */
  oldHost: string
  /** 移転後のホスト名（お知らせ 3 を出す） */
  newHost: string
  /** 移転後の住所（文言に出す） */
  newOrigin: string
  /**
   * 切替日（日本時間の日付 `YYYY-MM-DD`）。この日の 0:00（日本時間）を切替の始まりとみなす。
   * null のあいだ、または形式が正しくないときは、どのお知らせも出さない。
   */
  switchDate: string | null
  /** 新しい住所でお知らせ 3 を出す日数（切替日を 1 日目として数える） */
  noticeDays: number
}

export const SITE_MOVE: SiteMoveConfig = {
  oldHost: 'manabi-map.app',
  newHost: 'school.manabi-map.app',
  newOrigin: 'https://school.manabi-map.app',
  switchDate: null,
  noticeDays: 28,
}
