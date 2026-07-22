export type SchoolType = 'high_school' | 'kosen'
export type Ownership = 'prefectural' | 'municipal' | 'national' | 'private' | 'union'
export type GenderType = 'coed' | 'boys' | 'girls'
export type CourseTime = 'fulltime' | 'parttime' | 'correspondence'
export type CampusType = 'main' | 'partner_school' | 'satellite_campus' | 'support_school'
export type SchoolLifecycleStatus = 'planned' | 'active' | 'closing' | 'closed'
export type SchoolRecruitmentStatus =
  | 'unknown'
  | 'not_started'
  | 'recruiting'
  | 'no_external_high_school_intake'
  | 'stopped'
export type SchoolRelationshipType =
  | 'renamed_to'
  | 'merged_into'
  | 'split_into'
  | 'reorganized_into'
  | 'succeeded_by'
/**
 * UI の学科フィルタ 10 分類（course_type_master.ui_group と一致）。
 * MEXT 学校基本調査の 17 分類を UI 上 9+1 chip に集約したもの:
 *   general              普通科
 *   comprehensive        総合学科
 *   sciences_langs       理数・国際（理数 + 外国語 + 国際関係）
 *   arts_sports          芸術・体育（音楽 + 美術 + 体育）
 *   industrial           工業
 *   informatics          情報（工業寄り + 商業寄り 両方）
 *   commercial           商業
 *   agriculture_marine   農業・水産
 *   home_welfare_nursing 家庭・福祉・看護
 *   other                その他
 */
export type DeptUiGroup =
  | 'general'
  | 'comprehensive'
  | 'sciences_langs'
  | 'arts_sports'
  | 'industrial'
  | 'informatics'
  | 'commercial'
  | 'agriculture_marine'
  | 'home_welfare_nursing'
  | 'other'

export interface Department {
  id: string
  school_id: string
  name: string
  course_type: string | null
  /** course_type_master から自動同期された UI 分類。DB 側の trigger で常に一致する */
  ui_group: DeptUiGroup | null
  /** school_deviation_values の is_active な参考値（無い学科は null = 情報募集中） */
  deviation: number | null
}

export interface AdmissionStat {
  id?: string
  department_id: string | null
  year: number
  capacity: number | null
  applicants: number | null
  examinees: number | null
  admitted: number | null
  note: string | null
  source_url: string | null
}

export type AdmissionSelectionStage = 'primary' | 'secondary' | 'supplemental' | 'unknown'
export type AdmissionSelectionTrack =
  | 'general'
  | 'recommendation'
  | 'special'
  | 'combined'
  | 'other'
  | 'unknown'
export type AdmissionRecruitmentUnitKind =
  | 'department'
  | 'department_group'
  | 'school'
  | 'course_group'
  | 'time_division'
  | 'other'
  | 'unknown'
export type AdmissionMapRole =
  | 'primary_total'
  | 'component_only'
  | 'additional_stage'
  | 'detail_only'
  | 'unknown'
export type AdmissionQualityReason =
  | 'missing_capacity'
  | 'missing_applicants'
  | 'metric_not_published'
  | 'stage_unknown'
  | 'track_scope_mismatch'
  | 'metric_scope_mismatch'
  | 'recruitment_unit_mismatch'
  | 'overlapping_unit'
  | 'mixed_population'
  | 'source_conflict'
  | 'source_unreachable'
  | 'scheme_changed'

export interface AdmissionSelectionSource {
  fact_kind_code: string
  official_url: string
  doc_title: string
  published_at: string | null
  source_page_or_table: string | null
  quoted_evidence: string | null
  last_verified_at: string | null
  last_http_status: number | null
}

export interface AdmissionSelectionQualityFlag {
  metric_code: string | null
  reason_code: AdmissionQualityReason
  note: string | null
}

/**
 * 新しい選抜単位モデルを、フロントで扱いやすいよう1選抜統計ずつ平坦化した形。
 * 募集単位の membership は department_ids に保持し、くくり募集を学科行へ複製しない。
 */
export interface AdmissionSelection {
  id: string
  recruitment_unit_id: string
  unit_key: string
  unit_kind_code: AdmissionRecruitmentUnitKind
  unit_label: string
  course_time: CourseTime | null
  department_ids: string[]
  valid_from_year: number | null
  valid_to_year: number | null
  year: number
  selection_stage_code: AdmissionSelectionStage
  selection_track_code: AdmissionSelectionTrack
  stage_label_raw: string | null
  track_label_raw: string | null
  selection_scope_raw: string | null
  population_scope_raw: string | null
  scope_key: string
  map_role_code: AdmissionMapRole
  is_ratio_comparable: boolean
  capacity: number | null
  applicants: number | null
  examinees: number | null
  admitted: number | null
  exam_scope_raw: string | null
  exam_components: string[]
  quality_flags: AdmissionSelectionQualityFlag[]
  sources: AdmissionSelectionSource[]
}

export interface SchoolRelationshipSummary {
  id: string
  relationship_type_code: SchoolRelationshipType
  effective_on: string
  official_url: string
  notes: string | null
  predecessor: {
    id: string
    record_key: string
    name: string
    lifecycle_status_code: SchoolLifecycleStatus
    closed_on: string | null
    /** 前身校に帰属させた値。現行校の倍率トレンドには混ぜない。 */
    admission_selections: AdmissionSelection[]
  }
}

export interface SchoolNameHistory {
  id: string
  name: string
  name_kana: string | null
  valid_from: string | null
  valid_to: string | null
  official_url: string
  notes: string | null
}

export interface School {
  id: string
  record_key: string
  name: string
  name_kana: string | null
  type: SchoolType
  ownership: Ownership
  gender_type: GenderType
  is_integrated: boolean
  postal_code: string | null
  prefecture: string
  city: string | null
  address: string
  latitude: number
  longitude: number
  official_url: string | null
  is_active: boolean
  is_recruiting: boolean
  lifecycle_status_code: SchoolLifecycleStatus
  recruitment_status_code: SchoolRecruitmentStatus
  legally_established_on: string | null
  opened_on: string | null
  recruitment_ended_on: string | null
  closed_on: string | null
  status_official_url: string | null
  status_note: string | null
  course_times: CourseTime[]
  main_school_name: string | null
  campus_type: CampusType
  total_students: number | null
  enrollment_year: number | null
  male_ratio: number | null
  departments: Department[]
  /** 旧モデル。移行中の型互換と規模推計だけに残し、志願状況の新集計には使わない。 */
  admission_stats: AdmissionStat[]
  admission_selections: AdmissionSelection[]
  predecessor_relationships: SchoolRelationshipSummary[]
  name_history: SchoolNameHistory[]
}

export interface Favorite {
  school_id: string
  priority: number
  status: string
}

export interface SchoolNote {
  school_id: string
  note: string
  commute_note: string
}

export interface MineRecord {
  /** department_id → 個人偏差値 */
  depts: Record<string, number>
  note: string
  visibility: 'private' | 'submit_to_manabi'
}

export interface HomeLocation {
  label: string
  lat: number
  lng: number
}
