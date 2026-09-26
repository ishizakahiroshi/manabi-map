// ProfileProvider.tsx の操作の本体（profileState.ts の純粋な reducer と、store + dispatch を
// 受け取る関数）をテストする。React の hook は node 環境では描画できないため、useReducer の
// 代わりに reducer を手で呼ぶ簡易な harness で状態の変化を確かめる（子 plan「このファイルを開いた
// AI へ」の指示どおり）。ProfileProvider 自体の描画は renderToString で行う（C4 の
// packs.test.ts の Probe パターンに合わせる）。

import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createMemoryStore, type KanjiStore, type StoreMeta } from '../lib/store'
import { PROFILE_COLORS, type LearnerProfile } from '../types'
import { ProfileProvider, useCurrentProfile, useProfiles, type ProfilesValue } from './ProfileProvider'
import {
  addProfileAction,
  pickInitialCurrent,
  profileReducer,
  removeProfileAction,
  setUiLangAction,
  switchProfileAction,
  updateProfileAction,
  type ProfileAction,
  type ProfileState,
} from './profileState'

const NOW = '2026-01-01T00:00:00.000Z'

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

/**
 * useReducer の代わりに使う簡易な harness。dispatch を呼ぶたびに profileReducer で状態を進める。
 * getState はこの harness の最新の状態を返す（profileState.ts の GetProfileState と同じ形なので、
 * removeProfileAction / setUiLangAction にそのまま渡せる）。
 */
function makeHarness(initial: ProfileState) {
  let state = initial
  const dispatch = (action: ProfileAction) => {
    state = profileReducer(state, action)
  }
  return { dispatch, getState: () => state }
}

const EMPTY_STATE: ProfileState = { profiles: [], currentId: null, volatile: false, uiLang: 'ja' }

/** すべての store 呼び出しが失敗する偽物（2026-09-24 レビュー must 1・2・should 4 の各テストで使う） */
function makeFailingStore(): KanjiStore {
  return {
    volatile: false,
    async listProfiles() {
      return []
    },
    async getProfile() {
      return undefined
    },
    async saveProfile() {
      throw new Error('保存に失敗しました（テスト用の偽物）')
    },
    async deleteProfile() {
      throw new Error('削除に失敗しました（テスト用の偽物）')
    },
    async getMeta() {
      return undefined
    },
    async setMeta() {
      throw new Error('setMeta に失敗しました（テスト用の偽物）')
    },
    onClose() {
      return () => {}
    },
  }
}

/** setMeta だけ失敗し、他は base（実物のメモリ store）にそのまま委ねる偽物 */
function withFailingSetMeta(base: KanjiStore): KanjiStore {
  return {
    ...base,
    async setMeta<K extends keyof StoreMeta>(_key: K, _value: StoreMeta[K]): Promise<void> {
      throw new Error('setMeta に失敗しました（テスト用の偽物）')
    },
  }
}

/** deleteProfile は実際に消してから例外を出す（書き込みが成功したのに失敗と報告される想定） */
function withDeleteThrowingAfterSuccess(base: KanjiStore): KanjiStore {
  return {
    ...base,
    async deleteProfile(id: string): Promise<void> {
      await base.deleteProfile(id)
      throw new Error('削除に失敗しました（テスト用・実際には消えている）')
    },
  }
}

/** deleteProfile は何もせず例外だけ出す（本当に消えていない想定） */
function withDeleteAlwaysThrowing(base: KanjiStore): KanjiStore {
  return {
    ...base,
    async deleteProfile(): Promise<void> {
      throw new Error('削除に失敗しました（テスト用・実際には消えていない）')
    },
  }
}

/**
 * deleteProfile を手で解決する Promise で止める偽物（2026-09-24 再レビュー should 1）。
 * resolveDelete を呼ぶまで削除が終わらないので、その間に別の dispatch を割り込ませて
 * 「削除を待っている間に switch が入る」状況を再現できる。
 */
function withDeferredDelete(base: KanjiStore): { store: KanjiStore; resolveDelete: () => void } {
  let resolveGate: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve
  })
  const store: KanjiStore = {
    ...base,
    async deleteProfile(id: string): Promise<void> {
      await gate
      await base.deleteProfile(id)
    },
  }
  return { store, resolveDelete: resolveGate }
}

describe('pickInitialCurrent', () => {
  const p1 = makeProfile({ id: 'p1' })
  const p2 = makeProfile({ id: 'p2', nickname: 'はると' })

  it('lastProfileId の学習者がいればその id', () => {
    expect(pickInitialCurrent([p1, p2], 'p2')).toBe('p2')
  })

  it('lastProfileId の学習者がいなくて学習者が 1 人ならその id', () => {
    expect(pickInitialCurrent([p1], 'missing')).toBe('p1')
    expect(pickInitialCurrent([p1], undefined)).toBe('p1')
  })

  it('それ以外（学習者が 0 人、または 2 人以上で lastProfileId が無い）は null', () => {
    expect(pickInitialCurrent([], undefined)).toBeNull()
    expect(pickInitialCurrent([p1, p2], undefined)).toBeNull()
    expect(pickInitialCurrent([p1, p2], 'missing')).toBeNull()
  })
})

describe('profileReducer', () => {
  it('add: 一覧に足して createdAt の古い順に並べ、いまの学習者にする', () => {
    const p1 = makeProfile({ id: 'p1', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' })
    const p2 = makeProfile({
      id: 'p2',
      nickname: 'はると',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    const afterFirst = profileReducer(EMPTY_STATE, { type: 'add', profile: p1 })
    const afterSecond = profileReducer(afterFirst, { type: 'add', profile: p2 })

    expect(afterSecond.profiles.map((p) => p.id)).toEqual(['p2', 'p1'])
    expect(afterSecond.currentId).toBe('p2')
  })

  it('add: 同じ id で 2 回足すと置き換わる（should 1・重複を作らない）', () => {
    const p1 = makeProfile({ id: 'p1' })
    const afterFirst = profileReducer(EMPTY_STATE, { type: 'add', profile: p1 })
    const afterSecond = profileReducer(afterFirst, { type: 'add', profile: { ...p1, nickname: 'ゆいこ' } })

    expect(afterSecond.profiles).toHaveLength(1)
    expect(afterSecond.profiles[0].nickname).toBe('ゆいこ')
  })

  it('update: 該当する学習者だけ差し替える', () => {
    const p1 = makeProfile({ id: 'p1' })
    const state: ProfileState = { ...EMPTY_STATE, profiles: [p1], currentId: 'p1' }
    const updated = { ...p1, nickname: 'ゆいこ' }

    const next = profileReducer(state, { type: 'update', profile: updated })

    expect(next.profiles).toEqual([updated])
  })

  it('remove: いまの学習者を消すと残りの最初の学習者、最後の 1 人を消すと null', () => {
    const p1 = makeProfile({ id: 'p1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    const p2 = makeProfile({
      id: 'p2',
      nickname: 'はると',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    const state: ProfileState = { ...EMPTY_STATE, profiles: [p1, p2], currentId: 'p1' }

    const afterFirstRemove = profileReducer(state, { type: 'remove', id: 'p1' })
    expect(afterFirstRemove.profiles.map((p) => p.id)).toEqual(['p2'])
    expect(afterFirstRemove.currentId).toBe('p2')

    const afterSecondRemove = profileReducer(afterFirstRemove, { type: 'remove', id: 'p2' })
    expect(afterSecondRemove.profiles).toEqual([])
    expect(afterSecondRemove.currentId).toBeNull()
  })

  it('remove: いまの学習者でない方を消しても currentId は変わらない', () => {
    const p1 = makeProfile({ id: 'p1' })
    const p2 = makeProfile({ id: 'p2', nickname: 'はると' })
    const state: ProfileState = { ...EMPTY_STATE, profiles: [p1, p2], currentId: 'p1' }

    const next = profileReducer(state, { type: 'remove', id: 'p2' })

    expect(next.currentId).toBe('p1')
    expect(next.profiles.map((p) => p.id)).toEqual(['p1'])
  })

  it('switch: currentId を変えるだけ', () => {
    const state: ProfileState = { ...EMPTY_STATE, currentId: 'p1' }
    expect(profileReducer(state, { type: 'switch', id: 'p2' }).currentId).toBe('p2')
  })

  it('setUiLang: uiLang を変えるだけ', () => {
    expect(profileReducer(EMPTY_STATE, { type: 'setUiLang', lang: 'en' }).uiLang).toBe('en')
  })
})

describe('addProfileAction', () => {
  it('追加するといまの学習者になり、meta の lastProfileId が更新される', async () => {
    const store = createMemoryStore()
    const harness = makeHarness(EMPTY_STATE)
    const profile = makeProfile({ id: 'p1' })

    await addProfileAction(store, harness.dispatch, profile)

    expect(harness.getState().profiles).toEqual([profile])
    expect(harness.getState().currentId).toBe('p1')
    expect(await store.getMeta('lastProfileId')).toBe('p1')
    expect(await store.getProfile('p1')).toEqual(profile)
  })

  it('must 1: normalizeProfile を通した値を画面と保存の両方に使う（前後の空白・大文字の lang）', async () => {
    const store = createMemoryStore()
    const harness = makeHarness(EMPTY_STATE)
    const profile = makeProfile({ id: 'p1', nickname: '  ゆいこ  ', lang: 'EN' })

    await addProfileAction(store, harness.dispatch, profile)

    const stored = await store.getProfile('p1')
    expect(harness.getState().profiles[0]).toEqual(stored)
    expect(harness.getState().profiles[0].nickname).toBe('ゆいこ')
    expect(harness.getState().profiles[0].lang).toBe('en')
  })

  it('should 1: 同じ学習者で 2 回呼んでも画面の件数と保存の件数がどちらも 1', async () => {
    const store = createMemoryStore()
    const harness = makeHarness(EMPTY_STATE)
    const profile = makeProfile({ id: 'p1' })

    await addProfileAction(store, harness.dispatch, profile)
    await addProfileAction(store, harness.dispatch, { ...profile, nickname: 'ゆいこ' })

    expect(harness.getState().profiles).toHaveLength(1)
    expect(harness.getState().profiles[0].nickname).toBe('ゆいこ')
    expect(await store.listProfiles()).toHaveLength(1)
  })

  it('must 2: lastProfileId の書き込みが失敗しても、追加自体は例外にならない', async () => {
    const base = createMemoryStore()
    const store = withFailingSetMeta(base)
    const harness = makeHarness(EMPTY_STATE)
    const profile = makeProfile({ id: 'p1' })

    await expect(addProfileAction(store, harness.dispatch, profile)).resolves.toBeUndefined()

    expect(harness.getState().profiles).toEqual([profile])
    expect(harness.getState().currentId).toBe('p1')
    expect(await base.getProfile('p1')).toEqual(profile)
  })
})

describe('updateProfileAction', () => {
  it('updatedAt を now に更新してから保存し、状態も更新する', async () => {
    const store = createMemoryStore()
    const p1 = makeProfile({ id: 'p1' })
    await store.saveProfile(p1)
    const harness = makeHarness({ ...EMPTY_STATE, profiles: [p1], currentId: 'p1' })
    const later = '2026-02-01T00:00:00.000Z'

    await updateProfileAction(store, harness.dispatch, { ...p1, nickname: 'ゆいこ' }, later)

    expect(harness.getState().profiles[0].nickname).toBe('ゆいこ')
    expect(harness.getState().profiles[0].updatedAt).toBe(later)
    expect((await store.getProfile('p1'))?.nickname).toBe('ゆいこ')
  })

  it('must 1: normalizeProfile を通した値を画面と保存の両方に使う（前後の空白・大文字の lang）', async () => {
    const store = createMemoryStore()
    const p1 = makeProfile({ id: 'p1' })
    await store.saveProfile(p1)
    const harness = makeHarness({ ...EMPTY_STATE, profiles: [p1], currentId: 'p1' })
    const later = '2026-02-01T00:00:00.000Z'

    await updateProfileAction(store, harness.dispatch, { ...p1, nickname: '  ゆいこ  ', lang: 'EN' }, later)

    const stored = await store.getProfile('p1')
    expect(harness.getState().profiles[0]).toEqual(stored)
    expect(harness.getState().profiles[0].nickname).toBe('ゆいこ')
    expect(harness.getState().profiles[0].lang).toBe('en')
  })
})

describe('removeProfileAction', () => {
  it('いまの学習者を消すと次の学習者に替わり、最後の 1 人を消すと null になる', async () => {
    const store = createMemoryStore()
    const p1 = makeProfile({ id: 'p1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    const p2 = makeProfile({
      id: 'p2',
      nickname: 'はると',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    await store.saveProfile(p1)
    await store.saveProfile(p2)
    const harness = makeHarness({ ...EMPTY_STATE, profiles: [p1, p2], currentId: 'p1' })

    await removeProfileAction(store, harness.dispatch, harness.getState, 'p1')
    expect(harness.getState().profiles.map((p) => p.id)).toEqual(['p2'])
    expect(harness.getState().currentId).toBe('p2')
    expect(await store.getProfile('p1')).toBeUndefined()

    await removeProfileAction(store, harness.dispatch, harness.getState, 'p2')
    expect(harness.getState().profiles).toEqual([])
    expect(harness.getState().currentId).toBeNull()
  })

  it('must 2: deleteProfile が例外を出しても、実際には消えていれば状態を進めて例外を出さない', async () => {
    const base = createMemoryStore()
    const p1 = makeProfile({ id: 'p1' })
    await base.saveProfile(p1)
    const store = withDeleteThrowingAfterSuccess(base)
    const harness = makeHarness({ ...EMPTY_STATE, profiles: [p1], currentId: 'p1' })

    await expect(removeProfileAction(store, harness.dispatch, harness.getState, 'p1')).resolves.toBeUndefined()

    expect(harness.getState().profiles).toEqual([])
    expect(harness.getState().currentId).toBeNull()
    expect(await base.listProfiles()).toEqual([])
  })

  it('must 2: deleteProfile が例外を出して実際にまだ残っていれば、状態を変えずに例外を返す', async () => {
    const base = createMemoryStore()
    const p1 = makeProfile({ id: 'p1' })
    await base.saveProfile(p1)
    const store = withDeleteAlwaysThrowing(base)
    const state: ProfileState = { ...EMPTY_STATE, profiles: [p1], currentId: 'p1' }
    const harness = makeHarness(state)

    await expect(removeProfileAction(store, harness.dispatch, harness.getState, 'p1')).rejects.toThrow()

    expect(harness.getState()).toEqual(state)
    expect(await base.getProfile('p1')).toEqual(p1)
  })

  it('should 2: いまの学習者を消すと、次の学習者へ lastProfileId が進む', async () => {
    const store = createMemoryStore()
    const p1 = makeProfile({ id: 'p1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    const p2 = makeProfile({
      id: 'p2',
      nickname: 'はると',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    const p3 = makeProfile({
      id: 'p3',
      nickname: 'Linh',
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    })
    await store.saveProfile(p1)
    await store.saveProfile(p2)
    await store.saveProfile(p3)
    await store.setMeta('lastProfileId', 'p1')
    const harness = makeHarness({ ...EMPTY_STATE, profiles: [p1, p2, p3], currentId: 'p1' })

    await removeProfileAction(store, harness.dispatch, harness.getState, 'p1')

    const listed = await store.listProfiles()
    const lastProfileId = await store.getMeta('lastProfileId')
    expect(pickInitialCurrent(listed, lastProfileId)).toBe(harness.getState().currentId)
    expect(harness.getState().currentId).toBe('p2')
  })

  it('should 1（再レビュー）: 削除を待っている間に switch が割り込んでも、lastProfileId は割り込み後の状態に合わせる', async () => {
    // 削除後も 2 人残るようにする（1 人だけ残る形だと pickInitialCurrent が「1 人ならその id」で
    // 救ってしまい、lastProfileId が書かれていなくてもテストが通ってしまうため。2026-09-24
    // 再レビューでの自己検証で確認した）。
    const base = createMemoryStore()
    const p1 = makeProfile({ id: 'p1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })
    const p2 = makeProfile({
      id: 'p2',
      nickname: 'はると',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    const p3 = makeProfile({
      id: 'p3',
      nickname: 'Linh',
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    })
    await base.saveProfile(p1)
    await base.saveProfile(p2)
    await base.saveProfile(p3)
    const { store, resolveDelete } = withDeferredDelete(base)
    // 削除を始めた時点のいまの学習者は p2（消そうとしている p1 ではない）
    const harness = makeHarness({ ...EMPTY_STATE, profiles: [p1, p2, p3], currentId: 'p2' })

    const removing = removeProfileAction(store, harness.dispatch, harness.getState, 'p1')
    // 削除待ちの間に、いまの学習者が p1 へ切り替わる（削除中の学習者が「いま」になる）
    harness.dispatch({ type: 'switch', id: 'p1' })
    resolveDelete()
    await removing

    const listed = await store.listProfiles()
    const lastProfileId = await store.getMeta('lastProfileId')
    expect(pickInitialCurrent(listed, lastProfileId)).toBe(harness.getState().currentId)
    expect(harness.getState().currentId).toBe('p2')
  })
})

describe('switchProfileAction', () => {
  it('currentId を替えて lastProfileId を更新する', async () => {
    const store = createMemoryStore()
    const p1 = makeProfile({ id: 'p1' })
    const p2 = makeProfile({ id: 'p2', nickname: 'はると' })
    await store.saveProfile(p1)
    await store.saveProfile(p2)
    const harness = makeHarness({ ...EMPTY_STATE, profiles: [p1, p2], currentId: 'p1' })

    await switchProfileAction(store, harness.dispatch, 'p2')

    expect(harness.getState().currentId).toBe('p2')
    expect(await store.getMeta('lastProfileId')).toBe('p2')
  })
})

describe('setUiLangAction', () => {
  it('いまの学習者がいるときは、その学習者の lang を更新して保存する', async () => {
    const store = createMemoryStore()
    const p1 = makeProfile({ id: 'p1', lang: 'ja' })
    await store.saveProfile(p1)
    const harness = makeHarness({ ...EMPTY_STATE, profiles: [p1], currentId: 'p1' })
    const later = '2026-02-01T00:00:00.000Z'

    await setUiLangAction(store, harness.dispatch, 'en', harness.getState, later)

    expect(harness.getState().profiles[0].lang).toBe('en')
    expect(harness.getState().uiLang).toBe('ja') // 学習者がいるときは state.uiLang 自体は変えない
    expect((await store.getProfile('p1'))?.lang).toBe('en')
  })

  it('いまの学習者がいないときは meta の uiLang を更新する', async () => {
    const store = createMemoryStore()
    const harness = makeHarness(EMPTY_STATE)

    await setUiLangAction(store, harness.dispatch, 'en', harness.getState, '2026-02-01T00:00:00.000Z')

    expect(harness.getState().uiLang).toBe('en')
    expect(await store.getMeta('uiLang')).toBe('en')
  })

  it('should 3: switch の直後に呼んでも、切り替え後の学習者に効く（getState を呼んだ時点の最新を読む）', async () => {
    const store = createMemoryStore()
    const p1 = makeProfile({ id: 'p1', lang: 'ja' })
    const p2 = makeProfile({ id: 'p2', nickname: 'はると', lang: 'ja' })
    await store.saveProfile(p1)
    await store.saveProfile(p2)
    const harness = makeHarness({ ...EMPTY_STATE, profiles: [p1, p2], currentId: 'p1' })

    await switchProfileAction(store, harness.dispatch, 'p2')
    await setUiLangAction(store, harness.dispatch, 'en', harness.getState, NOW)

    expect(harness.getState().profiles.find((p) => p.id === 'p2')?.lang).toBe('en')
    expect(harness.getState().profiles.find((p) => p.id === 'p1')?.lang).toBe('ja')
    expect((await store.getProfile('p2'))?.lang).toBe('en')
    expect((await store.getProfile('p1'))?.lang).toBe('ja')
  })
})

describe('保存が失敗したとき（should 4: 各操作の網羅性）', () => {
  it('addProfileAction: saveProfile が失敗すると状態が変わらない', async () => {
    const store = makeFailingStore()
    const harness = makeHarness(EMPTY_STATE)
    const profile = makeProfile({ id: 'p1' })

    await expect(addProfileAction(store, harness.dispatch, profile)).rejects.toThrow()

    expect(harness.getState()).toEqual(EMPTY_STATE)
  })

  it('updateProfileAction: saveProfile が失敗すると状態が変わらない', async () => {
    const store = makeFailingStore()
    const p1 = makeProfile({ id: 'p1' })
    const state: ProfileState = { ...EMPTY_STATE, profiles: [p1], currentId: 'p1' }
    const harness = makeHarness(state)

    await expect(updateProfileAction(store, harness.dispatch, p1, '2026-02-01T00:00:00.000Z')).rejects.toThrow()

    expect(harness.getState()).toEqual(state)
  })

  it('switchProfileAction: setMeta が失敗すると状態が変わらない', async () => {
    const base = createMemoryStore()
    const p1 = makeProfile({ id: 'p1' })
    await base.saveProfile(p1)
    const store = withFailingSetMeta(base)
    const state: ProfileState = { ...EMPTY_STATE, profiles: [p1], currentId: 'p1' }
    const harness = makeHarness(state)

    await expect(switchProfileAction(store, harness.dispatch, 'p2')).rejects.toThrow()

    expect(harness.getState()).toEqual(state)
  })

  it('setUiLangAction（学習者あり）: saveProfile が失敗すると状態が変わらない', async () => {
    const store = makeFailingStore()
    const p1 = makeProfile({ id: 'p1' })
    const state: ProfileState = { ...EMPTY_STATE, profiles: [p1], currentId: 'p1' }
    const harness = makeHarness(state)

    await expect(setUiLangAction(store, harness.dispatch, 'en', harness.getState, NOW)).rejects.toThrow()

    expect(harness.getState()).toEqual(state)
  })

  it('setUiLangAction（学習者なし）: setMeta が失敗すると状態が変わらない', async () => {
    const base = createMemoryStore()
    const store = withFailingSetMeta(base)
    const harness = makeHarness(EMPTY_STATE)

    await expect(setUiLangAction(store, harness.dispatch, 'en', harness.getState, NOW)).rejects.toThrow()

    expect(harness.getState()).toEqual(EMPTY_STATE)
  })
})

describe('ProfileProvider（描画・should 4）', () => {
  function Probe({
    onCaptured,
  }: {
    onCaptured: (v: { value: ProfilesValue; current: LearnerProfile | null }) => void
  }) {
    const value = useProfiles()
    const current = useCurrentProfile()
    onCaptured({ value, current })
    return null
  }

  it('初期値（profiles・current・volatile）を確かめ、取り出した setUiLang で store の中の学習者の lang が変わる', async () => {
    const store = createMemoryStore()
    const p1 = makeProfile({ id: 'p1', lang: 'ja' })
    await store.saveProfile(p1)

    let captured: { value: ProfilesValue; current: LearnerProfile | null } | null = null
    renderToString(
      createElement(
        ProfileProvider,
        { store, initialProfiles: [p1], initialCurrentId: 'p1', initialUiLang: 'ja' },
        createElement(Probe, { onCaptured: (v) => (captured = v) }),
      ),
    )

    expect(captured).not.toBeNull()
    expect(captured!.value.profiles).toEqual([p1])
    expect(captured!.value.currentId).toBe('p1')
    expect(captured!.value.volatile).toBe(false)
    expect(captured!.current).toEqual(p1)

    // server 版（renderToString）は描き終えた後の dispatch（再描画）が効かないので、
    // 呼んだ結果は画面ではなく保存の中身で確かめる（子 plan の指示どおり）。
    await captured!.value.setUiLang('en')
    expect((await store.getProfile('p1'))?.lang).toBe('en')
  })

  it('2026-09-24 再レビュー should 2: switchProfile の直後に setUiLang を呼んでも、切り替え後の学習者に効く（getState が ref から最新を読む）', async () => {
    const store = createMemoryStore()
    const p1 = makeProfile({ id: 'p1', lang: 'ja' })
    const p2 = makeProfile({ id: 'p2', nickname: 'はると', lang: 'ja' })
    await store.saveProfile(p1)
    await store.saveProfile(p2)

    let captured: ProfilesValue | null = null
    renderToString(
      createElement(
        ProfileProvider,
        { store, initialProfiles: [p1, p2], initialCurrentId: 'p1', initialUiLang: 'ja' },
        createElement(Probe, { onCaptured: (v) => (captured = v.value) }),
      ),
    )
    expect(captured).not.toBeNull()

    // server 版では描き終えた後の dispatch は再描画に反映されないので、captured の関数を
    // そのまま連続で呼んで内部の ref だけで最新の状態が引き継がれることを確かめる。
    await captured!.switchProfile('p2')
    await captured!.setUiLang('en')

    expect((await store.getProfile('p2'))?.lang).toBe('en')
    expect((await store.getProfile('p1'))?.lang).toBe('ja')
  })

  it('Provider の外で useProfiles を呼ぶと例外になる', () => {
    function Outside() {
      useProfiles()
      return null
    }
    expect(() => renderToString(createElement(Outside))).toThrow()
  })

  it('Provider の外で useCurrentProfile を呼ぶと例外になる', () => {
    function Outside() {
      useCurrentProfile()
      return null
    }
    expect(() => renderToString(createElement(Outside))).toThrow()
  })
})
