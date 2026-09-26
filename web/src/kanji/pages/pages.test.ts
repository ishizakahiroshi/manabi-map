// C8（はじめての画面・学習者の一覧・学習者の追加と編集）のテスト。描画の確認は react-dom/server の
// renderToString と createElement を使う（vitest の環境は node で DOM が無く、クリックなどの
// イベントはシミュレートできない。子 plan「書き方の約束」）。LanguageSheet を開く操作そのもの
// （ことばのボタンを押す）はこの制約のため確かめられないが、onSelect の分岐（setUiLang を呼ばない）
// は components/sheets.test.ts の pickLanguage のテスト、EditLangField が onSelect を渡し切って
// いることは components/EditLangField.test.ts、ページ単位で 1 人目の学習者の lang に触れない設計は
// pages/ProfileEditPage.langWiring.test.ts、二重送信を防ぐ guard と保存の流れそのものは
// lib/saveProfileForm.test.ts で別々に確かめてある（2026-09-24 C8 レビュー must 2・3）。

import { createElement, type ReactElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import en from '../i18n/packs/en.json'
import ja from '../i18n/packs/ja.json'
import { I18nProvider } from '../i18n/I18nProvider'
import type { UiDict } from '../i18n/packs'
import { createMemoryStore, type KanjiStore } from '../lib/store'
import { ProfileEditPage, SaveErrorAlert } from './ProfileEditPage'
import { ProfilesPage } from './ProfilesPage'
import { WelcomePage } from './WelcomePage'
import { ProfileProvider } from '../state/ProfileProvider'
import { PROFILE_COLORS, type LearnerProfile } from '../types'

const jaUi = ja.ui as unknown as UiDict
const enUi = en.ui as unknown as UiDict
const NOW = '2026-01-01T00:00:00.000Z'

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
 * ProfileProvider・I18nProvider・MemoryRouter で包んで HTML 文字列にする（sheets.test.ts と
 * 同じ考え方）。element はコールバックにして、ProfileEditPage が必要とする store（テストごとに
 * 新しい createMemoryStore()）を作ってから渡せるようにする。
 *
 * ProfileEditPage は useParams()・useNavigate() を使うため、MemoryRouter の中に素で置くだけでは
 * 足りず、<Routes><Route path="..." /></Routes> で実際にルートを一致させる必要がある
 * （useParams は一致した <Route> の中でしか値を持たない）。routePath 省略時は path をそのまま
 * 使う（/welcome・/profiles のように動的な区間が無い画面用）。
 */
function renderPage(
  path: string,
  element: (store: KanjiStore) => ReactElement,
  options: { profiles?: LearnerProfile[]; currentId?: string | null; lang?: string; routePath?: string } = {},
): string {
  const store = createMemoryStore()
  return renderToString(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(
        ProfileProvider,
        {
          store,
          initialProfiles: options.profiles ?? [],
          initialCurrentId: options.currentId ?? null,
          initialUiLang: 'ja',
        },
        createElement(
          I18nProvider,
          { lang: options.lang ?? 'ja', display: 'child', uiByLang: { ja: jaUi, en: enUi }, onNeedLang: () => {} },
          createElement(
            Routes,
            null,
            createElement(Route, { path: options.routePath ?? path, element: element(store) }),
          ),
        ),
      ),
    ),
  )
}

describe('WelcomePage（描画。C9 でブランド差し替え後の文言に更新）', () => {
  it('wel.title（たねもじへようこそ）・wel.start（はじめる）と、2 つの注記が出て、ログインのボタンが無い', () => {
    const html = renderPage('/welcome', () => createElement(WelcomePage))
    // display: 'child' なので wel.title は配列の 0 番目（こども向け）
    expect(html).toContain('たねもじへようこそ')
    expect(html).toContain('はじめる')
    // notice.unofficial の一部
    expect(html).toContain('登録商標')
    // notice.localOnly の一部
    expect(html).toContain('サーバーには')
    expect(html).not.toContain('LINE')
    expect(html).not.toContain('Google')
  })

  it('「はじめる」は /profiles/new への行き先を持つ（Link）', () => {
    const html = renderPage('/welcome', () => createElement(WelcomePage))
    expect(html).toContain('href="/profiles/new"')
  })

  it('学校選びの Manabi Map への外部リンクを持つ', () => {
    const html = renderPage('/welcome', () => createElement(WelcomePage))
    expect(html).toContain('href="https://manabi-map.app/"')
    expect(html).toContain('target="_blank"')
  })
})

describe('ProfilesPage（描画）', () => {
  it('学習者のカード（ゆい）と「＋ 学習者を追加」が出る', () => {
    const html = renderPage('/profiles', () => createElement(ProfilesPage), {
      profiles: [makeProfile()],
      currentId: 'p1',
    })
    expect(html).toContain('ゆい')
    expect(html).toContain('href="/profiles/new"')
  })

  it('学習者が複数いれば全員分のカードが出る', () => {
    const html = renderPage('/profiles', () => createElement(ProfilesPage), {
      profiles: [makeProfile(), makeProfile({ id: 'p2', nickname: 'Linh', level: '5' })],
      currentId: 'p1',
    })
    expect(html).toContain('ゆい')
    expect(html).toContain('Linh')
  })
})

describe('ProfileEditPage（追加・/profiles/new）', () => {
  it('準 1 級・1 級のチップがあり、どちらも disabled（親 plan D-6）', () => {
    const html = renderPage('/profiles/new', (store) => createElement(ProfileEditPage, { store }))
    // aria-pressed="false" disabled="" のチップが、準1級・1級の 2 件だけ出る想定
    // （既定の級は 10 級なので、ほかのどのチップも disabled にはならない）。
    const disabledChips = html.match(/class="chip" aria-pressed="false" disabled=""/g) ?? []
    expect(disabledChips).toHaveLength(2)
  })

  it('級で選ぶビューのチップ 12 件すべてに「相当」が付く（level.nameEq。指示書 §2「○級相当」表記。2026-09-24 C9 再レビュー should 2）', () => {
    const html = renderPage('/profiles/new', (store) => createElement(ProfileEditPage, { store }))
    // edit.levelHint（「…10 級相当…」）が画面に常に出るため、html 全体への toContain('相当') では
    // チップ自体が level.nameEq を使っているかを見分けられなかった（should 2 の指摘）。
    // 級の band ごとの chip-row（aria-labelledby="kanji-edit-band-..."）の中身だけを取り出し、
    // その中の <button class="chip...">（furigana・1 日の目標・画面の雰囲気・書き取り・アイコンの
    // 色の chip-row は band とは別の aria-labelledby を持つので含まれない）ごとに確かめる。
    const bandBlocks = html.match(/<div class="chip-row" role="group" aria-labelledby="kanji-edit-band-[^"]+">[\s\S]*?<\/div>/g) ?? []
    expect(bandBlocks).toHaveLength(4) // 小学生・中学生・高校生一般・大学一般の 4 band
    const chipButtons = bandBlocks.join('').match(/<button[^>]*class="chip[^"]*"[\s\S]*?<\/button>/g) ?? []
    expect(chipButtons).toHaveLength(12) // lib/levels.ts の LEVELS 全 12 件
    const missing = chipButtons.filter((b) => !b.includes('相当'))
    expect(missing).toHaveLength(0)
  })

  it('削除のボタンが無い（新規のときは出さない）', () => {
    const html = renderPage('/profiles/new', (store) => createElement(ProfileEditPage, { store }))
    expect(html).not.toContain('class="link-btn bad"')
  })

  it('ニックネームの入力欄に label が付く', () => {
    const html = renderPage('/profiles/new', (store) => createElement(ProfileEditPage, { store }))
    expect(html).toContain('for="kanji-edit-nick"')
    expect(html).toContain('id="kanji-edit-nick"')
  })

  it('追加する（edit.submitNew）のボタンが出る', () => {
    const html = renderPage('/profiles/new', (store) => createElement(ProfileEditPage, { store }))
    expect(html).toContain('type="submit"')
  })
})

describe('ProfileEditPage（編集・/profiles/:id）', () => {
  it('削除のボタンがある（編集の画面にだけ出す）', () => {
    const html = renderPage('/profiles/p1', (store) => createElement(ProfileEditPage, { store }), {
      profiles: [makeProfile()],
      currentId: 'p1',
      routePath: '/profiles/:id',
    })
    expect(html).toContain('class="link-btn bad"')
  })

  it('既存のニックネームが入力欄の値として入る', () => {
    const html = renderPage('/profiles/p1', (store) => createElement(ProfileEditPage, { store }), {
      profiles: [makeProfile({ nickname: 'はると' })],
      currentId: 'p1',
      routePath: '/profiles/:id',
    })
    expect(html).toContain('value="はると"')
  })

  it('削除は 2 段階（既定では確認前のボタンだけが出て、実行ボタン・確認文は出ない。must 2）', () => {
    const html = renderPage('/profiles/p1', (store) => createElement(ProfileEditPage, { store }), {
      profiles: [makeProfile()],
      currentId: 'p1',
      routePath: '/profiles/:id',
    })
    // 1 段階目（この学習者を消す）は出る
    expect(html).toContain('class="link-btn bad"')
    // 2 段階目（edit.deleteConfirm・edit.deleteYes）は、1 段階目を押すまで出ない
    expect(html).not.toContain('記録をすべて消します')
  })

  it('should 1: ニックネーム・試験日の入力欄に aria-describedby が付く（エラーが無い既定の状態）', () => {
    const html = renderPage('/profiles/new', (store) => createElement(ProfileEditPage, { store }))
    expect(html).toContain('aria-describedby="kanji-edit-nick-hint"')
    expect(html).not.toContain('aria-invalid')
    // 試験日はヒントが無いので、エラーが無ければ aria-describedby 自体を付けない
    const examInputMatch = html.match(/<input id="kanji-edit-exam"[^>]*>/)
    expect(examInputMatch).not.toBeNull()
    expect(examInputMatch![0]).not.toContain('aria-describedby')
  })

  it('should 1: 級の band の見出しとチップの群が role="group"・aria-labelledby でつながっている', () => {
    const html = renderPage('/profiles/new', (store) => createElement(ProfileEditPage, { store }))
    expect(html).toContain('id="kanji-edit-band-es"')
    expect(html).toContain('role="group" aria-labelledby="kanji-edit-band-es"')
  })

  it('4 つの band 見出し（band.es・jh・hs・ad）すべてに「相当」が付く（ja。親の判断: notice.unofficial の「○級相当と表記しています」とそろえる。2026-09-24 C9 再レビュー should 3）', () => {
    const html = renderPage('/profiles/new', (store) => createElement(ProfileEditPage, { store }))
    const bandHeadings = html.match(/<span id="kanji-edit-band-[^"]+">[\s\S]*?<\/span>/g) ?? []
    expect(bandHeadings).toHaveLength(4)
    expect(bandHeadings.every((h) => h.includes('相当'))).toBe(true)
  })

  it('4 つの band 見出しすべてに「equiv.」が付く（en）', () => {
    const html = renderPage('/profiles/new', (store) => createElement(ProfileEditPage, { store }), { lang: 'en' })
    const bandHeadings = html.match(/<span id="kanji-edit-band-[^"]+">[\s\S]*?<\/span>/g) ?? []
    expect(bandHeadings).toHaveLength(4)
    expect(bandHeadings.every((h) => h.includes('equiv.'))).toBe(true)
  })

  it('must 1: id に一致する学習者がいない（/profiles/zzz）と、フォームを出さない', () => {
    const html = renderPage('/profiles/zzz', (store) => createElement(ProfileEditPage, { store }), {
      profiles: [makeProfile()],
      currentId: 'p1',
      routePath: '/profiles/:id',
    })
    expect(html).not.toContain('id="kanji-edit-nick"')
  })
})

describe('SaveErrorAlert（should 1・4: 保存全体の失敗を role="alert" で伝える）', () => {
  it('show=false では何も描かない', () => {
    const html = renderPage('/welcome', () => createElement(SaveErrorAlert, { show: false }))
    expect(html).toBe('')
  })

  it('show=true で role="alert" と edit.saveError の文を描く（保存に失敗した状態を再現）', () => {
    // 実際に保存を失敗させて saveError を true にする操作は、vitest の環境（node・DOM が無い）
    // からはボタンのクリックをシミュレートできないため再現できない。addProfile が失敗すると
    // ProfileEditPage の handleSubmit が saveError を true にする、という配線そのものは
    // lib/saveProfileForm.test.ts の「addProfile が失敗すると error を返す」で確かめてある。
    // ここでは show（＝ saveError の値）が true のときの描画だけを見る。
    const html = renderPage('/welcome', () => createElement(SaveErrorAlert, { show: true }))
    expect(html).toContain('role="alert"')
    expect(html).toContain('class="mini-hint bad"')
  })
})
