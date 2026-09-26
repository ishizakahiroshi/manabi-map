// 言語パックの形と読み込み（親 plan D-8・子 plan「作業内容」1〜3）。
// 1 言語 = 1 つの JSON ファイル（./packs/*.json）。import.meta.glob でファイルを集めるので、
// 言語の一覧はコードに直書きしない（detectLang の読み替え表だけは例外。子 plan「維持する仕様」）。
// 読み込むのは選んだ言語と英語の ui だけ（meta は一覧を作るために全部読む）。

import type { DisplayMode } from '../types'

/** 言語パックの status。source=日本語（原文）/ reviewed=母語話者の確認済み / draft=仮訳（未確認） */
export type PackStatus = 'source' | 'reviewed' | 'draft'

/** 言語パックの meta（子 plan「作業内容」1） */
export interface LangPackMeta {
  /** ファイル名（拡張子なし）と同じにする */
  code: string
  /** その言語自身での名前 */
  name: string
  /** 言語の一覧に出す並び順 */
  order: number
  /** その言語の文字に使う font-family の値。端末の文字を使うのでふつうは null */
  font: string | null
  status: PackStatus
}

/** 文言の値。単一の文言、または [こども向け, おとな向け] */
export type UiValue = string | [string, string]

/** 言語パックの ui（キー→文言）。値は同じディレクトリの markup.ts の書式で書く */
export type UiDict = Record<string, UiValue>

/**
 * 全言語パックの meta を eager（同期）で集めたもの（クエリ無しの通常の JSON import。名前付き
 * export の meta だけを取り出す）。全パックぶん読んでも meta は小さいのでコストは小さい。
 */
const metaModules = import.meta.glob<LangPackMeta>('./packs/*.json', { eager: true, import: 'meta' })

/** 全言語パックの meta を order の昇順に並べたもの。ファイルを足せば増える（一覧を直書きしない） */
export const LANGUAGES: LangPackMeta[] = Object.values(metaModules).sort((a, b) => a.order - b.order)

/**
 * 言語ごとに ui を遅延読み込みする関数。クエリ無しの通常の JSON import と同じ import 先（拡張子まで
 * 同じパス）を eager にも遅延にも使うと、Rollup が「どうせ静的 import 済みだから」と判断して動的
 * import を分割しない（ビルドが INEFFECTIVE_DYNAMIC_IMPORT を警告し、実際に ui が最初の chunk へ
 * 混ざる。2026-09-23 実装時に確認ビルドで検出。維持する仕様「読み込むのは選んだ言語と英語の ui
 * だけ」に反する）。`?raw` クエリを付けて別モジュール扱いにし、ここで JSON.parse して ui を取り出す
 * ことで、meta の eager import とは別 chunk に分けられるようにする。
 */
const uiRawLoaders = import.meta.glob<string>('./packs/*.json', { import: 'default', query: 'raw' })

/** BOM（U+FEFF）を取り除く。エディタが UTF-8 BOM 付きで保存した JSON でも JSON.parse に通す */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** UiValue（string か [string, string]）の形をしているか */
function isUiValue(value: unknown): value is UiValue {
  if (typeof value === 'string') return true
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string'
}

/**
 * raw な JSON テキストを言語パックとして検証し、ui を取り出す（should 1: 2026-09-23 レビュー。
 * `JSON.parse(raw) as ...` は形を何も確かめていなかった）。BOM を許容する。ui が無い・object で
 * ない・値が文字列でも [文字列, 文字列] でもないキーがあれば、code（ファイル名）を含むエラーを
 * 投げる。loadUi から呼ぶほか、テストからも直接呼べるよう export する。
 */
export function parsePackUi(raw: string, code: string): UiDict {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(raw))
  } catch (cause) {
    throw new Error(`言語パック ${code}: JSON として読めません`, { cause })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`言語パック ${code}: 中身が object ではありません`)
  }
  const ui = (parsed as Record<string, unknown>).ui
  if (typeof ui !== 'object' || ui === null || Array.isArray(ui)) {
    throw new Error(`言語パック ${code}: ui が object ではありません`)
  }
  for (const [key, value] of Object.entries(ui)) {
    if (!isUiValue(value)) {
      throw new Error(`言語パック ${code}: キー "${key}" の値が文字列でも [文字列, 文字列] でもありません`)
    }
  }
  return ui as UiDict
}

/**
 * code の言語の ui を読み込む。パックが無い言語では undefined を返す。呼んだ側はそのときも
 * uiByLang[code] = {} を入れる約束にする（子 plan「作業内容」4。I18nProvider.tsx の decideLang・
 * pruneRequested が「読み込み済み（失敗も含む）」として扱えるようにするため。2026-09-24 レビューで
 * コメントを子 plan の記述に合わせて直した）。
 */
export async function loadUi(code: string): Promise<UiDict | undefined> {
  const loader = uiRawLoaders[`./packs/${code}.json`]
  if (!loader) return undefined
  const raw = await loader()
  return parsePackUi(raw, code)
}

/** resolveText の返り値。lang は実際に使った言語（キーそのものを返したときは 'en'） */
export interface ResolvedText {
  text: string
  lang: string
}

/** 配列の値を display（こども / おとな）で選ぶ。単一の文言はそのまま返す */
function pickDisplay(value: UiValue, display: DisplayMode): string {
  if (Array.isArray(value)) {
    return display === 'child' ? value[0] : value[1]
  }
  return value
}

/**
 * key の文言を lang → en → キーそのもの、の順に探す（子 plan「作業内容」3）。
 * 配列の値は display で選ぶ。uiByLang に無い言語（未読み込み）は無視して次を試す。
 */
export function resolveText(
  key: string,
  lang: string,
  uiByLang: Record<string, UiDict | undefined>,
  display: DisplayMode,
): ResolvedText {
  const primary = uiByLang[lang]?.[key]
  if (primary !== undefined) {
    return { text: pickDisplay(primary, display), lang }
  }
  const fallback = uiByLang.en?.[key]
  if (fallback !== undefined) {
    return { text: pickDisplay(fallback, display), lang: 'en' }
  }
  return { text: key, lang: 'en' }
}

/**
 * 日本語のキーのうち、code の言語にあるキーの割合（0〜100 の整数）。ja または code の ui が
 * uiByLang に無ければ 0（網羅率を出すには両方が読み込み済みである必要がある）。
 */
export function coverage(code: string, uiByLang: Record<string, UiDict | undefined>): number {
  const ja = uiByLang.ja
  const target = uiByLang[code]
  if (!ja || !target) return 0
  const jaKeys = Object.keys(ja)
  if (jaKeys.length === 0) return 0
  const present = jaKeys.filter((key) => target[key] !== undefined).length
  // 切り捨て（should 3: 2026-09-23 レビュー）。四捨五入だと 1 キーだけ欠けていても 100 に
  // 丸まってしまうことがあり、「完全ではない」ことが網羅率の表示から消えてしまうため。
  return Math.floor((present / jaKeys.length) * 100)
}

/**
 * navigator.languages によく出る地域付きの表記を、言語パックのファイル名（BCP 47）に合わせる
 * 読み替え（親 plan D-8・子 plan「作業内容」3）。完全一致・先頭の言語コードの一致では拾えない
 * 組み合わせ（例: zh-TW → zh-Hant）のためだけに使う。tag は小文字化した値を渡す
 * （detectLang 側で大文字小文字を無視して比べるため。should 4: 2026-09-23 レビュー）。
 */
function remapTag(tagLower: string): string | undefined {
  if (tagLower === 'zh-cn' || tagLower === 'zh-sg' || tagLower.startsWith('zh-hans')) return 'zh-Hans'
  if (tagLower === 'zh-tw' || tagLower === 'zh-hk' || tagLower === 'zh-mo' || tagLower.startsWith('zh-hant')) return 'zh-Hant'
  if (tagLower === 'pt' || tagLower.startsWith('pt-')) return 'pt'
  if (tagLower === 'tl' || tagLower === 'fil' || tagLower.startsWith('fil-')) return 'fil'
  if (tagLower === 'es' || tagLower.startsWith('es-')) return 'es'
  return undefined
}

/**
 * 端末の言語（navigator.languages の形の配列）から、available にある言語コードを選ぶ
 * （子 plan「作業内容」3）。preferred を前から順に見て、各言語につき
 * 完全一致 → 読み替え → 先頭の言語コードの一致、の順で available にあるものを探す。
 * 比較は大文字小文字を区別しない（`zh-tw` でも `zh-TW` でも同じに扱う。should 4: 2026-09-23
 * レビュー）。返す値は available に書いてある形（大文字小文字も含めて元のまま）。
 * どれにも当たらなければ 'en'。
 */
export function detectLang(preferred: readonly string[], available: readonly string[]): string {
  const byLower = new Map<string, string>()
  for (const code of available) {
    const lower = code.toLowerCase()
    if (!byLower.has(lower)) byLower.set(lower, code)
  }

  for (const tag of preferred) {
    const tagLower = tag.toLowerCase()

    const exact = byLower.get(tagLower)
    if (exact) return exact

    const remapped = remapTag(tagLower)
    const remappedMatch = remapped ? byLower.get(remapped.toLowerCase()) : undefined
    if (remappedMatch) return remappedMatch

    const leadingLower = tagLower.split('-')[0]
    const leadingMatch = leadingLower ? byLower.get(leadingLower) : undefined
    if (leadingMatch) return leadingMatch
  }
  return 'en'
}

/**
 * meta.font があれば、その言語の文字に使う font-family を :lang() セレクタで指定する <style> を
 * head に 1 回だけ足す（既に足してあれば何もしない）。document が無い環境（テスト等）では何もしない。
 */
export function ensureFont(meta: LangPackMeta): void {
  if (!meta.font || typeof document === 'undefined') return
  if (document.head.querySelector(`style[data-kanji-font="${meta.code}"]`)) return
  const style = document.createElement('style')
  style.setAttribute('data-kanji-font', meta.code)
  style.textContent = `:lang(${meta.code}){font-family:${meta.font}}`
  document.head.appendChild(style)
}
