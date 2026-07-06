import { describe, it, expect } from 'vitest'
import { parsePostal, haversine } from './geo'

describe('parsePostal', () => {
  it('半角ハイフン付き（現行受理）', () => {
    expect(parsePostal('371-0026')?.label).toBe('前橋周辺')
  })
  it('ハイフンなし 7 桁（現行受理）', () => {
    expect(parsePostal('3710026')?.label).toBe('前橋周辺')
  })
  it('先頭 3 桁のみ', () => {
    expect(parsePostal('371')?.label).toBe('前橋周辺')
  })
  it('先頭〒を除去', () => {
    expect(parsePostal('〒371-0026')?.label).toBe('前橋周辺')
  })
  it('全角数字を半角化', () => {
    expect(parsePostal('３７１−００２６')?.label).toBe('前橋周辺')
  })
  it('全角ハイフン各種', () => {
    expect(parsePostal('371－0026')?.label).toBe('前橋周辺')
    expect(parsePostal('371ー0026')?.label).toBe('前橋周辺')
  })
  it('〒+全角の混在', () => {
    expect(parsePostal('〒３７１ー００２６')?.label).toBe('前橋周辺')
  })
  it('未登録の 3 桁は null', () => {
    expect(parsePostal('100-0001')).toBe(null)
  })
  it('英字混入は null', () => {
    expect(parsePostal('abc-defg')).toBe(null)
  })
  it('空文字は null', () => {
    expect(parsePostal('')).toBe(null)
    expect(parsePostal('   ')).toBe(null)
  })
  it('桁不足/超過は null', () => {
    expect(parsePostal('12')).toBe(null)
    expect(parsePostal('12345678')).toBe(null)
  })
})

describe('haversine', () => {
  it('同一地点は 0km', () => {
    expect(haversine({ lat: 36.39, lng: 139.06 }, { lat: 36.39, lng: 139.06 })).toBeCloseTo(0, 3)
  })
  it('前橋〜高崎の直線距離 は概ね 8km 前後', () => {
    // 前橋 (36.3907,139.0604) - 高崎 (36.322,139.0033) 実測 約 8.4km
    const d = haversine(
      { lat: 36.3907, lng: 139.0604 },
      { lat: 36.322, lng: 139.0033 },
    )
    expect(d).toBeGreaterThan(7)
    expect(d).toBeLessThan(10)
  })
})
