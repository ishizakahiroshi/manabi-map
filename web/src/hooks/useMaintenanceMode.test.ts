import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

type ReadResponse = { data: { value: unknown } | null; error: { message: string } | null }
type ProviderValue = {
  dbOn: boolean
  loading: boolean
  lastReadFailed: boolean
  applyDbOn: (on: boolean) => void
}

const mocks = vi.hoisted(() => {
  // useState / useEffect だけを差し替える最小の描画器。
  // 初回 render と effect の実行を分け、SSR（effect が走らない）と hydration 後を別々に確かめる。
  const states = new Map<number, unknown>()
  const mountedEffects = new Set<number>()
  let pendingEffects: Array<() => void | (() => void)> = []
  let cleanups: Array<() => void> = []
  let cursor = 0
  let target: (() => unknown) | null = null
  let result: unknown

  const renderNow = () => {
    if (!target) return
    cursor = 0
    result = target()
  }

  const react = {
    useState<T>(initial: T) {
      const index = cursor++
      if (!states.has(index)) states.set(index, initial)
      const setState = (next: T) => {
        states.set(index, next)
        renderNow()
      }
      return [states.get(index) as T, setState] as const
    },
    useEffect(effect: () => void | (() => void)) {
      const index = cursor++
      if (mountedEffects.has(index)) return
      mountedEffects.add(index)
      pendingEffects.push(effect)
    },
  }

  const harness = {
    render(next: () => unknown) {
      target = next
      renderNow()
    },
    runEffects() {
      const effects = pendingEffects
      pendingEffects = []
      for (const effect of effects) {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup)
      }
    },
    unmount() {
      for (const cleanup of cleanups) cleanup()
      cleanups = []
      target = null
    },
    result<T>() {
      return result as T
    },
    reset() {
      states.clear()
      mountedEffects.clear()
      pendingEffects = []
      cleanups = []
      cursor = 0
      target = null
      result = undefined
    },
  }

  const supabase = {
    from: vi.fn(),
    channel: vi.fn(),
    removeChannel: vi.fn(),
  }

  return { react, harness, supabase }
})

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: mocks.react.useState,
  useEffect: mocks.react.useEffect,
}))
vi.mock('../lib/supabase', () => ({ supabase: mocks.supabase }))

import { MaintenanceProvider } from './useMaintenanceMode'
import { MAINTENANCE_REFETCH_INTERVAL_MS } from '../lib/maintenance'

describe('MaintenanceProvider', () => {
  let answers: Array<(response: ReadResponse) => void>
  let fakeDocument: EventTarget & { visibilityState: DocumentVisibilityState }
  let fakeWindow: EventTarget

  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  }
  const answer = async (response: ReadResponse) => {
    answers.shift()?.(response)
    await settle()
  }
  const value = () => mocks.harness.result<ReactElement<{ value: ProviderValue }>>().props.value
  const mount = () => mocks.harness.render(() => MaintenanceProvider({ children: null }))

  beforeEach(() => {
    vi.useFakeTimers()
    answers = []
    fakeDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState })
    fakeWindow = new EventTarget()
    vi.stubGlobal('document', fakeDocument)
    vi.stubGlobal('window', fakeWindow)
    mocks.supabase.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          single: () => new Promise<ReadResponse>((resolve) => answers.push(resolve)),
        }),
      }),
    }))
  })

  afterEach(() => {
    mocks.harness.unmount()
    mocks.harness.reset()
    mocks.supabase.from.mockReset()
    mocks.supabase.channel.mockReset()
    mocks.supabase.removeChannel.mockReset()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('初回 render は SSR と同じ既定値で、読み込みは effect まで始めない', () => {
    mount()
    expect(value()).toMatchObject({ dbOn: false, loading: true, lastReadFailed: false })
    expect(mocks.supabase.from).not.toHaveBeenCalled()
  })

  it('realtime の購読を張らず、app_config の読み直しで切替を拾う', async () => {
    mount()
    mocks.harness.runEffects()
    expect(mocks.supabase.from).toHaveBeenCalledTimes(1)
    expect(mocks.supabase.from).toHaveBeenCalledWith('app_config')
    await answer({ data: { value: { on: true } }, error: null })
    expect(value()).toMatchObject({ dbOn: true, loading: false, lastReadFailed: false })

    // 5 分後の読み直しに失敗したら、直前に読めた値（ON）を保ったまま失敗を知らせる。
    // 保守中に 1 回失敗しただけで書込ブロックが外れないこと。
    vi.advanceTimersByTime(MAINTENANCE_REFETCH_INTERVAL_MS)
    expect(mocks.supabase.from).toHaveBeenCalledTimes(2)
    await answer({ data: null, error: { message: 'synthetic error' } })
    expect(value()).toMatchObject({ dbOn: true, loading: false, lastReadFailed: true })

    // 回線が戻って読めたら、失敗の表示を下ろす。
    fakeWindow.dispatchEvent(new Event('online'))
    expect(mocks.supabase.from).toHaveBeenCalledTimes(3)
    await answer({ data: { value: { on: false } }, error: null })
    expect(value()).toMatchObject({ dbOn: false, loading: false, lastReadFailed: false })

    expect(mocks.supabase.channel).not.toHaveBeenCalled()
    expect(mocks.supabase.removeChannel).not.toHaveBeenCalled()
  })

  it('最初の読み込みに失敗したら OFF のまま閲覧を止めず、失敗を知らせる', async () => {
    mount()
    mocks.harness.runEffects()
    await answer({ data: null, error: { message: 'synthetic error' } })
    expect(value()).toMatchObject({ dbOn: false, loading: false, lastReadFailed: true })
  })

  it('管理画面で切り替えた結果は、読み直しを待たずにこのタブへ入る', async () => {
    mount()
    mocks.harness.runEffects()
    await answer({ data: { value: { on: false } }, error: null })
    value().applyDbOn(true)
    expect(value()).toMatchObject({ dbOn: true, loading: false, lastReadFailed: false })
    expect(mocks.supabase.from).toHaveBeenCalledTimes(1)
  })

  it('外した後は、画面復帰・回線復帰・間隔のどれでも読まない', async () => {
    mount()
    mocks.harness.runEffects()
    await answer({ data: { value: { on: false } }, error: null })
    mocks.harness.unmount()

    fakeDocument.dispatchEvent(new Event('visibilitychange'))
    fakeWindow.dispatchEvent(new Event('online'))
    vi.advanceTimersByTime(MAINTENANCE_REFETCH_INTERVAL_MS * 3)
    expect(mocks.supabase.from).toHaveBeenCalledTimes(1)
  })
})
