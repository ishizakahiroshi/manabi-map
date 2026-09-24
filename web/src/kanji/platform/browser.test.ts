// platform/browser.ts のテスト（2026-09-24 C10 レビュー should 2）。
// requestPersistentStorage は lib/store.ts の requestPersistence が storage 引数を省略したときに
// だけ通る本番の経路。store.test.ts の「成功」「失敗」のテストはどちらも storage を明示的に渡すため、
// この経路（実際に navigator.storage.persist() を呼ぶ側）をどのテストも通っていなかった。
// ここでは vi.stubGlobal で navigator / window を差し替え、requestPersistence（storage 省略）と
// getHistoryIndex の実際の経路を確かめる。テストの終わりは vi.unstubAllGlobals() で必ず戻す。
//
// 確かめ方（1 回確認済み・確認後に元へ戻した）: requestPersistentStorage の try/catch を外すと、
// 「persist() が失敗（reject）しても…」のテストが落ちる（reject がそのまま requestPersistence の
// 呼び出し元へ伝わり、await が例外を投げるため）。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryStore, requestPersistence } from '../lib/store'
import { getHistoryIndex } from './browser'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('requestPersistence（storage 省略時。platform/browser.ts の requestPersistentStorage を経由する）', () => {
  it('navigator.storage.persist() が失敗（reject）しても例外を外へ出さず false を返し、meta に persisted: false が残る', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        persist: async () => {
          throw new Error('persist rejected')
        },
      },
    })
    const store = createMemoryStore()

    const result = await requestPersistence(store)

    expect(result).toBe(false)
    expect(await store.getMeta('persistRequested')).toBe(true)
    expect(await store.getMeta('persisted')).toBe(false)
  })

  it('navigator.storage.persist() が true を返せば true を返す', async () => {
    vi.stubGlobal('navigator', { storage: { persist: async () => true } })
    const store = createMemoryStore()

    const result = await requestPersistence(store)

    expect(result).toBe(true)
    expect(await store.getMeta('persistRequested')).toBe(true)
    expect(await store.getMeta('persisted')).toBe(true)
  })
})

describe('getHistoryIndex', () => {
  it('history.state が null なら undefined を返す', () => {
    vi.stubGlobal('window', { history: { state: null } })
    expect(getHistoryIndex()).toBeUndefined()
  })

  it('history.state.idx があればその値を返す', () => {
    vi.stubGlobal('window', { history: { state: { idx: 2 } } })
    expect(getHistoryIndex()).toBe(2)
  })
})
