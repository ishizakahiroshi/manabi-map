// C3（文言の書式とふりがな）のテスト。描画の確認は react-dom/server の renderToString と
// createElement を使う（vitest の環境は node で DOM が無い。子 plan「書き方の約束」）。
// 2026-09-23 レビュー（must 1・should 1〜7）と、その再レビュー（should 3 件）を反映。

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { FuriganaSetting } from './markup'
import { needsRuby, parseMarkup, plainText } from './markup'
import { FuriganaProvider, Markup } from './MarkupView'

/** FuriganaProvider で setting を差し替えて Markup を描き、HTML 文字列にする */
function renderWithSetting(text: string, setting: FuriganaSetting): string {
  return renderToString(
    createElement(FuriganaProvider, { value: setting }, createElement(Markup, { text })),
  )
}

describe('Markup（描画）', () => {
  it('{name} に <b>x</b> を差し込むと &lt;b&gt; として出る（タグにならない）', () => {
    const html = renderToString(createElement(Markup, { text: '{name}', vars: { name: '<b>x</b>' } }))
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<b>')
  })

  it('vars に無い {name} は空文字', () => {
    const html = renderToString(createElement(Markup, { text: '[{name}]' }))
    // React は隣り合う text ノードの境目を <!-- --> で区切ることがあるので、それは除いて比較する
    // （子 plan の書式では var は独立したセグメントとして残るため、'[' var ']' の 3 つが並ぶ）。
    expect(html.replace(/<!--.*?-->/g, '')).toBe('[]')
  })

  it('<a>{漢字|かんじ}</a> が span.accent の中の ruby になる', () => {
    const html = renderToString(createElement(Markup, { text: '<a>{漢字|かんじ}</a>' }))
    expect(html).toMatch(/<span class="accent">[\s\S]*<ruby/)
  })

  it('<br> が <br/> になる', () => {
    const html = renderToString(createElement(Markup, { text: 'あ<br>い' }))
    expect(html).toContain('<br/>')
  })

  it('モード none では ruby が出ない', () => {
    const html = renderWithSetting('{漢字|かんじ}', { mode: 'none', level: '10', levelOf: () => undefined })
    expect(html).not.toContain('<ruby')
    expect(html).toContain('漢字')
  })

  it('unlearned・級 6: levelOf が 10 を返す字には ruby が出ず、5 を返す字には出る', () => {
    // テスト用の合成の対応（子 plan「検証方法」）。実データは親 plan C3 で作る。
    const levelOf = (ch: string): FuriganaSetting['level'] | undefined => {
      if (ch === '日') return '10'
      if (ch === '熟') return '5'
      return undefined
    }
    const setting: FuriganaSetting = { mode: 'unlearned', level: '6', levelOf }

    const htmlAlreadyLearned = renderWithSetting('{日|ひ}', setting)
    expect(htmlAlreadyLearned).not.toContain('<ruby')

    const htmlNotYetLearned = renderWithSetting('{熟|じゅく}', setting)
    expect(htmlNotYetLearned).toContain('<ruby')
  })

  it('unlearned・levelOf が undefined を返す字には ruby が出る', () => {
    const setting: FuriganaSetting = { mode: 'unlearned', level: '6', levelOf: () => undefined }
    const html = renderWithSetting('{未|み}', setting)
    expect(html).toContain('<ruby')
  })

  it('漢字の無い {ABC|えーびーしー} には ruby が出ない', () => {
    const html = renderToString(createElement(Markup, { text: '{ABC|えーびーしー}' }))
    expect(html).not.toContain('<ruby')
    expect(html).toContain('ABC')
  })
})

describe('plainText', () => {
  it("plainText('<a>{漢字|かんじ}</a>を<br>書く') が '漢字を 書く'", () => {
    expect(plainText('<a>{漢字|かんじ}</a>を<br>書く')).toBe('漢字を 書く')
  })
})

describe('parseMarkup / needsRuby（補助）', () => {
  it('それ以外の { } はただの文字として残す（ふりがな候補の形に合わない場合）', () => {
    const segments = parseMarkup('{漢字}だけ')
    expect(segments).toEqual([{ type: 'text', value: '{漢字}だけ' }])
  })

  it('base に漢字が無ければ、どのモードでも false', () => {
    const setting: FuriganaSetting = { mode: 'all', level: '10', levelOf: () => undefined }
    expect(needsRuby('ABC', setting)).toBe(false)
  })
})

describe('must 1: <a> の中の <br> も改行になる', () => {
  it('<a>上<br>下</a> の <br> は改行になる（&lt;br&gt; という文字にならない）', () => {
    const html = renderToString(createElement(Markup, { text: '<a>上<br>下</a>' }))
    expect(html).not.toContain('&lt;br&gt;')
    expect(html).toContain('<br/>')
  })

  it("plainText('<a>上<br>下</a>') が '上 下'", () => {
    expect(plainText('<a>上<br>下</a>')).toBe('上 下')
  })
})

describe('should 1: 読みに | を含むものはふりがな候補にならない', () => {
  it("parseMarkup('{漢|字|かんじ}') が入力と同じ文字列の text セグメント 1 つを返す", () => {
    expect(parseMarkup('{漢|字|かんじ}')).toEqual([{ type: 'text', value: '{漢|字|かんじ}' }])
  })

  it("parseMarkup('{a||b}') が入力と同じ文字列の text セグメント 1 つを返す", () => {
    expect(parseMarkup('{a||b}')).toEqual([{ type: 'text', value: '{a||b}' }])
  })
})

describe('should 2: 々 は級の判定に使わない', () => {
  it("needsRuby('人々', ...) は、人 の級が学習者の級より下なら false（々 自体は級を持たない）", () => {
    const setting: FuriganaSetting = {
      mode: 'unlearned',
      level: '6',
      levelOf: (ch) => (ch === '人' ? '10' : undefined),
    }
    expect(needsRuby('人々', setting)).toBe(false)
  })
})

describe('should 3: 描画とふりがな境界の厳密なテスト', () => {
  it('<a>{漢字|かんじ}</a> の描画が完全一致する（rt を消したら落ちる）', () => {
    const html = renderToString(createElement(Markup, { text: '<a>{漢字|かんじ}</a>' }))
    expect(html).toBe('<span class="accent"><ruby>漢字<rt>かんじ</rt></ruby></span>')
  })

  it('needsRuby は境界（>=）で true になる（学習者と同じ級の字）', () => {
    const setting: FuriganaSetting = {
      mode: 'unlearned',
      level: '6',
      levelOf: (ch) => (ch === '六' ? '6' : undefined),
    }
    expect(needsRuby('六', setting)).toBe(true)
  })

  it('needsRuby は base の中の 1 字でも条件を満たせば true（some の確認）', () => {
    const levelOf = (ch: string) => (ch === '日' ? '10' : ch === '熟' ? '5' : undefined)
    const setting: FuriganaSetting = { mode: 'unlearned', level: '6', levelOf }
    expect(needsRuby('日熟', setting)).toBe(true)
  })
})

describe('should 4: vars の値・崩れた入力はどちらも書式として解釈しない', () => {
  it('vars の値に <a> や <br> に見える文字列を差し込んでもタグにならない', () => {
    const html = renderToString(
      createElement(Markup, { text: '{name}', vars: { name: '<a>{漢|かん}</a><br>' } }),
    )
    expect(html).not.toContain('<span')
    expect(html).not.toContain('<ruby')
    expect(html).not.toContain('<br/>')
    expect(html).toContain('&lt;a&gt;{漢|かん}')
  })

  const brokenInputs = [
    '<a>abc', // 閉じていない <a>
    '{', // { だけ
    '}', // } だけ
    '{|}',
    '{a|}',
    '<A>', // 大文字は <a> と別物（大文字小文字を区別する）
    '<br/>', // 自己終了は <br> と別物（4 文字ぴったりでない）
  ]
  it.each(brokenInputs)('崩れた入力 %j は plainText で変化しない', (input) => {
    expect(plainText(input)).toBe(input)
  })
})

describe('should 6: KANJI_RE は BMP の外の漢字も判定する', () => {
  it('𠮟（常用漢字・サロゲートペア）は漢字と判定され、すべてモードでふりがなが付く', () => {
    const html = renderToString(createElement(Markup, { text: '{𠮟る|しかる}' }))
    expect(html).toContain('<ruby')
  })
})

describe('should 7: {name} の差し込み値に React の要素を渡せる', () => {
  it('vars の値に <Markup> を渡すと、その中の ruby も出力に入る', () => {
    const html = renderToString(
      createElement(Markup, {
        text: '{name}から',
        vars: { name: createElement(Markup, { text: '{級|きゅう}' }) },
      }),
    )
    expect(html).toContain('<ruby')
    expect(html).toContain('きゅう')
  })
})

describe('再レビュー should 1: ふりがな候補の中の <br> はそこで区切られる', () => {
  it("parseMarkup('{漢<br>字|かん}') が [text '{漢', br, text '字|かん}'] を返す", () => {
    // 以前は base の文字クラスが < > を締め出していなかったため、<br> ごと base に取り込んで
    // しまい「&lt;br&gt;」という文字が出ていた。< > を締め出すと、その手前で match が切れる。
    expect(parseMarkup('{漢<br>字|かん}')).toEqual([
      { type: 'text', value: '{漢' },
      { type: 'br' },
      { type: 'text', value: '字|かん}' },
    ])
  })

  it('描いた結果に &lt;br&gt; という文字が出ない（<br> は改行として扱われる）', () => {
    const html = renderToString(createElement(Markup, { text: '{漢<br>字|かん}' }))
    expect(html).not.toContain('&lt;br&gt;')
    expect(html).toContain('<br/>')
  })
})

describe('再レビュー should 3: 差し込んだ要素に key が付き、React が警告を出さない', () => {
  it('同じ要素を <a> の中と外で 2 回差し込んでも console.error（key 警告など）が呼ばれない', () => {
    // renderVar が cloneElement で key を足しているかの確認。cloneElement の { key } を
    // 一時的に外して手元で実行すると、React の重複 key 警告で console.error が呼ばれてこの
    // テストが落ちることを確認済み（2026-09-23 再レビュー should 3。確認後に key を戻した）。
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const shared = createElement(Markup, { text: '{級|きゅう}' })
      const html = renderToString(
        createElement(Markup, { text: '{a}と<a>{a}</a>', vars: { a: shared } }),
      )
      expect(html).toContain('きゅう')
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
