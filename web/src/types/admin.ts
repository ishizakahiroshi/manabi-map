/**
 * Admin dashboard response types consumed by the React UI.
 *
 * Pages Functions are deployed separately from web/src, so they cannot safely
 * import this module in every Cloudflare build configuration. Keep the JSON
 * shapes here synchronized manually with functions/api/admin/*.ts.
 */

export interface Summary {
  tiles: {
    clicks: number
    impressions: number
    avgPosition: number | null
    visits: number
    usersTotal: number
    favoritesTotal: number
    delta: {
      clicks: number
      impressions: number
      visits: number
      usersTotal: number
    }
  }
  series: {
    dates: string[]
    clicks: number[]
    impressions: number[]
    visits: number[]
    newUsers: number[]
  }
}

export interface RankedRow {
  query?: string
  page?: string
  clicks: number
  impressions: number
  ctr: number | null
  position: number | null
}

export type Ranked = RankedRow[]

export interface AdminCoverage {
  pagesWithImpressions: number
  sitemapPageCount: number
}

export interface AdminReferer {
  referer: string
  visits: number
}

export interface AdminDimRow {
  value: string
  visits: number
}

export type AdminDims = Record<string, AdminDimRow[]>

export interface MaintenanceState {
  on: boolean
  updatedAt: string
  updatedBy: string | null
}

export type ReportStatus = 'pending' | 'reviewed' | 'applied' | 'rejected'

export interface Report {
  id: string
  school_id: string
  department_id: string | null
  field: string
  proposed_value: string
  source: string
  comment: string | null
  status: ReportStatus
  created_at: string
  reviewed_at: string | null
  school_name?: string
  department_name?: string
}
