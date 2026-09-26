// OS / ブラウザとの境界になる、いま実際に使っている機能だけをまとめた薄い層
// （子 plan C10 N4・指示書 §4・native readiness 文書 §4）。将来 Capacitor 等でラップするときは、
// このファイルの関数の中身だけを差し替えられるようにする。使う側（main.tsx・
// components/KanjiLayout.tsx・pages/ProfileEditPage.tsx・lib/store.ts）はこの関数越しに呼ぶ。
//
// DOM の操作（i18n/packs.ts の ensureFont の <style> 足し・フォーカス操作・keydown の購読など）は
// OS / ブラウザとの境界ではないので対象外（子 plan C10「作業内容」4）。使っていない機能
// （speechSynthesis・navigator.share・window.open）の関数や、空の interface は作らない
// （子 plan C10「作業内容」4・「維持する仕様」）。

/** 開き直す（components/KanjiLayout.tsx の store.closed の帯「開き直す」ボタン）。 */
export function reloadApp(): void {
  window.location.reload()
}

/** 端末の優先言語（main.tsx の起動処理。detectLang に渡す）。 */
export function getPreferredLanguages(): readonly string[] {
  return navigator.languages
}

/**
 * 永続化ストレージを要求する（lib/store.ts の requestPersistence）。API が無い環境、または
 * persist() が失敗（reject）した場合も例外を外へ出さず false を返す。
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.persist !== 'function') return false
  try {
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

/**
 * 戻るボタンの判定（routing.ts の shouldReplaceBack）に使う、いまの履歴エントリの idx
 * （components/KanjiLayout.tsx・pages/ProfileEditPage.tsx の must 3。学校サイトの useGoBack と
 * 同じ判定）。
 */
export function getHistoryIndex(): number | null | undefined {
  return (window.history.state as { idx?: number } | null)?.idx
}
