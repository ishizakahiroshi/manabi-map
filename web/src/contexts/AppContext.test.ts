import { describe, expect, it } from 'vitest'

import {
  formatHomeCoordinates,
  isValidHomeLocation,
  normalizeHomeForPersistence,
  parseStoredHome,
} from './AppContext'

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
