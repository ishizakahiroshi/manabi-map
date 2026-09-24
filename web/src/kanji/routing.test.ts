// routing.ts（ルートの表・redirectFor・戻るボタンの判定・言語の決定）のテスト
// （C6 レビュー should 2・9・must 2・3、および 2 巡目レビュー should 2・4）。

import { describe, expect, it } from 'vitest'
import { findRouteEntry, normalizePath, redirectFor, resolveLang, shouldReplaceBack, TAB_ENTRIES } from './routing'

describe('redirectFor（3 状態 × 代表的なパス）', () => {
  it('学習者がいない: /welcome・/profiles/new・/about はそのまま、他は /welcome へ', () => {
    expect(redirectFor('/welcome', false, false)).toBeNull()
    expect(redirectFor('/profiles/new', false, false)).toBeNull()
    expect(redirectFor('/about', false, false)).toBeNull()
    expect(redirectFor('/', false, false)).toBe('/welcome')
    expect(redirectFor('/profiles', false, false)).toBe('/welcome')
    expect(redirectFor('/profiles/xyz', false, false)).toBe('/welcome')
  })

  it('学習者はいるが、いまの学習者がいない: /profiles・/profiles/new・/about はそのまま、他は /profiles へ', () => {
    expect(redirectFor('/profiles', true, false)).toBeNull()
    expect(redirectFor('/profiles/new', true, false)).toBeNull()
    expect(redirectFor('/about', true, false)).toBeNull()
    expect(redirectFor('/', true, false)).toBe('/profiles')
    expect(redirectFor('/welcome', true, false)).toBe('/profiles')
    expect(redirectFor('/profiles/xyz', true, false)).toBe('/profiles')
  })

  it('いまの学習者がいる: /welcome は / へ、他は移動しない', () => {
    expect(redirectFor('/welcome', true, true)).toBe('/')
    expect(redirectFor('/', true, true)).toBeNull()
    expect(redirectFor('/profiles/xyz', true, true)).toBeNull()
    expect(redirectFor('/about', true, true)).toBeNull()
  })

  it('末尾の / をそろえてから判断する（/profiles/new/ もそのまま扱う）', () => {
    expect(redirectFor('/profiles/new/', false, false)).toBeNull()
  })

  it('2 巡目レビュー should 4: 大文字小文字をそろえてから判断する（/Welcome でも / へ）', () => {
    expect(redirectFor('/Welcome', true, true)).toBe('/')
  })
})

describe('normalizePath', () => {
  it('ルート自身は削らない', () => {
    expect(normalizePath('/')).toBe('/')
  })

  it('末尾の / を 1 つ削る', () => {
    expect(normalizePath('/practice/')).toBe('/practice')
  })

  it('末尾に / が無ければそのまま', () => {
    expect(normalizePath('/practice')).toBe('/practice')
  })

  it('2 巡目レビュー should 4: 小文字にそろえる', () => {
    expect(normalizePath('/PRACTICE')).toBe('/practice')
    expect(normalizePath('/Welcome/')).toBe('/welcome')
  })
})

describe('findRouteEntry（must 2・should 2、2 巡目レビュー should 4）', () => {
  it('/ は brand で下のタブ（tab）を持つ', () => {
    const entry = findRouteEntry('/')
    expect(entry).toMatchObject({ variant: 'brand', page: 'home' })
    expect(entry.tab).toBeDefined()
  })

  it('/profiles は brand（must 2: back から直した。ことばのボタンが要る・戻ると redirectFor でまた /profiles に戻るだけのため）で下のタブは無い', () => {
    const entry = findRouteEntry('/profiles')
    // C8 で page が 'soon'（準備中の共通画面）から 'profiles'（pages/ProfilesPage.tsx）に変わった。
    expect(entry).toMatchObject({ variant: 'brand', page: 'profiles' })
    expect(entry.tab).toBeUndefined()
  })

  it('/welcome は brand', () => {
    expect(findRouteEntry('/welcome')).toMatchObject({ variant: 'brand' })
    expect(findRouteEntry('/welcome').tab).toBeUndefined()
  })

  it('/profiles/new は back・edit.titleNew（/profiles/:id と紛れない）', () => {
    expect(findRouteEntry('/profiles/new')).toMatchObject({ variant: 'back', titleKey: 'edit.titleNew' })
  })

  it('/profiles/xyz（動的な id）は back・edit.titleEdit', () => {
    expect(findRouteEntry('/profiles/xyz')).toMatchObject({ variant: 'back', titleKey: 'edit.titleEdit' })
  })

  it('/practice/ でも /practice と同じ行になる（末尾の / をそろえる）', () => {
    expect(findRouteEntry('/practice/')).toEqual(findRouteEntry('/practice'))
  })

  it('2 巡目レビュー should 4: /PRACTICE（大文字）でも /practice と同じ行になる', () => {
    expect(findRouteEntry('/PRACTICE')).toEqual(findRouteEntry('/practice'))
  })

  it('表に無い URL は見つからないの画面（notFound・back・notfound.title）になる', () => {
    expect(findRouteEntry('/no-such-page')).toMatchObject({
      variant: 'back',
      titleKey: 'notfound.title',
      page: 'notFound',
    })
  })
})

describe('TAB_ENTRIES（2 巡目レビュー should 4: 下のタブのボタンをルートの表から作る）', () => {
  it('/ /practice /map /stats の 4 件だけを、この並び順で持つ', () => {
    expect(TAB_ENTRIES.map((e) => e.path)).toEqual(['/', '/practice', '/map', '/stats'])
  })

  it('各行が icon と labelKey を持つ', () => {
    for (const entry of TAB_ENTRIES) {
      expect(entry.tab.icon.length).toBeGreaterThan(0)
      expect(entry.tab.labelKey.length).toBeGreaterThan(0)
    }
  })
})

describe('shouldReplaceBack（must 3）', () => {
  it('idx が 0 なら置き換え遷移（true）', () => {
    expect(shouldReplaceBack(0)).toBe(true)
  })

  it('idx が無い（undefined・null）なら置き換え遷移（true）', () => {
    expect(shouldReplaceBack(undefined)).toBe(true)
    expect(shouldReplaceBack(null)).toBe(true)
  })

  it('idx が 1 以上なら 1 つ戻る（false）', () => {
    expect(shouldReplaceBack(1)).toBe(false)
    expect(shouldReplaceBack(3)).toBe(false)
  })
})

describe('resolveLang（2 巡目レビュー should 2）', () => {
  const AVAILABLE = ['ja', 'en']

  it('candidate が実在するパックならそれを使う', () => {
    expect(resolveLang('en', 'ja', AVAILABLE)).toBe('en')
  })

  it('candidate が実在しないパック（未対応の言語）なら fallback を使う', () => {
    expect(resolveLang('vi', 'ja', AVAILABLE)).toBe('ja')
  })

  it('candidate が undefined・文字列以外（壊れたデータ）なら fallback を使う', () => {
    expect(resolveLang(undefined, 'ja', AVAILABLE)).toBe('ja')
    expect(resolveLang(123, 'ja', AVAILABLE)).toBe('ja')
    expect(resolveLang(null, 'ja', AVAILABLE)).toBe('ja')
  })
})
