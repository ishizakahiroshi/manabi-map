// 言語パックの遅延読み込みを失敗に強くする（C6 レビュー should 4）。
// loadUi 自体（C4・i18n/packs.ts の loadUi）は変えない。呼び出し側（KanjiApp.tsx の
// onNeedLang）が reject を握りつぶさずに投げっぱなしにしていた分を、ここで必ず {} に丸める。

import type { UiDict } from '../i18n/packs'

/**
 * loadUi(code) を呼び、reject しても {} を返す（例外を外へ投げない）。呼んだ側は、パックが無い・
 * 失敗した言語にも uiByLang[code] = {} を入れる約束（C4「作業内容」3）を、途中で失敗した場合にも
 * 及ぼすための薄いラッパー。
 */
export async function loadUiSafely(
  loadUi: (code: string) => Promise<UiDict | undefined>,
  code: string,
): Promise<UiDict> {
  try {
    return (await loadUi(code)) ?? {}
  } catch {
    return {}
  }
}

/**
 * すでに読み込み済みの言語（{} で表す「失敗した」も含む）は上書きしない純粋な merge。
 * KanjiApp.tsx の onNeedLang から使う（テストしやすいよう React の外に出してある）。
 */
export function mergeUiByLang(
  prev: Record<string, UiDict | undefined>,
  code: string,
  ui: UiDict,
): Record<string, UiDict | undefined> {
  return prev[code] !== undefined ? prev : { ...prev, [code]: ui }
}
