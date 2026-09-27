import { describe, expect, it } from 'vitest'
import type { MineRecord, School } from '../types/school'
import { savedDepartmentValues, savedSchoolEntries, schoolReferenceStatus } from './saved-school-references'

const school = { id: 'published-school', name: '合成公開高校', departments: [{ id: 'published-department', name: '合成学科' }] } as School

describe('saved school references', () => {
  it('keeps every saved ID and its original record, even with an empty public map', () => {
    const records = { 'unlisted-school': { note: '合成メモ\n続き', commute_note: '合成通学メモ' }, 'published-school': { note: '公開校のメモ', commute_note: '' } }
    const before = structuredClone(records)
    const entries = savedSchoolEntries([school], records)
    expect(entries.map(({ id }) => id)).toEqual(['published-school', 'unlisted-school'])
    expect(entries[1].school).toBeUndefined()
    expect(entries[1].record).toBe(records['unlisted-school'])
    expect(savedSchoolEntries([], records)).toHaveLength(2)
    expect(records).toEqual(before)
  })

  it('preserves known and unavailable department values including zero, scoped to their school', () => {
    const record: MineRecord = { depts: { 'unlisted-department': 0, 'published-department': 51.2 }, note: '数値の合成メモ', visibility: 'private' }
    expect(savedDepartmentValues(school, record)).toEqual([
      { id: 'published-department', name: '合成学科', value: 51.2 },
      { id: 'unlisted-department', name: undefined, value: 0 },
    ])
    expect(savedDepartmentValues(undefined, record)).toEqual([
      { id: 'unlisted-department', name: undefined, value: 0 },
      { id: 'published-department', name: undefined, value: 51.2 },
    ])
  })

  it('separates loading, failed requests, and absence from a loaded public list', () => {
    expect(schoolReferenceStatus(true, null)).toBe('loading')
    expect(schoolReferenceStatus(false, 'synthetic failure')).toBe('failed')
    expect(schoolReferenceStatus(false, null)).toBe('unlisted')
  })
})
