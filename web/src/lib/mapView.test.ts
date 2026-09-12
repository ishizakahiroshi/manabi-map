import { describe, it, expect } from 'vitest'
import {
  parseStoredHomeZoom,
  matchesHome,
  resolveInitialMapView,
  nationalMapView,
  parseSharedMapView,
  buildShareQuery,
  roundShareCoordinate,
} from './mapView'
import { ACTIVE_REGION } from './region'

const HOME = { label: '設定地点', lat: 36.631, lng: 138.957 }

describe('parseStoredHomeZoom', () => {
  it('正常な保存値を読む', () => {
    expect(parseStoredHomeZoom('{"lat":36.631,"lng":138.957,"zoom":10}')).toEqual({
      lat: 36.631,
      lng: 138.957,
      zoom: 10,
    })
  })
  it('null・壊れた JSON は null', () => {
    expect(parseStoredHomeZoom(null)).toBe(null)
    expect(parseStoredHomeZoom('')).toBe(null)
    expect(parseStoredHomeZoom('{lat:1}')).toBe(null)
    expect(parseStoredHomeZoom('"10"')).toBe(null)
  })
  it('範囲外・非整数のズームは捨てる', () => {
    expect(parseStoredHomeZoom('{"lat":36.6,"lng":138.9,"zoom":0}')).toBe(null)
    expect(parseStoredHomeZoom('{"lat":36.6,"lng":138.9,"zoom":19}')).toBe(null)
    expect(parseStoredHomeZoom('{"lat":36.6,"lng":138.9,"zoom":10.5}')).toBe(null)
    expect(parseStoredHomeZoom('{"lat":36.6,"lng":138.9,"zoom":"10"}')).toBe(null)
  })
  it('範囲外の座標は捨てる', () => {
    expect(parseStoredHomeZoom('{"lat":91,"lng":138.9,"zoom":10}')).toBe(null)
    expect(parseStoredHomeZoom('{"lat":36.6,"lng":181,"zoom":10}')).toBe(null)
  })
})

describe('matchesHome', () => {
  it('同じ設定地点なら使える', () => {
    expect(matchesHome({ lat: 36.631, lng: 138.957, zoom: 10 }, HOME)).toBe(true)
  })
  it('別の設定地点のズームは使わない', () => {
    expect(matchesHome({ lat: 35.689, lng: 139.691, zoom: 12 }, HOME)).toBe(false)
  })
  it('片方が無ければ false', () => {
    expect(matchesHome(null, HOME)).toBe(false)
    expect(matchesHome({ lat: 36.631, lng: 138.957, zoom: 10 }, null)).toBe(false)
  })
})

describe('resolveInitialMapView', () => {
  it('設定地点と一致するズームがあれば通学圏へ寄せる', () => {
    expect(resolveInitialMapView(HOME, { lat: 36.631, lng: 138.957, zoom: 10 })).toEqual({
      lat: 36.631,
      lng: 138.957,
      zoom: 10,
      restored: true,
    })
  })
  it('設定地点が無ければ全国表示', () => {
    expect(resolveInitialMapView(null, { lat: 36.631, lng: 138.957, zoom: 10 })).toEqual(nationalMapView())
  })
  it('覚えたズームが無い初回は全国表示', () => {
    expect(resolveInitialMapView(HOME, null)).toEqual(nationalMapView())
  })
  it('別地点のズームしか無ければ全国表示', () => {
    expect(resolveInitialMapView(HOME, { lat: 35.689, lng: 139.691, zoom: 12 })).toEqual(nationalMapView())
  })
  it('全国表示は ACTIVE_REGION そのもの', () => {
    expect(nationalMapView()).toEqual({
      lat: ACTIVE_REGION.mapCenter.lat,
      lng: ACTIVE_REGION.mapCenter.lng,
      zoom: ACTIVE_REGION.mapZoom,
      restored: false,
    })
  })
})

describe('共有 URL（plan_map-location-share-url.md C1）', () => {
  it('座標は保存側と同じ小数第 3 位へ丸める', () => {
    expect(roundShareCoordinate(35.4661234)).toBe(35.466)
    expect(roundShareCoordinate(139.6219876)).toBe(139.622)
    // -0 を作らない（URL に "-0" が出ると見た目が悪く、比較でも紛れる）
    expect(Object.is(roundShareCoordinate(-0.0001), 0)).toBe(true)
  })

  it('丸めた座標だけをクエリへ入れる', () => {
    const q = buildShareQuery(35.4661234, 139.6219876, 12.4)
    expect(q).toBe('lat=35.466&lng=139.622&z=12')
    // 生の座標が混ざっていないこと
    expect(q).not.toContain('35.4661')
  })

  it('ズームは 1〜18 に収める', () => {
    expect(buildShareQuery(35, 139, 99)).toContain('z=18')
    expect(buildShareQuery(35, 139, -5)).toContain('z=1')
  })

  it('正しいクエリを読み取る', () => {
    expect(parseSharedMapView(new URLSearchParams('lat=35.466&lng=139.622&z=12'))).toEqual({
      lat: 35.466,
      lng: 139.622,
      zoom: 12,
    })
  })

  it('欠け・壊れ・範囲外は null（従来の初期表示へ落とす）', () => {
    expect(parseSharedMapView(new URLSearchParams(''))).toBeNull()
    expect(parseSharedMapView(new URLSearchParams('lat=35.466&lng=139.622'))).toBeNull()
    expect(parseSharedMapView(new URLSearchParams('lat=abc&lng=139.622&z=12'))).toBeNull()
    expect(parseSharedMapView(new URLSearchParams('lat=91&lng=139.622&z=12'))).toBeNull()
    expect(parseSharedMapView(new URLSearchParams('lat=35.466&lng=181&z=12'))).toBeNull()
    expect(parseSharedMapView(new URLSearchParams('lat=35.466&lng=139.622&z=0'))).toBeNull()
    expect(parseSharedMapView(new URLSearchParams('lat=35.466&lng=139.622&z=19'))).toBeNull()
    expect(parseSharedMapView(new URLSearchParams('lat=35.466&lng=139.622&z=12.5'))).toBeNull()
  })
})
