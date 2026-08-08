import { useCallback, useMemo, useState } from 'react'
import { useI18n } from '../contexts/I18nContext'
import { GEN_FULL, COURSE_TIME_FULL } from '../lib/format'
import type { PrefListSchool } from '../lib/prefIndex'
import type { CourseTime, GenderType } from '../types/school'

/**
 * 一覧の内訳チップ（公立/私立/国立・課程・共学別学）の状態とフィルタ。
 * 県ページ（/pref/:pref）と市区町村ページ（/pref/:pref/:city）で共有する。
 *
 * 偏差値・倍率による絞り込みは実装しない（ランキングサイト化の禁止線・
 * docs/local/plan_seo-growth-strategy.md §やらないこと）。
 */

type OwnershipChip = 'public' | 'private' | 'national'

interface ChipState {
  ownership: Set<OwnershipChip>
  course: Set<CourseTime>
  gender: Set<GenderType>
}

export interface SchoolChip {
  key: string
  label: string
  n: number
  on: boolean
  toggle: () => void
}

export interface SchoolChips {
  /** 該当 0 件の区分は含まない（「私立 0」を並べない）。 */
  chips: SchoolChip[]
  /** 1 つ以上選択されている。 */
  active: boolean
  matches: (school: PrefListSchool) => boolean
  clear: () => void
}

function emptyChipState(): ChipState {
  return { ownership: new Set(), course: new Set(), gender: new Set() }
}

function ownershipChipOf(s: PrefListSchool): OwnershipChip {
  if (s.ownership === 'private') return 'private'
  if (s.ownership === 'national') return 'national'
  return 'public'
}

function toggleSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

export function useSchoolChips(schools: PrefListSchool[]): SchoolChips {
  const { t } = useI18n()
  const [state, setState] = useState<ChipState>(emptyChipState)

  const active = state.ownership.size > 0 || state.course.size > 0 || state.gender.size > 0

  const matches = useCallback(
    (s: PrefListSchool): boolean => {
      if (state.ownership.size > 0 && !state.ownership.has(ownershipChipOf(s))) return false
      if (state.course.size > 0 && !s.course_times.some((c) => state.course.has(c))) return false
      if (state.gender.size > 0 && !state.gender.has(s.gender_type)) return false
      return true
    },
    [state],
  )

  const clear = useCallback(() => setState(emptyChipState()), [])

  const chips = useMemo(() => {
    const count = (fn: (s: PrefListSchool) => boolean) => schools.filter(fn).length
    const defs: SchoolChip[] = []
    const ownershipDefs: Array<[OwnershipChip, string]> = [
      ['public', t('prefPage.chipPublic')],
      ['private', t('prefPage.chipPrivate')],
      ['national', t('prefPage.chipNational')],
    ]
    for (const [key, label] of ownershipDefs) {
      const n = count((s) => ownershipChipOf(s) === key)
      if (n === 0) continue
      defs.push({
        key: `own-${key}`, label, n, on: state.ownership.has(key),
        toggle: () => setState((c) => ({ ...c, ownership: toggleSet(c.ownership, key) })),
      })
    }
    for (const key of ['fulltime', 'parttime', 'correspondence'] as CourseTime[]) {
      const n = count((s) => s.course_times.includes(key))
      if (n === 0) continue
      defs.push({
        key: `course-${key}`, label: COURSE_TIME_FULL[key], n, on: state.course.has(key),
        toggle: () => setState((c) => ({ ...c, course: toggleSet(c.course, key) })),
      })
    }
    for (const key of ['coed', 'girls', 'boys'] as GenderType[]) {
      const n = count((s) => s.gender_type === key)
      if (n === 0) continue
      defs.push({
        key: `gender-${key}`, label: GEN_FULL[key], n, on: state.gender.has(key),
        toggle: () => setState((c) => ({ ...c, gender: toggleSet(c.gender, key) })),
      })
    }
    return defs
  }, [schools, state, t])

  return { chips, active, matches, clear }
}
