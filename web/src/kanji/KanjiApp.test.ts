// C6（画面の骨組み）のテスト。描画の確認は react-dom/server の renderToString と createElement を
// 使う（vitest の環境は node で DOM が無い。子 plan「書き方の約束」）。MemoryRouter で経路を固定する。
// redirectFor・findRouteEntry・shouldReplaceBack 自体の純粋な関数としてのテストは routing.test.ts
// （C6 レビュー should 9）。ここでは KanjiApp を実際に描いたときの見え方を確かめる。
//
// C7 で KanjiLayout.tsx が MoreDrawer（components/MoreDrawer.tsx）を常にマウントするようになり、
// どの経路を描いても __APP_VERSION__ を参照するようになった。実体は Vite の gitVersion プラグインの
// define でしか入らず vitest には無いので、components/sheets.test.ts と同じく vi.stubGlobal で埋める
// （C7 が KanjiLayout 経由で持ち込んだ副作用への対応）。

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import en from './i18n/packs/en.json'
import ja from './i18n/packs/ja.json'
import type { UiDict } from './i18n/packs'
import { KanjiApp, type KanjiAppProps } from './KanjiApp'
import { createMemoryStore } from './lib/store'
import { PROFILE_COLORS, type LearnerProfile } from './types'

const jaUi = ja.ui as unknown as UiDict
const enUi = en.ui as unknown as UiDict

const NOW = '2026-01-01T00:00:00.000Z'

beforeAll(() => {
  vi.stubGlobal('__APP_VERSION__', '0.0.0-test')
})

/** テスト用の学習者 fixture。見本の名前（ゆい・はると・Linh）だけ使う */
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

/** KanjiApp を MemoryRouter の中で描いて HTML 文字列にする */
function renderApp(path: string, profile: LearnerProfile | null, overrides: Partial<KanjiAppProps> = {}): string {
  const props: KanjiAppProps = {
    store: createMemoryStore(),
    initialProfiles: profile ? [profile] : [],
    initialCurrentId: profile ? profile.id : null,
    initialUiLang: 'ja',
    uiByLang: { ja: jaUi, en: enUi },
    loadUi: async () => ({}),
    ...overrides,
  }
  return renderToString(createElement(MemoryRouter, { initialEntries: [path] }, createElement(KanjiApp, props)))
}

describe('KanjiApp（描画）', () => {
  it('学習者 1 人・/ で描くと bottom-tab が 5 つあり、ホームに aria-current="page" が付く', () => {
    const html = renderApp('/', makeProfile())
    expect(html).toContain('<nav class="bottom-tabs"')
    expect((html.match(/class="bottom-tab( on)?"/g) ?? []).length).toBe(5)
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1)
    expect(html).toMatch(/class="bottom-tab on" aria-current="page"><span aria-hidden="true">🏠<\/span>/)
  })

  it('/ には <h1> の挨拶がある（should 7）', () => {
    const html = renderApp('/', makeProfile())
    expect(html).toMatch(/<h1>/)
  })

  it('ヘッダー（brand ヘッダー）に brand（たねもじ）が出る（C9・子 plan「作業内容」6）', () => {
    const html = renderApp('/', makeProfile())
    const headerHtml = html.slice(0, html.indexOf('<main'))
    expect(headerHtml).toContain('たねもじ')
  })

  it('/practice では練習のタブに aria-current="page" が付く', () => {
    const html = renderApp('/practice', makeProfile())
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1)
    expect(html).toMatch(/class="bottom-tab on" aria-current="page"><span aria-hidden="true">✏️<\/span>/)
  })

  it('/practice/（末尾の /）でも /practice と同じく練習のタブに aria-current="page" が付く（should 2・ブラウザでの目視で発見した不一致の再発防止）', () => {
    const html = renderApp('/practice/', makeProfile())
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1)
    expect(html).toMatch(/class="bottom-tab on" aria-current="page"><span aria-hidden="true">✏️<\/span>/)
  })

  it('/PRACTICE（大文字）でも練習のタブに on が付く（2 巡目レビュー should 4）', () => {
    const html = renderApp('/PRACTICE', makeProfile())
    expect((html.match(/aria-current="page"/g) ?? []).length).toBe(1)
    expect(html).toMatch(/class="bottom-tab on" aria-current="page"><span aria-hidden="true">✏️<\/span>/)
  })

  it('/profiles/new ではタブが無く、edit.titleNew の見出しが出る（should 8）', () => {
    const html = renderApp('/profiles/new', makeProfile())
    expect(html).not.toContain('bottom-tabs')
    // edit.titleNew = 「{学習者|がくしゅうしゃ}を{追加|ついか}」。ふりがな付きで ruby になるので、
    // 各漢字の base（ruby の直後に <rt> が続く前の文字）だけを見る。back ヘッダーの .brand の中に出る。
    expect(html).toContain('学習者')
    expect(html).toContain('追加')
  })

  it('言語を en にすると Practice と lang="en" が出る', () => {
    const html = renderApp('/practice', makeProfile({ lang: 'en' }))
    expect(html).toContain('<span lang="en">Practice</span>')
  })

  it('下のタブの英語ラベルは <b><span lang="en">…</span></b> の入れ子で出る（2026-09-24 C9 レビュー should 2）', () => {
    // kanji.css の .bottom-tab b span（下のタブの文言が日本語以外のとき 1.1rem になる不具合の
    // 直し。C9「作業内容」0）は、KanjiLayout.tsx の BottomTabs が <b>{t(labelKey)}</b> の直下に
    // I18nProvider の t() が返す <span lang> を置く、というこの入れ子を前提にしている。見た目
    // （実際に大きさが揃うか）は親の再確認（pnpm dev:kanji の目視）で見るので、ここでは DOM の
    // 入れ子の形だけを固定する。
    const html = renderApp('/practice', makeProfile({ lang: 'en' }))
    expect(html).toContain('<b><span lang="en">Practice</span></b>')
  })

  it('学習者の display が child のとき phone kid が出る', () => {
    const html = renderApp('/', makeProfile({ display: 'child' }))
    expect(html).toContain('class="phone kid"')
  })

  it('学習者の display が adult のときは phone kid が出ない', () => {
    const html = renderApp('/', makeProfile({ display: 'adult' }))
    expect(html).toContain('class="phone"')
    expect(html).not.toContain('class="phone kid"')
  })

  it('保存の volatile が true のとき帯の文言が <span> で 1 つにまとまって出る（must 1）', () => {
    const html = renderApp('/', makeProfile(), { store: createMemoryStore({ volatile: true }) })
    expect(html).toContain('<p class="volatile-banner" role="status"><span')
    expect(html).toContain('プライベートブラウズなど')
  })

  it('volatile が false のときは帯が出ない', () => {
    const html = renderApp('/', makeProfile())
    expect(html).not.toContain('role="status"')
  })

  it('ホームに学習者のニックネームを使った挨拶が出る', () => {
    const html = renderApp('/', makeProfile({ nickname: 'はると' }))
    // {name} の差し込みと後続の文言は別の text セグメントなので、React が隣り合う text ノードの
    // 境目に <!-- --> を挟むことがある（markup.test.ts と同じ理由）。除いてから比較する。
    expect(html.replace(/<!--.*?-->/g, '')).toContain('はるとさん、こんにちは')
  })

  it('学習者がいなくても /profiles/new は学習者の追加フォームが出る（C8。/profiles/new は allowWithoutProfile なので redirectFor で /welcome へは飛ばない）', () => {
    const html = renderApp('/profiles/new', null)
    // edit.nick = 「ニックネーム」。edit.submitNew = 「{追加|ついか}する」→「する」で確認
    // （「追加」は ruby の base になるため）。
    expect(html).toContain('ニックネーム')
    expect(html).toContain('する')
    expect(html).toContain('id="kanji-edit-nick"')
  })

  it('見つからない画面にも <h1> がある', () => {
    const html = renderApp('/no-such-page', makeProfile())
    expect(html).toMatch(/<h1>/)
    // notfound.title = 「ページが{見|み}つかりません」。見 だけ ruby になるので、続きの
    // 「つかりません」（かな部分・ruby をまたがない）で確認する。
    expect(html).toContain('つかりません')
  })

  describe('must 2: いまの学習者がいない状態で /profiles を描く', () => {
    function renderProfilesWithoutCurrent(): string {
      const profile = makeProfile()
      return renderApp('/profiles', null, {
        initialProfiles: [profile],
        initialCurrentId: null,
      })
    }

    it('hd-lang（ことばのボタン）がある', () => {
      const html = renderProfilesWithoutCurrent()
      expect(html).toContain('class="hd-lang"')
    })

    it('戻るボタン（icon-btn）が無い（brand ヘッダーなので back ではない）', () => {
      const html = renderProfilesWithoutCurrent()
      // C7 で常にマウントされる MoreDrawer（sb-head の閉じるボタン）も icon-btn を使う
      // （本家の Sidebar.tsx と同じ。子 plan「このファイルを開いた AI へ」）ため、ページ全体では
      // なく <main> より前（= ヘッダーだけ）に絞って確かめる。
      const headerHtml = html.slice(0, html.indexOf('<main'))
      expect(headerHtml).not.toContain('class="icon-btn"')
    })
  })

  describe('must 3: back ヘッダーの戻るボタン', () => {
    it('/about（back ヘッダー）は icon-btn の戻るボタンを持ち、ことばのボタンは無い', () => {
      const html = renderApp('/about', makeProfile())
      expect(html).toContain('class="icon-btn"')
      expect(html).toContain('aria-label="もどる"')
      expect(html).not.toContain('class="hd-lang"')
    })
  })

  describe('C7 レビュー should 3: /about は AboutPage を描く', () => {
    it('<main> の中に AboutPage 固有の文言（about.body の「毎日」・about.credits の文）が出る', () => {
      const html = renderApp('/about', makeProfile())
      // SoonPage にも <h1> があり、notice.unofficial は MoreDrawer の sb-footer にも常に出るため
      // （must 4）、それらだけでは AboutPage が描かれたと見分けられない（C7 再レビュー should 1）。
      // <main>...</main> の中身だけを切り出し、AboutPage 固有の文言で確かめる。
      const mainMatch = html.match(/<main[^>]*>[\s\S]*?<\/main>/)
      expect(mainMatch).not.toBeNull()
      const mainHtml = mainMatch![0]
      // about.body: 「{漢字|かんじ}の{練習|れんしゅう}を、{毎日|まいにち}...」→「毎日」は ruby の base
      expect(mainHtml).toContain('毎日')
      // about.credits: 「{使|つか}っているデータ」→「使」は ruby の base、続く「っているデータ」は
      // ruby をまたがない連続した文字列として出る
      expect(mainHtml).toContain('っているデータ')
      // ヘッダーは KanjiLayout が 1 か所だけで描く（C6 の仕組み）
      expect((html.match(/class="header"/g) ?? []).length).toBe(1)
    })
  })

  it('学習者のボタンの aria-label にニックネームと級の文字が入る（should 6）', () => {
    const html = renderApp('/', makeProfile({ nickname: 'はると', level: '10' }))
    expect(html).toMatch(/aria-label="[^"]*はると[^"]*"/)
  })

  it('学習者のボタンの aria-label は半角スペース区切り（2 巡目レビュー should 3: 全角「：」「・」の直書きをやめた）', () => {
    const html = renderApp('/', makeProfile({ nickname: 'はると', level: '10' }))
    // profiles.switch（「学習者を切り替える」）+ ' ' + はると + ' ' + 10級相当（level.nameEq。
    // text() なので ruby は無い。2026-09-24 C9 レビュー must 2 で level.name → level.nameEq に
    // 直した）
    expect(html).toMatch(/aria-label="学習者を切り替える はると 10級相当"/)
    expect(html).not.toMatch(/aria-label="[^"]*：[^"]*"/)
  })

  it('パックに無い lang の学習者でも、起動時に読んだ言語（initialUiLang）で描かれる（2 巡目レビュー should 2）', () => {
    // 'xx' はどのパックにも無い言語コード。以前は画面側（KanjiAppShell）が resolveLang を通さず
    // currentProfile.lang をそのまま I18nProvider の lang に渡していたため、初回描画の
    // activeLang が 'xx' のまま uiByLang['xx'] が無く、resolveText が en へフォールバックして
    // 英語で描かれていた（main.tsx が実際に読み込んだのは ja + en で、xx は読んでいない）。
    // renderApp の initialUiLang（起動時に main.tsx が読んだ言語の想定）'ja' で描かれることを確かめる。
    const html = renderApp('/', makeProfile({ lang: 'xx' }))
    expect(html).toContain('ホーム')
    expect(html).not.toContain('<span lang="en">Home</span>')
  })

  describe('should 4（2026-09-24 C8 レビュー）: welcome・profiles・profileEdit の実画面が描かれる', () => {
    it('/welcome（学習者なし）に href="/profiles/new" が出る', () => {
      const html = renderApp('/welcome', null)
      expect(html).toContain('href="/profiles/new"')
    })

    it('/profiles（いまの学習者なし）に学習者のカードが出る', () => {
      const profile = makeProfile({ nickname: 'はると' })
      const html = renderApp('/profiles', null, { initialProfiles: [profile], initialCurrentId: null })
      expect(html).toContain('はると')
    })

    it('/profiles/:id（学習者 p1 を編集）に編集のフォームが出る', () => {
      const profile = makeProfile()
      const html = renderApp(`/profiles/${profile.id}`, profile)
      expect(html).toContain('id="kanji-edit-nick"')
      expect(html).toContain('class="link-btn bad"')
    })
  })
})
