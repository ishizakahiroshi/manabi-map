import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  SIGNED_OUT_CLEARED_KEYS,
  clearSignedOutDeviceState,
  formatHomeCoordinates,
  isValidHomeLocation,
  normalizeHomeForPersistence,
  parseStoredHome,
} from './AppContext'
import { getAnalyticsSessionId } from '../lib/analytics'

describe('stored home validation', () => {
  it('accepts a finite synthetic location', () => {
    const home = { label: '合成地点', lat: 35.6812, lng: 139.7671 }
    expect(isValidHomeLocation(home)).toBe(true)
    expect(parseStoredHome(JSON.stringify(home))).toEqual({
      label: '設定地点', lat: 35.681, lng: 139.767,
    })
  })

  it('rejects malformed, non-finite, and incomplete values', () => {
    expect(parseStoredHome('{not-json')).toBeNull()
    expect(parseStoredHome(JSON.stringify({ label: '合成地点', lat: '35', lng: 139 }))).toBeNull()
    expect(parseStoredHome(JSON.stringify({ label: '合成地点', lat: null, lng: 139 }))).toBeNull()
    expect(parseStoredHome(JSON.stringify({ label: '合成地点', lat: 35, lng: 139, extra: true }))).toEqual({
      label: '設定地点', lat: 35, lng: 139,
    })
    expect(isValidHomeLocation({ label: '合成地点', lat: Infinity, lng: 139 })).toBe(false)
    expect(isValidHomeLocation({ label: '合成地点', lat: 90.001, lng: 139 })).toBe(false)
    expect(isValidHomeLocation({ label: '合成地点', lat: 35, lng: -180.001 })).toBe(false)
  })

  it('formats valid coordinates to three decimal places', () => {
    expect(formatHomeCoordinates({ label: '合成地点', lat: 35.68123, lng: 139.76789 })).toEqual({
      lat: '35.681',
      lng: '139.768',
    })
  })

  it('does not format invalid coordinates', () => {
    expect(formatHomeCoordinates({ label: '合成地点', lat: NaN, lng: 139 })).toBeNull()
  })

  it('removes a raw address and rounds persisted coordinates to three decimals', () => {
    expect(normalizeHomeForPersistence({
      label: '東京都千代田区丸の内1-1',
      lat: 35.6812345,
      lng: 139.7678912,
    })).toEqual({
      label: '設定地点',
      lat: 35.681,
      lng: 139.768,
    })
  })

  it('normalizes negative zero and rejects non-finite persistence input', () => {
    expect(normalizeHomeForPersistence({ label: '合成地点', lat: -0.0001, lng: -73.9856 })).toEqual({
      label: '設定地点', lat: 0, lng: -73.986,
    })
    expect(normalizeHomeForPersistence({ label: '合成地点', lat: Infinity, lng: 139 })).toBeNull()
  })
})

describe('sign-out device cleanup', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists the home key, the map zoom key, and the analytics session key', () => {
    expect([...SIGNED_OUT_CLEARED_KEYS]).toEqual(['mm.home', 'mm.map_home_zoom', 'mm_session_id'])
  })

  it('removes the map zoom and analytics session keys as well, and leaves unrelated keys alone', () => {
    const store = new Map<string, string>([
      ['mm.home', JSON.stringify({ label: '設定地点', lat: 35.681, lng: 139.767 })],
      ['mm.map_home_zoom', JSON.stringify({ lat: 35.681, lng: 139.767, zoom: 12 })],
      ['mm_session_id', '00000000-0000-4000-8000-000000000001'],
      ['mm.locale', 'ja'],
    ])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
    })

    clearSignedOutDeviceState()

    expect(store.has('mm.home')).toBe(false)
    expect(store.has('mm.map_home_zoom')).toBe(false)
    expect(store.has('mm_session_id')).toBe(false)
    expect(store.get('mm.locale')).toBe('ja')
  })

  it('makes the next analytics session id differ from the signed-out one', () => {
    const store = new Map<string, string>([
      ['mm_session_id', '00000000-0000-4000-8000-000000000001'],
    ])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
    })

    clearSignedOutDeviceState()
    const next = getAnalyticsSessionId()

    expect(next).not.toBe('00000000-0000-4000-8000-000000000001')
    expect(store.get('mm_session_id')).toBe(next)
  })

  it('does not throw where localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      removeItem: () => { throw new Error('storage disabled') },
    })
    expect(() => clearSignedOutDeviceState()).not.toThrow()
  })
})
