import { describe, expect, it } from 'vitest'
import type { AdmissionSelection, School } from '../types/school'
import { applicantRatioBand, primaryAdmissionTrend } from './admission'

function selection(
  year: number,
  capacity: number,
  applicants: number,
  overrides: Partial<AdmissionSelection> = {},
): AdmissionSelection {
  const unitKey = overrides.unit_key ?? 'school-fulltime'
  return {
    id: overrides.id ?? `${unitKey}-${year}`,
    recruitment_unit_id: overrides.recruitment_unit_id ?? unitKey,
    unit_key: unitKey,
    unit_kind_code: 'school',
    unit_label: '全校',
    course_time: 'fulltime',
    department_ids: [],
    valid_from_year: null,
    valid_to_year: null,
    year,
    selection_stage_code: 'primary',
    selection_track_code: 'combined',
    stage_label_raw: '第一次募集',
    track_label_raw: '一般・特色',
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
    exam_components: [],
    quality_flags: [],
    sources: [],
    ...overrides,
  }
}

function school(admissionSelections: AdmissionSelection[]): School {
  return {
    id: 'school-1',
    record_key: 'test-school-1',
    name: 'テスト校',
    name_kana: null,
    type: 'high_school',
    ownership: 'prefectural',
    gender_type: 'coed',
    is_integrated: false,
    postal_code: null,
    prefecture: '宮城県',
    city: null,
    address: '',
    latitude: 0,
    longitude: 0,
    official_url: null,
    is_active: true,
    is_recruiting: true,
    lifecycle_status_code: 'active',
    recruitment_status_code: 'recruiting',
    legally_established_on: null,
    opened_on: null,
    recruitment_ended_on: null,
    closed_on: null,
    status_official_url: null,
    status_note: null,
    course_times: ['fulltime'],
    main_school_name: null,
    campus_type: 'main',
    total_students: null,
    enrollment_year: null,
    male_ratio: null,
    departments: [],
    admission_stats: [],
    admission_selections: admissionSelections,
    predecessor_relationships: [],
    name_history: [],
  }
}

describe('primaryAdmissionTrend', () => {
  it('連続3年は年度別値と3年平均を返す', () => {
    const trend = primaryAdmissionTrend(
      school([selection(2024, 100, 90), selection(2026, 100, 120), selection(2025, 100, 150)]),
    )

    expect(trend).toEqual({
      annual: [
        { year: 2026, capacity: 100, applicants: 120, ratio: 1.2 },
        { year: 2025, capacity: 100, applicants: 150, ratio: 1.5 },
        { year: 2024, capacity: 100, applicants: 90, ratio: 0.9 },
      ],
      continuity: 'three',
      average: 1.2,
    })
  })

  it('連続2年は two、平均なし', () => {
    const trend = primaryAdmissionTrend(school([selection(2026, 100, 110), selection(2025, 80, 80)]))
    expect(trend?.continuity).toBe('two')
    expect(trend?.average).toBeNull()
  })

  it('隔年2年は gapped、平均なし', () => {
    const trend = primaryAdmissionTrend(school([selection(2026, 100, 110), selection(2024, 100, 90)]))
    expect(trend?.annual.map(({ year }) => year)).toEqual([2026, 2024])
    expect(trend?.continuity).toBe('gapped')
    expect(trend?.average).toBeNull()
  })

  it('最新1年は one、平均なし', () => {
    const trend = primaryAdmissionTrend(school([selection(2026, 100, 110)]))
    expect(trend?.continuity).toBe('one')
    expect(trend?.average).toBeNull()
  })

  it('年度間のscope署名が不一致なら年度別表示だけ残して平均しない', () => {
    const trend = primaryAdmissionTrend(
      school([
        selection(2026, 100, 110, { scope_key: 'external-only' }),
        selection(2025, 100, 120, { scope_key: 'external-and-special' }),
        selection(2024, 100, 90, { scope_key: 'external-only' }),
      ]),
    )
    expect(trend?.annual).toHaveLength(3)
    expect(trend?.continuity).toBe('three')
    expect(trend?.average).toBeNull()
  })

  it('定員改定があっても同一scopeなら各年度倍率を等しく平均する', () => {
    const trend = primaryAdmissionTrend(
      school([selection(2026, 80, 120), selection(2025, 100, 100), selection(2024, 120, 60)]),
    )
    expect(trend?.annual.map(({ ratio }) => ratio)).toEqual([1.5, 1, 0.5])
    expect(trend?.average).toBe(1)
  })

  it('くくり募集は複数学科membershipでも募集単位を1度だけ数える', () => {
    const grouped = selection(2026, 120, 150, {
      recruitment_unit_id: 'group-1',
      unit_key: 'engineering-group',
      unit_kind_code: 'department_group',
      unit_label: '工業系くくり募集',
      department_ids: ['mechanical', 'electrical', 'informatics'],
    })
    expect(primaryAdmissionTrend(school([grouped]))?.annual[0]).toEqual({
      year: 2026,
      capacity: 120,
      applicants: 150,
      ratio: 1.25,
    })
  })

  it('同年度のmembership重複は年度全体を除外し、推測合算しない', () => {
    const selections = [
      selection(2026, 40, 50, {
        recruitment_unit_id: 'group-a',
        unit_key: 'group-a',
        unit_kind_code: 'department_group',
        department_ids: ['general', 'science'],
      }),
      selection(2026, 40, 60, {
        recruitment_unit_id: 'group-b',
        unit_key: 'group-b',
        unit_kind_code: 'department_group',
        department_ids: ['science', 'international'],
      }),
      selection(2025, 100, 100),
    ]
    const trend = primaryAdmissionTrend(school(selections))
    expect(trend?.annual.map(({ year }) => year)).toEqual([2025])
    expect(trend?.continuity).toBe('one')
  })

  it('学校全体と学科単位が共存する年度は除外する', () => {
    const whole = selection(2026, 100, 100)
    const department = selection(2026, 40, 50, {
      recruitment_unit_id: 'department-1',
      unit_key: 'department-1',
      unit_kind_code: 'department',
      department_ids: ['department-1'],
    })
    expect(primaryAdmissionTrend(school([whole, department]))).toBeNull()
  })

  it('全日制と定時制を合算せず、全日制があれば地図の代表値にする', () => {
    const fulltime = selection(2026, 100, 120)
    const parttime = selection(2026, 40, 20, {
      id: 'parttime',
      recruitment_unit_id: 'parttime',
      unit_key: 'parttime',
      unit_kind_code: 'time_division',
      unit_label: '定時制',
      course_time: 'parttime',
    })
    expect(primaryAdmissionTrend(school([fulltime, parttime]))?.annual[0]).toEqual({
      year: 2026,
      capacity: 100,
      applicants: 120,
      ratio: 1.2,
    })
  })

  it('定時制だけの学校は定時制の一次募集を表示できる', () => {
    const parttime = selection(2026, 40, 20, {
      course_time: 'parttime',
      unit_kind_code: 'time_division',
      unit_label: '定時制',
    })
    expect(primaryAdmissionTrend(school([parttime]))?.annual[0].ratio).toBe(0.5)
  })

  it('対象外stage/role/comparable行と旧admission_statsを地図集計に使わない', () => {
    const target = school([
      selection(2026, 100, 120),
      selection(2026, 10, 100, {
        id: 'secondary',
        recruitment_unit_id: 'secondary',
        selection_stage_code: 'secondary',
      }),
      selection(2026, 10, 100, {
        id: 'component',
        recruitment_unit_id: 'component',
        map_role_code: 'component_only',
      }),
      selection(2026, 10, 100, {
        id: 'incomparable',
        recruitment_unit_id: 'incomparable',
        is_ratio_comparable: false,
      }),
    ])
    target.admission_stats = [
      {
        department_id: null,
        year: 2026,
        capacity: 1,
        applicants: 100,
        examinees: null,
        admitted: null,
        note: null,
        source_url: null,
      },
    ]
    expect(primaryAdmissionTrend(target)?.annual[0].ratio).toBe(1.2)
    expect(applicantRatioBand(target)).toBe('from1_2')
  })
})

describe('applicantRatioBand', () => {
  it.each([
    [0.9, 'under1'],
    [1, 'from1'],
    [1.2, 'from1_2'],
    [1.5, 'from1_5'],
  ] as const)('最新年度倍率 %s を境界どおり分類する', (ratio, expected) => {
    expect(applicantRatioBand(school([selection(2026, 1000, ratio * 1000)]))).toBe(expected)
  })

  it('最新年度の表示丸め後の値で分類する', () => {
    expect(applicantRatioBand(school([selection(2026, 1000, 1199)]))).toBe('from1_2')
  })

  it('比較可能な新モデルがなければ unknown', () => {
    expect(applicantRatioBand(school([]))).toBe('unknown')
  })
})
