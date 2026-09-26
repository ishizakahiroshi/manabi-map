// lib/profileForm.ts（画面の入力から LearnerProfile を作る）のテスト（C8・子 plan「検証方法」）。

import { describe, expect, it } from 'vitest'
import type { LearnerProfile } from '../types'
import { PROFILE_COLORS } from '../types'
import {
  defaultProfileForm,
  formToProfile,
  profileToForm,
  SCHOOL_LEVEL_ENTRIES,
  SCHOOL_TO_LEVEL,
  updateFormField,
  type ProfileFormInput,
} from './profileForm'

const NOW = '2026-01-01T00:00:00.000Z'

function baseForm(overrides: Partial<ProfileFormInput> = {}): ProfileFormInput {
  return {
    ...defaultProfileForm('ja'),
    nickname: 'ゆい',
    ...overrides,
  }
}

describe('formToProfile', () => {
  it('ニックネームが空白だけならエラー（nickname: edit.nickError）', () => {
    const result = formToProfile(baseForm({ nickname: '   ' }), null, NOW, 'p1')
    expect(result).toEqual({ ok: false, errors: { nickname: 'edit.nickError' } })
  })

  it('ニックネームが 21 文字以上ならエラー', () => {
    const result = formToProfile(baseForm({ nickname: 'あ'.repeat(21) }), null, NOW, 'p1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.nickname).toBe('edit.nickError')
  })

  it('試験日が 2026-02-30（実在しない日付）ならエラー（examDate: edit.examError）', () => {
    const result = formToProfile(baseForm({ examDate: '2026-02-30' }), null, NOW, 'p1')
    expect(result).toEqual({ ok: false, errors: { examDate: 'edit.examError' } })
  })

  it('試験日の形が壊れている（YYYY-MM-DD でない）ならエラー', () => {
    const result = formToProfile(baseForm({ examDate: '2026/2/3' }), null, NOW, 'p1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.examDate).toBe('edit.examError')
  })

  it('ニックネームと試験日の両方が不正なら両方のエラーを返す', () => {
    const result = formToProfile(baseForm({ nickname: '', examDate: 'abc' }), null, NOW, 'p1')
    expect(result).toEqual({
      ok: false,
      errors: { nickname: 'edit.nickError', examDate: 'edit.examError' },
    })
  })

  it('試験日が空文字なら examDate は null（任意項目・エラーにしない）', () => {
    const result = formToProfile(baseForm({ examDate: '' }), null, NOW, 'p1')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.profile.examDate).toBeNull()
  })

  it('正しい入力なら normalizeProfile を通った学習者を返す（新規: id・createdAt は渡した id・now）', () => {
    const result = formToProfile(baseForm({ nickname: 'はると', examDate: '2026-03-01' }), null, NOW, 'p1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.profile).toMatchObject({
        id: 'p1',
        nickname: 'はると',
        examDate: '2026-03-01',
        createdAt: NOW,
        updatedAt: NOW,
        color: PROFILE_COLORS[0],
        level: '10',
        furigana: 'all',
        display: 'child',
        kanaKeyboard: false,
        dailyGoal: 10,
        writeMode: 'auto',
      })
    }
  })

  it('既存の学習者を編集するときは id・createdAt を引き継ぐ', () => {
    const existing: LearnerProfile = {
      id: 'p1',
      nickname: 'ゆい',
      color: PROFILE_COLORS[0],
      level: '5',
      lang: 'ja',
      furigana: 'unlearned',
      display: 'adult',
      kanaKeyboard: true,
      dailyGoal: 20,
      examDate: null,
      writeMode: 'paper',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-06-01T00:00:00.000Z',
    }
    const form = profileToForm(existing)
    const result = formToProfile({ ...form, nickname: 'ゆいこ' }, existing, NOW, 'unused')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.profile.id).toBe('p1')
      expect(result.profile.createdAt).toBe('2025-01-01T00:00:00.000Z')
      expect(result.profile.nickname).toBe('ゆいこ')
      expect(result.profile.level).toBe('5')
    }
  })
})

describe('SCHOOL_TO_LEVEL（学年・立場 → 級の対応。10 通り）', () => {
  it('10 件ある', () => {
    expect(SCHOOL_LEVEL_ENTRIES).toHaveLength(10)
    expect(Object.keys(SCHOOL_TO_LEVEL)).toHaveLength(10)
  })

  it('小 1〜小 6・中学生・高校生・大人・日本語を学んでいる、が見本の対応どおり', () => {
    expect(SCHOOL_TO_LEVEL).toEqual({
      g1: '10',
      g2: '9',
      g3: '8',
      g4: '7',
      g5: '6',
      g6: '5',
      jh: '4',
      hs: 'pre2',
      adult: '2',
      jsl: '10',
    })
  })
})

describe('updateFormField（2026-09-24 C8 再レビュー申し送り 4）', () => {
  it('指定したキーだけを書き換え、他の項目は元のまま', () => {
    const form = baseForm()
    const next = updateFormField(form, 'lang', 'vi')
    expect(next.lang).toBe('vi')
    expect(next.nickname).toBe(form.nickname)
    expect(next.level).toBe(form.level)
    expect(next.furigana).toBe(form.furigana)
    // 元のオブジェクトは書き換えない（新しいオブジェクトを返す）
    expect(form.lang).toBe('ja')
  })
})

// 「2 人目の追加で 1 人目の lang が変わらない」テストは、以前ここに置いていたが、formToProfile が
// 他の学習者オブジェクトを引数として受け取っていないことを示すだけの、実装を壊しても通ってしまう
// 中身の無いテストだった（2026-09-24 C8 レビュー must 3）。ページのつなぎ方そのもの（ことばシートで
// 選んだ言語が、本物の ProfileProvider・store 上の 1 人目の学習者に触れないこと）を確かめる
// テストへ差し替え、pages/ProfileEditPage.langWiring.test.ts へ移した。
