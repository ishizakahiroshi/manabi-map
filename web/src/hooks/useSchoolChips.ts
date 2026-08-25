import { useCallback, useMemo, useState } from 'react'
import { useI18n } from '../contexts/I18nContext'
import type { PrefListSchool } from '../lib/prefIndex'
import type { CourseTime, DeptUiGroup, GenderType } from '../types/school'
import {
  DEPT_GROUP_ORDER,
  hasReliableDeptData,
} from '../../scripts/lib/dept-groups-shared.mjs'

/**
 * 一覧の内訳チップ（公立/私立/国立・課程・共学別学・学科系統・中高一貫）の状態とフィルタ。
 * 県ページ（/pref/:pref）と市区町村ページ（/pref/:pref/:city）で共有する。
 *
 * 意味づけ: 同じ軸の中は OR、軸をまたぐと AND、何も選ばなければ全表示。
 * MapPage の学科フィルタとは**方式が逆**（あちらは既定 ON の除外型なので
 * 「学科情報なし」chip が要る。こちらは既定 OFF の包含型なので要らない。
 * 根拠は docs/local/plan_city-page-local-context.md C2）。
 *
 * 偏差値・倍率による絞り込みは実装しない（ランキングサイト化の禁止線・
 * docs/local/plan_seo-growth-strategy.md §やらないこと）。
 */

type OwnershipChip = 'public' | 'private' | 'national'
type DeptChip = Exclude<DeptUiGroup, 'unknown'>

interface ChipState {
  ownership: Set<OwnershipChip>
  course: Set<CourseTime>
  gender: Set<GenderType>
  dept: Set<DeptChip>
  integrated: boolean
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
  /** 学科チップを出したか。注記（chipsDeptNote）の表示条件と対。 */
  showsDept: boolean
  matches: (school: PrefListSchool) => boolean
  clear: () => void
}

function emptyChipState(): ChipState {
  return {
    ownership: new Set(),
    course: new Set(),
    gender: new Set(),
    dept: new Set(),
    integrated: false,
  }
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

/**
 * この一覧で学科チップを出してよいか。
 *
 * 学科データが県ごとに欠けているので、素直に集計すると神戸市 61 校が
 * 「商業 2・情報 1・工業 1」になり誤読を招く。判定は生成側（meta description）と
 * 同じ実装を共有する（dept-groups-shared.mjs）。
 */
function canShowDeptChips(schools: PrefListSchool[]): boolean {
  return hasReliableDeptData(
    schools.map((s) => ({ ct: s.course_times, dg: s.dept_groups })),
  )
}

export function useSchoolChips(schools: PrefListSchool[]): SchoolChips {
  const { t } = useI18n()
  const [state, setState] = useState<ChipState>(emptyChipState)

  const showsDept = useMemo(() => canShowDeptChips(schools), [schools])

  const active =
    state.ownership.size > 0 ||
    state.course.size > 0 ||
    state.gender.size > 0 ||
    state.dept.size > 0 ||
    state.integrated

  const matches = useCallback(
    (s: PrefListSchool): boolean => {
      if (state.ownership.size > 0 && !state.ownership.has(ownershipChipOf(s))) return false
      if (state.course.size > 0 && !s.course_times.some((c) => state.course.has(c))) return false
      if (state.gender.size > 0 && !state.gender.has(s.gender_type)) return false
      // 学科ゼロの学校（ほぼ通信制）は、学科チップを押した時点で外れる。
      // 何も押していなければ全校が出ているので、消えるのは明示的に絞り込んだときだけ。
      if (state.dept.size > 0 && !s.dept_groups.some((g) => state.dept.has(g))) return false
      if (state.integrated && !s.is_integrated) return false
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
        key: `course-${key}`, label: t(`labels.course.${key}`), n, on: state.course.has(key),
        toggle: () => setState((c) => ({ ...c, course: toggleSet(c.course, key) })),
      })
    }
    for (const key of ['coed', 'girls', 'boys'] as GenderType[]) {
      const n = count((s) => s.gender_type === key)
      if (n === 0) continue
      defs.push({
        key: `gender-${key}`, label: t(`labels.gen.${key}`), n, on: state.gender.has(key),
        toggle: () => setState((c) => ({ ...c, gender: toggleSet(c.gender, key) })),
      })
    }
    if (showsDept) {
      for (const key of DEPT_GROUP_ORDER) {
        const n = count((s) => s.dept_groups.includes(key))
        if (n === 0) continue
        defs.push({
          key: `dept-${key}`, label: t(`filter.dept.${key}`), n, on: state.dept.has(key),
          toggle: () => setState((c) => ({ ...c, dept: toggleSet(c.dept, key) })),
        })
      }
    }
    const integratedCount = count((s) => s.is_integrated)
    if (integratedCount > 0) {
      defs.push({
        key: 'integrated',
        label: t('prefPage.chipIntegrated'),
        n: integratedCount,
        on: state.integrated,
        toggle: () => setState((c) => ({ ...c, integrated: !c.integrated })),
      })
    }
    return defs
  }, [schools, showsDept, state, t])

  return { chips, active, showsDept, matches, clear }
}
