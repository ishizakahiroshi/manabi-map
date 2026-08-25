import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEPT_COVERAGE_MIN,
  DEPT_GROUP_BY_CODE,
  DEPT_GROUP_CODES,
  DEPT_GROUP_ORDER,
  decodeDeptGroups,
  encodeDeptGroups,
  hasReliableDeptData,
  isCorrespondenceOnly,
} from './dept-groups-shared.mjs'

const dept = (ui_group) => ({ ui_group })

test('コードは 10 分類ぶんあり、重複しない', () => {
  const codes = Object.values(DEPT_GROUP_CODES)
  assert.equal(codes.length, 10)
  assert.equal(new Set(codes).size, 10, '1 文字コードが衝突している')
  assert.equal(DEPT_GROUP_ORDER.length, 10)
  assert.deepEqual(
    [...DEPT_GROUP_ORDER].sort(),
    Object.keys(DEPT_GROUP_CODES).sort(),
    'ORDER と CODES で分類の集合がずれている',
  )
})

test('コードは 1 文字（ペイロード削減の前提）', () => {
  for (const [group, code] of Object.entries(DEPT_GROUP_CODES)) {
    assert.equal(code.length, 1, `${group} のコードが 1 文字ではない`)
  }
})

test('encode と decode が往復する', () => {
  for (const group of DEPT_GROUP_ORDER) {
    assert.deepEqual(decodeDeptGroups(encodeDeptGroups([dept(group)])), [group])
  }
  assert.deepEqual(DEPT_GROUP_BY_CODE[DEPT_GROUP_CODES.industrial], 'industrial')
})

test('encode は重複を排除し ORDER 順に並べる', () => {
  const codes = encodeDeptGroups([
    dept('commercial'),
    dept('general'),
    dept('commercial'),
    dept('industrial'),
  ])
  assert.deepEqual(codes, [
    DEPT_GROUP_CODES.general,
    DEPT_GROUP_CODES.industrial,
    DEPT_GROUP_CODES.commercial,
  ])
})

test('学科ゼロ・null・未知の ui_group は空配列（キーを置かせない）', () => {
  assert.deepEqual(encodeDeptGroups([]), [])
  assert.deepEqual(encodeDeptGroups(null), [])
  assert.deepEqual(encodeDeptGroups(undefined), [])
  assert.deepEqual(encodeDeptGroups([dept(null)]), [])
  // MapPage の sentinel。ペイロードへは書かない（キーが無いこと自体が unknown を表す）
  assert.deepEqual(encodeDeptGroups([dept('unknown')]), [])
})

test('decode は未知のコードを黙って捨てる（前方互換）', () => {
  assert.deepEqual(decodeDeptGroups(['g', 'ZZZ', 'i']), ['general', 'industrial'])
  assert.deepEqual(decodeDeptGroups(undefined), [])
})

test('通信制のみの判定', () => {
  assert.equal(isCorrespondenceOnly(['correspondence']), true)
  assert.equal(isCorrespondenceOnly(['correspondence', 'fulltime']), false)
  assert.equal(isCorrespondenceOnly(['correspondence', 'parttime']), false)
  assert.equal(isCorrespondenceOnly(['fulltime']), false)
  // 空・未指定は生成側と同じく全日制として扱う
  assert.equal(isCorrespondenceOnly([]), false)
  assert.equal(isCorrespondenceOnly(null), false)
})

test('ガード: 通信制のみの学校は分母から外れる（宇都宮市の形）', () => {
  // 全日制 15 校すべてに学科があり、通信制のみ 8 校には無い。
  // 分母に通信制を入れると 15/23 = 65% で伏せられてしまうが、外せば 100%。
  const entries = [
    ...Array.from({ length: 15 }, () => ({ ct: ['fulltime'], dg: ['g'] })),
    ...Array.from({ length: 8 }, () => ({ ct: ['correspondence'] })),
  ]
  assert.equal(hasReliableDeptData(entries), true)
})

test('ガード: 学科がほぼ無い一覧は false（神戸市の形）', () => {
  const entries = [
    ...Array.from({ length: 3 }, () => ({ ct: ['fulltime'], dg: ['m'] })),
    ...Array.from({ length: 57 }, () => ({ ct: ['fulltime'] })),
    { ct: ['correspondence'] },
  ]
  assert.equal(hasReliableDeptData(entries), false)
})

test('ガード: 境界は DEPT_COVERAGE_MIN ちょうどで通す', () => {
  const total = 10
  const covered = Math.round(total * DEPT_COVERAGE_MIN)
  const atThreshold = [
    ...Array.from({ length: covered }, () => ({ ct: ['fulltime'], dg: ['g'] })),
    ...Array.from({ length: total - covered }, () => ({ ct: ['fulltime'] })),
  ]
  assert.equal(hasReliableDeptData(atThreshold), true)

  const belowThreshold = [
    ...Array.from({ length: covered - 1 }, () => ({ ct: ['fulltime'], dg: ['g'] })),
    ...Array.from({ length: total - covered + 1 }, () => ({ ct: ['fulltime'] })),
  ]
  assert.equal(hasReliableDeptData(belowThreshold), false)
})

test('ガード: 分母 0（通信制しか無い市区町村）と空一覧は false', () => {
  assert.equal(hasReliableDeptData([{ ct: ['correspondence'] }]), false)
  assert.equal(hasReliableDeptData([]), false)
  assert.equal(hasReliableDeptData(null), false)
})
