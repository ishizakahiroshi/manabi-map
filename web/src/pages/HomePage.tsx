import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../contexts/AppContext'
import { useI18n } from '../contexts/I18nContext'
import { parsePostal, geocodeSearch, ACTIVE_GEOCODER, type GeocodeCandidate } from '../lib/geo'
import {
  loadSearchIndexes,
  matchCities,
  matchSchools,
  type SearchIndexes,
} from '../lib/searchIndex'
import { PREFECTURES, REGION_KEYS } from '../lib/prefecture'
import { GUIDES, guideNavLabel } from '../lib/guides'
import siteFooterLinks from '../../data/site-footer-links.json'
import { trackEvent } from '../lib/analytics'
import type { HomeLocation } from '../types/school'
import { AdSlot } from './../components/AdSlot'
import { HeroQr } from '../components/HeroQr'
import { SiteFooter } from '../components/SiteFooter'
import { slotsForPlacement } from '../data/ad-slots'

const DEMO_HOMES: Record<string, HomeLocation & { fill: string }> = {
  東京駅: { label: '東京駅 丸の内', lat: 35.6812, lng: 139.7671, fill: '東京都千代田区丸の内一丁目' },
}

/** 統合検索の候補は各グループ最大 3 件 + もっと見る（モック第 4 版で確定）。 */
const GROUP_LIMIT = 3

type Hint = { text: string; tone: 'accent' | 'ok' | 'bad' | 'soft' }

export function HomePage() {
  const navigate = useNavigate()
  const { setHome, toast, setLoginOpen } = useApp()
  const { t, locale } = useI18n()
  // 見出しは site-footer-links.json の /guide/ 行と同じラベルを使う（言葉の実体を 1 箇所に保つ）。
  const guideSectionLabel = siteFooterLinks.links.find((link) => link.path === '/guide/school-visit')?.[locale] ?? ''
  const [q, setQ] = useState('')
  const [hint, setHint] = useState<Hint | null>(null)
  const [candidates, setCandidates] = useState<GeocodeCandidate[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const [selected, setSelected] = useState<(HomeLocation & { source: string }) | null>(null)
  const [indexes, setIndexes] = useState<SearchIndexes | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastQuery = useRef('')

  // 市区町村・校名の軽量索引は検索欄フォーカス時に遅延読込する
  // （schools.json 全体はトップで読まない）。失敗しても住所検索は生きるので静かに諦める。
  const ensureIndexes = () => {
    void loadSearchIndexes()
      .then(setIndexes)
      .catch(() => {})
  }

  const cityMatches = useMemo(
    () => (indexes && q.trim() ? matchCities(indexes.cities, q, GROUP_LIMIT) : []),
    [indexes, q],
  )
  const schoolMatches = useMemo(
    () => (indexes && q.trim() ? matchSchools(indexes.schools, q, GROUP_LIMIT) : []),
    [indexes, q],
  )

  const onQueryInput = (v: string) => {
    setQ(v)
    setSelected(null)
    setSearchError(false)
    if (timer.current) clearTimeout(timer.current)
    if (!v.trim()) {
      setHint(null)
      setCandidates(null)
      // 残すと同一文字列の再入力が runSearch の重複ガードに飲まれて「検索中…」のまま止まる
      lastQuery.current = ''
      return
    }
    const local = parsePostal(v.trim())
    if (local) {
      setHint({ text: t('home.searchPostal', { label: local.label }), tone: 'ok' })
      setSelected({ label: `〒${v.replace(/[^0-9-]/g, '')} ${local.label}`, lat: local.lat, lng: local.lng, source: 'postal' })
    } else {
      setHint({ text: t('home.searching'), tone: 'soft' })
    }
    timer.current = setTimeout(() => void runSearch(v.trim()), 400)
  }

  const runSearch = async (query: string) => {
    if (query === lastQuery.current) return
    lastQuery.current = query
    setSearching(true)
    try {
      const items = await geocodeSearch(query)
      // 完了時に最新クエリでなければ捨てる（遅いレスポンスによる候補上書き防止）
      if (query !== lastQuery.current) return
      setCandidates(items)
      setSearchError(false)
      // 郵便番号でも、候補（Nominatim の正確地点）が取れたら暫定の県中心から着地点を格上げする。
      if (items.length > 0) {
        pick(items[0])
      } else {
        // 0 件時に「検索中…」を残さない。郵便番号の ok ヒントは残す（soft のみ消す）
        setHint((h) => (h && h.tone === 'soft' ? null : h))
      }
    } catch {
      if (query !== lastQuery.current) return
      setCandidates(null)
      setSearchError(true)
      setHint((h) => (h && h.tone === 'soft' ? null : h))
      // 同一文字列での再試行を許す（失敗後に lastQuery が残るとリトライ不能になる）
      lastQuery.current = ''
    } finally {
      if (query === lastQuery.current || lastQuery.current === '') {
        setSearching(false)
      }
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

  // 候補クリックからは state 更新を待たず override で直接渡す（setSelected は非同期のため）
  const goToMap = (override?: HomeLocation & { source: string }) => {
    const target = override ?? selected
    if (target) {
      trackEvent('search', { source: target.source, result_count: candidates?.length })
      setHome({ label: target.label, lat: target.lat, lng: target.lng })
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

  const openCity = (prefSlug: string, city: string) => {
    trackEvent('search', { source: 'home_city' })
    navigate(`/pref/${prefSlug}#${encodeURIComponent(city)}`)
  }

  const openSchool = (id: string, name: string, lat: number | null, lng: number | null) => {
    trackEvent('search', { source: 'home_school' })
    if (lat != null && lng != null) setHome({ label: name, lat, lng })
    navigate(`/school/${id}`)
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

  const hasLocalMatches = cityMatches.length > 0 || schoolMatches.length > 0
  const geocodeShown = candidates?.slice(0, GROUP_LIMIT) ?? null

  return (
    <main id="main-content" className="content home-content" tabIndex={-1}>
      <div className="hero-row">
        <div className="hero-text">
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
        </div>
        <HeroQr />
      </div>

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
          onFocus={ensureIndexes}
        />
        <button className="q-clear" onClick={clearQuery} title={t('common.clear')} aria-label={t('common.clear')}>
          ×
        </button>
      </div>
      {hint && <div className={`mini-hint ${hint.tone === 'accent' ? '' : hint.tone}`}>{hint.text}</div>}
      <div className="q-results" role="listbox" aria-label={t('home.searchLabel')}>
        {searching && <div className="spinner">{t('home.searchingPlaces')}</div>}
        {searchError && <div className="nores error">{t('home.searchFail')}</div>}
        {!searching && !searchError && q.trim() && geocodeShown?.length === 0 && !hasLocalMatches && (
          <div className="nores">{t('home.searchNone')}</div>
        )}

        {!searching && geocodeShown && geocodeShown.length > 0 && (
          <div className="cand-group-label">{t('home.searchGroupMap')}</div>
        )}
        {!searching &&
          geocodeShown?.map((c, i) => (
            <button
              key={i}
              role="option"
              aria-selected={selected?.label === c.label}
              className={`cand ${selected?.label === c.label ? 'on' : ''}`}
              onClick={() => {
                pick(c)
                goToMap({ label: c.label, lat: c.lat, lng: c.lng, source: ACTIVE_GEOCODER })
              }}
            >
              <span className="cand-icon" aria-hidden="true">{c.icon}</span>
              <span className="cand-body">
                <b>{c.label}</b>
                <span className="cand-sub">{c.sub}</span>
              </span>
            </button>
          ))}

        {cityMatches.length > 0 && (
          <div className="cand-group-label">{t('home.searchGroupList')}</div>
        )}
        {cityMatches.map((c) => (
          <button
            key={`${c.prefSlug}-${c.city}`}
            role="option"
            aria-selected={false}
            className="cand"
            onClick={() => openCity(c.prefSlug, c.city)}
          >
            <span className="cand-icon" aria-hidden="true">📄</span>
            <span className="cand-body">
              <b>{t('home.cityListItem', { city: c.city, n: c.count })}</b>
              <span className="cand-sub">{c.pref}</span>
            </span>
          </button>
        ))}

        {schoolMatches.length > 0 && (
          <div className="cand-group-label">{t('home.searchGroupSchool')}</div>
        )}
        {schoolMatches.map((s) => (
          <button
            key={s.id}
            role="option"
            aria-selected={false}
            className="cand"
            onClick={() => openSchool(s.id, s.name, s.lat, s.lng)}
          >
            <span className="cand-icon" aria-hidden="true">🏫</span>
            <span className="cand-body">
              <b>{s.name}</b>
              <span className="cand-sub">
                {s.pref}
                {s.city ? ` ${s.city}` : ''}
              </span>
            </span>
          </button>
        ))}
        {q.trim() && (
          <button className="cand cand-more" onClick={() => navigate('/search')}>
            <span className="cand-icon" aria-hidden="true">🔍</span>
            <span className="cand-body">
              <b>{t('home.moreSchools')}</b>
            </span>
          </button>
        )}
      </div>

      <button className="cta secondary geo" onClick={useGeolocation}>
        <span className="geo-icon" aria-hidden="true">📍</span> {t('home.geo')}
      </button>

      <button className="cta" onClick={() => goToMap()}>
        {t('home.viewMap')}
      </button>

      <div className="divider">{t('home.browse')}</div>
      <nav className="region-accordion" aria-label={t('home.browse')}>
        {REGION_KEYS.map((region) => {
          const prefs = PREFECTURES.filter((p) => p.region === region)
          if (prefs.length === 0) return null
          return (
            <details key={region} className="region-group">
              <summary>{t(`regions.${region}`)}</summary>
              <div className="region-pref-links">
                {prefs.map((p) => (
                  <a
                    key={p.slug}
                    href={`/pref/${p.slug}/`}
                    onClick={(e) => {
                      e.preventDefault()
                      navigate(`/pref/${p.slug}`)
                    }}
                  >
                    {p.name}
                  </a>
                ))}
              </div>
            </details>
          )
        })}
        <a
          className="all-schools-link"
          href="/schools/"
          onClick={(e) => {
            e.preventDefault()
            navigate('/schools')
          }}
        >
          {t('home.allSchools')}
        </a>
      </nav>

      <section aria-labelledby="school-guide-heading">
        <div className="divider" id="school-guide-heading">{guideSectionLabel}</div>
        <nav className="demo-links" aria-label={guideSectionLabel}>
          {GUIDES.map((guide) => (
            <a key={guide.slug} href={`/guide/${guide.slug}/`}>
              {guideNavLabel(guide, locale)}
            </a>
          ))}
        </nav>
      </section>

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
      <SiteFooter />
    </main>
  )
}
