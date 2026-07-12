import { useEffect, useState, type ReactNode } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useApp } from '../contexts/AppContext'
import { LineChart } from '../components/dashboard/LineChart'
import { HBarList } from '../components/dashboard/HBarList'
import { supabase } from '../lib/supabase'
import { MAINTENANCE_MODE } from '../lib/maintenance'
import type { AdminCoverage, AdminDims, AdminReferer, Ranked, Report, ReportStatus, Summary } from '../types/admin'

const fmt = (value: number | null) => value == null ? '—' : value.toLocaleString('ja-JP')
const fmtPercent = (value: number | null) => value == null ? '—' : `${(value * 100).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}%`

const REPORT_STATUSES: ReportStatus[] = ['reviewed', 'applied', 'rejected']

function DashboardTabs({ tab, onChange }: { tab: 'metrics' | 'reports'; onChange: (tab: 'metrics' | 'reports') => void }) {
  return (
    <div className="dashboard-tabs" role="tablist" aria-label="管理ダッシュボードの表示切替">
      <button className={`chip ${tab === 'metrics' ? 'on' : ''}`} role="tab" aria-selected={tab === 'metrics'} onClick={() => onChange('metrics')}>
        アクセス分析
      </button>
      <button className={`chip ${tab === 'reports' ? 'on' : ''}`} role="tab" aria-selected={tab === 'reports'} onClick={() => onChange('reports')}>
        情報提供レポート
      </button>
    </div>
  )
}

function reportFieldLabel(field: string): string {
  const labels: Record<string, string> = {
    capacity: '募集定員',
    total_students: '生徒数',
    male_ratio: '男女比',
    deviation: '偏差値',
    other: 'その他',
  }
  return labels[field] ?? field
}

function reportStatusLabel(status: ReportStatus): string {
  return { pending: '未確認', reviewed: '確認済み', applied: '反映済み', rejected: '見送り' }[status]
}

function ReportsPanel() {
  const { session } = useAuth()
  const { toast } = useApp()
  const [reports, setReports] = useState<Report[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [updating, setUpdating] = useState<string | null>(null)

  useEffect(() => {
    if (!session) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      const { data, error: reportError } = await supabase
        .from('data_reports')
        .select('id, school_id, department_id, field, proposed_value, source, comment, status, created_at, reviewed_at')
        .order('created_at', { ascending: false })
        .limit(200)
      if (reportError) throw reportError
      const rows = (data ?? []) as Report[]
      const schoolIds = [...new Set(rows.map((row) => row.school_id))]
      const departmentIds = [...new Set(rows.map((row) => row.department_id).filter((id): id is string => Boolean(id)))]
      const [schools, departments] = await Promise.all([
        schoolIds.length > 0
          ? supabase.from('schools').select('id, name').in('id', schoolIds)
          : Promise.resolve({ data: [], error: null }),
        departmentIds.length > 0
          ? supabase.from('school_departments').select('id, name').in('id', departmentIds)
          : Promise.resolve({ data: [], error: null }),
      ])
      if (schools.error) throw schools.error
      if (departments.error) throw departments.error
      const schoolNames = new Map((schools.data ?? []).map((row) => [row.id, row.name]))
      const departmentNames = new Map((departments.data ?? []).map((row) => [row.id, row.name]))
      const enriched = rows.map((row) => ({
        ...row,
        school_name: schoolNames.get(row.school_id),
        department_name: row.department_id ? departmentNames.get(row.department_id) : undefined,
      }))
      if (!cancelled) {
        setReports(enriched)
        setError(false)
      }
    })().catch(() => {
      if (!cancelled) setError(true)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [session])

  const updateStatus = async (reportId: string, status: ReportStatus) => {
    if (MAINTENANCE_MODE || !session) return
    setUpdating(reportId)
    try {
      const { error: updateError } = await supabase
        .from('data_reports')
        .update({ status, reviewed_at: new Date().toISOString(), reviewed_by: session.user.id })
        .eq('id', reportId)
      if (updateError) throw updateError
      setReports((current) => current.map((report) => report.id === reportId ? { ...report, status, reviewed_at: new Date().toISOString() } : report))
    } catch {
      toast('報告のステータスを更新できませんでした')
    } finally {
      setUpdating(null)
    }
  }

  const pendingCount = reports.filter((report) => report.status === 'pending').length
  return (
    <section className="dashboard-reports">
      <div className="dashboard-reports-head">
        <div>
          <h2>情報提供レポート</h2>
          <p className="sub">未確認 {pendingCount} 件。反映済みはステータスだけを管理し、学校データは別途確認して更新します。</p>
        </div>
        <span className="dashboard-report-count">全 {reports.length} 件</span>
      </div>
      {loading && <p>報告を読み込み中…</p>}
      {error && <p>報告を取得できませんでした。</p>}
      {!loading && !error && reports.length === 0 && <p className="dashboard-report-empty">まだ報告はありません。</p>}
      {!loading && !error && reports.length > 0 && (
        <div className="dashboard-report-table-wrap">
          <table className="dashboard-report-table">
            <thead>
              <tr><th>受付日時</th><th>学校 / 項目</th><th>提供値</th><th>出典・補足</th><th>状態</th><th>操作</th></tr>
            </thead>
            <tbody>
              {reports.map((report) => (
                <tr key={report.id}>
                  <td>{new Date(report.created_at).toLocaleString('ja-JP')}</td>
                  <td>
                    <b>{report.school_name ?? report.school_id}</b>
                    <small>{report.department_name ? `${report.department_name} / ` : ''}{reportFieldLabel(report.field)}</small>
                  </td>
                  <td className="dashboard-report-value">{report.proposed_value}</td>
                  <td>
                    {/^https?:\/\//i.test(report.source) ? <a href={report.source} target="_blank" rel="noreferrer">出典 URL</a> : report.source}
                    {report.comment && <small>{report.comment}</small>}
                  </td>
                  <td><span className={`dashboard-report-status ${report.status}`}>{reportStatusLabel(report.status)}</span></td>
                  <td>
                    <div className="dashboard-report-actions">
                      {REPORT_STATUSES.map((status) => (
                        <button
                          key={status}
                          type="button"
                          className={`chip ${report.status === status ? 'on' : ''}`}
                          disabled={MAINTENANCE_MODE || updating === report.id || report.status === status}
                          onClick={() => void updateStatus(report.id, status)}
                        >
                          {reportStatusLabel(status)}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

type PageFrameProps = {
  tab: 'metrics' | 'reports'
  onTabChange: (tab: 'metrics' | 'reports') => void
  snapshotDate?: string | null
  children: ReactNode
}

function DashboardHeader({ tab, onTabChange, snapshotDate }: Omit<PageFrameProps, 'children'>) {
  return (
    <>
      <header className="dashboard-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1>管理ダッシュボード</h1>
          <p className="sub">日次スナップショット（Search Console・Cloudflare Web Analytics・Supabase）</p>
        </div>
        <p className="sub" style={{ margin: 0, textAlign: 'right' }}>
          スナップショット: {snapshotDate ?? '—'}（日次更新）<br />
          データ源: Search Console / Cloudflare Web Analytics / Supabase
        </p>
      </header>
      <DashboardTabs tab={tab} onChange={onTabChange} />
    </>
  )
}

function DashboardFrame({ tab, onTabChange, snapshotDate, children }: PageFrameProps) {
  return (
    <main id="main-content" className="page" style={{ maxWidth: 1120, margin: '0 auto', padding: '24px 16px 88px' }}>
      <DashboardHeader tab={tab} onTabChange={onTabChange} snapshotDate={snapshotDate} />
      {children}
    </main>
  )
}

function PeriodFilter({ days, onChange }: { days: 7 | 28 | 90; onChange: (days: 7 | 28 | 90) => void }) {
  return (
    <div className="dashboard-period-filter" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '8px 0 18px' }}>
      <span className="sub">期間:</span>
      {([7, 28, 90] as const).map((period) => (
        <button key={period} className={`chip ${days === period ? 'on' : ''}`} onClick={() => onChange(period)} aria-pressed={days === period}>
          {period}日
        </button>
      ))}
    </div>
  )
}

function DeltaDisplay({ value }: { value: number }) {
  const trend = value > 0 ? 'up' : value < 0 ? 'down' : 'flat'
  const symbol = value > 0 ? '▲' : value < 0 ? '▼' : '−'
  const number = value > 0 ? `+${fmt(value)}` : fmt(value)
  const description = value > 0 ? '増加' : value < 0 ? '減少' : '変化なし'
  return (
    <span className={`dashboard-delta ${trend}`} aria-label={`前期間比 ${description} ${number}`}>
      {symbol} {number}（前期間比）
    </span>
  )
}

function KpiTiles({ summary }: { summary: Summary }) {
  // 平均掲載順位は小さいほうがよい指標。将来 delta を追加するときは色の意味を反転する。
  const tiles = [
    { source: 'SEARCH CONSOLE', label: 'クリック数', value: summary.tiles.clicks, delta: summary.tiles.delta.clicks },
    { source: 'SEARCH CONSOLE', label: '表示回数', value: summary.tiles.impressions, delta: summary.tiles.delta.impressions },
    { source: 'SEARCH CONSOLE', label: '平均掲載順位', value: summary.tiles.avgPosition },
    { source: 'CLOUDFLARE', label: '訪問数', value: summary.tiles.visits, delta: summary.tiles.delta.visits },
    { source: 'SUPABASE', label: '登録ユーザー', value: summary.tiles.usersTotal, delta: summary.tiles.delta.usersTotal },
    { source: 'SUPABASE', label: 'お気に入り合計', value: summary.tiles.favoritesTotal },
  ] as const

  return (
    <section className="dashboard-kpis" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(145px,1fr))', gap: 10 }}>
      {tiles.map((tile) => (
        <div key={tile.label} className="card">
          <small>{tile.source}</small>
          <div>{tile.label}</div>
          <b className="dashboard-number" style={{ display: 'block', fontSize: 24 }}>{fmt(tile.value)}</b>
          {'delta' in tile && tile.delta !== undefined && <DeltaDisplay value={tile.delta} />}
        </div>
      ))}
    </section>
  )
}

function SearchPerformancePanel({ summary }: { summary: Summary }) {
  return (
    <section>
      <h2>検索パフォーマンス（Google Search Console）</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 12 }}>
        <div className="card">
          <h3>クリック数 / 日</h3>
          <LineChart dates={summary.series.dates} values={summary.series.clicks} />
          <small>クリック数と表示回数はスケールが異なるため、別チャートで表示しています。</small>
        </div>
        <div className="card">
          <h3>表示回数 / 日</h3>
          <LineChart dates={summary.series.dates} values={summary.series.impressions} />
          <small>2 軸チャートは使用していません。</small>
        </div>
      </div>
    </section>
  )
}

function PopularQueriesPanel({ rows, shown }: { rows: Ranked; shown: number }) {
  return (
    <div className="card">
      <h3>人気クエリ</h3>
      <HBarList rows={rows.slice(0, shown).map((row) => ({ label: row.query ?? '', value: row.clicks }))} />
    </div>
  )
}

function IndexCoverageCard({ coverage }: { coverage: AdminCoverage }) {
  const percentage = coverage.sitemapPageCount
    ? Math.min(100, Math.round(coverage.pagesWithImpressions / coverage.sitemapPageCount * 100))
    : 0

  return (
    <div className="card">
      <h3>インデックス状況</h3>
      <b className="dashboard-number">{coverage.pagesWithImpressions.toLocaleString()} / {coverage.sitemapPageCount.toLocaleString()} ページ（{percentage}%）</b>
      <div style={{ height: 20, background: '#e7e0d2', marginTop: 8 }}>
        <div style={{ height: '100%', width: `${percentage}%`, background: '#e8622a' }} />
      </div>
      <small>検索表示実績のあるページ数。正確な登録数は GSC 画面で確認してください。</small>
    </div>
  )
}

function SearchSummaryPanels({ queries, coverage, shown }: { queries: Ranked; coverage: AdminCoverage; shown: number }) {
  return (
    <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 12 }}>
      <PopularQueriesPanel rows={queries} shown={shown} />
      <IndexCoverageCard coverage={coverage} />
    </section>
  )
}

function RankedTable({ rows }: { rows: Ranked }) {
  return (
    <div className="dashboard-table-wrap" style={{ overflowX: 'auto' }}>
      <table className="dashboard-table" style={{ width: '100%', minWidth: 560 }}>
        <thead>
          <tr><th>ページ</th><th className="dashboard-number">クリック</th><th className="dashboard-number">表示回数</th><th className="dashboard-number">CTR</th><th className="dashboard-number">平均順位</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.page}>
              <td>{row.page}</td>
              <td className="dashboard-number">{fmt(row.clicks)}</td>
              <td className="dashboard-number">{fmt(row.impressions)}</td>
              <td className="dashboard-number">{fmtPercent(row.ctr)}</td>
              <td className="dashboard-number">{fmt(row.position)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PopularPagesPanel({ rows, shown }: { rows: Ranked; shown: number }) {
  return (
    <section>
      <h2>人気ページ</h2>
      <RankedTable rows={rows.slice(0, shown)} />
    </section>
  )
}

function AccessPanel({ summary, referers, shown }: { summary: Summary; referers: AdminReferer[]; shown: number }) {
  return (
    <section>
      <h2>アクセス（Cloudflare Web Analytics）</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 12 }}>
        <div className="card">
          <h3>訪問数 / 日</h3>
          <LineChart dates={summary.series.dates} values={summary.series.visits} />
        </div>
        <div className="card">
          <h3>流入元（Referer 上位）</h3>
          <HBarList rows={referers.slice(0, shown).map((row) => ({ label: row.referer, value: row.visits }))} />
        </div>
      </div>
    </section>
  )
}

const DIMENSION_LABELS: Record<string, string> = {
  country: '国',
  browser: 'ブラウザ',
  os: 'OS',
  device: 'デバイス',
}

function EnvironmentBreakdown({ dims }: { dims: AdminDims }) {
  const order = ['country', 'browser', 'os', 'device']
  const entries = Object.entries(dims).sort(([a], [b]) => {
    const aIndex = order.indexOf(a)
    const bIndex = order.indexOf(b)
    return (aIndex < 0 ? order.length : aIndex) - (bIndex < 0 ? order.length : bIndex)
  })

  return (
    <div>
      <h3>環境内訳</h3>
      <small>訪問数の多い順</small>
      {entries.map(([type, rows]) => (
        <div key={type} style={{ marginTop: 10 }}>
          <b>{DIMENSION_LABELS[type] ?? type}</b>
          <HBarList rows={[...rows].sort((a, b) => b.visits - a.visits).slice(0, 5).map((row) => ({ label: row.value, value: row.visits }))} />
        </div>
      ))}
    </div>
  )
}

function AppMetricsPanel({ summary, dims }: { summary: Summary; dims: AdminDims }) {
  return (
    <section>
      <h2>アプリ内指標（Supabase）</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 12 }}>
        <div className="card">
          <h3>新規登録ユーザー / 日</h3>
          <LineChart dates={summary.series.dates} values={summary.series.newUsers} unit="人" />
        </div>
        <div className="card">
          <EnvironmentBreakdown dims={dims} />
        </div>
      </div>
    </section>
  )
}

export function DashboardPage() {
  const { session } = useAuth()
  const [days, setDays] = useState<7 | 28 | 90>(28)
  const [tab, setTab] = useState<'metrics' | 'reports'>('metrics')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [queries, setQueries] = useState<Ranked>([])
  const [pages, setPages] = useState<Ranked>([])
  const [coverage, setCoverage] = useState<AdminCoverage>({ pagesWithImpressions: 0, sitemapPageCount: 0 })
  const [referers, setReferers] = useState<AdminReferer[]>([])
  const [dims, setDims] = useState<AdminDims>({})
  const [error, setError] = useState(false)
  const [more, setMore] = useState(false)

  useEffect(() => {
    if (!session) return
    let cancelled = false
    const get = async <T,>(path: string): Promise<T> => {
      const response = await fetch(path, { headers: { authorization: `Bearer ${session.access_token}` } })
      if (!response.ok) throw new Error('request failed')
      return response.json() as Promise<T>
    }

    void Promise.all([
      get<Summary>(`/api/admin/summary?days=${days}`),
      get<Ranked>(`/api/admin/queries?days=${days}&limit=50`),
      get<Ranked>(`/api/admin/pages?days=${days}&limit=50`),
      get<AdminCoverage>(`/api/admin/coverage?days=${days}`),
      get<AdminReferer[]>(`/api/admin/referers?days=${days}`),
      get<AdminDims>(`/api/admin/dims?days=${days}`),
    ]).then(([nextSummary, nextQueries, nextPages, nextCoverage, nextReferers, nextDims]) => {
      if (cancelled) return
      setSummary(nextSummary)
      setQueries(nextQueries)
      setPages(nextPages)
      setCoverage(nextCoverage)
      setReferers(nextReferers)
      setDims(nextDims)
      setError(false)
    }).catch(() => {
      if (!cancelled) setError(true)
    })

    return () => { cancelled = true }
  }, [days, session])

  const snapshotDate = summary?.series.dates.at(-1) ?? null
  const frameProps = { tab, onTabChange: setTab, snapshotDate }

  if (tab === 'reports') return <DashboardFrame {...frameProps}><ReportsPanel /></DashboardFrame>
  if (error) return <DashboardFrame {...frameProps}><p>データを取得できませんでした。</p></DashboardFrame>
  if (!summary) return <DashboardFrame {...frameProps}><p>読み込み中…</p></DashboardFrame>
  if (summary.series.dates.length === 0) return <DashboardFrame {...frameProps}><p>収集ジョブの初回実行待ちです。</p></DashboardFrame>

  const shown = more ? 50 : 8
  const canShowMore = queries.length > 8 || pages.length > 8

  return (
    <DashboardFrame {...frameProps}>
      <PeriodFilter days={days} onChange={setDays} />
      <KpiTiles summary={summary} />
      <SearchPerformancePanel summary={summary} />
      <SearchSummaryPanels queries={queries} coverage={coverage} shown={shown} />
      <PopularPagesPanel rows={pages} shown={shown} />
      <AccessPanel summary={summary} referers={referers} shown={shown} />
      <AppMetricsPanel summary={summary} dims={dims} />
      {canShowMore && (
        <button className="chip" onClick={() => setMore((value) => !value)} aria-expanded={more}>
          {more ? '閉じる' : 'もっと見る'}
        </button>
      )}
    </DashboardFrame>
  )
}
