import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCityCounts,
  cityPagePath,
  resolveCityGroup,
} from './municipalities.mjs'

const muniByPref = new Map([
  ['合成県', [
    { name: '蒲郡市', code: '230000', kana: 'がまごおりし' },
    { name: 'みなかみ町', code: '104490', kana: 'みなかみまち' },
    { name: '横浜市', code: '141003', kana: 'よこはまし' },
    { name: '府中市', code: '132063', kana: 'ふちゅうし' },
    { name: '府中町', code: '342076', kana: 'ふちゅうちょう' },
  ]],
])

test('市名に郡を含む市を郡除去で壊さない', () => {
  assert.equal(resolveCityGroup({ prefecture: '合成県', city: '蒲郡市' }, muniByPref)?.label, '蒲郡市')
})

test('郡付き町村は郡なし表記で照合し label は郡付きのまま', () => {
  assert.equal(
    resolveCityGroup({ prefecture: '合成県', city: '利根郡みなかみ町' }, muniByPref)?.label,
    '利根郡みなかみ町',
  )
})

test('政令市の区は市へ丸める', () => {
  assert.equal(resolveCityGroup({ prefecture: '合成県', city: '横浜市中区' }, muniByPref)?.label, '横浜市')
})

test('address 経路は最長一致で府中市と府中町を取り違えない', () => {
  assert.equal(
    resolveCityGroup({ prefecture: '合成県', city: null, address: '合成県府中市宮西町1' }, muniByPref)?.label,
    '府中市',
  )
})

test('市区町村ページの URL は percent-encode する', () => {
  assert.equal(cityPagePath('gunma', '前橋市'), '/pref/gunma/%E5%89%8D%E6%A9%8B%E5%B8%82/')
})

test('市区町村件数は掲載校のある順に返す', () => {
  assert.deepEqual(
    buildCityCounts({ cities: ['府中町', '府中市'], schools: [{ c: '府中市' }, { c: '府中市' }] }),
    [{ c: '府中市', n: 2 }],
  )
})
