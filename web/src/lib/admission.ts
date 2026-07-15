import type { AdmissionSelection, School } from '../types/school'

export interface AnnualAdmissionRatio {
  year: number
  capacity: number
  applicants: number
  ratio: number
}

export type AdmissionContinuity = 'three' | 'two' | 'gapped' | 'one'

export interface PrimaryAdmissionTrend {
  /** 比較可能な年度のみ。新しい順。 */
  annual: AnnualAdmissionRatio[]
  continuity: AdmissionContinuity
  /** 直近3年度が連続し、募集範囲の署名も同一の場合だけ返す年度別倍率の平均。 */
  average: number | null
}

interface AnnualWithScope extends AnnualAdmissionRatio {
  scopeSignature: string
}

/** 倍率フィルタの区分。志願状況の絞り込み用で、難易度の区分ではない。 */
export type ApplicantRatioBand = 'under1' | 'from1' | 'from1_2' | 'from1_5' | 'unknown'

export const APPLICANT_RATIO_BANDS = ['under1', 'from1', 'from1_2', 'from1_5', 'unknown'] as const

function isMapComparable(selection: AdmissionSelection): boolean {
  return (
    selection.selection_stage_code === 'primary' &&
    selection.map_role_code === 'primary_total' &&
    selection.is_ratio_comparable &&
    selection.capacity != null &&
    selection.capacity > 0 &&
    selection.applicants != null
  )
}

/**
 * 1年度分の募集単位が安全に合算できるかを検査する。
 *
 * - 同じ募集単位の複数採用
 * - 学校全体と学科・学科群単位の共存
 * - 募集単位間の学科 membership 重複
 *
 * のいずれかがあれば、その年度を丸ごと採用しない。部分的な差し引きや推測合算はしない。
 */
function aggregateYear(year: number, selections: AdmissionSelection[]): AnnualWithScope | null {
  const unitIds = new Set<string>()
  for (const selection of selections) {
    if (unitIds.has(selection.recruitment_unit_id)) return null
    unitIds.add(selection.recruitment_unit_id)
  }

  const schoolWide = selections.filter((selection) => selection.unit_kind_code === 'school')
  if (schoolWide.length > 0 && (schoolWide.length > 1 || selections.length > 1)) return null

  const claimedDepartments = new Set<string>()
  for (const selection of selections) {
    for (const departmentId of new Set(selection.department_ids)) {
      if (claimedDepartments.has(departmentId)) return null
      claimedDepartments.add(departmentId)
    }
  }

  const capacity = selections.reduce((sum, selection) => sum + selection.capacity!, 0)
  const applicants = selections.reduce((sum, selection) => sum + selection.applicants!, 0)
  if (capacity <= 0) return null

  const scopeSignature = selections
    .map((selection) =>
      [
        selection.unit_key,
        selection.selection_stage_code,
        selection.selection_track_code,
        selection.scope_key,
        selection.course_time ?? '',
        selection.population_scope_raw ?? '',
      ].join('\u001f'),
    )
    .sort()
    .join('\u001e')

  return { year, capacity, applicants, ratio: applicants / capacity, scopeSignature }
}

function continuityOf(annual: AnnualWithScope[]): AdmissionContinuity {
  if (
    annual.length >= 3 &&
    annual[0].year - annual[1].year === 1 &&
    annual[1].year - annual[2].year === 1
  ) {
    return 'three'
  }
  if (annual.length >= 2 && annual[0].year - annual[1].year === 1) return 'two'
  if (annual.length >= 2) return 'gapped'
  return 'one'
}

/**
 * 公式の一次募集全体として比較可能と裁定された新モデルだけから、学校の志願状況を返す。
 * 旧 school_admission_stats は参照しない。
 */
export function primaryAdmissionTrend(school: School): PrimaryAdmissionTrend | null {
  const byYear = new Map<number, AdmissionSelection[]>()
  for (const selection of school.admission_selections ?? []) {
    if (!isMapComparable(selection)) continue
    const values = byYear.get(selection.year) ?? []
    values.push(selection)
    byYear.set(selection.year, values)
  }

  const annualWithScope = [...byYear.entries()]
    .map(([year, selections]) => {
      // 全日制と定時制・通信制は同じ学校でも別の募集scope。
      // 全日制が公表されていれば地図の代表値には全日制だけを使う。
      // 全日制が無い学校は、単一course_timeだけならその課程を表示する。
      const fulltime = selections.filter((selection) => selection.course_time === 'fulltime')
      const scoped = fulltime.length > 0 ? fulltime : selections
      const courseTimes = new Set(scoped.map((selection) => selection.course_time ?? 'unknown'))
      if (courseTimes.size > 1) return null
      return aggregateYear(year, scoped)
    })
    .filter((value): value is AnnualWithScope => value != null)
    .sort((a, b) => b.year - a.year)

  if (annualWithScope.length === 0) return null
  const continuity = continuityOf(annualWithScope)
  const latestThree = annualWithScope.slice(0, 3)
  const canAverage =
    continuity === 'three' &&
    latestThree.every((value) => value.scopeSignature === latestThree[0].scopeSignature)
  const average = canAverage
    ? latestThree.reduce((sum, value) => sum + value.ratio, 0) / latestThree.length
    : null

  return {
    annual: annualWithScope.map(({ scopeSignature: _scopeSignature, ...annual }) => annual),
    continuity,
    average,
  }
}

/**
 * 地図カードに表示する最新年度値（小数第2位丸め）と同じ値で区分する。
 * 3年平均では分類しない。
 */
export function applicantRatioBand(school: School): ApplicantRatioBand {
  const latest = primaryAdmissionTrend(school)?.annual[0]
  if (latest == null) return 'unknown'
  const shown = Number(latest.ratio.toFixed(2))
  if (shown < 1) return 'under1'
  if (shown < 1.2) return 'from1'
  if (shown < 1.5) return 'from1_2'
  return 'from1_5'
}

/** @deprecated 詳細・地図とも primaryAdmissionTrend を使う。新モデルのみを読む互換ラッパー。 */
export function threeYearApplicantRatio(
  school: School,
): { years: [number, number, number]; average: number } | null {
  const trend = primaryAdmissionTrend(school)
  if (trend?.average == null || trend.annual.length < 3) return null
  return {
    years: [trend.annual[0].year, trend.annual[1].year, trend.annual[2].year],
    average: trend.average,
  }
}
