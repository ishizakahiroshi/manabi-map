import type { AdmissionSelection, AdmissionSelectionQualityFlag, AdmissionSelectionSource } from '../types/school'

// 募集単位（admission_recruitment_units）のネスト形を、フロントで扱いやすい
// AdmissionSelection の平坦形へ変換する共有ロジック。
//
// React 側（hooks/useSchools.ts）と Node ビルドスクリプト
// （scripts/gen-seo-pages.mjs が .ts のまま import する。Node 22.18+ の
// type stripping 前提・erasableSyntaxOnly）で共有される。
// このロジックを .mjs へフォークしない（静的 HTML と JS mount 後で倍率が
// 食い違う事故を防ぐ・docs/local/plan_seo-growth-strategy_c4 C3）。
// 依存を持たない純関数だけを置くこと（値 import を足すと Node 直 import が壊れる）。

export interface AdmissionRecruitmentUnitRow {
  id: string
  unit_key: string
  unit_kind_code: AdmissionSelection['unit_kind_code']
  label: string
  course_time: AdmissionSelection['course_time']
  valid_from_year: number | null
  valid_to_year: number | null
  admission_recruitment_unit_departments?: { department_id: string }[] | null
  school_admission_selection_stats?: AdmissionSelectionStatRow[] | null
}

export interface AdmissionSelectionStatRow {
  id: string
  year: number
  selection_stage_code: AdmissionSelection['selection_stage_code']
  selection_track_code: AdmissionSelection['selection_track_code']
  stage_label_raw: string | null
  track_label_raw: string | null
  selection_scope_raw: string | null
  population_scope_raw: string | null
  scope_key: string
  map_role_code: AdmissionSelection['map_role_code']
  is_ratio_comparable: boolean
  capacity: number | null
  applicants: number | null
  examinees: number | null
  admitted: number | null
  exam_scope_raw: string | null
  school_admission_stat_exam_components?: { component_code: string }[] | null
  school_admission_stat_quality_flags?: AdmissionSelectionQualityFlag[] | null
  school_admission_stat_sources?: AdmissionSelectionSource[] | null
}

/** 募集単位のネスト行を、1 選抜統計 = 1 要素の平坦形へ変換する。 */
export function flattenRecruitmentUnits(
  units: readonly AdmissionRecruitmentUnitRow[] | null | undefined,
): AdmissionSelection[] {
  return (units ?? []).flatMap((unit) => {
    const departmentIds = (unit.admission_recruitment_unit_departments ?? [])
      .map((membership) => membership.department_id)
      .filter((id): id is string => typeof id === 'string')
    return (unit.school_admission_selection_stats ?? []).map((stat) => ({
      id: stat.id,
      recruitment_unit_id: unit.id,
      unit_key: unit.unit_key,
      unit_kind_code: unit.unit_kind_code,
      unit_label: unit.label,
      course_time: unit.course_time,
      department_ids: [...new Set(departmentIds)].sort(),
      valid_from_year: unit.valid_from_year,
      valid_to_year: unit.valid_to_year,
      year: stat.year,
      selection_stage_code: stat.selection_stage_code,
      selection_track_code: stat.selection_track_code,
      stage_label_raw: stat.stage_label_raw,
      track_label_raw: stat.track_label_raw,
      selection_scope_raw: stat.selection_scope_raw,
      population_scope_raw: stat.population_scope_raw,
      scope_key: stat.scope_key,
      map_role_code: stat.map_role_code,
      is_ratio_comparable: stat.is_ratio_comparable,
      capacity: stat.capacity,
      applicants: stat.applicants,
      examinees: stat.examinees,
      admitted: stat.admitted,
      exam_scope_raw: stat.exam_scope_raw,
      exam_components: (stat.school_admission_stat_exam_components ?? [])
        .map((component) => component.component_code)
        .filter((code): code is string => typeof code === 'string'),
      quality_flags: stat.school_admission_stat_quality_flags ?? [],
      sources: stat.school_admission_stat_sources ?? [],
    }))
  })
}
