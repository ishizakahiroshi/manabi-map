import { useEffect, useState } from 'react'
import type { School, Department } from '../types/school'

interface DeviationRow {
  department_id: string | null
  value: number
  is_active: boolean
}

interface DepartmentRow {
  id: string
  school_id: string
  name: string
  course_type: string | null
}

interface SchoolRow {
  id: string
  name: string
  name_kana: string | null
  type: 'high_school' | 'kosen'
  ownership: School['ownership']
  gender_type: School['gender_type']
  is_integrated: boolean
  postal_code: string | null
  prefecture: string
  city: string | null
  address: string
  latitude: string | number | null
  longitude: string | number | null
  official_url: string | null
  is_active: boolean
  is_recruiting: boolean
  course_times?: School['course_times'] | null
  main_school_name?: string | null
  campus_type?: School['campus_type'] | null
  total_students?: number | null
  enrollment_year?: number | null
  male_ratio?: number | null
  school_departments: DepartmentRow[]
  school_deviation_values: DeviationRow[]
}

interface SchoolsState {
  schools: School[]
  loading: boolean
  error: string | null
  reload: () => void
}

function mapSchoolRows(rows: SchoolRow[]): School[] {
  return rows
    .filter((r) => r.latitude != null && r.longitude != null)
    .map((r) => {
      const devByDept = new Map<string | null, number>()
      for (const dv of r.school_deviation_values ?? []) {
        if (dv.is_active) devByDept.set(dv.department_id, dv.value)
      }
      const departments: Department[] = (r.school_departments ?? []).map((d) => ({
        id: d.id,
        school_id: d.school_id,
        name: d.name,
        course_type: d.course_type,
        deviation: devByDept.get(d.id) ?? null,
      }))
      return {
        id: r.id,
        name: r.name,
        name_kana: r.name_kana,
        type: r.type,
        ownership: r.ownership,
        gender_type: r.gender_type,
        is_integrated: r.is_integrated,
        postal_code: r.postal_code,
        prefecture: r.prefecture,
        city: r.city,
        address: r.address,
        latitude: Number(r.latitude),
        longitude: Number(r.longitude),
        official_url: r.official_url,
        is_active: r.is_active,
        is_recruiting: r.is_recruiting,
        course_times: r.course_times?.length ? r.course_times : ['fulltime'],
        main_school_name: r.main_school_name ?? null,
        campus_type: r.campus_type ?? 'main',
        total_students: r.total_students ?? null,
        enrollment_year: r.enrollment_year ?? null,
        male_ratio: r.male_ratio ?? null,
        departments,
      }
    })
}

async function fetchSchoolRows(): Promise<SchoolRow[]> {
  if (import.meta.env.VITE_SCHOOLS_SOURCE === 'supabase') {
    const { supabase } = await import('../lib/supabase')
    const { data, error } = await supabase
      .from('schools')
      .select(
        '*, school_departments(id, school_id, name, course_type), school_deviation_values(department_id, value, is_active)',
      )
      .eq('is_active', true)
    if (error) throw error
    return (data ?? []) as unknown as SchoolRow[]
  }

  const response = await fetch('/schools.json')
  if (!response.ok) throw new Error(`schools.json fetch failed: ${response.status}`)
  return (await response.json()) as SchoolRow[]
}

export function useSchools(): SchoolsState {
  const [schools, setSchools] = useState<School[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      if (cancelled) return
      try {
        const rows = await fetchSchoolRows()
        if (cancelled) return
        setSchools(mapSchoolRows(rows))
        setError(null)
      } catch {
        if (cancelled) return
        setError('学校データの取得に失敗しました。時間をおいて再読み込みしてください。')
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [nonce])

  return { schools, loading, error, reload: () => setNonce((n) => n + 1) }
}
