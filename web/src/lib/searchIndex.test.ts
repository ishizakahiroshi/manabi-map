import { describe, expect, it } from 'vitest'
import {
  matchCities,
  matchSchools,
  normalizeForMatch,
  type CityIndexEntry,
  type SchoolIndexEntry,
} from './searchIndex'

const cities: CityIndexEntry[] = [
  { pref: '千葉県', prefSlug: 'chiba', city: '鎌ケ谷市', kana: 'かまがやし', count: 3 },
  { pref: '茨城県', prefSlug: 'ibaraki', city: '龍ケ崎市', kana: 'りゅうがさきし', count: 2 },
  { pref: '千葉県', prefSlug: 'chiba', city: '袖ケ浦市', kana: 'そでがうらし', count: 1 },
  { pref: '埼玉県', prefSlug: 'saitama', city: '鶴ケ島市', kana: 'つるがしまし', count: 1 },
  { pref: '群馬県', prefSlug: 'gunma', city: '前橋市', kana: 'まえばしし', count: 10 },
]

const schools: SchoolIndexEntry[] = [
  { id: 'synthetic-kamakura', name: '鎌ケ谷合成高校', kana: 'かまがやごうせいこうこう', pref: '千葉県', city: '鎌ケ谷市', lat: 35, lng: 140 },
  { id: 'synthetic-maebashi', name: '前橋合成高校', kana: 'まえばしごうせいこうこう', pref: '群馬県', city: '前橋市', lat: 36, lng: 139 },
]

describe('normalizeForMatch', () => {
  it('カタカナ・小書きかな・空白を同じ形へ寄せる', () => {
    expect(normalizeForMatch(' 鎌ヶ谷 ')).toBe('鎌け谷')
    expect(normalizeForMatch('鎌ケ谷市')).toBe('鎌け谷市')
    expect(normalizeForMatch('キャッスル')).toBe('きやつする')
  })
})

describe('matchCities', () => {
  it('漢字のヶ/ケ変種・かな・県名込みを前方/部分一致する', () => {
    expect(matchCities(cities, '鎌ヶ谷', 5).map((city) => city.city)).toContain('鎌ケ谷市')
    expect(matchCities(cities, 'りゅうがさき', 5).map((city) => city.city)).toContain('龍ケ崎市')
    expect(matchCities(cities, '群馬県前橋', 5).map((city) => city.city)).toContain('前橋市')
  })

  it('limit を超えて返さず空クエリは空配列にする', () => {
    expect(matchCities(cities, '市', 2)).toHaveLength(2)
    expect(matchCities(cities, '  ', 5)).toEqual([])
  })
})

describe('matchSchools', () => {
  it('校名・かな・県/市の部分一致と limit を扱う', () => {
    expect(matchSchools(schools, '鎌ヶ谷', 5).map((school) => school.id)).toEqual(['synthetic-kamakura'])
    expect(matchSchools(schools, 'まえばし', 5).map((school) => school.id)).toEqual(['synthetic-maebashi'])
    expect(matchSchools(schools, '群馬県', 1)).toHaveLength(1)
    expect(matchSchools(schools, '', 5)).toEqual([])
  })
})
