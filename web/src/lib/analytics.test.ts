import { afterEach, describe, expect, it, vi } from 'vitest'

// events.insert / auth.getSession だけを観測する（FamilyJoinPage.test.ts と同じ形）。
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  insert: vi.fn(),
}))

vi.mock('./supabase', () => ({
  supabase: {
    auth: { getSession: mocks.getSession },
    from: vi.fn(() => ({ insert: mocks.insert })),
  },
}))

import { ANALYTICS_SESSION_STORAGE_KEY, captureAdLanding, getAnalyticsSessionId, trackEvent } from './analytics'

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

/** sessionStorage も同じ形で差し替える（captureAdLanding / via 付与のテスト用） */
function stubSessionStorage(initial: [string, string][] = []): Map<string, string> {
  const store = new Map<string, string>(initial)
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
  })
  return store
}

/** sendEvent 内の await（getSession → insert）が終わるまでマイクロタスクを回す（useIsAdmin.test.ts と同じ形） */
async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
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

describe('captureAdLanding（広告経由の着地記録・plan_ads-trial-google-search.md C1）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('utm_source=google & utm_medium=cpc & utm_campaign が mm-trial- で始まる時だけ印を立てる', () => {
    const store = stubSessionStorage()
    captureAdLanding('utm_source=google&utm_medium=cpc&utm_campaign=mm-trial-2026-10')
    expect(store.get('mm_via')).toBe('google-ads')
  })

  it('UTM が無い時は何も書かず、既存の値も消さない', () => {
    const store = stubSessionStorage([['mm_via', 'google-ads']])
    captureAdLanding('')
    expect(store.get('mm_via')).toBe('google-ads')
    expect(store.size).toBe(1)
  })

  it('別の utm_source（自社の広告カード等）では何も書かず、既存の値も消さない', () => {
    const store = stubSessionStorage([['mm_via', 'google-ads']])
    captureAdLanding('utm_source=manabi-map&utm_medium=school-detail&utm_campaign=launch-1.0.0')
    expect(store.get('mm_via')).toBe('google-ads')
  })

  it('utm_campaign が mm-trial- で始まらない時は書かない', () => {
    const store = stubSessionStorage()
    captureAdLanding('utm_source=google&utm_medium=cpc&utm_campaign=other-campaign')
    expect(store.size).toBe(0)
  })

  it('gclid や UTM の値そのものは sessionStorage に保存しない（保存されるのは via の 1 件だけ）', () => {
    const store = stubSessionStorage()
    captureAdLanding('utm_source=google&utm_medium=cpc&utm_campaign=mm-trial-2026-10&gclid=abc123')
    expect(Array.from(store.entries())).toEqual([['mm_via', 'google-ads']])
  })

  it('sessionStorage が例外を投げても投げ返さない', () => {
    vi.stubGlobal('sessionStorage', {
      setItem: () => { throw new Error('storage disabled') },
    })
    expect(() => captureAdLanding('utm_source=google&utm_medium=cpc&utm_campaign=mm-trial-2026-10')).not.toThrow()
  })

  it('location も sessionStorage も無い環境（SSR 相当）でも投げない', () => {
    // search を省略すると location.search を読みに行くが、location を stub していないので
    // ReferenceError になる。captureAdLanding はそれも握りつぶす。
    expect(() => captureAdLanding()).not.toThrow()
  })
})

describe('via: google-ads の props 付与（sendEvent・plan_ads-trial-google-search.md C1）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    mocks.getSession.mockReset()
    mocks.insert.mockReset()
  })

  it('広告経由の印がある時は、trackEvent の呼び出し側を変えずに props へ via を足す', async () => {
    stubStorage()
    stubSessionStorage([['mm_via', 'google-ads']])
    mocks.getSession.mockResolvedValue({ data: { session: null } })
    mocks.insert.mockResolvedValue({ error: null })

    trackEvent('search', { prefecture: 'tokyo' })
    await settle()

    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ props: { prefecture: 'tokyo', via: 'google-ads' } }),
    )
  })

  it('広告経由の印が無い時は via を付けない', async () => {
    stubStorage()
    stubSessionStorage()
    mocks.getSession.mockResolvedValue({ data: { session: null } })
    mocks.insert.mockResolvedValue({ error: null })

    trackEvent('search', { prefecture: 'tokyo' })
    await settle()

    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ props: { prefecture: 'tokyo' } }))
  })

  it('sessionStorage の値が google-ads 以外の時も via を付けない', async () => {
    stubStorage()
    stubSessionStorage([['mm_via', 'something-else']])
    mocks.getSession.mockResolvedValue({ data: { session: null } })
    mocks.insert.mockResolvedValue({ error: null })

    trackEvent('search', {})
    await settle()

    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ props: {} }))
  })

  it('sessionStorage が例外を投げてもイベント送信は止まらず、via も付かない', async () => {
    stubStorage()
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('storage disabled') },
    })
    mocks.getSession.mockResolvedValue({ data: { session: null } })
    mocks.insert.mockResolvedValue({ error: null })

    trackEvent('search', { prefecture: 'tokyo' })
    await settle()

    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ props: { prefecture: 'tokyo' } }))
  })
})
