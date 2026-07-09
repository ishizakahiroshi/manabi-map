import { useEffect, useState } from 'react'
import type { School, Department } from '../types/school'

const FETCH_ERROR_MESSAGE = '学校データの取得に失敗しました。時間をおいて再読み込みしてください。'

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
  ui_group: Department['ui_group']
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
        ui_group: d.ui_group ?? null,
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
        '*, school_departments(id, school_id, name, course_type, ui_group), school_deviation_values(department_id, value, is_active)',
      )
      .eq('is_active', true)
    if (error) throw error
    return (data ?? []) as unknown as SchoolRow[]
  }

  // build hash 付き URL 化（docs/local/plan_schools-json-cache-strategy.md）:
  // まず `/schools-manifest.json` を no-store で fetch し、そこに書かれた
  // hash 付き URL（例: `/schools-abc1234567.json`）を続けて fetch する。
  // manifest は常に fresh を取り、実体 JSON はブラウザ / CDN に永続キャッシュ可。
  // dev サーバー（public/ 生成前）や旧デプロイ経路での fallback として、
  // manifest 取得に失敗したら従来の `/schools.json` を試す。
  let dataUrl = '/schools.json'
  try {
    const manifestRes = await fetch('/schools-manifest.json', { cache: 'no-store' })
    if (manifestRes.ok) {
      const manifest = (await manifestRes.json()) as { url?: string }
      // 同一オリジンの schools JSON のみ許可（絶対 URL や path traversal を拒否）
      if (
        typeof manifest.url === 'string' &&
        /^\/schools(?:-[0-9a-f]+)?\.json$/i.test(manifest.url)
      ) {
        dataUrl = manifest.url
      }
    }
  } catch {
    // manifest 取得に失敗しても、下の fallback で `/schools.json` を試す。
  }

  const response = await fetch(dataUrl)
  if (!response.ok) throw new Error(`schools fetch failed: ${response.status} (${dataUrl})`)
  return (await response.json()) as SchoolRow[]
}

// ---------------------------------------------------------------------------
// モジュールレベル共有ストア
//
// useSchools() は MapPage / FavoritesPage / ComparePage から個別に呼ばれるが、
// 学校データは全画面で同一なので、モジュール変数に 1 度だけキャッシュして
// 画面遷移での再フェッチをなくす。マウント中のすべての useSchools が同じ
// ストアを購読し、reload() 明示時のみ再取得（バックグラウンド再検証）する。
//
// 将来の分県ロード / 遅延ロード（v0.2 関東拡大）へは、この 1 キャッシュを
// 「県キー付きの Map<pref, School[]>」へ拡張する最小差分で移行できる。
// ---------------------------------------------------------------------------

type Listener = () => void

const listeners = new Set<Listener>()
let cachedSchools: School[] | null = null
let cacheError: string | null = null
let inFlight: Promise<void> | null = null
/** force 連打で古いレスポンスが新キャッシュを上書きしないための世代カウンタ */
let loadGeneration = 0

function emit(): void {
  for (const listener of listeners) listener()
}

/** 学校データをロードする。cache があり force=false なら何もしない（再フェッチしない）。 */
function loadSchools(force: boolean): Promise<void> {
  if (!force && cachedSchools != null) return Promise.resolve()
  // 既に取得中なら、その完了を共有する（重複フェッチ防止）。force 時は新世代で取り直す。
  if (inFlight != null && !force) return inFlight

  const gen = ++loadGeneration
  const run = async () => {
    try {
      const rows = await fetchSchoolRows()
      if (gen !== loadGeneration) return
      cachedSchools = mapSchoolRows(rows)
      cacheError = null
    } catch {
      if (gen !== loadGeneration) return
      cacheError = FETCH_ERROR_MESSAGE
    }
    emit()
  }

  const promise = run().finally(() => {
    if (inFlight === promise) inFlight = null
  })
  inFlight = promise
  if (gen === loadGeneration) {
    cacheError = null
    emit()
  }
  return promise
}

export function useSchools(): SchoolsState {
  // ストア更新の通知でのみ再レンダリングさせるためのダミー state。
  const [, forceRender] = useState(0)

  useEffect(() => {
    const listener = () => forceRender((n) => n + 1)
    listeners.add(listener)
    // 初回のみ（キャッシュも取得中フローも無ければ）ロード開始。
    if (cachedSchools == null && inFlight == null) void loadSchools(false)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  return {
    schools: cachedSchools ?? [],
    // データ未取得・エラー未発生の両方が成り立つ間だけ loading（取得中）扱い。
    loading: cachedSchools == null && cacheError == null,
    error: cacheError,
    reload: () => {
      void loadSchools(true)
    },
  }
}
