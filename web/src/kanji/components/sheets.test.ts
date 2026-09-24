// C7（シートと引き出し・「このアプリについて」）のテスト。描画の確認は react-dom/server の
// renderToString と createElement を使う（vitest の環境は node で DOM が無い。子 plan
// 「書き方の約束」）。
//
// __APP_VERSION__ は Vite の gitVersion プラグインの define でしか実体が入らず、
// web/vitest.config.ts には define が無い。MoreDrawer・AboutPage を描く前に vi.stubGlobal で
// 埋める（web/src/kanji/lib/applyFonts.test.ts と同じやり方）。

import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from '../i18n/packs/en.json'
import ja from '../i18n/packs/ja.json'
import { I18nProvider } from '../i18n/I18nProvider'
import type { UiDict } from '../i18n/packs'
import { createMemoryStore } from '../lib/store'
import { AboutPage } from '../pages/AboutPage'
import { ProfileProvider } from '../state/ProfileProvider'
import { PROFILE_COLORS, type LearnerProfile } from '../types'
import { LanguageSheet } from './LanguageSheet'
import { pickLanguage } from './languagePick'
import { MoreDrawer } from './MoreDrawer'
import { ProfileSheet } from './ProfileSheet'

const jaUi = ja.ui as unknown as UiDict
const enUi = en.ui as unknown as UiDict
const NOW = '2026-01-01T00:00:00.000Z'
const TEST_VERSION = '0.0.0-test'

beforeAll(() => {
  vi.stubGlobal('__APP_VERSION__', TEST_VERSION)
})

/** テスト用の学習者 fixture。見本の名前（ゆい・Linh）だけ使う */
function makeProfile(overrides: Partial<LearnerProfile> = {}): LearnerProfile {
  return {
    id: 'p1',
    nickname: 'ゆい',
    color: PROFILE_COLORS[0],
    level: '10',
    lang: 'ja',
    furigana: 'all',
    display: 'child',
    kanaKeyboard: false,
    dailyGoal: 10,
    examDate: null,
    writeMode: 'auto',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/**
 * ProfileProvider・I18nProvider・MemoryRouter で包んで HTML 文字列にする（各コンポーネントが
 * useProfiles・useI18n・useNavigate を使うため）。学習者は「ゆい」（id: p1）「Linh」（id: p2）の
 * 合成の 2 人を常に持たせる。
 */
function renderWithProviders(children: ReactElement, currentId: string | null = 'p1'): string {
  const profiles = [makeProfile(), makeProfile({ id: 'p2', nickname: 'Linh', level: '5' })]
  return renderToString(
    createElement(
      MemoryRouter,
      null,
      createElement(
        ProfileProvider,
        {
          store: createMemoryStore(),
          initialProfiles: profiles,
          initialCurrentId: currentId,
          initialUiLang: 'ja',
        },
        createElement(
          I18nProvider,
          { lang: 'ja', display: 'child', uiByLang: { ja: jaUi, en: enUi }, onNeedLang: () => {} },
          children,
        ),
      ),
    ),
  )
}

describe('LanguageSheet（描画）', () => {
  it('日本語 と English のボタンがある', () => {
    const html = renderWithProviders(createElement(LanguageSheet, { onClose: () => {}, noTabs: false }))
    expect(html).toContain('日本語')
    expect(html).toContain('English')
  })

  it('English は <span lang="en">English</span> で名前だけを包み、ボタン自体には lang が付かない（must 3）', () => {
    const html = renderWithProviders(createElement(LanguageSheet, { onClose: () => {}, noTabs: false }))
    expect(html).toContain('<span lang="en">English</span>')
    expect(html).not.toMatch(/<button[^>]*lang=/)
  })

  it('「仮訳」は draft の言語（en）だけに付き、source の日本語には付かない（should 3）', () => {
    const html = renderWithProviders(createElement(LanguageSheet, { onClose: () => {}, noTabs: false }))
    // en.json の meta.status は draft・ja.json は source（子 plan C4「作業内容」2）なので、
    // 2 言語しか無いこの環境では「仮訳」の出現は 1 回だけになる。
    expect((html.match(/仮訳/g) ?? []).length).toBe(1)
  })

  it('value に渡した言語のボタンに chip on が付く', () => {
    const html = renderWithProviders(createElement(LanguageSheet, { value: 'en', onClose: () => {}, noTabs: false }))
    expect(html).toMatch(/class="chip on"[^>]*>\s*<span lang="en">English<\/span>/)
  })

  it('role="dialog" と aria-modal を持つ', () => {
    const html = renderWithProviders(createElement(LanguageSheet, { onClose: () => {}, noTabs: false }))
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
  })

  it('背景（sheet-backdrop）と閉じるボタンがある', () => {
    const html = renderWithProviders(createElement(LanguageSheet, { onClose: () => {}, noTabs: false }))
    expect(html).toContain('class="sheet-backdrop"')
    expect(html).toContain('class="sheet-close"')
  })

  it('下のタブが無い画面（noTabs）では sheet に no-tabs が付く（should 1）', () => {
    const html = renderWithProviders(createElement(LanguageSheet, { onClose: () => {}, noTabs: true }))
    expect(html).toContain('class="sheet auto no-tabs"')
  })
})

describe('pickLanguage（純粋な関数・should 3）', () => {
  it('onSelect があれば setUiLang を呼ばず、onSelect へ選んだ言語を渡す', () => {
    const onSelect = vi.fn()
    const setUiLang = vi.fn().mockResolvedValue(undefined)
    pickLanguage('en', { onSelect, setUiLang })
    expect(onSelect).toHaveBeenCalledWith('en')
    expect(setUiLang).not.toHaveBeenCalled()
  })

  it('onSelect が無ければ setUiLang を呼ぶ', () => {
    const setUiLang = vi.fn().mockResolvedValue(undefined)
    pickLanguage('en', { setUiLang })
    expect(setUiLang).toHaveBeenCalledWith('en')
  })

  it('setUiLang が失敗しても例外を外へ投げない（should 2）', async () => {
    const setUiLang = vi.fn().mockRejectedValue(new Error('保存に失敗（テスト用）'))
    expect(() => pickLanguage('en', { setUiLang })).not.toThrow()
    // .catch が処理されるのを待つ（未処理の rejection が出ないことの確認）
    await Promise.resolve()
    await Promise.resolve()
  })
})

describe('ProfileSheet（描画）', () => {
  it('合成の学習者 2 人（ゆい・Linh）が出て、いまの学習者にだけ「いま」が付く', () => {
    const html = renderWithProviders(createElement(ProfileSheet, { onClose: () => {}, noTabs: false }), 'p1')
    expect(html).toContain('ゆい')
    expect(html).toContain('Linh')
    expect((html.match(/class="tag accent"/g) ?? []).length).toBe(1)
  })

  it('いまの学習者が p2 のときは p2 にだけ「いま」が付く（should 3）', () => {
    const html = renderWithProviders(createElement(ProfileSheet, { onClose: () => {}, noTabs: false }), 'p2')
    const currentIndex = html.indexOf('class="tag accent"')
    const linhIndex = html.indexOf('Linh')
    const yuiIndex = html.indexOf('ゆい')
    expect(currentIndex).toBeGreaterThan(-1)
    // 「いま」タグが Linh のボタンより後ろ（同じ <button> の中）・ゆいのボタンより後ろに出る
    expect(currentIndex).toBeGreaterThan(linhIndex)
    expect(currentIndex).toBeGreaterThan(yuiIndex)
  })

  it('「＋ 学習者を追加」の行き先は /profiles/new（should 3）', () => {
    const html = renderWithProviders(createElement(ProfileSheet, { onClose: () => {}, noTabs: false }))
    expect(html).toContain('href="/profiles/new"')
    expect(html).toContain('学習者')
    expect(html).toContain('追加')
  })

  it('下のタブが無い画面（noTabs）では sheet に no-tabs が付く（should 1）', () => {
    const html = renderWithProviders(createElement(ProfileSheet, { onClose: () => {}, noTabs: true }))
    expect(html).toContain('class="sheet auto no-tabs"')
  })
})

describe('MoreDrawer（描画）', () => {
  it('5 つの sb-item（学習者の設定・切り替え・ことば・このアプリについて・学校選びのリンク）と版の表示がある', () => {
    const html = renderWithProviders(
      createElement(MoreDrawer, { open: true, onClose: () => {}, onOpenLang: () => {}, onOpenProfile: () => {} }),
    )
    expect((html.match(/class="sb-item"/g) ?? []).length).toBe(5)
    expect(html).toContain(TEST_VERSION)
  })

  it('sb-footer に注記が 2 つ（notice.unofficial・notice.localOnly）続けて出る（must 4・C9 作業内容 2）', () => {
    const html = renderWithProviders(
      createElement(MoreDrawer, { open: true, onClose: () => {}, onOpenLang: () => {}, onOpenProfile: () => {} }),
    )
    expect(html).toContain('公益財団法人')
    expect(html).toContain('登録商標')
    // notice.localOnly の一部
    expect(html).toContain('サーバーには')
  })

  it('学校選びの Manabi Map のリンクは target="_blank" rel="noopener" の 1 つだけ', () => {
    const html = renderWithProviders(
      createElement(MoreDrawer, { open: true, onClose: () => {}, onOpenLang: () => {}, onOpenProfile: () => {} }),
    )
    expect((html.match(/target="_blank"/g) ?? []).length).toBe(1)
    expect(html).toContain('rel="noopener"')
    expect(html).toContain('href="https://manabi-map.app/"')
  })

  it('open が false のとき sidebar・sb-backdrop に on が付かない', () => {
    const html = renderWithProviders(
      createElement(MoreDrawer, { open: false, onClose: () => {}, onOpenLang: () => {}, onOpenProfile: () => {} }),
    )
    expect(html).toContain('class="sidebar"')
    expect(html).not.toContain('class="sidebar on"')
    expect(html).toContain('class="sb-backdrop"')
    expect(html).not.toContain('class="sb-backdrop on"')
  })

  it('open が false のとき aside に inert="" が付き、true のときは付かない（must 1）', () => {
    const htmlClosed = renderWithProviders(
      createElement(MoreDrawer, { open: false, onClose: () => {}, onOpenLang: () => {}, onOpenProfile: () => {} }),
    )
    expect(htmlClosed).toContain('inert=""')

    const htmlOpen = renderWithProviders(
      createElement(MoreDrawer, { open: true, onClose: () => {}, onOpenLang: () => {}, onOpenProfile: () => {} }),
    )
    expect(htmlOpen).not.toContain('inert=""')
  })
})

describe('AboutPage（描画）', () => {
  it('<h1> の見出しと、ブランド行（brand.withSubtitle）と、注記が 2 つ（notice.unofficial・notice.localOnly）出る（should 4・C9 作業内容 1・2）', () => {
    const html = renderWithProviders(createElement(AboutPage, {}))
    // C7 再レビュー should 2 で <h1> に class="about-title" を付けたため、属性を許す形にする
    expect(html).toMatch(/<h1[^>]*>/)
    // brand.withSubtitle = 「たねもじ — {漢字|かんじ}{学習|がくしゅう}」。notice.unofficial にも
    // 「たねもじ」が出るため（2026-09-24 C9 レビュー should 3）、about-brand の要素とその中身で
    // 確かめる（ブランドの行を消しても notice の「たねもじ」だけで通ってしまわないように）。
    expect(html).toMatch(/<p class="about-brand">たねもじ/)
    expect(html).toContain('公益財団法人')
    expect(html).toContain('登録商標')
    // notice.localOnly の一部
    expect(html).toContain('サーバーには')
  })

  it('並び順が本文 → 注記 → 使っているデータ → 版になる（should 4）', () => {
    const html = renderWithProviders(createElement(AboutPage, {}))
    const bodyIndex = html.indexOf('毎日')
    const noticeIndex = html.indexOf('公益財団法人')
    // about.credits は「{使|つか}っているデータ」。「使」は ruby の base になり、続く
    // 「っているデータ」だけが ruby をまたがない連続した文字列として出る。
    const creditsIndex = html.indexOf('っているデータ')
    const versionIndex = html.indexOf(TEST_VERSION)
    expect(bodyIndex).toBeGreaterThan(-1)
    expect(bodyIndex).toBeLessThan(noticeIndex)
    expect(noticeIndex).toBeLessThan(creditsIndex)
    expect(creditsIndex).toBeLessThan(versionIndex)
  })

  it('バージョンの表示（more.version）がある', () => {
    const html = renderWithProviders(createElement(AboutPage, {}))
    expect(html).toContain(TEST_VERSION)
  })
})
