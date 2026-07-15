import { useEffect, useState } from 'react'
import type {
  AdmissionSelection,
  AdmissionSelectionQualityFlag,
  AdmissionSelectionSource,
  AdmissionStat,
  Department,
  School,
  SchoolNameHistory,
  SchoolRelationshipSummary,
} from '../types/school'

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
  record_key?: string | null
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
  lifecycle_status_code?: School['lifecycle_status_code'] | null
  recruitment_status_code?: School['recruitment_status_code'] | null
  legally_established_on?: string | null
  opened_on?: string | null
  recruitment_ended_on?: string | null
  closed_on?: string | null
  status_official_url?: string | null
  status_note?: string | null
  course_times?: School['course_times'] | null
  main_school_name?: string | null
  campus_type?: School['campus_type'] | null
  total_students?: number | null
  enrollment_year?: number | null
  male_ratio?: number | null
  school_departments: DepartmentRow[]
  school_deviation_values: DeviationRow[]
  school_admission_stats?: AdmissionStatRow[]
  admission_recruitment_units?: AdmissionRecruitmentUnitRow[]
  predecessor_relationships?: SchoolRelationshipRow[] | null
  school_name_history?: SchoolNameHistory[] | null
}

interface SchoolRelationshipRow {
  id: string
  relationship_type_code: SchoolRelationshipSummary['relationship_type_code']
  effective_on: string
  official_url: string
  notes: string | null
  predecessor:
    | (Omit<SchoolRelationshipSummary['predecessor'], 'admission_selections'> & {
        admission_recruitment_units?: AdmissionRecruitmentUnitRow[] | null
      })
    | null
}

interface AdmissionStatRow {
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

interface AdmissionRecruitmentUnitRow {
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

interface AdmissionSelectionStatRow {
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
      const admissionSelections: AdmissionSelection[] = (
        r.admission_recruitment_units ?? []
      ).flatMap((unit) => {
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
      return {
        id: r.id,
        record_key: r.record_key ?? `school-${r.id}`,
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
        lifecycle_status_code: r.lifecycle_status_code ?? (r.is_active ? 'active' : 'closed'),
        recruitment_status_code:
          r.recruitment_status_code ??
          (r.is_recruiting
            ? 'recruiting'
            : r.is_integrated
              ? 'no_external_high_school_intake'
              : 'unknown'),
        legally_established_on: r.legally_established_on ?? null,
        opened_on: r.opened_on ?? null,
        recruitment_ended_on: r.recruitment_ended_on ?? null,
        closed_on: r.closed_on ?? null,
        status_official_url: r.status_official_url ?? null,
        status_note: r.status_note ?? null,
        course_times: r.course_times?.length ? r.course_times : ['fulltime'],
        main_school_name: r.main_school_name ?? null,
        campus_type: r.campus_type ?? 'main',
        total_students: r.total_students ?? null,
        enrollment_year: r.enrollment_year ?? null,
        male_ratio: r.male_ratio ?? null,
        departments,
        admission_stats: (r.school_admission_stats ?? []) as AdmissionStat[],
        admission_selections: admissionSelections,
        predecessor_relationships: (r.predecessor_relationships ?? [])
          .filter((relationship) => relationship.predecessor != null)
          .map((relationship) => ({
            id: relationship.id,
            relationship_type_code: relationship.relationship_type_code,
            effective_on: relationship.effective_on,
            official_url: relationship.official_url,
            notes: relationship.notes,
            predecessor: {
              ...relationship.predecessor!,
              admission_selections: (relationship.predecessor!.admission_recruitment_units ?? [])
                .flatMap((unit) => {
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
                }),
            },
          })),
        name_history: r.school_name_history ?? [],
      }
    })
}

async function fetchSchoolRows(): Promise<SchoolRow[]> {
  if (import.meta.env.VITE_SCHOOLS_SOURCE === 'supabase') {
    const { supabase } = await import('../lib/supabase')
    // PostgREST（Supabase）は既定で最大 1000 行しか返さないため、
    // gen-schools-json.mjs と同様に range でページングして全校取得する。
    const pageSize = 1000
    const rows: SchoolRow[] = []
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from('schools')
        .select(
          '*, school_departments(id, school_id, name, course_type, ui_group), school_deviation_values(department_id, value, is_active), school_admission_stats(id, department_id, year, capacity, applicants, examinees, admitted, note, source_url), predecessor_relationships:school_relationships!school_relationships_successor_school_id_fkey(id, relationship_type_code, effective_on, official_url, notes, predecessor:schools!school_relationships_predecessor_school_id_fkey(id, record_key, name, lifecycle_status_code, closed_on)), school_name_history(id, name, name_kana, valid_from, valid_to, official_url, notes)',
        )
        .eq('is_active', true)
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1)
      if (error) throw error
      const page = (data ?? []) as unknown as SchoolRow[]
      rows.push(...page)
      if (page.length < pageSize) break
    }
    const admissionsBySchool = new Map<string, AdmissionRecruitmentUnitRow[]>()
    const admissionPageSize = 250
    for (let from = 0; ; from += admissionPageSize) {
      const { data, error } = await supabase
        .from('admission_recruitment_units')
        .select(
          'school_id, id, unit_key, unit_kind_code, label, course_time, valid_from_year, valid_to_year, admission_recruitment_unit_departments(department_id), school_admission_selection_stats(id, year, selection_stage_code, selection_track_code, stage_label_raw, track_label_raw, selection_scope_raw, population_scope_raw, scope_key, map_role_code, is_ratio_comparable, capacity, applicants, examinees, admitted, exam_scope_raw, school_admission_stat_exam_components(component_code), school_admission_stat_quality_flags(metric_code, reason_code, note), school_admission_stat_sources(fact_kind_code, official_url, doc_title, published_at, source_page_or_table, quoted_evidence, last_verified_at, last_http_status))',
        )
        .order('id', { ascending: true })
        .range(from, from + admissionPageSize - 1)
      if (error) throw error
      const page = (data ?? []) as unknown as Array<AdmissionRecruitmentUnitRow & { school_id: string }>
      for (const unit of page) {
        const units = admissionsBySchool.get(unit.school_id) ?? []
        units.push(unit)
        admissionsBySchool.set(unit.school_id, units)
      }
      if (page.length < admissionPageSize) break
    }
    for (const row of rows) {
      row.admission_recruitment_units = admissionsBySchool.get(row.id) ?? []
      for (const relationship of row.predecessor_relationships ?? []) {
        if (relationship.predecessor) {
          relationship.predecessor.admission_recruitment_units =
            admissionsBySchool.get(relationship.predecessor.id) ?? []
        }
      }
    }
    return rows
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
        /^\/schools(?:-[0-9a-f]+)?\.json(?:\.gz)?$/i.test(manifest.url)
      ) {
        dataUrl = manifest.url
      }
    }
  } catch {
    // manifest 取得に失敗しても、下の fallback で `/schools.json` を試す。
  }

  const response = await fetch(dataUrl)
  if (!response.ok) throw new Error(`schools fetch failed: ${response.status} (${dataUrl})`)
  let payload: unknown
  if (dataUrl.endsWith('.gz')) {
    // CDN / dev serverによっては .gz をHTTP層で自動展開し、URLだけが .gz のまま
    // になる。先頭のgzip magic byteを見て、raw gzipと展開済みJSONの両方を読む。
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const compressed = new Blob([bytes]).stream()
      const decompressed = compressed.pipeThrough(new DecompressionStream('gzip'))
      payload = await new Response(decompressed).json()
    } else {
      payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    }
  } else {
    payload = await response.json()
  }
  if (Array.isArray(payload)) return payload as SchoolRow[]
  if (
    payload == null ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as { schools?: unknown }).schools) ||
    !Array.isArray((payload as { sourceCatalog?: unknown }).sourceCatalog)
  ) {
    throw new Error('schools payload has an unsupported format')
  }

  const compact = payload as {
    schools: SchoolRow[]
    sourceCatalog: AdmissionSelectionSource[]
  }
  const hydrateUnitSources = (units: AdmissionRecruitmentUnitRow[] | null | undefined) => {
    for (const unit of units ?? []) {
      for (const stat of unit.school_admission_selection_stats ?? []) {
        const refs = (stat.school_admission_stat_sources ?? []) as unknown[]
        stat.school_admission_stat_sources = refs
          .map((ref) =>
            typeof ref === 'number' ? compact.sourceCatalog[ref] : ref,
          )
          .filter(
            (source): source is AdmissionSelectionSource =>
              source != null && typeof source === 'object',
          )
      }
    }
  }
  for (const row of compact.schools) {
    hydrateUnitSources(row.admission_recruitment_units)
    for (const relationship of row.predecessor_relationships ?? []) {
      hydrateUnitSources(relationship.predecessor?.admission_recruitment_units)
    }
  }
  return compact.schools
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
