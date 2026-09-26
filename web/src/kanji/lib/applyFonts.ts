// LANGUAGES 全体にフォントを適用する（C6 レビュー should 1）。main.tsx の起動処理から呼ぶ。
// ensureFont 自体は C4（../i18n/packs.ts）の関数で、ここでは変えない（C1〜C5 のファイルは
// main.tsx の置き換え以外変えない約束のため。子 plan「このファイルを開いた AI へ」）。

import { ensureFont, LANGUAGES, type LangPackMeta } from '../i18n/packs'

/**
 * languages（既定は LANGUAGES 全部）のそれぞれに ensureFont を呼ぶ。ensureFont は
 * document が無い環境・meta.font が無い言語では何もしない（i18n/packs.ts の実装で確認済み）。
 * いまの ja・en は両方 font: null なので、現時点では何もしない（後の C で font を持つ言語パック
 * を足したときに効く）。
 */
export function applyAllFonts(languages: readonly LangPackMeta[] = LANGUAGES): void {
  languages.forEach(ensureFont)
}
