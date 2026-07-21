import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { checkSchoolRows } from './schools-candidate-check.mjs'

// 実県のデータは使わない（合成のみ）。過去に S4 まで持ち越された defect を再現する。
function row(overrides = {}) {
  return {
    record_key: 'kx-0001',
    name: '架空県立架空高等学校',
    type: 'high_school',
    gender_type: 'coed',
    campus_type: '',
    course_times: '{fulltime}',
    ...overrides,
  }
}

describe('checkSchoolRows', () => {
  it('健全な行は違反 0', () => {
    assert.deepEqual(checkSchoolRows([row(), row({ record_key: 'kx-0002' })]), [])
  })

  it('course_times が空なら検出する（大阪 S4 FAIL の原因）', () => {
    const empty = checkSchoolRows([row({ course_times: '{}' })])
    assert.equal(empty.length, 1)
    assert.equal(empty[0].rule, 'course_times_empty')
    assert.equal(checkSchoolRows([row({ course_times: '' })])[0].rule, 'course_times_empty')
  })

  it("gender_type='female' を検出し 'girls' を示す（岐阜2/三重1 の defect）", () => {
    const [violation] = checkSchoolRows([row({ gender_type: 'female' })])
    assert.equal(violation.rule, 'gender_type_forbidden')
    assert.match(violation.detail, /girls/)
  })

  it('未知の gender_type も検出する', () => {
    assert.equal(checkSchoolRows([row({ gender_type: 'mixed' })])[0].rule, 'gender_type_unknown')
  })

  it("type='secondary_education_school' を検出する（奈良 S4 FAIL の原因）", () => {
    const [violation] = checkSchoolRows([row({ type: 'secondary_education_school' })])
    assert.equal(violation.rule, 'type_forbidden')
    assert.match(violation.detail, /high_school/)
  })

  it('高専の kosen は許容する', () => {
    assert.deepEqual(checkSchoolRows([row({ type: 'kosen' })]), [])
  })

  it("campus_type='satellite' を検出する（福岡で見つかった enum 外）", () => {
    const [violation] = checkSchoolRows([row({ campus_type: 'satellite' })])
    assert.equal(violation.rule, 'campus_type_forbidden')
    assert.match(violation.detail, /satellite_campus/)
  })

  it('record_key の空・重複を検出する', () => {
    assert.equal(checkSchoolRows([row({ record_key: '' })])[0].rule, 'record_key_empty')
    const dup = checkSchoolRows([row(), row()])
    assert.equal(dup.length, 1)
    assert.equal(dup[0].rule, 'record_key_duplicated')
    assert.equal(dup[0].row, 3)
  })

  it('course_times 列が無い CSV では course_times を検査しない', () => {
    const noColumn = { record_key: 'kx-0003', name: '架空高等学校', type: 'high_school', gender_type: 'coed' }
    assert.deepEqual(checkSchoolRows([noColumn]), [])
  })

  it('1 行に複数の違反があれば全部返す', () => {
    const violations = checkSchoolRows([row({ gender_type: 'female', type: 'secondary_education_school', course_times: '{}' })])
    assert.deepEqual(violations.map((v) => v.rule).sort(), ['course_times_empty', 'gender_type_forbidden', 'type_forbidden'])
  })
})
