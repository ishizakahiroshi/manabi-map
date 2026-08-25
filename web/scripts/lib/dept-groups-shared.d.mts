import type { CourseTime, DeptUiGroup } from '../../src/types/school'

/** 'unknown' は含まない（学科が 1 件も無い学校は dg キーごと省く）。 */
type EncodableDeptUiGroup = Exclude<DeptUiGroup, 'unknown'>

export const DEPT_GROUP_CODES: Record<EncodableDeptUiGroup, string>
export const DEPT_GROUP_BY_CODE: Record<string, EncodableDeptUiGroup>
export const DEPT_GROUP_ORDER: readonly EncodableDeptUiGroup[]
export const DEPT_COVERAGE_MIN: number

export function encodeDeptGroups(
  departments: ReadonlyArray<{ ui_group?: string | null }> | null | undefined,
): string[]

export function decodeDeptGroups(
  codes: readonly string[] | null | undefined,
): EncodableDeptUiGroup[]

export function isCorrespondenceOnly(
  courseTimes: readonly CourseTime[] | null | undefined,
): boolean

export function hasReliableDeptData(
  entries: ReadonlyArray<{ ct?: readonly CourseTime[] | null; dg?: readonly string[] | null }>,
): boolean
