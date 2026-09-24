// 言語の切り替えの判断（いまの言語・求める言語）だけを扱う純粋な関数（子 plan「作業内容」4・
// 2026-09-23 / 2026-09-24 レビュー）。I18nProvider.tsx（コンポーネント）の useEffect から呼ぶ。
// 副作用（onNeedLang の呼び出し・setState）は持たない。コンポーネントのファイルから関数 export を
// 追い出し、react-refresh の only-export-components 警告を消すために分けてある
// （2026-09-24 レビュー should 4）。

import type { UiDict } from './packs'

export interface DecideLangInput {
  /** props で渡された、いまねらう言語 */
  lang: string
  /** いま実際に文言の解決に使っている言語 */
  active: string
  /** 読み込み済み（失敗して {} が入っているものも含む）の ui */
  uiByLang: Record<string, UiDict | undefined>
  /** すでに onNeedLang で求めた言語（呼び出し側の ref をそのまま渡す） */
  requested: ReadonlySet<string>
}

export interface DecideLangResult {
  /** 次に active にすべき言語（切り替えないときは入力の active と同じ） */
  active: string
  /** onNeedLang で新しく求めるべき言語（無ければ空配列） */
  need: string[]
}

/**
 * 言語の切り替えの判断（いまの言語・求める言語）を行う純粋な関数（子 plan「作業内容」4・
 * 2026-09-23 レビュー must 1・should 2）。
 *
 * lang の ui と en の ui（lang が en 自身なら en だけ）の両方が uiByLang に揃っていれば（呼び出し側の
 * 約束により、読み込みに失敗した言語は空の {} が入る。空でも「揃っている」扱いにして、文言は
 * resolveText の英語フォールバックへ任せる）active を lang に進める。揃っていなければ active は
 * 変えず、まだ requested に無い（＝一度も求めていない）ものだけ need に積む
 * （must 1: 最初の描画でも lang === active になり得るので、「等しいか」ではなく「揃っているか」で
 * 判断する。以前は lang === active の時点で早期リターンしていて、初回に何も求められなかった）。
 */
export function decideLang({ lang, active, uiByLang, requested }: DecideLangInput): DecideLangResult {
  const need: string[] = []
  if (uiByLang[lang] === undefined && !requested.has(lang)) need.push(lang)
  if (lang !== 'en' && uiByLang.en === undefined && !requested.has('en')) need.push('en')

  const langReady = uiByLang[lang] !== undefined
  const enReady = lang === 'en' || uiByLang.en !== undefined
  if (langReady && enReady) {
    return { active: lang, need }
  }
  return { active, need }
}

/**
 * requested（onNeedLang で求めたことがある言語の記録）から、uiByLang に入った言語を取り除く。
 * requestedRef は「一度求めたら二度と求めない」ための記録ではなく「いま進行中の要求」の記録として
 * 使うための後始末（2026-09-24 レビュー should 1: 取り除かないと、uiByLang から言語が消えたとき
 * （呼んだ側の都合でキャッシュを破棄した場合など）に二度と求められなくなる）。
 * I18nProvider.tsx の useEffect から、decideLang を呼ぶ前に毎回かける。
 */
export function pruneRequested(
  requested: ReadonlySet<string>,
  uiByLang: Record<string, UiDict | undefined>,
): Set<string> {
  const next = new Set<string>()
  for (const code of requested) {
    if (uiByLang[code] === undefined) next.add(code)
  }
  return next
}
