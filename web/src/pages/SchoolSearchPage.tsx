import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../contexts/AppContext'
import { useI18n } from '../contexts/I18nContext'
import { useSchools } from '../hooks/useSchools'
import { trackEvent } from '../lib/analytics'
import type { School } from '../types/school'

const MAX_RESULTS = 50

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/\s+/g, '')
}

function topDeviation(school: School): number | null {
  let best: number | null = null
  for (const d of school.departments) {
    if (d.deviation != null && (best == null || d.deviation > best)) best = d.deviation
  }
  return best
}

export function SchoolSearchPage() {
  const navigate = useNavigate()
  const { setHome } = useApp()
  const { t } = useI18n()
  const { schools, loading, error } = useSchools()
  const [q, setQ] = useState('')

  const results = useMemo(() => {
    const query = normalize(q.trim())
    if (query.length < 1) return []
    return schools
      .filter((s) => {
        const hay = normalize(`${s.name} ${s.name_kana ?? ''} ${s.prefecture} ${s.city ?? ''}`)
        return hay.includes(query)
      })
      .slice(0, MAX_RESULTS)
  }, [schools, q])

  const openSchool = (school: School) => {
    trackEvent('search', { source: 'school_name' })
    setHome({ label: school.name, lat: school.latitude, lng: school.longitude })
    navigate(`/school/${school.id}`)
  }

  return (
    <div className="screen">
      <div className="header">
        <button className="icon-btn" onClick={() => navigate(-1)} aria-label={t('common.back')}>
          ←
        </button>
        <div className="brand">{t('schoolSearch.title')}</div>
      </div>
      <main id="main-content" className="content home-content" tabIndex={-1}>
        <label htmlFor="school-q" className="form-label">
          {t('schoolSearch.label')}
        </label>
        <div className="q-wrap">
          <input
            id="school-q"
            className="input"
            autoComplete="off"
            autoFocus
            placeholder={t('schoolSearch.placeholder')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {q && (
            <button className="q-clear" onClick={() => setQ('')} title={t('common.clear')} aria-label={t('common.clear')}>
              ×
            </button>
          )}
        </div>

        {loading && <div className="mini-hint">{t('common.loading')}</div>}
        {error && <div className="mini-hint bad" role="alert">{error}</div>}

        {!loading && !error && q.trim().length === 0 && (
          <div className="mini-hint soft">{t('schoolSearch.hint')}</div>
        )}

        {!loading && !error && q.trim().length > 0 && results.length === 0 && (
          <div className="mini-hint">{t('schoolSearch.noResults')}</div>
        )}

        {results.length > 0 && (
          <div className="mini-hint soft" aria-live="polite">
            {t('schoolSearch.resultCount', { n: String(results.length), max: String(MAX_RESULTS) })}
          </div>
        )}

        <div className="q-results" role="listbox" aria-label={t('schoolSearch.label')}>
          {results.map((s) => {
            const dev = topDeviation(s)
            return (
              <button
                key={s.id}
                role="option"
                aria-selected={false}
                className="cand"
                onClick={() => openSchool(s)}
              >
                <span className="cand-body">
                  <b>{s.name}</b>
                  <span className="cand-sub">
                    {s.prefecture}
                    {s.city ? ` ${s.city}` : ''}
                    {dev != null ? ` ・ ${t('schoolSearch.deviationLabel', { v: String(dev) })}` : ''}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </main>
    </div>
  )
}
