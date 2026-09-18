import { describe, it, expect } from 'vitest'
import {
  MAINTENANCE_REFETCH_MIN_INTERVAL_MS,
  isMaintenanceChannelBroken,
  isMaintenanceChannelLive,
  readMaintenanceOn,
  shouldRefetchForChannelStatus,
  shouldRefetchNow,
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

describe('購読状態の判定', () => {
  it('SUBSCRIBED だけが生きている状態', () => {
    expect(isMaintenanceChannelLive('SUBSCRIBED')).toBe(true)
    expect(isMaintenanceChannelLive('CHANNEL_ERROR')).toBe(false)
  })
  it('切断・失敗の 3 状態を切れたと見なす', () => {
    expect(isMaintenanceChannelBroken('CHANNEL_ERROR')).toBe(true)
    expect(isMaintenanceChannelBroken('TIMED_OUT')).toBe(true)
    expect(isMaintenanceChannelBroken('CLOSED')).toBe(true)
    expect(isMaintenanceChannelBroken('SUBSCRIBED')).toBe(false)
  })
  it('成立時と切断時のどちらでも読み直す', () => {
    expect(shouldRefetchForChannelStatus('SUBSCRIBED')).toBe(true)
    expect(shouldRefetchForChannelStatus('TIMED_OUT')).toBe(true)
    expect(shouldRefetchForChannelStatus('UNKNOWN_STATE')).toBe(false)
  })
})

describe('shouldRefetchNow', () => {
  it('まだ一度も読んでいなければ読む', () => {
    expect(shouldRefetchNow(null, 1_000)).toBe(true)
  })
  it('最小間隔に満たない再試行は読まない（常時ポーリングにしない）', () => {
    expect(shouldRefetchNow(1_000, 1_000 + MAINTENANCE_REFETCH_MIN_INTERVAL_MS - 1)).toBe(false)
  })
  it('最小間隔を過ぎていれば読む', () => {
    expect(shouldRefetchNow(1_000, 1_000 + MAINTENANCE_REFETCH_MIN_INTERVAL_MS)).toBe(true)
  })
})
