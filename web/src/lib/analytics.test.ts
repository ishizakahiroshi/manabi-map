import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANALYTICS_SESSION_STORAGE_KEY, getAnalyticsSessionId } from './analytics'

/** AppContext.test.ts と同じ形の localStorage 差し替え（Map 1 本で実体を持つ） */
function stubStorage(initial: [string, string][] = []): Map<string, string> {
  const store = new Map<string, string>(initial)
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
  })
  return store
}

describe('分析用セッション ID', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('キーは cookie ではなく localStorage の mm_session_id', () => {
    expect(ANALYTICS_SESSION_STORAGE_KEY).toBe('mm_session_id')
  })

  it('保存済みの ID をそのまま使う（同じ利用者の中では変えない）', () => {
    stubStorage([[ANALYTICS_SESSION_STORAGE_KEY, '00000000-0000-4000-8000-000000000001']])
    expect(getAnalyticsSessionId()).toBe('00000000-0000-4000-8000-000000000001')
    expect(getAnalyticsSessionId()).toBe('00000000-0000-4000-8000-000000000001')
  })

  it('未発行なら発行して保存する（events.session_id の 64 文字制約に収まる）', () => {
    const store = stubStorage()
    const id = getAnalyticsSessionId()
    expect(id.length).toBeGreaterThan(0)
    expect(id.length).toBeLessThanOrEqual(64)
    expect(store.get(ANALYTICS_SESSION_STORAGE_KEY)).toBe(id)
  })

  it('サインアウトでキーが消えた後は別の ID を発行する', () => {
    const store = stubStorage()
    const before = getAnalyticsSessionId()

    // サインアウト時の掃除（contexts/AppContext.tsx の clearSignedOutDeviceState）と同じ操作
    store.delete(ANALYTICS_SESSION_STORAGE_KEY)

    const after = getAnalyticsSessionId()
    expect(after).not.toBe(before)
    expect(store.get(ANALYTICS_SESSION_STORAGE_KEY)).toBe(after)
  })

  it('localStorage が使えない環境でも投げずに no-storage を返す', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('storage disabled') },
    })
    expect(getAnalyticsSessionId()).toBe('no-storage')
  })
})
