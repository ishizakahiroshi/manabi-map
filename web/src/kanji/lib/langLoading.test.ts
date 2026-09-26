// langLoading.ts（C6 レビュー should 4）のテスト。

import { describe, expect, it } from 'vitest'
import { loadUiSafely, mergeUiByLang } from './langLoading'

describe('loadUiSafely', () => {
  it('reject する loadUi を渡しても {} が入る', async () => {
    const rejecting = async (): Promise<undefined> => {
      throw new Error('boom')
    }
    await expect(loadUiSafely(rejecting, 'xx')).resolves.toEqual({})
  })

  it('undefined を返す loadUi（パックが無い）は {} になる', async () => {
    await expect(loadUiSafely(async () => undefined, 'xx')).resolves.toEqual({})
  })

  it('読めた ui はそのまま返す', async () => {
    await expect(loadUiSafely(async () => ({ a: 'b' }), 'xx')).resolves.toEqual({ a: 'b' })
  })
})

describe('mergeUiByLang', () => {
  it('無い言語を足す', () => {
    expect(mergeUiByLang({}, 'vi', {})).toEqual({ vi: {} })
  })

  it('すでにある言語は上書きしない（{} で失敗を表している場合も含む）', () => {
    const prev = { vi: {} }
    expect(mergeUiByLang(prev, 'vi', { a: 'b' })).toBe(prev)
  })
})
