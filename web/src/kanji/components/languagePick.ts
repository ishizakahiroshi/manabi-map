// LanguageSheet の「選んだときの処理」を、React から切り離した純粋な関数にしたもの
// （C7 レビュー should 3: レンダリングせずに onSelect の有無で分岐を確かめられるようにする）。
// onSelect があれば setUiLang を呼ばずに onSelect だけへ渡す（C8 のフォーム用。いまの学習者の
// 言語は変えない）。onSelect が無ければ setUiLang を呼ぶ（2026-09-23 C5 レビューの申し送り）。
// setUiLang の失敗は握りつぶす（C7 レビュー should 2: このシートはエラー表示を持たないため、
// 処理されない例外を出さないようにする）。

export interface PickLanguageDeps {
  onSelect?: (code: string) => void
  setUiLang: (code: string) => Promise<void>
}

export function pickLanguage(code: string, { onSelect, setUiLang }: PickLanguageDeps): void {
  if (onSelect) {
    onSelect(code)
    return
  }
  void setUiLang(code).catch(() => {})
}
