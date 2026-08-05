import { describe, expect, it } from 'vitest'

import { isValidHomeLocation, parseStoredHome } from './AppContext'

describe('stored home validation', () => {
  it('accepts a finite synthetic location', () => {
    const home = { label: '合成地点', lat: 35.6812, lng: 139.7671 }
    expect(isValidHomeLocation(home)).toBe(true)
    expect(parseStoredHome(JSON.stringify(home))).toEqual(home)
  })

  it('rejects malformed, non-finite, and incomplete values', () => {
    expect(parseStoredHome('{not-json')).toBeNull()
    expect(parseStoredHome(JSON.stringify({ label: '合成地点', lat: '35', lng: 139 }))).toBeNull()
    expect(parseStoredHome(JSON.stringify({ label: '合成地点', lat: null, lng: 139 }))).toBeNull()
    expect(parseStoredHome(JSON.stringify({ label: '合成地点', lat: 35, lng: 139, extra: true }))).toEqual({
      label: '合成地点', lat: 35, lng: 139, extra: true,
    })
    expect(isValidHomeLocation({ label: '合成地点', lat: Infinity, lng: 139 })).toBe(false)
  })
})
