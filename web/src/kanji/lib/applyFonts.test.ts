// applyFonts.ts（C6 レビュー should 1）のテスト。
// ensureFont（C4・i18n/packs.ts）は document.head.querySelector / document.createElement /
// style.setAttribute / style.textContent / document.head.appendChild だけを使う。vitest の環境は
// node で document が無いので、ensureFont の型を変えずに実際の DOM 操作を確かめるため、必要な分
// だけの軽い偽物を作って vi.stubGlobal で差し込む（should 1「document を渡せる形にする」の代わり）。

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LangPackMeta } from '../i18n/packs'
import { applyAllFonts } from './applyFonts'

interface FakeStyleEl {
  attrs: Record<string, string>
  textContent: string
  setAttribute(key: string, value: string): void
}

function makeFakeDocument() {
  const styles: FakeStyleEl[] = []
  return {
    head: {
      querySelector(selector: string) {
        const code = /data-kanji-font="([^"]+)"/.exec(selector)?.[1]
        return styles.find((s) => s.attrs['data-kanji-font'] === code) ?? null
      },
      appendChild(el: FakeStyleEl) {
        styles.push(el)
        return el
      },
    },
    createElement(_tag: string): FakeStyleEl {
      const el: FakeStyleEl = {
        attrs: {},
        textContent: '',
        setAttribute(key, value) {
          el.attrs[key] = value
        },
      }
      return el
    },
    _styles: styles,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const META_WITH_FONT: LangPackMeta = { code: 'zz', name: 'Zz', order: 99, font: "'Zz Sans'", status: 'draft' }
const META_WITHOUT_FONT: LangPackMeta = { code: 'ja', name: '日本語', order: 0, font: null, status: 'source' }

describe('applyAllFonts', () => {
  it('font を持つ合成の meta を渡すと、document.head に style[data-kanji-font] がちょうど 1 つできる', () => {
    const fakeDocument = makeFakeDocument()
    vi.stubGlobal('document', fakeDocument)

    applyAllFonts([META_WITH_FONT, META_WITHOUT_FONT])

    const zzStyles = fakeDocument._styles.filter((s) => s.attrs['data-kanji-font'] === 'zz')
    expect(zzStyles.length).toBe(1)
    expect(zzStyles[0]!.textContent).toBe(":lang(zz){font-family:'Zz Sans'}")
    // font が無い言語（ja）では作らない
    expect(fakeDocument._styles.some((s) => s.attrs['data-kanji-font'] === 'ja')).toBe(false)
  })

  it('同じ言語に 2 回呼んでも style は 1 つのまま（ensureFont 自身の重複防止）', () => {
    const fakeDocument = makeFakeDocument()
    vi.stubGlobal('document', fakeDocument)

    applyAllFonts([META_WITH_FONT])
    applyAllFonts([META_WITH_FONT])

    expect(fakeDocument._styles.length).toBe(1)
  })

  it('document が無い環境（vitest の既定）では例外を投げない', () => {
    expect(() => applyAllFonts([META_WITH_FONT])).not.toThrow()
  })
})
