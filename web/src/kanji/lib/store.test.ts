import { describe, it, expect } from 'vitest'
import type { LearnerProfile } from '../types'
import { PROFILE_COLORS } from '../types'
import { levelRank, isLevel, levelParts } from './levels'
import {
  createMemoryBackend,
  createMemoryStore,
  createStore,
  isValidNickname,
  newProfile,
  nicknameLength,
  normalizeProfile,
  requestPersistence,
} from './store'

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

describe('createMemoryStore', () => {
  it('保存 → 一覧 → 取得が往復する', async () => {
    const store = createMemoryStore()
    const profile = makeProfile({ id: 'p1', nickname: 'ゆい' })
    await store.saveProfile(profile)

    const list = await store.listProfiles()
    expect(list).toEqual([profile])

    const got = await store.getProfile('p1')
    expect(got).toEqual(profile)
  })

  it('一覧が createdAt の古い順', async () => {
    const store = createMemoryStore()
    const later = makeProfile({
      id: 'p2',
      nickname: 'はると',
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    })
    const earlier = makeProfile({
      id: 'p1',
      nickname: 'ゆい',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    // わざと新しい方を先に保存し、一覧が保存順ではなく createdAt 順であることを確かめる
    await store.saveProfile(later)
    await store.saveProfile(earlier)

    const list = await store.listProfiles()
    expect(list.map((p) => p.id)).toEqual(['p1', 'p2'])
  })

  it('ニックネームが空白だけ・21 文字の学習者は保存されず例外になる', async () => {
    const store = createMemoryStore()
    const blank = makeProfile({ id: 'p1', nickname: '   ' })
    await expect(store.saveProfile(blank)).rejects.toThrow()

    const tooLong = makeProfile({ id: 'p2', nickname: 'あ'.repeat(21) })
    await expect(store.saveProfile(tooLong)).rejects.toThrow()

    expect(await store.listProfiles()).toEqual([])
  })

  it('lastProfileId の学習者を消すと lastProfileId も消える', async () => {
    const store = createMemoryStore()
    await store.saveProfile(makeProfile({ id: 'p1' }))
    await store.setMeta('lastProfileId', 'p1')

    await store.deleteProfile('p1')

    expect(await store.getProfile('p1')).toBeUndefined()
    expect(await store.getMeta('lastProfileId')).toBeUndefined()
  })

  it('lastProfileId ではない学習者を消しても lastProfileId は残る', async () => {
    const store = createMemoryStore()
    await store.saveProfile(makeProfile({ id: 'p1' }))
    await store.saveProfile(makeProfile({ id: 'p2', nickname: 'はると' }))
    await store.setMeta('lastProfileId', 'p1')

    await store.deleteProfile('p2')

    expect(await store.getMeta('lastProfileId')).toBe('p1')
  })

  it('volatile: true を渡すと volatile が true になる', () => {
    expect(createMemoryStore({ volatile: true }).volatile).toBe(true)
    expect(createMemoryStore().volatile).toBe(false)
  })

  it('取得した学習者を書き換えても保存済みの値は変わらない（structuredClone、IndexedDB と同じ挙動）', async () => {
    const store = createMemoryStore()
    await store.saveProfile(makeProfile({ id: 'p1', nickname: 'ゆい' }))

    const got = await store.getProfile('p1')
    got!.nickname = '書き換えた'

    const listed = await store.listProfiles()
    listed[0].nickname = 'また書き換えた'

    const reread = await store.getProfile('p1')
    expect(reread?.nickname).toBe('ゆい')
  })

  it('onClose は解除関数を返し、呼んでも例外を出さない（メモリ版は登録だけ受けて何もしない）', () => {
    const store = createMemoryStore()
    const unsubscribe = store.onClose(() => {
      throw new Error('メモリ版では呼ばれないはず')
    })

    expect(typeof unsubscribe).toBe('function')
    expect(() => unsubscribe()).not.toThrow()
  })
})

describe('createStore + createMemoryBackend（共通の層のテスト）', () => {
  it('壊れたレコード（createdAt が無い等）が混ざっていても listProfiles は例外を出さず、そのレコードだけ除く', async () => {
    const backend = createMemoryBackend()
    await backend.putProfile(makeProfile({ id: 'good', nickname: 'ゆい' }))
    // backend は素の読み書きだけなので、検証を経ない壊れたレコードも書き込める（createdAt が無い）
    await backend.putProfile({ id: 'broken', nickname: 'はると' } as unknown as LearnerProfile)

    const store = createStore(backend)
    const list = await store.listProfiles()

    expect(list.map((p) => p.id)).toEqual(['good'])
    expect(await store.getProfile('broken')).toBeUndefined()
  })
})

describe('normalizeProfile', () => {
  it('不正な列挙値を既定値にし、知らない項目を捨て、不正な日付を null にする', () => {
    const raw = {
      id: 'p1',
      nickname: '  ゆい  ',
      level: 'not-a-level',
      furigana: 'invalid',
      display: 'invalid',
      writeMode: 'invalid',
      dailyGoal: 999,
      color: '#000000',
      kanaKeyboard: 'yes',
      lang: '???',
      examDate: '2026-02-30',
      createdAt: NOW,
      updatedAt: NOW,
      // 知らない項目
      favoriteFood: 'カレー',
    }

    const normalized = normalizeProfile(raw)

    expect(normalized).toEqual({
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
    })
  })

  it('id が空、またはニックネームが空白だけ・21 文字以上なら null', () => {
    expect(normalizeProfile({ id: '', nickname: 'ゆい', createdAt: NOW, updatedAt: NOW })).toBeNull()
    expect(normalizeProfile({ id: 'p1', nickname: '   ', createdAt: NOW, updatedAt: NOW })).toBeNull()
    expect(normalizeProfile({ id: 'p1', nickname: 'あ'.repeat(21), createdAt: NOW, updatedAt: NOW })).toBeNull()
    expect(normalizeProfile('not-an-object')).toBeNull()
  })

  it('createdAt / updatedAt が文字列でない、または ISO 8601 として不正なら null（読み出し時の壊れたレコード対策）', () => {
    expect(normalizeProfile({ id: 'p1', nickname: 'ゆい' })).toBeNull()
    expect(normalizeProfile({ id: 'p1', nickname: 'ゆい', createdAt: NOW })).toBeNull()
    expect(normalizeProfile({ id: 'p1', nickname: 'ゆい', createdAt: 12345, updatedAt: NOW })).toBeNull()
    // 型は文字列でも、ISO 8601 の形でない・Date.parse できない値は弾く（2026-09-23 再レビュー should 1）
    expect(normalizeProfile({ id: 'p1', nickname: 'ゆい', createdAt: '', updatedAt: NOW })).toBeNull()
    expect(normalizeProfile({ id: 'p1', nickname: 'ゆい', createdAt: 'abc', updatedAt: NOW })).toBeNull()
    expect(normalizeProfile({ id: 'p1', nickname: 'ゆい', createdAt: NOW, updatedAt: '' })).toBeNull()
    expect(normalizeProfile({ id: 'p1', nickname: 'ゆい', createdAt: NOW, updatedAt: 'abc' })).toBeNull()
  })

  it('正しい形式の examDate はそのまま通す', () => {
    const normalized = normalizeProfile({
      id: 'p1',
      nickname: 'ゆい',
      examDate: '2026-03-15',
      createdAt: NOW,
      updatedAt: NOW,
    })
    expect(normalized?.examDate).toBe('2026-03-15')
  })

  it('うるう年の判定が正しい（2024 年はうるう年、2026・2100 年は違う）', () => {
    const withDate = (examDate: string) =>
      normalizeProfile({ id: 'p1', nickname: 'ゆい', examDate, createdAt: NOW, updatedAt: NOW })?.examDate

    expect(withDate('2024-02-29')).toBe('2024-02-29')
    expect(withDate('2026-02-29')).toBeNull()
    expect(withDate('2100-02-29')).toBeNull()
  })

  it('lang を正規化してから保存する（大文字・小文字やスクリプト表記のゆれを吸収）', () => {
    const withUpper = normalizeProfile({ id: 'p1', nickname: 'ゆい', lang: 'JA', createdAt: NOW, updatedAt: NOW })
    expect(withUpper?.lang).toBe('ja')

    const withScript = normalizeProfile({
      id: 'p1',
      nickname: 'ゆい',
      lang: 'zh-hans',
      createdAt: NOW,
      updatedAt: NOW,
    })
    expect(withScript?.lang).toBe('zh-Hans')
  })

  it.each(['zh-Hans', 'fil'] as const)(
    '既定値でない正しい値は入力のままそっくり通る（lang=%s）',
    (lang) => {
      const raw = {
        id: 'p1',
        nickname: 'はると',
        color: PROFILE_COLORS[4],
        level: 'pre2',
        lang,
        furigana: 'none',
        display: 'adult',
        kanaKeyboard: true,
        dailyGoal: 30,
        examDate: '2024-02-29',
        writeMode: 'paper',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      }
      expect(normalizeProfile(raw)).toEqual(raw)
    },
  )
})

describe('nicknameLength / isValidNickname', () => {
  it('絵文字を 1 文字として数える', () => {
    expect(nicknameLength('😀'.repeat(20))).toBe(20)
    expect(isValidNickname('😀'.repeat(20))).toBe(true)
    expect(isValidNickname('😀'.repeat(21))).toBe(false)
  })

  it('漢字・ひらがなも 1 文字として数える', () => {
    expect(isValidNickname('あ'.repeat(20))).toBe(true)
    expect(isValidNickname('あ'.repeat(21))).toBe(false)
  })

  it('前後の空白を除いて数える', () => {
    expect(isValidNickname('  ' + 'あ'.repeat(20) + '  ')).toBe(true)
  })
})

describe('newProfile', () => {
  it('入力の不足分を既定値で埋め、id と createdAt/updatedAt に渡した値を使う', () => {
    const profile = newProfile({ nickname: 'Linh' }, '2026-03-01T00:00:00.000Z', 'p9')
    expect(profile.id).toBe('p9')
    expect(profile.nickname).toBe('Linh')
    expect(profile.level).toBe('10')
    expect(profile.furigana).toBe('all')
    expect(profile.createdAt).toBe('2026-03-01T00:00:00.000Z')
    expect(profile.updatedAt).toBe('2026-03-01T00:00:00.000Z')
  })

  it('ニックネームが不正なら例外を投げる', () => {
    expect(() => newProfile({ nickname: '' }, '2026-03-01T00:00:00.000Z', 'p9')).toThrow()
  })
})

describe('levelRank / isLevel / levelParts', () => {
  it('levelRank の順が 10 < 9 < … < pre2 < 2 < pre1 < 1', () => {
    const order = ['10', '9', '8', '7', '6', '5', '4', '3', 'pre2', '2', 'pre1', '1'] as const
    const ranks = order.map((level) => levelRank(level))
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it('isLevel が Level の値だけ true を返す', () => {
    expect(isLevel('10')).toBe(true)
    expect(isLevel('pre1')).toBe(true)
    expect(isLevel('11')).toBe(false)
    expect(isLevel('pre3')).toBe(false)
    expect(isLevel(10)).toBe(false)
  })

  it('levelParts が準 n 級と n 級を分解する', () => {
    expect(levelParts('10')).toEqual({ n: '10', pre: false })
    expect(levelParts('pre2')).toEqual({ n: '2', pre: true })
    expect(levelParts('pre1')).toEqual({ n: '1', pre: true })
  })
})

describe('requestPersistence', () => {
  it('persist() を 1 回しか呼ばず、結果を meta に残す', async () => {
    const store = createMemoryStore()
    let calls = 0
    const storage = {
      persist: async () => {
        calls += 1
        return true
      },
    }

    const first = await requestPersistence(store, storage)
    const second = await requestPersistence(store, storage)

    expect(first).toBe(true)
    expect(second).toBe(true)
    expect(calls).toBe(1)
    expect(await store.getMeta('persistRequested')).toBe(true)
    expect(await store.getMeta('persisted')).toBe(true)
  })

  it('persist API が無ければ false を返し、meta には requested: true / persisted: false を残す', async () => {
    const store = createMemoryStore()
    const result = await requestPersistence(store, undefined)

    expect(result).toBe(false)
    expect(await store.getMeta('persistRequested')).toBe(true)
    expect(await store.getMeta('persisted')).toBe(false)
  })

  it('persist() が失敗（reject）しても例外を外へ出さず false を返す', async () => {
    const store = createMemoryStore()
    const storage = {
      persist: async () => {
        throw new Error('permission denied')
      },
    }

    const result = await requestPersistence(store, storage)

    expect(result).toBe(false)
    expect(await store.getMeta('persistRequested')).toBe(true)
    expect(await store.getMeta('persisted')).toBe(false)
  })
})
