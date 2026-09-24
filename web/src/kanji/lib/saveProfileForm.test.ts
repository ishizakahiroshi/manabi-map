// lib/saveProfileForm.ts のテスト（C8 レビュー must 2・should 4）。

import { describe, expect, it, vi } from 'vitest'
import type { LearnerProfile } from '../types'
import { PROFILE_COLORS } from '../types'
import { defaultProfileForm, type ProfileFormInput } from './profileForm'
import { createProfileId, saveProfileForm, type SubmitGuard } from './saveProfileForm'

/** id を固定値にするだけの createId（既定の createProfileId の代わりにテストへ渡す） */
function fixedId(id: string): () => string {
  return () => id
}

const NOW = '2026-01-01T00:00:00.000Z'

function baseForm(overrides: Partial<ProfileFormInput> = {}): ProfileFormInput {
  return { ...defaultProfileForm('ja'), nickname: 'ゆい', ...overrides }
}

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

/** 呼ばれるたびに resolve のタイミングを外から制御できる addProfile のモック */
function deferredFn<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('saveProfileForm', () => {
  it('検証に失敗（ニックネーム空白）すると validation を返し、addProfile を呼ばない', async () => {
    const addProfile = vi.fn().mockResolvedValue(undefined)
    const updateProfile = vi.fn().mockResolvedValue(undefined)
    const requestPersistence = vi.fn().mockResolvedValue(true)
    const guard: SubmitGuard = { current: false }
    const outcome = await saveProfileForm(baseForm({ nickname: '  ' }), null, NOW, fixedId('p1'), guard, {
      addProfile,
      updateProfile,
      requestPersistence,
      store: {} as never,
    })
    expect(outcome).toEqual({ kind: 'validation', errors: { nickname: 'edit.nickError' } })
    expect(addProfile).not.toHaveBeenCalled()
    expect(guard.current).toBe(false)
  })

  it('新規追加が成功すると addProfile を呼び、requestPersistence を 1 回だけ呼ぶ（完了は待たない）', async () => {
    const addProfile = vi.fn().mockResolvedValue(undefined)
    const updateProfile = vi.fn().mockResolvedValue(undefined)
    const requestPersistence = vi.fn().mockResolvedValue(true)
    const guard: SubmitGuard = { current: false }
    const outcome = await saveProfileForm(baseForm(), null, NOW, fixedId('p1'), guard, {
      addProfile,
      updateProfile,
      requestPersistence,
      store: {} as never,
    })
    expect(outcome.kind).toBe('saved')
    if (outcome.kind === 'saved') expect(outcome.mode).toBe('new')
    expect(addProfile).toHaveBeenCalledTimes(1)
    expect(updateProfile).not.toHaveBeenCalled()
    // requestPersistence は待たずに呼ぶだけなので、await の直後でも呼ばれている
    expect(requestPersistence).toHaveBeenCalledTimes(1)
    // 申し送り 1（2026-09-24）: 保存成功時は guard を戻さない（画面を離れるまで再送信できない
    // ようにするため）。
    expect(guard.current).toBe(true)
  })

  it('requestPersistence が失敗しても saved の結果には影響しない（握りつぶす）', async () => {
    const addProfile = vi.fn().mockResolvedValue(undefined)
    const updateProfile = vi.fn().mockResolvedValue(undefined)
    const requestPersistence = vi.fn().mockRejectedValue(new Error('persist に失敗（テスト用）'))
    const guard: SubmitGuard = { current: false }
    const outcome = await saveProfileForm(baseForm(), null, NOW, fixedId('p1'), guard, {
      addProfile,
      updateProfile,
      requestPersistence,
      store: {} as never,
    })
    expect(outcome.kind).toBe('saved')
    // .catch が処理されるのを待つ（未処理の rejection が出ないことの確認。sheets.test.ts と同じ理由）
    await Promise.resolve()
    await Promise.resolve()
  })

  it('編集（existing あり）は updateProfile を呼び、requestPersistence は呼ばない', async () => {
    const existing = makeProfile()
    const addProfile = vi.fn().mockResolvedValue(undefined)
    const updateProfile = vi.fn().mockResolvedValue(undefined)
    const requestPersistence = vi.fn().mockResolvedValue(true)
    const guard: SubmitGuard = { current: false }
    // 編集は existing.id を使うため、createId が呼ばれないことも確かめる。
    const createId = vi.fn(fixedId('unused'))
    const outcome = await saveProfileForm(baseForm({ nickname: 'ゆいこ' }), existing, NOW, createId, guard, {
      addProfile,
      updateProfile,
      requestPersistence,
      store: {} as never,
    })
    expect(outcome.kind).toBe('saved')
    if (outcome.kind === 'saved') expect(outcome.mode).toBe('edit')
    expect(updateProfile).toHaveBeenCalledTimes(1)
    expect(addProfile).not.toHaveBeenCalled()
    expect(requestPersistence).not.toHaveBeenCalled()
    expect(createId).not.toHaveBeenCalled()
    // 申し送り 1: 編集の保存成功時も guard を戻さない。
    expect(guard.current).toBe(true)
  })

  it('addProfile が失敗すると error を返し、guard は解放される（続けて呼べば再試行できる）', async () => {
    const addProfile = vi.fn().mockRejectedValue(new Error('保存に失敗（テスト用）'))
    const updateProfile = vi.fn().mockResolvedValue(undefined)
    const requestPersistence = vi.fn().mockResolvedValue(true)
    const guard: SubmitGuard = { current: false }
    const outcome = await saveProfileForm(baseForm(), null, NOW, fixedId('p1'), guard, {
      addProfile,
      updateProfile,
      requestPersistence,
      store: {} as never,
    })
    expect(outcome).toEqual({ kind: 'error' })
    expect(guard.current).toBe(false)
    expect(requestPersistence).not.toHaveBeenCalled()
  })

  it('申し送り 1: id を作る関数（createId）が例外を投げても error を返し、guard は false に戻る', async () => {
    const addProfile = vi.fn().mockResolvedValue(undefined)
    const updateProfile = vi.fn().mockResolvedValue(undefined)
    const requestPersistence = vi.fn().mockResolvedValue(true)
    const guard: SubmitGuard = { current: false }
    const createId = vi.fn(() => {
      throw new Error('id 作成に失敗（テスト用）')
    })
    const outcome = await saveProfileForm(baseForm(), null, NOW, createId, guard, {
      addProfile,
      updateProfile,
      requestPersistence,
      store: {} as never,
    })
    expect(outcome).toEqual({ kind: 'error' })
    expect(addProfile).not.toHaveBeenCalled()
    expect(guard.current).toBe(false)
  })

  it('must 2: 連続して 2 回呼んでも（1 回目が完了する前に 2 回目を呼んでも）保存は 1 回だけになる', async () => {
    const deferred = deferredFn<void>()
    const addProfile = vi.fn().mockReturnValue(deferred.promise)
    const updateProfile = vi.fn().mockResolvedValue(undefined)
    const requestPersistence = vi.fn().mockResolvedValue(true)
    const guard: SubmitGuard = { current: false }
    const deps = { addProfile, updateProfile, requestPersistence, store: {} as never }

    // 1 回目はまだ addProfile の Promise を待っている途中（await していない）
    const first = saveProfileForm(baseForm(), null, NOW, fixedId('p1'), guard, deps)
    // 1 回目が同期的に guard.current を true にした直後に、2 回目を（await せず）連続して呼ぶ
    const second = saveProfileForm(baseForm(), null, NOW, fixedId('p2'), guard, deps)

    const secondOutcome = await second
    expect(secondOutcome).toEqual({ kind: 'skipped' })
    expect(addProfile).toHaveBeenCalledTimes(1)

    // 1 回目を完了させる
    deferred.resolve()
    const firstOutcome = await first
    expect(firstOutcome.kind).toBe('saved')
    expect(addProfile).toHaveBeenCalledTimes(1)
    // 申し送り 1: 保存成功時は guard を戻さないので、ここでは true のまま。
    expect(guard.current).toBe(true)
  })
})

describe('createProfileId', () => {
  it('crypto.randomUUID があればそれを使う', () => {
    const id = createProfileId()
    // ブラウザ・Node の実行環境どちらでも crypto.randomUUID は使えるはずなので、既定の分岐を通る。
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('crypto.randomUUID が無い環境では getRandomValues で作った 16 進文字列を返す', () => {
    // randomUUID を持たない crypto に一時的に差し替える（申し送り 1 の代わりの作り方の分岐）。
    // getRandomValues は本物をそのまま使うので、実際に乱数から 32 桁の 16 進文字列を作れることも
    // 確かめられる。
    const originalCrypto = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) })
    try {
      const id = createProfileId()
      expect(id).toMatch(/^[0-9a-f]{32}$/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
