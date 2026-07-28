import { describe, expect, it } from 'vitest'
import type { Department, DeptUiGroup } from '../types/school'
import { departmentUiGroups } from './school-filter'

function department(ui_group: DeptUiGroup | null) {
  return { ui_group } as unknown as Department
}

describe('departmentUiGroups', () => {
  it('学科行が無い学校は unknown として扱う', () => {
    expect(departmentUiGroups({ departments: [] })).toEqual(['unknown'])
  })

  it('分類不能な学科行は other として扱う', () => {
    expect(departmentUiGroups({ departments: [department(null)] })).toEqual(['other'])
  })

  it('複数の学科分類を保持する', () => {
    expect(
      departmentUiGroups({
        departments: [department('general'), department('commercial')],
      }),
    ).toEqual(['general', 'commercial'])
  })
})
