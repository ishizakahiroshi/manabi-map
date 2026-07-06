export type SchoolType = 'high_school' | 'kosen'
export type Ownership = 'prefectural' | 'municipal' | 'national' | 'private' | 'union'
export type GenderType = 'coed' | 'boys' | 'girls'
export type CourseTime = 'fulltime' | 'parttime' | 'correspondence'
export type CampusType = 'main' | 'partner_school' | 'satellite_campus' | 'support_school'
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

export interface School {
  id: string
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
  course_times: CourseTime[]
  main_school_name: string | null
  campus_type: CampusType
  total_students: number | null
  enrollment_year: number | null
  male_ratio: number | null
  departments: Department[]
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
