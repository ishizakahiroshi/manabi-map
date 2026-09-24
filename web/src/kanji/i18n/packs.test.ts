// C4（言語パック）のテスト。ja.json / en.json 自体の整合、resolveText・detectLang・coverage・
// parsePackUi の挙動、I18nProvider / useI18n / decideLang / pruneRequested の挙動を確かめる
// （子 plan「検証方法」と 2026-09-23・2026-09-24 レビューの must 1・must 2・should 1〜5）。

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ja from './packs/ja.json'
import en from './packs/en.json'
import {
  coverage,
  detectLang,
  loadUi,
  parsePackUi,
  resolveText,
  type LangPackMeta,
  type UiDict,
} from './packs'
import { decideLang, pruneRequested } from './decideLang'
import { I18nProvider, useI18n } from './I18nProvider'

// JSON から推論される配列プロパティの型は string[]（固定長のタプルではない）なので、
// UiDict（[string, string] を含む）へは unknown を経由してキャストする。
const jaUi = ja.ui as unknown as UiDict
const enUi = en.ui as unknown as UiDict

// BOM（U+FEFF）はソースに生の文字で書かない。4 桁の文字コードのエスケープ表記も書かない
// （エディタや保存ツールがその表記を実際の文字へ変換してしまうことがあるため。2026-09-24
// レビュー should）。16 進数の数値から組み立てる。web/src/kanji に U+FEFF の生の文字が
// 無いことは別途バイト単位で確認している。
const BOM = String.fromCharCode(0xfeff)

// must 2（2026-09-23 レビュー）: 「すべてのパック」の検査を ja・en の直書きにせず、
// import.meta.glob でディレクトリの実物から集める。将来パックが増えても、また誰かが壊れた
// パックを置いてもこのテストが拾う。
const allPackModules = import.meta.glob<{ meta: LangPackMeta; ui: UiDict }>('./packs/*.json', { eager: true })

function codeFromPath(path: string): string {
  const match = /\/([^/]+)\.json$/.exec(path)
  if (!match) throw new Error(`glob のパスの形が想定外です: ${path}`)
  return match[1]!
}

describe('言語パックの JSON（すべてのパック・must 2）', () => {
  const entries = Object.entries(allPackModules).map(([path, mod]) => [codeFromPath(path), mod] as const)

  it('パックが 1 つ以上見つかる（glob が空を返していないことの確認）', () => {
    expect(entries.length).toBeGreaterThan(0)
  })

  it('すべてのパックの meta.code がファイル名と一致し、status が決めた 3 つのどれかである', () => {
    const allowedStatus = ['source', 'reviewed', 'draft']
    for (const [code, mod] of entries) {
      expect(mod.meta.code).toBe(code)
      expect(allowedStatus).toContain(mod.meta.status)
    }
  })

  it('すべてのパックの order が有限の数で重複せず、name が空でない文字列、font が文字列か null である', () => {
    const orders = new Set<number>()
    for (const [, mod] of entries) {
      expect(Number.isFinite(mod.meta.order)).toBe(true)
      expect(orders.has(mod.meta.order)).toBe(false)
      orders.add(mod.meta.order)
      expect(typeof mod.meta.name).toBe('string')
      expect(mod.meta.name.length).toBeGreaterThan(0)
      expect(mod.meta.font === null || typeof mod.meta.font === 'string').toBe(true)
    }
  })

  it('すべてのパックの文言に、書式の 4 つ以外の <...> が無い', () => {
    const allowed = new Set(['<a>', '</a>', '<br>'])
    for (const [, mod] of entries) {
      for (const value of Object.values(mod.ui)) {
        const texts: string[] = Array.isArray(value) ? value : [value]
        for (const text of texts) {
          const tags = text.match(/<[^>]*>/g) ?? []
          for (const tag of tags) {
            expect(allowed.has(tag)).toBe(true)
          }
        }
      }
    }
  })

  it('すべてのパックで loadUi(code) が glob で見えている ui と同じ内容を返す', async () => {
    for (const [code, mod] of entries) {
      const ui = await loadUi(code)
      expect(ui).toEqual(mod.ui)
    }
  })

  it('ja のキーと en のキーが同じ集合である', () => {
    const byCode = Object.fromEntries(entries)
    expect(Object.keys(byCode.ja!.ui).sort()).toEqual(Object.keys(byCode.en!.ui).sort())
  })
})

describe('parsePackUi（should 1）', () => {
  it('先頭に BOM（U+FEFF）が付いていても読める', () => {
    const raw = BOM + JSON.stringify({ meta: ja.meta, ui: { a: 'b', c: ['x', 'y'] } })
    expect(parsePackUi(raw, 'zz')).toEqual({ a: 'b', c: ['x', 'y'] })
  })

  it('ui が無ければ、ファイル名（code）を含む例外を投げる', () => {
    const raw = JSON.stringify({ meta: ja.meta })
    expect(() => parsePackUi(raw, 'zz')).toThrow(/zz/)
  })

  it('値が要素 1 つの配列なら、ファイル名（code）を含む例外を投げる', () => {
    const raw = JSON.stringify({ meta: ja.meta, ui: { a: ['only-one'] } })
    expect(() => parsePackUi(raw, 'zz')).toThrow(/zz/)
  })
})

describe('resolveText', () => {
  it('vi（未読み込み）→ en の値を lang: "en" で返す', () => {
    const resolved = resolveText('tab.home', 'vi', { en: enUi }, 'child')
    expect(resolved).toEqual({ text: 'Home', lang: 'en' })
  })

  it('配列の値で child が 0 番目・adult が 1 番目を返す', () => {
    const child = resolveText('tab.practice', 'ja', { ja: jaUi }, 'child')
    const adult = resolveText('tab.practice', 'ja', { ja: jaUi }, 'adult')
    expect(child).toEqual({ text: 'れんしゅう', lang: 'ja' })
    expect(adult).toEqual({ text: '{練習|れんしゅう}', lang: 'ja' })
  })

  it('無いキーはキーそのものを返す', () => {
    const resolved = resolveText('no.such.key', 'ja', { ja: jaUi, en: enUi }, 'child')
    expect(resolved).toEqual({ text: 'no.such.key', lang: 'en' })
  })
})

describe('detectLang', () => {
  // 実際のパックはまだ ja / en の 2 つだけなので、将来の 14 言語ぶんの available を合成して検証する
  const available = ['ja', 'en', 'zh-Hans', 'zh-Hant', 'pt', 'fil', 'es']

  it("detectLang(['zh-TW'], available) が zh-Hant", () => {
    expect(detectLang(['zh-TW'], available)).toBe('zh-Hant')
  })

  it("detectLang(['pt-BR'], available) が pt", () => {
    expect(detectLang(['pt-BR'], available)).toBe('pt')
  })

  it("detectLang(['fr-FR', 'ja-JP'], available) が ja", () => {
    expect(detectLang(['fr-FR', 'ja-JP'], available)).toBe('ja')
  })

  it("detectLang(['fr-FR'], available) が en", () => {
    expect(detectLang(['fr-FR'], available)).toBe('en')
  })

  it("should 4: 大文字小文字を無視する（['zh-tw'] → 'zh-Hant'）", () => {
    expect(detectLang(['zh-tw'], available)).toBe('zh-Hant')
  })

  it("should 4: 大文字小文字を無視する（['PT-br'] → 'pt'）", () => {
    expect(detectLang(['PT-br'], available)).toBe('pt')
  })
})

describe('coverage', () => {
  it("coverage('en', ...) が 100", () => {
    expect(coverage('en', { ja: jaUi, en: enUi })).toBe(100)
  })

  it('should 3: 端数は切り捨てる（200 キー中 199 → 99）', () => {
    const jaSynthetic: UiDict = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, 'x']))
    const targetSynthetic: UiDict = Object.fromEntries(Array.from({ length: 199 }, (_, i) => [`k${i}`, 'y']))
    expect(coverage('target', { ja: jaSynthetic, target: targetSynthetic })).toBe(99)
  })
})

describe('decideLang（must 1・should 2・純粋関数）', () => {
  it('must 1: 最初の描画で lang === active でも、未読み込みなら need に積む', () => {
    const result = decideLang({ lang: 'vi', active: 'vi', uiByLang: {}, requested: new Set() })
    expect(result.need).toEqual(['vi', 'en'])
  })

  it('ja と en を読み込み済みで lang="ja" なら need は空', () => {
    const result = decideLang({ lang: 'ja', active: 'ja', uiByLang: { ja: jaUi, en: enUi }, requested: new Set() })
    expect(result.need).toEqual([])
  })

  it('should 2: 新しい言語が {}（読み込み失敗の印）でも active はそちらへ移る', () => {
    const result = decideLang({ lang: 'vi', active: 'ja', uiByLang: { vi: {}, en: enUi }, requested: new Set() })
    expect(result.active).toBe('vi')
  })

  it('should 2: 一度求めた言語は、まだ読み込めていなくても need に繰り返さない', () => {
    const first = decideLang({ lang: 'vi', active: 'ja', uiByLang: {}, requested: new Set() })
    expect(first.need).toEqual(['vi', 'en'])
    const requested = new Set(first.need)
    const second = decideLang({ lang: 'vi', active: 'ja', uiByLang: {}, requested })
    expect(second.need).toEqual([])
  })

  it('2026-09-24 レビュー should: 一度読み込んだ言語が uiByLang から消えると、pruneRequested を挟んだ後の need にもう一度入る', () => {
    // 1 回目: vi・en とも未読み込み。両方 need に積まれ、呼び出し側が requestedRef に記録する。
    const first = decideLang({ lang: 'vi', active: 'ja', uiByLang: {}, requested: new Set() })
    expect(first.need).toEqual(['vi', 'en'])
    let requested = new Set(first.need)

    // 2 回目: vi・en とも読み込み終わった。I18nProvider の effect は decideLang の前に
    // pruneRequested をかけるので、読み込み済みになった言語は requested から消える。
    const loadedUiByLang = { vi: {}, en: enUi }
    requested = pruneRequested(requested, loadedUiByLang)
    expect(requested.size).toBe(0)
    const second = decideLang({ lang: 'vi', active: 'ja', uiByLang: loadedUiByLang, requested })
    expect(second.active).toBe('vi')
    expect(second.need).toEqual([])

    // 3 回目: 何らかの理由で vi が uiByLang から消えた（キャッシュ破棄などを想定）。
    // requested はすでに 2 回目で空になっているので、vi がもう一度 need に入る。
    const uiByLangAfterEviction = { en: enUi }
    requested = pruneRequested(requested, uiByLangAfterEviction)
    const third = decideLang({ lang: 'vi', active: 'vi', uiByLang: uiByLangAfterEviction, requested })
    expect(third.need).toEqual(['vi'])
  })
})

describe('I18nProvider / useI18n（描画・should 5）', () => {
  function Probe({ k }: { k: string }) {
    const { t, text } = useI18n()
    return createElement('div', { 'data-text': text(k) }, t(k))
  }

  it('ja は span[lang] で包まない', () => {
    const html = renderToString(
      createElement(
        I18nProvider,
        { lang: 'ja', display: 'child', uiByLang: { ja: jaUi, en: enUi }, onNeedLang: () => {} },
        createElement(Probe, { k: 'tab.home' }),
      ),
    )
    expect(html).not.toContain('<span lang=')
    expect(html).toContain('ホーム')
  })

  it('vi が en へ落ちたら <span lang="en"> で包む', () => {
    const html = renderToString(
      createElement(
        I18nProvider,
        { lang: 'vi', display: 'child', uiByLang: { en: enUi }, onNeedLang: () => {} },
        createElement(Probe, { k: 'tab.home' }),
      ),
    )
    expect(html).toContain('<span lang="en">Home</span>')
  })

  it('text は書式を外した文字列を返す（{ } < > を含まない）', () => {
    const html = renderToString(
      createElement(
        I18nProvider,
        { lang: 'ja', display: 'child', uiByLang: { ja: jaUi, en: enUi }, onNeedLang: () => {} },
        createElement(Probe, { k: 'wel.body' }),
      ),
    )
    const dataText = /data-text="([^"]*)"/.exec(html)?.[1]
    expect(dataText).toBeDefined()
    expect(dataText).not.toMatch(/[{}<>]/)
    // wel.body（child, C9 でたねもじの文言に差し替え）: 「{漢字|かんじ}を、ひとつずつ
    // {育|そだ}てていこう。<br>…」。ruby と <br> を含む
    expect(dataText).toContain('育てていこう')
  })
})
