import { describe, expect, it } from 'vitest'
import {
  NEIGHBOR_FILL_TARGET,
  NEIGHBOR_MAX_COUNT,
  NEIGHBOR_MIN_COUNT,
  neighborCityKey,
  neighborPlaceLabel,
  selectNeighbors,
  type NeighborSchool,
} from './neighbors'

// fixture は合成データ（実在校を使わない）。緯度 0.01 度 ≒ 1.11 km。
let seq = 0
function school(overrides: Partial<NeighborSchool>): NeighborSchool {
  seq += 1
  return {
    id: `synthetic-${String(seq).padStart(3, '0')}`,
    prefecture: '群馬県',
    city: '合成市',
    latitude: 36.0,
    longitude: 139.0,
    ...overrides,
  }
}

describe('neighborCityKey', () => {
  it('県名の二重接頭辞を剥がして同一判定する', () => {
    expect(neighborCityKey({ prefecture: '東京都', city: '東京都町田市' })).toBe('東京都|町田市')
    expect(neighborCityKey({ prefecture: '東京都', city: '町田市' })).toBe('東京都|町田市')
  })

  it('city が無い学校は同一市区町村グループを持たない', () => {
    expect(neighborCityKey({ prefecture: '群馬県', city: null })).toBeNull()
  })
})

describe('neighborPlaceLabel', () => {
  it('同一県内は市区町村のみ、県外は県名を冠する', () => {
    const subject = { prefecture: '群馬県' }
    expect(neighborPlaceLabel(subject, { prefecture: '群馬県', city: '合成市' })).toBe('合成市')
    expect(neighborPlaceLabel(subject, { prefecture: '埼玉県', city: '合成郡合成町' })).toBe('埼玉県合成郡合成町')
  })

  it('city が無ければ県名を出す', () => {
    expect(neighborPlaceLabel({ prefecture: '群馬県' }, { prefecture: '群馬県', city: null })).toBe('群馬県')
  })
})

describe('selectNeighbors', () => {
  it('同一市区町村を全て含め、8 校まで 10km 圏内から距離補完する', () => {
    const subject = school({ city: '合成市' })
    const sameCity = [1, 2, 3].map((i) => school({ city: '合成市', latitude: 36.0 + i * 0.01 }))
    const nearOtherCity = [1, 2, 3, 4, 5, 6].map((i) =>
      school({ city: '別の市', latitude: 36.0 + 0.005 + i * 0.01 }),
    )
    const farOtherCity = school({ city: '遠い市', latitude: 37.0 })
    const picked = selectNeighbors(subject, [subject, ...sameCity, ...nearOtherCity, farOtherCity])
    expect(picked).toHaveLength(NEIGHBOR_FILL_TARGET)
    for (const s of sameCity) expect(picked.map((p) => p.school.id)).toContain(s.id)
    expect(picked.map((p) => p.school.id)).not.toContain(farOtherCity.id)
    // 距離昇順
    const dists = picked.map((p) => p.distanceKm)
    expect([...dists].sort((a, b) => a - b)).toEqual(dists)
  })

  it('同一市区町村が多くても上限で打ち切る（近い順）', () => {
    const subject = school({ city: '合成市' })
    const sameCity = Array.from({ length: 30 }, (_, i) =>
      school({ city: '合成市', latitude: 36.0 + (i + 1) * 0.01 }),
    )
    const picked = selectNeighbors(subject, [subject, ...sameCity])
    expect(picked).toHaveLength(NEIGHBOR_MAX_COUNT)
    expect(picked[0].school.id).toBe(sameCity[0].id)
  })

  it('過疎地フォールバック: 10km 圏内が無くても最低 3 校出す', () => {
    const subject = school({ city: '孤島村' })
    const far = [1, 2, 3, 4].map((i) => school({ city: '遠い市', latitude: 36.0 + 0.5 + i * 0.1 }))
    const picked = selectNeighbors(subject, [subject, ...far])
    expect(picked).toHaveLength(NEIGHBOR_MIN_COUNT)
  })

  it('候補が自分しかいなければ空を返す', () => {
    const subject = school({})
    expect(selectNeighbors(subject, [subject])).toHaveLength(0)
  })

  it('県境をまたぐ補完を許容する', () => {
    const subject = school({ city: null })
    const crossPref = school({ prefecture: '埼玉県', city: '合成市', latitude: 36.01 })
    const picked = selectNeighbors(subject, [subject, crossPref])
    expect(picked.map((p) => p.school.id)).toContain(crossPref.id)
  })
})
