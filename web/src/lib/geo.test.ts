import { describe, it, expect } from 'vitest'
import { parsePostal, haversine } from './geo'

describe('parsePostal', () => {
  // ACTIVE_REGION = 東日本 20 都道県。郵便番号上 3 桁は県単位の暫定ラベル（都市名ではない）。
  it('半角ハイフン付き（現行受理）', () => {
    expect(parsePostal('371-0026')?.label).toBe('群馬県周辺')
  })
  it('ハイフンなし 7 桁（現行受理）', () => {
    expect(parsePostal('3710026')?.label).toBe('群馬県周辺')
  })
  it('先頭 3 桁のみ', () => {
    expect(parsePostal('371')?.label).toBe('群馬県周辺')
  })
  it('先頭〒を除去', () => {
    expect(parsePostal('〒371-0026')?.label).toBe('群馬県周辺')
  })
  it('全角数字を半角化', () => {
    expect(parsePostal('３７１−００２６')?.label).toBe('群馬県周辺')
  })
  it('全角ハイフン各種', () => {
    expect(parsePostal('371－0026')?.label).toBe('群馬県周辺')
    expect(parsePostal('371ー0026')?.label).toBe('群馬県周辺')
  })
  it('〒+全角の混在', () => {
    expect(parsePostal('〒３７１ー００２６')?.label).toBe('群馬県周辺')
  })
  it('東日本内の他県も受理', () => {
    expect(parsePostal('100-0001')?.label).toBe('東京都周辺')
    expect(parsePostal('060-0001')?.label).toBe('北海道周辺')
    expect(parsePostal('980-0001')?.label).toBe('宮城県周辺')
  })
  it('北海道の非連続レンジを判定', () => {
    expect(parsePostal('000-0001')?.label).toBe('北海道周辺')
    expect(parsePostal('009-0001')?.label).toBe('北海道周辺')
    expect(parsePostal('040-0001')?.label).toBe('北海道周辺')
    expect(parsePostal('010-0001')?.label).toBe('秋田県周辺')
  })
  it('リージョン外の 3 桁は null', () => {
    // 530 台 = 大阪府（ACTIVE_REGION 外）
    expect(parsePostal('530-0001')).toBe(null)
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
