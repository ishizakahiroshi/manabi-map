import type { School } from '../types/school'

export interface ThreeYearApplicantRatio {
  /** 新しい順の3年度。連続した年度だけを対象にする。 */
  years: [number, number, number]
  /** 各年度の志願倍率を等しく扱った3年平均。 */
  average: number
}

/**
 * 学校カード用の直近3年・志願倍率平均を返す。
 *
 * 同じ年度に学科別行と学校全体行が共存する場合は、学科別行を合算して二重計上を避ける。
 * 連続する3年度の募集定員・志願者数がそろう場合だけ返し、欠年や未公表を推測で埋めない。
 */
/** 倍率フィルタの区分。志願状況の絞り込み用で、難易度の区分ではない。 */
export type ApplicantRatioBand = 'under1' | 'from1' | 'from1_2' | 'from1_5' | 'unknown'

export const APPLICANT_RATIO_BANDS = ['under1', 'from1', 'from1_2', 'from1_5', 'unknown'] as const

/**
 * 学校カードに表示する値（小数第2位丸め）と同じ値で区分し、
 * 表示上「1.20」の学校がフィルタでは 1.0〜1.2 に入る、というずれを防ぐ。
 */
export function applicantRatioBand(school: School): ApplicantRatioBand {
  const ratio = threeYearApplicantRatio(school)
  if (ratio == null) return 'unknown'
  const shown = Number(ratio.average.toFixed(2))
  if (shown < 1) return 'under1'
  if (shown < 1.2) return 'from1'
  if (shown < 1.5) return 'from1_2'
  return 'from1_5'
}

export function threeYearApplicantRatio(school: School): ThreeYearApplicantRatio | null {
  const byYear = new Map<
    number,
    { departmentCapacity: number; departmentApplicants: number; hasDepartment: boolean; wholeCapacity: number; wholeApplicants: number; hasWhole: boolean }
  >()

  for (const stat of school.admission_stats) {
    if (stat.capacity == null || stat.capacity <= 0 || stat.applicants == null) continue
    const entry = byYear.get(stat.year) ?? {
      departmentCapacity: 0,
      departmentApplicants: 0,
      hasDepartment: false,
      wholeCapacity: 0,
      wholeApplicants: 0,
      hasWhole: false,
    }
    if (stat.department_id == null) {
      entry.wholeCapacity += stat.capacity
      entry.wholeApplicants += stat.applicants
      entry.hasWhole = true
    } else {
      entry.departmentCapacity += stat.capacity
      entry.departmentApplicants += stat.applicants
      entry.hasDepartment = true
    }
    byYear.set(stat.year, entry)
  }

  const annual = [...byYear.entries()]
    .map(([year, value]) => {
      const capacity = value.hasDepartment ? value.departmentCapacity : value.hasWhole ? value.wholeCapacity : 0
      const applicants = value.hasDepartment ? value.departmentApplicants : value.hasWhole ? value.wholeApplicants : 0
      return capacity > 0 ? { year, ratio: applicants / capacity } : null
    })
    .filter((value): value is { year: number; ratio: number } => value != null)
    .sort((a, b) => b.year - a.year)

  if (annual.length < 3) return null
  const latestThree = annual.slice(0, 3)
  if (latestThree[0].year - latestThree[2].year !== 2) return null

  return {
    years: [latestThree[0].year, latestThree[1].year, latestThree[2].year],
    average: latestThree.reduce((sum, year) => sum + year.ratio, 0) / 3,
  }
}
