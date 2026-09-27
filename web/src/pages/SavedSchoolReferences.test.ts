import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { School } from '../types/school'

const mocks = vi.hoisted(() => ({ schools: [] as School[], loading: false, error: null as string | null }))
vi.mock('../hooks/useSchools', () => ({ useSchools: () => mocks }))
vi.mock('../contexts/AppContext', () => ({ useApp: () => ({ home: null, homeLoadState: 'ready', toast: vi.fn(), setLoginOpen: vi.fn() }), formatHomeCoordinates: () => null }))
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ session: { user: { id: 'synthetic-user' } }, kind: 'google', displayName: '合成表示名', signOut: vi.fn() }) }))
vi.mock('../components/SchoolDetailSheet', () => ({ SchoolDetailSheet: () => null }))
vi.mock('../components/FamilyShareSheet', () => ({ FamilyShareSheet: () => null }))
vi.mock('../components/SiteMoveNotice', () => ({ SiteMoveGuestNotice: () => null }))
vi.mock('../components/AdSlot', () => ({ AdSlot: () => null }))

import { I18nProvider } from '../contexts/I18nContext'
import { FavoritesPage } from './FavoritesPage'
import { MyPage } from './MyPage'

const data = {
  favorites: { 'unlisted-school': { school_id: 'unlisted-school', priority: 3, status: '' } },
  notes: { 'unlisted-school': { school_id: 'unlisted-school', note: '合成メモ本文\n合成メモ続き', commute_note: '合成通学本文' } },
  mine: { 'unlisted-school': { depts: { 'unlisted-department': 0 }, note: '合成数値メモ', visibility: 'private' } },
  loadError: false, reload: vi.fn(), toggleFavoriteWithResult: vi.fn(), deleteNote: vi.fn(), deleteMine: vi.fn(),
} as unknown as ComponentProps<typeof FavoritesPage>['userData']

function render(page: 'favorites' | 'mypage') {
  const element = page === 'favorites' ? createElement(FavoritesPage, { userData: data }) : createElement(MyPage, { userData: data, favCount: 1, noteCount: 1 })
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(I18nProvider, null, element)))
}

afterEach(() => { mocks.schools = []; mocks.loading = false; mocks.error = null })

describe('saved cards without current public school information', () => {
  it('keeps favorite rank, priority, both notes, ID, and removal control without a broken detail button', () => {
    const html = render('favorites')
    for (const text of ['fav-card', '★★★☆☆', 'unlisted-school', '合成メモ本文', '合成メモ続き', '合成通学本文', '保存した内容は残っています', 'fav-card-delete']) expect(html).toContain(text)
    expect(html).toContain('<div class="fav-card-main saved-school-unavailable">')
    expect(data.notes['unlisted-school'].note).toBe('合成メモ本文\n合成メモ続き')
  })

  it('keeps note and numeric cards including unavailable department IDs and zero', () => {
    const html = render('mypage')
    for (const text of ['mypage-note-card', 'mypage-mine-card', '合成メモ本文', '合成通学本文', '合成数値メモ', 'unlisted-department', ': 0', 'mypage-card-delete']) expect(html).toContain(text)
    expect(html).not.toContain('href="/school/unlisted-school"')
  })

  it('keeps a saved department value when its school remains public but that department is absent', () => {
    mocks.schools = [{ id: 'unlisted-school', name: '合成公開高等学校', departments: [], ownership: 'private', prefecture: '合成県' } as unknown as School]
    const html = render('mypage')
    expect(html).toContain('合成公開高校')
    expect(html).toContain('unlisted-department')
    expect(html).toContain(': 0')
    expect(html).toContain('合成数値メモ')
    expect(html).not.toContain('現在の公開一覧では学校情報を確認できません')
  })

  it('does not confuse a loading request or failure with absence from the published list', () => {
    mocks.loading = true
    const loading = render('favorites')
    expect(loading).toContain('公開学校情報を読み込み中です')
    expect(loading).not.toContain('現在の公開一覧では')
    mocks.loading = false
    mocks.error = 'synthetic failure'
    const failed = render('favorites')
    expect(failed).toContain('公開学校情報を取得できませんでした')
    expect(failed).toContain('合成メモ本文')
    expect(failed).not.toContain('現在の公開一覧では')
  })
})
