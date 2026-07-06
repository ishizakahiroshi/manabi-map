export type SchoolType = 'high_school' | 'kosen'
export type Ownership = 'prefectural' | 'municipal' | 'national' | 'private' | 'union'
export type GenderType = 'coed' | 'boys' | 'girls'
export type CourseTime = 'fulltime' | 'parttime' | 'correspondence'
export type CampusType = 'main' | 'partner_school' | 'satellite_campus' | 'support_school'

export interface Department {
  id: string
  school_id: string
  name: string
  course_type: string | null
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
