// 言語パック（同じディレクトリの packs.ts）の値を、画面から使いやすい形（t・text）で配る React の部品。
// 言語を切り替えるときは、新しい言語と英語の ui を読み込み終えてから切り替える（読み込み中は
// 前の言語のまま表示する。子 plan「作業内容」4）。読み込み自体はこのファイルの責任ではなく、
// onNeedLang で呼び出し側（親 plan C6 の起動処理）に依頼する。

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import type { DisplayMode } from '../types'
import { decideLang, pruneRequested } from './decideLang'
import { plainText } from './markup'
import { Markup, type VarValue } from './MarkupView'
import { resolveText, type UiDict } from './packs'

/** useI18n() が返す値 */
export interface I18nValue {
  /** 実際に文言の解決に使っている言語（読み込み待ちの間は前の言語のまま） */
  lang: string
  /** C3 の書式で書いた文言を Markup で描いた要素にする。使った言語が日本語以外なら span[lang] で包む */
  t: (key: string, vars?: Record<string, VarValue>) => ReactElement
  /** 書式を外した素の文字列（aria-label・placeholder 用） */
  text: (key: string, vars?: Record<string, string>) => string
}

/** lang・display・uiByLang から I18nValue を作る（Provider の値にも、Provider の外で使う既定値にも使う） */
function createI18nValue(lang: string, display: DisplayMode, uiByLang: Record<string, UiDict | undefined>): I18nValue {
  return {
    lang,
    t(key, vars) {
      const resolved = resolveText(key, lang, uiByLang, display)
      const markup = <Markup text={resolved.text} vars={vars} />
      // 既定は日本語（web/kanji/index.html の lang="ja"）なので、使った言語が日本語のときは
      // 余分な lang 属性を付けない。日本語以外のときだけ span[lang] で包む。
      if (resolved.lang === 'ja') return markup
      return <span lang={resolved.lang}>{markup}</span>
    },
    text(key, vars) {
      const resolved = resolveText(key, lang, uiByLang, display)
      return plainText(resolved.text, vars)
    },
  }
}

/**
 * Provider の外（万一の描き忘れ）でも落ちないための既定値。uiByLang が空なので、
 * どのキーも resolveText がキーそのものを返す（FuriganaContext と同じ考え方の既定値。
 * MarkupView.tsx の DEFAULT_FURIGANA_SETTING を参照）。
 */
const I18nContext = createContext<I18nValue>(createI18nValue('en', 'child', {}))

export interface I18nProviderProps {
  /** いまの言語（学習者の設定、または学習者がいないときの uiLang） */
  lang: string
  display: DisplayMode
  /**
   * 読み込み済みの ui。テストでは JSON を直接 import して渡す。読み込みに失敗した言語は、
   * 呼んだ側（親 plan C6 の起動処理）が uiByLang[code] = {} を入れる約束（子 plan「作業内容」4）。
   */
  uiByLang: Record<string, UiDict | undefined>
  /** 未読み込みの言語が要るときに呼ぶ（読み込みそのものは呼び出し側が行う。同じ言語は 2 回求めない） */
  onNeedLang: (code: string) => void
  children?: ReactNode
}

export function I18nProvider({ lang, display, uiByLang, onNeedLang, children }: I18nProviderProps) {
  // 実際に文言の解決に使う言語。新しい lang と en の両方が uiByLang に揃うまでは、前の値のまま
  // 据え置く（読み込み中に文言が英語や空欄へ一瞬切り替わるのを防ぐ。子 plan「作業内容」4）。
  const [activeLang, setActiveLang] = useState(lang)
  // onNeedLang を求めた言語の記録。onNeedLang 自身がメモ化されていなくても、同じ言語を
  // 2 回以上求めない（should 2: 2026-09-23 レビュー）。ただし「一度求めたら永久に求めない」記録では
  // ない。uiByLang に入った（読み込み済みになった）言語は、decideLang を呼ぶ前に毎回 pruneRequested
  // で取り除く（2026-09-24 レビュー: 取り除かないと、後で uiByLang からその言語が消えたときに
  // 二度と求められなくなる）。
  const requestedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    requestedRef.current = pruneRequested(requestedRef.current, uiByLang)
    const result = decideLang({ lang, active: activeLang, uiByLang, requested: requestedRef.current })
    if (result.active !== activeLang) setActiveLang(result.active)
    for (const code of result.need) {
      requestedRef.current.add(code)
      onNeedLang(code)
    }
  }, [lang, activeLang, uiByLang, onNeedLang])

  const value = useMemo(
    () => createI18nValue(activeLang, display, uiByLang),
    [activeLang, display, uiByLang],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  return useContext(I18nContext)
}
