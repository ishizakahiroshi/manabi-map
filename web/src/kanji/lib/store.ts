import { requestPersistentStorage } from '../platform/browser'
import type { DisplayMode, FuriganaMode, LearnerProfile, WriteMode } from '../types'
import { DAILY_GOALS, PROFILE_COLORS } from '../types'
import { isLevel } from './levels'

/** アプリ全体の設定（学習者をまたぐもの） */
export interface StoreMeta {
  lastProfileId: string
  /** 学習者がまだいないとき（はじめての画面など）に使う画面の言語 */
  uiLang: string
  persistRequested: boolean
  persisted: boolean
}

/**
 * 端末内保存の入口。IndexedDB 版とメモリ版（IndexedDB が使えない端末向け）の両方がこの形を満たす。
 * 実装は createStore（共通の層）+ ProfileBackend（素の読み書きだけの実装）に分かれている。
 */
export interface KanjiStore {
  /** true なら端末に残せない（メモリ保存。アプリを閉じると消える） */
  readonly volatile: boolean
  /** createdAt の古い順 */
  listProfiles(): Promise<LearnerProfile[]>
  getProfile(id: string): Promise<LearnerProfile | undefined>
  /** normalizeProfile を通す。通らなければ例外を投げ、何も保存しない */
  saveProfile(profile: LearnerProfile): Promise<void>
  /** 消したのが lastProfileId なら、その meta も消す */
  deleteProfile(id: string): Promise<void>
  getMeta<K extends keyof StoreMeta>(key: K): Promise<StoreMeta[K] | undefined>
  setMeta<K extends keyof StoreMeta>(key: K, value: StoreMeta[K]): Promise<void>
  /**
   * 接続が閉じられた（版を上げる別タブが開いた・予期せず切断された等）ときに呼ばれる。
   * 戻り値は購読解除の関数。メモリ版は呼ばれない（登録だけ受けて何もしない）。
   * 画面側の扱い（「開き直してください」の帯）は親 plan C6 で作る。ここでは通知するだけ。
   */
  onClose(listener: () => void): () => void
}

const FURIGANA_MODES: FuriganaMode[] = ['all', 'unlearned', 'none']
const DISPLAY_MODES: DisplayMode[] = ['child', 'adult']
const WRITE_MODES: WriteMode[] = ['auto', 'screen', 'paper']

/** YYYY-MM-DD の形で、かつ実在する日付か（2026-02-30・うるう年でない年の 02-29 等をはじく） */
function isValidDateStr(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/**
 * ISO 8601 の日時（例: 2026-01-01T00:00:00.000Z）の形をしていて、かつ Date.parse が
 * NaN にならないか（2026-09-23 レビュー should 1: createdAt/updatedAt が文字列でさえあれば
 * 通していたのを、'' や 'abc' のような壊れた値もはじくようにする）。
 */
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/
function isValidIsoTimestamp(value: string): boolean {
  return ISO_TIMESTAMP_RE.test(value) && !Number.isNaN(Date.parse(value))
}

/**
 * BCP 47 の言語コードを正規化する（大文字小文字・スクリプト表記のゆれを吸収。例: JA → ja、
 * zh-hans → zh-Hans）。形式が不正で正規化できない値は null（呼び出し側で既定値にする）。
 */
function canonicalLang(value: string): string | null {
  try {
    const [canonical] = Intl.getCanonicalLocales(value)
    return canonical ?? null
  } catch {
    return null
  }
}

/**
 * ニックネームの文字数を数える。絵文字（サロゲートペア）等を 1 文字として数えるため、
 * string.length（UTF-16 のコード単位数）ではなく Array.from（コードポイント単位）を使う。
 * 学習者の追加・編集の画面（親 plan C8）でも同じ数え方をするために export する。
 */
export function nicknameLength(nickname: string): number {
  return Array.from(nickname).length
}

/** 前後の空白を除いて 1〜20 文字か（nicknameLength と同じコードポイント単位で数える） */
export function isValidNickname(nickname: string): boolean {
  const length = nicknameLength(nickname.trim())
  return length >= 1 && length <= 20
}

/**
 * 未知のデータ（IndexedDB から読んだ値・後方互換のない古い版のデータ等）を LearnerProfile に直す。
 * 知らない項目は捨てる。列挙の値が不正なら既定値にする。id が空、または nickname が前後の空白を
 * 除いて 0 文字か 21 文字以上なら null を返す（親 plan D-5・子 plan「作業内容」3）。
 * createdAt / updatedAt が ISO 8601 の日時の形でない、または Date.parse できないレコードも
 * null にする（2026-09-23 レビュー should 4・再レビュー should 1。「無ければ今の時刻で埋める」の
 * ではなく、壊れたレコードごと弾く。createStore の listProfiles / getProfile がここを読み出しの
 * フィルタとしても使う）。
 */
export function normalizeProfile(raw: unknown): LearnerProfile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>

  const id = typeof r.id === 'string' ? r.id : ''
  if (id.length === 0) return null

  const nickname = typeof r.nickname === 'string' ? r.nickname.trim() : ''
  if (!isValidNickname(nickname)) return null

  if (
    typeof r.createdAt !== 'string' ||
    typeof r.updatedAt !== 'string' ||
    !isValidIsoTimestamp(r.createdAt) ||
    !isValidIsoTimestamp(r.updatedAt)
  ) {
    return null
  }
  const createdAt = r.createdAt
  const updatedAt = r.updatedAt

  const level = isLevel(r.level) ? r.level : '10'
  const furigana: FuriganaMode = FURIGANA_MODES.includes(r.furigana as FuriganaMode)
    ? (r.furigana as FuriganaMode)
    : 'all'
  const display: DisplayMode = DISPLAY_MODES.includes(r.display as DisplayMode)
    ? (r.display as DisplayMode)
    : 'child'
  const writeMode: WriteMode = WRITE_MODES.includes(r.writeMode as WriteMode)
    ? (r.writeMode as WriteMode)
    : 'auto'
  const dailyGoal = (DAILY_GOALS as readonly number[]).includes(r.dailyGoal as number)
    ? (r.dailyGoal as LearnerProfile['dailyGoal'])
    : 10
  const color = (PROFILE_COLORS as readonly string[]).includes(r.color as string)
    ? (r.color as LearnerProfile['color'])
    : PROFILE_COLORS[0]
  const kanaKeyboard = typeof r.kanaKeyboard === 'boolean' ? r.kanaKeyboard : false
  const lang = typeof r.lang === 'string' ? (canonicalLang(r.lang) ?? 'ja') : 'ja'
  const examDate = typeof r.examDate === 'string' && isValidDateStr(r.examDate) ? r.examDate : null

  return {
    id,
    nickname,
    color,
    level,
    lang,
    furigana,
    display,
    kanaKeyboard,
    dailyGoal,
    examDate,
    writeMode,
    createdAt,
    updatedAt,
  }
}

/** 学習者の追加・編集の入力（不足分は normalizeProfile の既定値で埋まる） */
export type NewProfileInput = Pick<LearnerProfile, 'nickname'> &
  Partial<Omit<LearnerProfile, 'id' | 'nickname' | 'createdAt' | 'updatedAt'>>

/**
 * 既定値で埋めた LearnerProfile を作る。createdAt と updatedAt は now。
 * id は呼ぶ側が crypto.randomUUID() で作って渡す（テストで固定値を渡せるように）。
 */
export function newProfile(input: NewProfileInput, now: string, id: string): LearnerProfile {
  const profile = normalizeProfile({ ...input, id, createdAt: now, updatedAt: now })
  if (!profile) {
    // nickname が不正な場合だけここに来る（他は既定値で埋まるため）。
    throw new Error('newProfile: nickname が不正です（1〜20 文字にしてください）')
  }
  return profile
}

/**
 * 学習者データの素の読み書きだけを行う backend。検証・並べ替え・lastProfileId の付随処理・
 * 読み出したレコードの normalizeProfile は持たない（それらは createStore が共通で行う。
 * 2026-09-23 レビュー must 1: IndexedDB 版とメモリ版に同じロジックの写しを持たせない）。
 */
export interface ProfileBackend {
  readonly volatile: boolean
  getAllProfiles(): Promise<unknown[]>
  getProfile(id: string): Promise<unknown>
  putProfile(profile: LearnerProfile): Promise<void>
  deleteProfile(id: string): Promise<void>
  getMetaRaw(key: string): Promise<unknown>
  setMetaRaw(key: string, value: unknown): Promise<void>
  deleteMetaRaw(key: string): Promise<void>
  /** 接続が閉じられたときに呼ぶための購読。IndexedDB 版だけが実際に呼ぶ。メモリ版は登録だけ受けて何もしない */
  onClose(listener: () => void): () => void
}

/**
 * backend の上に乗る共通の層。検証・並べ替え・lastProfileId の付随処理・読み出したレコードの
 * normalizeProfile は、IndexedDB 版・メモリ版のどちらでもここで 1 回だけ行う。
 */
export function createStore(backend: ProfileBackend): KanjiStore {
  return {
    volatile: backend.volatile,
    async listProfiles() {
      const raw = await backend.getAllProfiles()
      const profiles = raw.map((r) => normalizeProfile(r)).filter((p): p is LearnerProfile => p !== null)
      // localeCompare は実行環境のロケールに依存しうるため使わず、ISO 8601 文字列を単純比較する
      return profiles.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    },
    async getProfile(id) {
      const raw = await backend.getProfile(id)
      if (raw === undefined) return undefined
      return normalizeProfile(raw) ?? undefined
    },
    async saveProfile(profile) {
      const normalized = normalizeProfile(profile)
      if (!normalized) throw new Error('saveProfile: 不正な学習者データです')
      await backend.putProfile(normalized)
    },
    async deleteProfile(id) {
      await backend.deleteProfile(id)
      // should 5（2026-09-23 レビュー・直さずコメントで済ませる）: 学習者本体と lastProfileId の
      // 削除は別々の書き込みで、1 つの操作にまとまっていない。片方だけ失敗すると、学習者は
      // 消えたのに lastProfileId が古いまま残ることがありうる。ただし C5 の pickInitialCurrent は
      // 「lastProfileId の学習者が一覧にいなければ使わない」設計（起動時に一覧と突き合わせて
      // 無視するだけ）なので、ずれても実害は無い。
      const lastProfileId = await backend.getMetaRaw('lastProfileId')
      if (lastProfileId === id) {
        await backend.deleteMetaRaw('lastProfileId')
      }
    },
    async getMeta<K extends keyof StoreMeta>(key: K) {
      return (await backend.getMetaRaw(key)) as StoreMeta[K] | undefined
    },
    async setMeta<K extends keyof StoreMeta>(key: K, value: StoreMeta[K]) {
      await backend.setMetaRaw(key, value)
    },
    onClose(listener) {
      return backend.onClose(listener)
    },
  }
}

/**
 * メモリだけに持つ backend。テストと、IndexedDB が使えないときの逃げ先に使う。
 * 保存・読み出しのときに structuredClone で写しを渡す（2026-09-23 レビュー should 6:
 * ブラウザの IndexedDB は構造化複製で値をやり取りするため、同じ挙動に合わせる）。
 */
export function createMemoryBackend(options?: { volatile?: boolean }): ProfileBackend {
  const profiles = new Map<string, unknown>()
  const meta = new Map<string, unknown>()

  return {
    volatile: options?.volatile ?? false,
    async getAllProfiles() {
      return Array.from(profiles.values()).map((p) => structuredClone(p))
    },
    async getProfile(id) {
      const value = profiles.get(id)
      return value === undefined ? undefined : structuredClone(value)
    },
    async putProfile(profile) {
      profiles.set(profile.id, structuredClone(profile))
    },
    async deleteProfile(id) {
      profiles.delete(id)
    },
    async getMetaRaw(key) {
      const value = meta.get(key)
      return value === undefined ? undefined : structuredClone(value)
    },
    async setMetaRaw(key, value) {
      meta.set(key, structuredClone(value))
    },
    async deleteMetaRaw(key) {
      meta.delete(key)
    },
    // メモリ版の接続が閉じられることはないので、登録だけ受けて何もしない（呼ばない）
    onClose(_listener) {
      return () => {}
    },
  }
}

/** メモリだけに持つ実装。テストと、IndexedDB が使えないときの逃げ先に使う */
export function createMemoryStore(options?: { volatile?: boolean }): KanjiStore {
  return createStore(createMemoryBackend(options))
}

const DB_NAME = 'manabi-map-kanji'
const DB_VERSION = 1
const STORE_PROFILES = 'profiles'
const STORE_META = 'meta'

function wrapReadRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/**
 * IndexedDB 版の backend。保存と読み出し以外のロジックは持たせない（値の検証・並べ替え・
 * lastProfileId の付随処理は createStore 任せ）。
 * 書き込みはリクエストの成功ではなく、トランザクションの完了（tx.oncomplete）を待って resolve する
 * （2026-09-23 レビュー must 2: リクエストの成功はディスクへ書き終わったことを意味しない）。
 */
function createIndexedDbBackend(db: IDBDatabase): ProfileBackend {
  const closeListeners = new Set<() => void>()
  function notifyClose() {
    for (const listener of closeListeners) listener()
  }
  // 版を上げる別タブが開く等で古い接続を持ち続けないよう、閉じてよいときは閉じる。
  // 閉じた後にこのタブが読み書きを続けると全部失敗するので、購読者へ知らせる
  // （2026-09-23 再レビュー should 3。画面側の「開き直してください」帯は親 plan C6 で作る）。
  db.onversionchange = () => {
    db.close()
    notifyClose()
  }
  // 予期せず切断された場合（ブラウザのストレージ整理等）も同様に知らせる
  db.onclose = () => {
    notifyClose()
  }

  function readStore(name: string) {
    return db.transaction(name, 'readonly').objectStore(name)
  }

  function writeThrough(storeName: string, run: (store: IDBObjectStore) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite')
      run(tx.objectStore(storeName))
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction error'))
    })
  }

  return {
    volatile: false,
    async getAllProfiles() {
      return wrapReadRequest<unknown[]>(readStore(STORE_PROFILES).getAll())
    },
    async getProfile(id) {
      return wrapReadRequest<unknown>(readStore(STORE_PROFILES).get(id))
    },
    async putProfile(profile) {
      await writeThrough(STORE_PROFILES, (store) => store.put(profile))
    },
    async deleteProfile(id) {
      await writeThrough(STORE_PROFILES, (store) => store.delete(id))
    },
    async getMetaRaw(key) {
      return wrapReadRequest<unknown>(readStore(STORE_META).get(key))
    },
    async setMetaRaw(key, value) {
      await writeThrough(STORE_META, (store) => store.put(value, key))
    },
    async deleteMetaRaw(key) {
      await writeThrough(STORE_META, (store) => store.delete(key))
    },
    onClose(listener) {
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
  }
}

/** indexedDB.open は仕様上 throw しうる（プライベートブラウズの一部の実装等）ので try で包む */
function tryOpenIndexedDb(): IDBOpenDBRequest | null {
  try {
    return indexedDB.open(DB_NAME, DB_VERSION)
  } catch {
    return null
  }
}

const OPEN_TIMEOUT_MS = 5000

/**
 * IndexedDB を開く。開けない（例外・onerror・onblocked・IndexedDB が無い・5 秒たっても開けない）
 * ときは volatile なメモリ保存を返す（親 plan D-4 の既知のリスク。iOS Safari 等で保存領域が
 * 使えない・消される場合の逃げ先。書き出し・読み込みは親 plan C7 で足す）。
 * 2026-09-23 レビュー should 3: 関数全体を try で包み、5 秒のタイムアウトでメモリへ逃げた後に
 * 実際の接続が開けたら、使わずに閉じる（つなぎっぱなしを防ぐ）。版上げが始まったらタイムアウトは
 * 止める（再レビュー should 2）。開けた接続の onversionchange・onclose・KanjiStore.onClose の
 * 配線は createIndexedDbBackend の中で行う（再レビュー should 3）。
 */
export function openKanjiStore(): Promise<KanjiStore> {
  try {
    if (typeof indexedDB === 'undefined') {
      return Promise.resolve(createStore(createMemoryBackend({ volatile: true })))
    }

    return new Promise((resolve) => {
      let settled = false
      const fallbackToMemory = () => {
        if (settled) return
        settled = true
        resolve(createStore(createMemoryBackend({ volatile: true })))
      }
      const timeoutId = setTimeout(fallbackToMemory, OPEN_TIMEOUT_MS)

      const request = tryOpenIndexedDb()
      if (!request) {
        clearTimeout(timeoutId)
        fallbackToMemory()
        return
      }

      request.onupgradeneeded = (event) => {
        // 版上げが始まったら 5 秒のタイムアウトは止める（2026-09-23 再レビュー should 2:
        // 版上げが長引いても、進行中の upgrade トランザクションを見捨ててメモリの保存へ
        // 逃げてしまわないようにする）。
        clearTimeout(timeoutId)
        const db = request.result
        if (event.oldVersion < 1) {
          db.createObjectStore(STORE_PROFILES, { keyPath: 'id' })
          db.createObjectStore(STORE_META)
        }
        // 後の C で版を上げるときは、ここに `if (event.oldVersion < 2) { ... }` を足していく
      }
      request.onsuccess = () => {
        clearTimeout(timeoutId)
        const db = request.result
        if (settled) {
          // タイムアウトで先にメモリへ逃げた後に開けた場合は、この接続は使わず閉じる
          // （onversionchange 等の配線は createIndexedDbBackend の中で行うので、ここでは呼ばない）
          db.close()
          return
        }
        settled = true
        resolve(createStore(createIndexedDbBackend(db)))
      }
      request.onerror = () => {
        clearTimeout(timeoutId)
        fallbackToMemory()
      }
      request.onblocked = () => {
        clearTimeout(timeoutId)
        fallbackToMemory()
      }
    })
  } catch {
    return Promise.resolve(createStore(createMemoryBackend({ volatile: true })))
  }
}

/**
 * navigator.storage.persist() を 1 回だけ試し、persistRequested と persisted を meta に残す。
 * 2 回目以降は persist() を呼ばずに記録済みの値を返す。API が無い環境、または persist() が
 * 失敗（reject）した場合も例外を外へ出さず false を返す。storage を渡すとテストで差し替えられる
 * （省略時は platform/browser.ts の requestPersistentStorage を使う。子 plan C10 N4: OS / ブラウザ
 * との境界を薄い層に寄せる対象に navigator.storage.persist() も含まれるため）。
 */
export async function requestPersistence(
  store: KanjiStore,
  storage?: { persist: () => Promise<boolean> },
): Promise<boolean> {
  const alreadyRequested = (await store.getMeta('persistRequested')) ?? false
  if (alreadyRequested) {
    return (await store.getMeta('persisted')) ?? false
  }

  let persisted = false
  if (storage) {
    try {
      persisted = await storage.persist()
    } catch {
      persisted = false
    }
  } else {
    persisted = await requestPersistentStorage()
  }

  await store.setMeta('persistRequested', true)
  await store.setMeta('persisted', persisted)
  return persisted
}
