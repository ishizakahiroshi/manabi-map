// 漢字アプリの学習者・設定に関する型（C2）。
// 学校サイトの型（web/src/types/school.ts 等）とは別に持つ（漢字アプリのコードは学校サイトの
// モジュールを import しない。親 plan D-4・子 plan「書き方の約束」）。

/** 漢検の級。易しい順の並びは web/src/kanji/lib/levels.ts の LEVELS / levelRank で扱う */
export type Level = '10' | '9' | '8' | '7' | '6' | '5' | '4' | '3' | 'pre2' | '2' | 'pre1' | '1'

/** ふりがなの付け方。all=すべて / unlearned=まだ習っていない字だけ / none=なし（親 plan D-9） */
export type FuriganaMode = 'all' | 'unlearned' | 'none'

/** 画面の言い回しと演出（親 plan D-10）。ふりがな・言語とは独立に選べる */
export type DisplayMode = 'child' | 'adult'

/** 書き取りの答え方。auto は端末（iPad/iPhone）に合わせる。判定は後の C の書き取り機能で行う */
export type WriteMode = 'auto' | 'screen' | 'paper'

/**
 * 言語パックのファイル名（拡張子なし）。言語の一覧は言語パックのファイルの数で決まるため、
 * 型には一覧を直書きしない（親 plan D-8）。
 */
export type LangCode = string

/** 学習者アイコンの色の選択肢（共有用モック v4 に合わせた 5 色） */
export const PROFILE_COLORS = ['#ff7a3d', '#3b7ddd', '#2e7d4f', '#e6a419', '#8e5bd1'] as const

/** 学習者アイコンの色 */
export type ProfileColor = (typeof PROFILE_COLORS)[number]

/** 1 日の目標問題数の選択肢 */
export const DAILY_GOALS = [5, 10, 15, 20, 30] as const

/** 1 日の目標問題数 */
export type DailyGoal = (typeof DAILY_GOALS)[number]

/** 学習者ごとの設定（親 plan D-5） */
export interface LearnerProfile {
  id: string
  /** 前後の空白を除いて 1〜20 文字。normalizeProfile（lib/store.ts）で検証する */
  nickname: string
  color: ProfileColor
  level: Level
  lang: LangCode
  furigana: FuriganaMode
  display: DisplayMode
  kanaKeyboard: boolean
  dailyGoal: DailyGoal
  /** YYYY-MM-DD。未設定は null */
  examDate: string | null
  writeMode: WriteMode
  /** ISO 8601 の文字列 */
  createdAt: string
  /** ISO 8601 の文字列 */
  updatedAt: string
}
