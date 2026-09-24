// ProfileEditPage が components/EditLangField.tsx に渡す props（value・onChange）の配線を確かめる
// テスト（C8 レビュー must 3・2026-09-24 再レビュー申し送り 4）。
//
// components/EditLangField.tsx を vi.mock して、ProfileEditPage が実際に渡す value・onChange を
// 捕まえる。vitest の環境は node（DOM が無い）ため、「ことばのボタンを押してシートを開く」操作は
// シミュレートできない。EditLangField を常にマウントされる形にしてあるおかげで（open は
// EditLangField の内部で条件分岐する。ProfileEditPage 側は open の真偽に関わらず EditLangField
// 自体は毎回描く）、open を経由せずに props を捕まえられる。
//
// EditLangField 自身の中身（LanguageSheet への onSelect の配線）は components/EditLangField.test.ts、
// LanguageSheet 自体の分岐（onSelect の有無で setUiLang を呼ぶか）は components/sheets.test.ts の
// pickLanguage のテストで別々に確かめてある。ここで見るのは「2 人目の学習者を追加するフォームで
// ことばを選んでも、1 人目の学習者（本物の ProfileProvider・store 上のデータ）の lang は変わらない」
// という、ページ単位の統合の保証だけ。
//
// 確認（実装時に手動で 1 回行った・子 plan の指示）: ProfileEditPage.tsx の EditLangField の
// onChange を、update('lang', code) の代わりに useProfiles().setUiLang(code) を直接呼ぶ形に
// 書き換えて実行したところ、下の「1 人目の lang は変わっていない」の assertion が
// 「expected 'vi' to be 'en'」で落ちることを確かめてから元に戻した（setUiLang はいまの学習者
// （このテストでは currentId='p1'）の lang を実際に書き換えるため、店（store）の p1 が変わって
// しまい、このテストが検出する）。onChange を丸ごと外す変更は EditLangFieldProps.onChange が
// 必須 prop のため pnpm typecheck が先に検出する。
//
// 申し送り 4（2026-09-24 再レビュー）:
// - 編集（/profiles/p1）のテストは、I18nProvider の lang（画面の言語＝uiLang）を p1.lang（en）と
//   異なる ja にしてある。以前は両方 en だったため、ProfileEditPage.tsx 側で value={form.lang} を
//   value={uiLang} に書き換える regression が起きても値が偶然 en のまま一致し、テストが検出でき
//   なかった。ja にしたことで、その書き換えが起きれば capturedFieldProps.value が 'ja' になり
//   assertion が落ちる。実際に value={uiLang} へ一時的に書き換えて pnpm test を実行し、このテストが
//   「expected 'ja' to be 'en'」で落ちることを確認してから元に戻した。
// - 「onChange でフォームの lang が変わること」は、lib/profileForm.ts の updateFormField（update の
//   実体）を vi.mock（importActual による部分モック）で spy にして確かめる。SSR の
//   renderToString は 1 回きりで、onChange を呼んだ後にもう一度描画してフォームの値を読み直す
//   ことはできない（このファイルのこれまでの確認や pages/pages.test.ts の SaveErrorAlert の
//   コメントと同じ制約）ため、「onChange が updateFormField(フォームの現在値, 'lang', 選んだ
//   コード) を実際に呼び出したこと」を直接検証する形にした。

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import en from '../i18n/packs/en.json'
import ja from '../i18n/packs/ja.json'
import { I18nProvider } from '../i18n/I18nProvider'
import type { UiDict } from '../i18n/packs'
import { createMemoryStore } from '../lib/store'
import { ProfileProvider } from '../state/ProfileProvider'
import { PROFILE_COLORS, type LearnerProfile } from '../types'

const jaUi = ja.ui as unknown as UiDict
const enUi = en.ui as unknown as UiDict
const NOW = '2026-01-01T00:00:00.000Z'

let capturedFieldProps: { value?: string; onChange?: (code: string) => void } | null = null

vi.mock('../components/EditLangField', () => ({
  EditLangField: (props: { value?: string; onChange?: (code: string) => void }) => {
    capturedFieldProps = props
    return null
  },
}))

// 申し送り 4: updateFormField だけを spy にし、他の export（defaultProfileForm・profileToForm 等）は
// 本物のまま使う。ProfileEditPage.tsx・lib/saveProfileForm.ts のどちらの import 先も同じファイルを
// 指す（vi.mock はモジュールの実ファイル単位で効くので、相対パスの書き方の違いは関係ない）。
vi.mock('../lib/profileForm', async () => {
  const actual = await vi.importActual<typeof import('../lib/profileForm')>('../lib/profileForm')
  return { ...actual, updateFormField: vi.fn(actual.updateFormField) }
})

// vi.mock は巻き上げられるので、この後の静的 import でモック済みの EditLangField・updateFormField が
// 使われる。
import { updateFormField } from '../lib/profileForm'
import { ProfileEditPage } from './ProfileEditPage'

function makeProfile(overrides: Partial<LearnerProfile> = {}): LearnerProfile {
  return {
    id: 'p1',
    nickname: 'ゆい',
    color: PROFILE_COLORS[0],
    level: '10',
    lang: 'en',
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

beforeEach(() => {
  capturedFieldProps = null
  vi.mocked(updateFormField).mockClear()
})

describe('ProfileEditPage → EditLangField の配線（must 3・申し送り 4）', () => {
  it('/profiles/new（2 人目の追加）で EditLangField に value・onChange を渡し、onChange はフォームの lang だけを書き換える', async () => {
    const store = createMemoryStore()
    const p1 = makeProfile()
    await store.saveProfile(p1)

    renderToString(
      createElement(
        MemoryRouter,
        { initialEntries: ['/profiles/new'] },
        createElement(
          ProfileProvider,
          { store, initialProfiles: [p1], initialCurrentId: 'p1', initialUiLang: 'ja' },
          createElement(
            I18nProvider,
            { lang: 'en', display: 'child', uiByLang: { ja: jaUi, en: enUi }, onNeedLang: () => {} },
            createElement(
              Routes,
              null,
              createElement(Route, { path: '/profiles/new', element: createElement(ProfileEditPage, { store }) }),
            ),
          ),
        ),
      ),
    )

    expect(capturedFieldProps).not.toBeNull()
    expect(typeof capturedFieldProps!.onChange).toBe('function')

    // ことばシートで vi を選んだ想定（EditLangField の onSelect が呼ぶ onChange を直接呼ぶ）。
    capturedFieldProps!.onChange!('vi')

    // 1 人目（p1）の lang は変わっていない（onChange はフォームの値だけを変える設計。子 plan
    // 「作業内容」4）。
    const stillP1 = await store.getProfile('p1')
    expect(stillP1?.lang).toBe('en')

    // 申し送り 4: onChange が updateFormField を 'lang' キーで呼び出したこと（＝フォームの lang を
    // 書き換える経路を実際に通ったこと）を確かめる。/profiles/new の既定の lang は画面の言語
    // （I18nProvider の lang='en'）なので、書き換え前の値は 'en'。
    expect(updateFormField).toHaveBeenCalledWith(expect.objectContaining({ lang: 'en' }), 'lang', 'vi')
  })

  it('/profiles/p1（編集）でも EditLangField に既存の lang（en）を value として渡す（画面の言語は ja で別にしてある）', async () => {
    const store = createMemoryStore()
    const p1 = makeProfile()
    await store.saveProfile(p1)

    renderToString(
      createElement(
        MemoryRouter,
        { initialEntries: ['/profiles/p1'] },
        createElement(
          ProfileProvider,
          { store, initialProfiles: [p1], initialCurrentId: 'p1', initialUiLang: 'ja' },
          createElement(
            // 申し送り 4: lang を p1.lang（en）と違う ja にする。value={form.lang} が
            // value={uiLang}（画面の言語）に書き換えられてしまう regression を検出できるように。
            I18nProvider,
            { lang: 'ja', display: 'child', uiByLang: { ja: jaUi, en: enUi }, onNeedLang: () => {} },
            createElement(
              Routes,
              null,
              createElement(Route, { path: '/profiles/:id', element: createElement(ProfileEditPage, { store }) }),
            ),
          ),
        ),
      ),
    )

    expect(capturedFieldProps).not.toBeNull()
    expect(capturedFieldProps!.value).toBe('en')
  })
})
