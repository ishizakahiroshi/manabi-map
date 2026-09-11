import { describe, expect, it } from 'vitest'
import type { AdmissionRecruitmentUnitRow, AdmissionSelectionStatRow } from './admissionUnits.ts'
import { buildMapPayload, latestPrimaryAdmissionOf, toMapSchoolRow } from './mapPayload.ts'

/**
 * 全件 JSON（scripts/gen-schools-json.mjs の payload.schools）に近い形の 1 行。
 * 入試履歴は PostgREST の nest 形（admission_recruitment_units）で持つ。
 */
function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'school-1',
    record_key: 'test-school-1',
    name: '合成第一高等学校',
    name_kana: 'ごうせいだいいちこうとうがっこう',
    type: 'high_school',
    ownership: 'prefectural',
    gender_type: 'coed',
    is_integrated: false,
    postal_code: '370-0000',
    prefecture: '群馬県',
    city: '前橋市',
    address: '群馬県前橋市1-1-1',
    latitude: 36.4,
    longitude: 139.1,
    official_url: 'https://example.test/',
    is_active: true,
    is_recruiting: true,
    lifecycle_status_code: 'active',
    recruitment_status_code: 'recruiting',
    legally_established_on: null,
    opened_on: null,
    recruitment_ended_on: null,
    closed_on: null,
    status_official_url: null,
    course_times: ['fulltime'],
    main_school_name: null,
    campus_type: 'main',
    total_students: 600,
    enrollment_year: 2025,
    male_ratio: 0.5,
    // 地図 payload に載せない列
    updated_at: '2026-09-01T00:00:00Z',
    status_description: '内部メモ',
    school_field_sources: [{ field: 'name', official_url: 'https://example.test/' }],
    school_departments: [
      {
        id: 'dept-1',
        school_id: 'school-1',
        name: '普通科',
        course_type: 'general',
        ui_group: 'general',
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
    school_deviation_values: [
      { department_id: 'dept-1', value: 58, is_active: true, note: '内部メモ' },
    ],
    school_admission_stats: [{ department_id: null, year: 2025, capacity: 200 }],
    predecessor_relationships: [],
    school_name_history: [],
    admission_recruitment_units: admissionUnits(),
    ...overrides,
  }
}

function admissionUnits(): AdmissionRecruitmentUnitRow[] {
  return [
    {
      id: 'unit-1',
      unit_key: 'school-fulltime',
      unit_kind_code: 'school',
      label: '全校',
      course_time: 'fulltime',
      valid_from_year: null,
      valid_to_year: null,
      admission_recruitment_unit_departments: [{ department_id: 'dept-1' }],
      school_admission_selection_stats: [
        admissionStat(2024, 200, 210),
        admissionStat(2025, 200, 260),
      ],
    },
  ]
}

function admissionStat(year: number, capacity: number, applicants: number): AdmissionSelectionStatRow {
  return {
    id: `stat-${year}`,
    year,
    selection_stage_code: 'primary',
    selection_track_code: 'combined',
    stage_label_raw: '第一次募集',
    track_label_raw: '一般',
    selection_scope_raw: '第一次募集全体',
    population_scope_raw: '外部志願者',
    scope_key: 'primary-total',
    map_role_code: 'primary_total',
    is_ratio_comparable: true,
    capacity,
    applicants,
    examinees: null,
    admitted: null,
    exam_scope_raw: null,
    school_admission_stat_exam_components: [],
    school_admission_stat_quality_flags: [],
    school_admission_stat_sources: [
      {
        fact_kind_code: 'applicants',
        official_url: 'https://example.test/admission',
        doc_title: '合成県 令和7年度 志願状況',
        published_at: '2025-02-20',
        source_page_or_table: 'p.1',
        quoted_evidence: null,
        last_verified_at: '2025-03-01',
        last_http_status: 200,
      },
    ],
  }
}

describe('toMapSchoolRow', () => {
  it('地図・一覧が読む列を残す', () => {
    const row = toMapSchoolRow(sourceRow())
    for (const field of [
      'id', 'name', 'name_kana', 'prefecture', 'city', 'address', 'latitude', 'longitude',
      'ownership', 'gender_type', 'type', 'is_integrated', 'course_times',
      'school_departments', 'school_deviation_values',
    ]) {
      expect(row[field], field).not.toBe(undefined)
    }
    expect(row.school_departments).toEqual([
      { id: 'dept-1', school_id: 'school-1', name: '普通科', course_type: 'general', ui_group: 'general' },
    ])
    expect(row.school_deviation_values).toEqual([
      { department_id: 'dept-1', value: 58, is_active: true },
    ])
  })

  it('詳細シートでしか使わない重い項目を落とす', () => {
    const row = toMapSchoolRow(sourceRow())
    for (const field of [
      'admission_recruitment_units',
      'school_admission_stats',
      'predecessor_relationships',
      'school_name_history',
      'school_field_sources',
      'updated_at',
      'status_description',
    ]) {
      expect(row[field], field).toBe(undefined)
    }
    // 学科・偏差値の行に紛れている内部項目も持ち出さない
    expect(JSON.stringify(row)).not.toContain('内部メモ')
    expect(JSON.stringify(row)).not.toContain('created_at')
  })

  it('最新年度の一次募集倍率を畳んで載せる', () => {
    const row = toMapSchoolRow(sourceRow())
    expect(row.latest_primary_admission).toEqual({ year: 2025, ratio: 260 / 200 })
  })

  it('比較可能な一次募集が無い学校には倍率を載せない', () => {
    const row = toMapSchoolRow(sourceRow({ admission_recruitment_units: [] }))
    expect(row.latest_primary_admission).toBe(undefined)
    expect(latestPrimaryAdmissionOf(sourceRow({ admission_recruitment_units: null }))).toBe(null)
  })

  it('元の行を書き換えない（全件 JSON と同じオブジェクトを共有しているため）', () => {
    const source = sourceRow()
    const before = JSON.stringify(source)
    toMapSchoolRow(source)
    expect(JSON.stringify(source)).toBe(before)
  })
})

describe('buildMapPayload', () => {
  it('全件 JSON と同じ形（formatVersion / sourceCatalog / schools）で返す', () => {
    const payload = buildMapPayload([sourceRow(), sourceRow({ id: 'school-2' })])
    expect(payload.formatVersion).toBe(2)
    expect(payload.sourceCatalog).toEqual([])
    expect(payload.schools.map((s) => s.id)).toEqual(['school-1', 'school-2'])
  })
})
