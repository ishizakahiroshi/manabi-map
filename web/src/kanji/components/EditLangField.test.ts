// components/EditLangField.tsx のテスト（C8 レビュー must 3）。
// LanguageSheet を vi.mock して、EditLangField が渡す props（value・onSelect）を捕まえる。
// vitest の環境は node（DOM が無い）ため、シートの中のボタンを実際に「押す」ことはできない。
// その代わり、捕まえた onSelect を素の関数として直接呼び、EditLangField が onChange（setUiLang
// ではない）を正しく呼ぶことを確かめる（LanguageSheet 自身の onSelect の有無での分岐は
// components/sheets.test.ts の pickLanguage のテストで確かめ済み。ここでは EditLangField が
// LanguageSheet に onSelect を渡し切っていること・その先で onChange を呼ぶことだけを見る）。

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import en from '../i18n/packs/en.json'
import ja from '../i18n/packs/ja.json'
import { I18nProvider } from '../i18n/I18nProvider'
import type { UiDict } from '../i18n/packs'

const jaUi = ja.ui as unknown as UiDict
const enUi = en.ui as unknown as UiDict

let capturedSheetProps: { value?: string; onSelect?: (code: string) => void } | null = null

vi.mock('./LanguageSheet', () => ({
  LanguageSheet: (props: { value?: string; onSelect?: (code: string) => void }) => {
    capturedSheetProps = props
    return null
  },
}))

// vitest（Vite）は vi.mock をファイル先頭へ巻き上げるので、この後の静的 import で
// モック済みの LanguageSheet が使われる（school サイトの src/hooks/useIsAdmin.test.ts 等と同じ書き方）。
import { EditLangField } from './EditLangField'

function renderField(props: {
  value: string
  onChange: (code: string) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return renderToString(
    createElement(
      I18nProvider,
      { lang: 'ja', display: 'child', uiByLang: { ja: jaUi, en: enUi }, onNeedLang: () => {} },
      createElement(EditLangField, { ...props, labelId: 'kanji-edit-lang-label' }),
    ),
  )
}

beforeEach(() => {
  capturedSheetProps = null
})

describe('EditLangField', () => {
  it('open=false のときは LanguageSheet を描かない', () => {
    renderField({ value: 'ja', onChange: () => {}, open: false, onOpenChange: () => {} })
    expect(capturedSheetProps).toBeNull()
  })

  it('open=true のときは LanguageSheet に value と onSelect を渡す', () => {
    renderField({ value: 'en', onChange: () => {}, open: true, onOpenChange: () => {} })
    expect(capturedSheetProps).not.toBeNull()
    expect(capturedSheetProps!.value).toBe('en')
    expect(typeof capturedSheetProps!.onSelect).toBe('function')
  })

  it('LanguageSheet の onSelect を呼ぶと onChange が呼ばれ、シートが閉じる（onOpenChange(false)）', () => {
    const onChange = vi.fn()
    const onOpenChange = vi.fn()
    renderField({ value: 'ja', onChange, open: true, onOpenChange })
    capturedSheetProps!.onSelect!('vi')
    expect(onChange).toHaveBeenCalledWith('vi')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('ことばのボタンの aria-labelledby に、見出しの id と言語名の span の id の両方が入る（should 2）', () => {
    const html = renderField({ value: 'en', onChange: () => {}, open: false, onOpenChange: () => {} })
    expect(html).toContain('aria-labelledby="kanji-edit-lang-label kanji-edit-lang-label-value"')
    expect(html).toContain('id="kanji-edit-lang-label-value"')
  })
})
