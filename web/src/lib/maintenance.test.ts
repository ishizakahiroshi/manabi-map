import { afterEach, beforeEach, describe, it, expect, vi, type Mock } from 'vitest'
import {
  MAINTENANCE_REFETCH_INTERVAL_MS,
  readMaintenanceOn,
  watchMaintenanceFlag,
  type MaintenanceReadResult,
} from './maintenance'

describe('readMaintenanceOn', () => {
  it('on=true のときだけ ON', () => {
    expect(readMaintenanceOn({ on: true })).toBe(true)
    expect(readMaintenanceOn({ on: false })).toBe(false)
    expect(readMaintenanceOn({ on: 'true' })).toBe(false)
  })
  it('形が違う値は OFF に倒す', () => {
    expect(readMaintenanceOn(null)).toBe(false)
    expect(readMaintenanceOn(undefined)).toBe(false)
    expect(readMaintenanceOn('on')).toBe(false)
    expect(readMaintenanceOn({})).toBe(false)
  })
})

describe('watchMaintenanceFlag', () => {
  // 読み込み 1 回ごとに、テスト側で成功・失敗を決められるようにする。
  type Pending = { resolve: (on: boolean) => void; reject: (error: unknown) => void }
  let pending: Pending[]
  let results: MaintenanceReadResult[]
  let visible: boolean
  let doc: EventTarget
  let win: EventTarget
  let fetchOn: Mock<() => Promise<boolean>>

  // fetchOn → onRead の間の await を流し切る。
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  }
  const answer = async (on: boolean) => {
    pending.shift()?.resolve(on)
    await settle()
  }
  const fail = async () => {
    pending.shift()?.reject(new Error('synthetic network error'))
    await settle()
  }
  const setVisible = (next: boolean) => {
    visible = next
    doc.dispatchEvent(new Event('visibilitychange'))
  }
  const start = () =>
    watchMaintenanceFlag({
      fetchOn,
      onRead: (result) => results.push(result),
      isVisible: () => visible,
      doc,
      win,
    })

  beforeEach(() => {
    vi.useFakeTimers()
    pending = []
    results = []
    visible = true
    doc = new EventTarget()
    win = new EventTarget()
    fetchOn = vi.fn(
      () => new Promise<boolean>((resolve, reject) => pending.push({ resolve, reject })),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('始めた時点で 1 回だけ読む', async () => {
    start()
    expect(fetchOn).toHaveBeenCalledTimes(1)
    await answer(true)
    expect(results).toEqual([{ on: true, failed: false }])
  })

  it('見えているタブでは、読み終えてから 5 分ごとに読み直す', async () => {
    start()
    await answer(false)
    vi.advanceTimersByTime(MAINTENANCE_REFETCH_INTERVAL_MS - 1)
    expect(fetchOn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(fetchOn).toHaveBeenCalledTimes(2)
    await answer(true)
    vi.advanceTimersByTime(MAINTENANCE_REFETCH_INTERVAL_MS)
    expect(fetchOn).toHaveBeenCalledTimes(3)
    expect(results).toEqual([
      { on: false, failed: false },
      { on: true, failed: false },
    ])
  })

  it('見えていない間はタイマーで読まず、見えた時点で読む', async () => {
    visible = false
    start()
    await answer(false)
    vi.advanceTimersByTime(MAINTENANCE_REFETCH_INTERVAL_MS * 3)
    expect(fetchOn).toHaveBeenCalledTimes(1)

    setVisible(true)
    expect(fetchOn).toHaveBeenCalledTimes(2)
    await answer(true)
    // 見えてからは間隔の読み直しが再開する。
    vi.advanceTimersByTime(MAINTENANCE_REFETCH_INTERVAL_MS)
    expect(fetchOn).toHaveBeenCalledTimes(3)
  })

  it('見えなくなったら、予約していた読み直しを取り消す', async () => {
    start()
    await answer(false)
    vi.advanceTimersByTime(60_000)
    setVisible(false)
    vi.advanceTimersByTime(MAINTENANCE_REFETCH_INTERVAL_MS * 3)
    expect(fetchOn).toHaveBeenCalledTimes(1)
  })

  it('きっかけで読んだら、次の間隔はそこから数え直す', async () => {
    start()
    await answer(false)
    vi.advanceTimersByTime(4 * 60_000)
    setVisible(true)
    expect(fetchOn).toHaveBeenCalledTimes(2)
    await answer(false)
    // 最初の読み込みから 5 分の時点では読まない（直前に読んだばかり）。
    vi.advanceTimersByTime(60_000)
    expect(fetchOn).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(MAINTENANCE_REFETCH_INTERVAL_MS - 60_000)
    expect(fetchOn).toHaveBeenCalledTimes(3)
  })

  it('回線が戻ったら読み直す。見えていないタブでは読まない', async () => {
    start()
    await answer(false)
    win.dispatchEvent(new Event('online'))
    expect(fetchOn).toHaveBeenCalledTimes(2)
    await answer(true)

    visible = false
    win.dispatchEvent(new Event('online'))
    expect(fetchOn).toHaveBeenCalledTimes(2)
  })

  it('読み込み中に来たきっかけでは重ねて読まない', async () => {
    start()
    setVisible(true)
    win.dispatchEvent(new Event('online'))
    expect(fetchOn).toHaveBeenCalledTimes(1)
    await answer(false)

    // 読み終わった後のきっかけでは読む。
    win.dispatchEvent(new Event('online'))
    expect(fetchOn).toHaveBeenCalledTimes(2)
  })

  it('読めなかったときは値を渡さず failed を立て、次に読めたら下ろす', async () => {
    start()
    await answer(true)
    vi.advanceTimersByTime(MAINTENANCE_REFETCH_INTERVAL_MS)
    await fail()
    expect(results.at(-1)).toEqual({ failed: true })

    // 失敗した後も間隔の読み直しは続く。
    vi.advanceTimersByTime(MAINTENANCE_REFETCH_INTERVAL_MS)
    expect(fetchOn).toHaveBeenCalledTimes(3)
    await answer(true)
    expect(results).toEqual([
      { on: true, failed: false },
      { failed: true },
      { on: true, failed: false },
    ])
  })

  it('止めた後は読まず、読み込み中だった結果も渡さない', async () => {
    const stop = start()
    stop()
    await answer(true)
    expect(results).toEqual([])

    setVisible(true)
    win.dispatchEvent(new Event('online'))
    vi.advanceTimersByTime(MAINTENANCE_REFETCH_INTERVAL_MS * 3)
    expect(fetchOn).toHaveBeenCalledTimes(1)
  })
})
