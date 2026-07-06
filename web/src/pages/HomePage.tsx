import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../contexts/AppContext'
import { useI18n } from '../contexts/I18nContext'
import { parsePostal, geocodeSearch, ACTIVE_GEOCODER, type GeocodeCandidate } from '../lib/geo'
import { trackEvent } from '../lib/analytics'
import type { HomeLocation } from '../types/school'
import { AdSlot } from './../components/AdSlot'
import { slotsForPlacement } from '../data/ad-slots'

const DEMO_HOMES: Record<string, HomeLocation & { fill: string }> = {
  東京駅: { label: '東京駅 丸の内', lat: 35.6812, lng: 139.7671, fill: '東京都千代田区丸の内一丁目' },
}

type Hint = { text: string; tone: 'accent' | 'ok' | 'bad' | 'soft' }

export function HomePage() {
  const navigate = useNavigate()
  const { setHome, toast, setLoginOpen } = useApp()
  const { t } = useI18n()
  const [q, setQ] = useState('')
  const [hint, setHint] = useState<Hint | null>(null)
  const [candidates, setCandidates] = useState<GeocodeCandidate[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const [selected, setSelected] = useState<(HomeLocation & { source: string }) | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastQuery = useRef('')

  const onQueryInput = (v: string) => {
    setQ(v)
    setSelected(null)
    setSearchError(false)
    if (timer.current) clearTimeout(timer.current)
    if (!v.trim()) {
      setHint(null)
      setCandidates(null)
      return
    }
    const local = parsePostal(v.trim())
    if (local) {
      setHint({ text: t('home.searchPostal', { label: local.label }), tone: 'ok' })
      setSelected({ label: `〒${v.replace(/[^0-9-]/g, '')} ${local.label}`, lat: local.lat, lng: local.lng, source: 'postal' })
    } else {
      setHint({ text: t('home.searching'), tone: 'soft' })
    }
    timer.current = setTimeout(() => void runSearch(v.trim(), !!local), 400)
  }

  const runSearch = async (query: string, hasPostal: boolean) => {
    if (query === lastQuery.current) return
    lastQuery.current = query
    setSearching(true)
    try {
      const items = await geocodeSearch(query)
      setCandidates(items)
      setSearchError(false)
      if (items.length > 0 && !hasPostal) {
        pick(items[0])
      }
    } catch {
      setCandidates(null)
      setSearchError(true)
    } finally {
      setSearching(false)
    }
  }

  const pick = (c: GeocodeCandidate) => {
    setSelected({ label: c.label, lat: c.lat, lng: c.lng, source: ACTIVE_GEOCODER })
    setHint({ text: t('home.searchOk', { label: c.label }), tone: 'ok' })
  }

  const clearQuery = () => {
    setQ('')
    setHint(null)
    setCandidates(null)
    setSelected(null)
    setSearchError(false)
    lastQuery.current = ''
  }

  const useGeolocation = () => {
    if (!navigator.geolocation) {
      setHint({ text: t('home.geoNoSupport'), tone: 'bad' })
      return
    }
    setHint({ text: t('home.geoFetching'), tone: 'accent' })
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords
        setSelected({ label: t('home.geoDone'), lat, lng, source: 'geo' })
        setHint({
          text: t('home.geoOk', { lat: lat.toFixed(3), lng: lng.toFixed(3) }),
          tone: 'ok',
        })
        setCandidates(null)
        toast(t('home.geoDone'))
      },
      (err) => {
        const msg =
          err.code === 1
            ? t('home.geoDenied')
            : err.code === 2
              ? t('home.geoUnavailable')
              : err.code === 3
                ? t('home.geoTimeout')
                : t('home.geoError')
        setHint({ text: msg, tone: 'bad' })
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 },
    )
  }

  const goToMap = () => {
    if (selected) {
      trackEvent('search', { source: selected.source, result_count: candidates?.length })
      setHome({ label: selected.label, lat: selected.lat, lng: selected.lng })
      navigate('/map')
      return
    }
    const p = parsePostal(q.trim())
    if (p) {
      trackEvent('search', { source: 'postal' })
      setHome(p)
      navigate('/map')
      return
    }
    if (!q.trim()) {
      toast(t('home.needInput'))
      return
    }
    toast(t('home.pickCandidate'))
  }

  const loadDemo = (key: keyof typeof DEMO_HOMES) => {
    const d = DEMO_HOMES[key]
    trackEvent('search', { source: 'demo' })
    setHome({ label: d.label, lat: d.lat, lng: d.lng })
    setQ(d.fill)
    setCandidates(null)
    setSelected(null)
    navigate('/map')
  }

  return (
    <main id="main-content" className="content home-content" tabIndex={-1}>
      <h1 className="catch">
        {t('home.catch1')}
        <br />
        <span className="accent">{t('home.catch2')}</span>
        {t('home.catch3')}
      </h1>
      <p className="sub">
        {t('home.sub1')}
        <br />
        {t('home.sub2')}
      </p>

      <label htmlFor="q" className="form-label">
        {t('home.searchLabel')}
      </label>
      <div className="q-wrap">
        <input
          id="q"
          className="input"
          autoComplete="off"
          placeholder={t('home.searchPlaceholder')}
          value={q}
          onChange={(e) => onQueryInput(e.target.value)}
        />
        <button className="q-clear" onClick={clearQuery} title={t('common.clear')} aria-label={t('common.clear')}>
          ×
        </button>
      </div>
      {hint && <div className={`mini-hint ${hint.tone === 'accent' ? '' : hint.tone}`}>{hint.text}</div>}
      <div className="q-results" role="listbox" aria-label={t('home.searchLabel')}>
        {searching && <div className="spinner">{t('home.searchingPlaces')}</div>}
        {searchError && <div className="nores error">{t('home.searchFail')}</div>}
        {!searching && !searchError && candidates?.length === 0 && (
          <div className="nores">{t('home.searchNone')}</div>
        )}
        {!searching &&
          candidates?.map((c, i) => (
            <button
              key={i}
              role="option"
              aria-selected={selected?.label === c.label}
              className={`cand ${selected?.label === c.label ? 'on' : ''}`}
              onClick={() => pick(c)}
            >
              <span className="cand-icon" aria-hidden="true">{c.icon}</span>
              <span className="cand-body">
                <b>{c.label}</b>
                <span className="cand-sub">{c.sub}</span>
              </span>
            </button>
          ))}
      </div>

      <button className="cta secondary geo" onClick={useGeolocation}>
        <span className="geo-icon" aria-hidden="true">📍</span> {t('home.geo')}
      </button>

      <button className="cta" onClick={goToMap}>
        {t('home.viewMap')}
      </button>

      <div className="divider">{t('common.or')}</div>
      <button className="cta secondary" onClick={() => navigate('/search')}>
        🔍 {t('home.searchBySchool')}
      </button>

      <div className="divider">{t('home.demo')}</div>
      <div className="demo-links">
        <button onClick={() => loadDemo('東京駅')}>
          <span>▸ {t('home.demoTokyoStation')}</span>
          <small>{t('home.demoTokyoStationSub')}</small>
        </button>
      </div>

      <ul className="feature-list">
        <li>{t('home.feature1')}</li>
        <li>{t('home.feature2')}</li>
        <li>{t('home.feature3')}</li>
      </ul>

      <button className="login-btn" onClick={() => setLoginOpen(true)}>
        {t('nav.login')}
      </button>

      {slotsForPlacement('home').map((s) => (
        <AdSlot key={s.id} slot={s} categoryLabel={t('home.adCategory')} />
      ))}
    </main>
  )
}