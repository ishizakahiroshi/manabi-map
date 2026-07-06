import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import type { CourseTime, School } from '../types/school'
import { band, topDev, shortSchoolName, escapeHtml } from '../lib/format'
import { useI18n } from '../contexts/I18nContext'
import { useFormat } from '../hooks/useFormat'
import {
  haversine,
  shortLabel,
  estimateWalkMinutes,
  estimateBikeMinutes,
  estimateCarMinutes,
  estimateTransitMinutes,
} from '../lib/geo'
import type { HomeLocation } from '../types/school'
import { OSM_ATTRIBUTION_HTML, PROTOMAPS_ATTRIBUTION_HTML } from '../lib/attribution'
import { useApp } from '../contexts/AppContext'
import { useSchools } from '../hooks/useSchools'
import type { useUserData } from '../hooks/useUserData'
import { SchoolDetailSheet } from '../components/SchoolDetailSheet'
import { AdSlot } from '../components/AdSlot'
import { slotsForPlacement } from '../data/ad-slots'

const RADIUS_MIN = 5
const RADIUS_MAX = 80
const ALL_BANDS = [70, 60, 50, 40] as const
const UNRATED = -1 as const
const DEPT_KEYS = [
  'general',
  'comprehensive',
  'commercial',
  'industrial',
  'agricultural',
  'welfare',
] as const

/**
 * 地図タイルソース。env `VITE_TILE_SOURCE`（'osm' | 'protomaps'）で切替。
 * **既定は 'osm'**（現行動作維持・R2 / PMTiles 生成不要）。'protomaps' の明示と
 * `VITE_PMTILES_URL` の設定が両方そろった時のみ Protomaps ベクタタイルへ切替える。
 */
const TILE_SOURCE: 'osm' | 'protomaps' =
  (import.meta.env.VITE_TILE_SOURCE as string | undefined) === 'protomaps' ? 'protomaps' : 'osm'
const PMTILES_URL = import.meta.env.VITE_PMTILES_URL as string | undefined

/** OSM 標準ラスタタイルを map に載せる（既定・フォールバック共通経路） */
function addOsmTileLayer(map: L.Map): void {
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: OSM_ATTRIBUTION_HTML,
  }).addTo(map)
}

/**
 * ベース地図レイヤを map に載せる。既定は OSM ラスタ。
 * VITE_TILE_SOURCE=protomaps と VITE_PMTILES_URL の両設定時のみ protomaps-leaflet を
 * **動的 import** して PMTiles ベクタレイヤを載せる（既定 osm 経路では protomaps-leaflet を
 * 一切ロードしない = 未インストールでも現行動作に影響しない）。読み込み失敗時は OSM へ退避。
 * @returns アンマウント時に呼ぶ cancel 関数（非同期ロード完了後の addTo を無効化する）
 */
function attachBaseTileLayer(map: L.Map): () => void {
  if (TILE_SOURCE !== 'protomaps' || !PMTILES_URL) {
    addOsmTileLayer(map)
    return () => {}
  }
  let cancelled = false
  // 非リテラル指定子で動的 import（protomaps-leaflet 未導入時の型解決エラーを避ける。
  // このパッケージは protomaps タイル選択時のみ必要で、既定 osm 経路では読まれない）。
  const spec = 'protomaps-leaflet'
  import(/* @vite-ignore */ spec)
    .then((protomapsL: { leafletLayer: (opts: Record<string, unknown>) => L.Layer }) => {
      if (cancelled) return
      protomapsL
        .leafletLayer({
          url: PMTILES_URL,
          flavor: 'light',
          lang: 'ja',
          attribution: PROTOMAPS_ATTRIBUTION_HTML,
        })
        .addTo(map)
    })
    .catch(() => {
      // protomaps-leaflet 未インストール or PMTiles 取得失敗時は OSM へ退避（地図を白紙にしない）
      if (!cancelled) addOsmTileLayer(map)
    })
  return () => {
    cancelled = true
  }
}

function deptGroupOf(courseType: string | null): (typeof DEPT_KEYS)[number] | null {
  if (!courseType) return null
  const c = courseType
  if (c === 'comprehensive') return 'comprehensive'
  // 普通科系: 普通・理数・国際・IB・スポーツ・芸術・中高一貫
  if (
    c === 'general' ||
    c.startsWith('science') ||
    c === 'international' ||
    c === 'chuko_ikkan' ||
    c === 'ib_diploma' ||
    c === 'sports' ||
    c === 'arts'
  )
    return 'general'
  // 商業系: commercial* / accounting / information_processing
  if (c.startsWith('commercial') || c === 'accounting' || c === 'information_processing') return 'commercial'
  // 工業系: industrial* / kosen* / civil / environmental_engineering / environmental_technology
  if (
    c.startsWith('industrial') ||
    c.startsWith('kosen') ||
    c === 'civil' ||
    c === 'environmental_engineering' ||
    c === 'environmental_technology'
  )
    return 'industrial'
  // 農業系: agricultur* / natural_environment
  if (c.startsWith('agricultur') || c === 'natural_environment') return 'agricultural'
  // 福祉・看護（家庭系含む）: health_nursing / human_service / welfare / culinary
  if (c === 'health_nursing' || c === 'human_service' || c === 'welfare' || c === 'culinary') return 'welfare'
  return null
}

function schoolIcon(
  s: School,
  isFav: boolean,
  home: HomeLocation | null,
  code: string,
  dev: string,
  kosenBadge: string,
  integratedBadge: string,
): L.DivIcon {
  const top = topDev(s)
  const b = top != null ? band(top) : null
  const badge =
    s.type === 'kosen'
      ? ` <small>${escapeHtml(kosenBadge.trim())}</small>`
      : s.is_integrated
        ? ` <small>${escapeHtml(integratedBadge.trim())}</small>`
        : ''
  const commute = home
    ? (() => {
        const d = haversine(home, { lat: s.latitude, lng: s.longitude })
        return `<div class="label-commute">🚶${estimateWalkMinutes(d)}/🚲${estimateBikeMinutes(d)}/🚗${estimateCarMinutes(d)}/🚃${estimateTransitMinutes(d)}分</div>`
      })()
    : ''
  return L.divIcon({
    className: '',
    iconSize: [200, home ? 70 : 56],
    iconAnchor: [100, home ? 70 : 56],
    html: `<div class="pin ${isFav ? 'fav' : ''}" ${b != null ? `data-band="${b}"` : ''}>
      <div class="label">
        <div class="label-name">${escapeHtml(shortSchoolName(s.name))}</div>
        <div class="label-dev">${escapeHtml(code)}<span class="dev-value">${escapeHtml(dev)}</span>${badge}</div>
        ${commute}
      </div>
      <div class="dot"></div>
    </div>`,
  })
}

function homeIcon(homeLabel: string): L.DivIcon {
  return L.divIcon({
    className: '',
    iconSize: [80, 44],
    iconAnchor: [40, 44],
    html: `<div class="pin home"><div class="label">${escapeHtml(homeLabel)} ⌂</div><div class="dot">⌂</div></div>`,
  })
}

interface Filters {
  radius: number
  bands: Set<number>
  own: Set<string>
  gen: Set<string>
  types: Set<string>
  courseTimes: Set<CourseTime>
  depts: Set<string>
  onlyIntegrated: boolean
}

type PopoverKey = 'own' | 'bands' | 'gen' | 'courseTimes' | 'depts' | null

interface Props {
  userData: ReturnType<typeof useUserData>
}

export function MapPage({ userData }: Props) {
  const navigate = useNavigate()
  const { id: sharedSchoolId } = useParams<{ id: string }>()
  const sharedOpenedRef = useRef(false)
  const { home, toast } = useApp()
  const { t } = useI18n()
  const fmt = useFormat()
  const { schools, loading, error } = useSchools()
  const { favorites } = userData
  const mapNodeRef = useRef<HTMLDivElement | null>(null)
  const markerLayerRef = useRef<L.LayerGroup | null>(null)
  const clusterLayerRef = useRef<L.MarkerClusterGroup | null>(null)
  const [mapRef, setMapRef] = useState<L.Map | null>(null)
  const [sheetExpanded, setSheetExpanded] = useState(false)
  const [schoolListOpen, setSchoolListOpen] = useState(false)
  const [detail, setDetail] = useState<School | null>(null)

  const BAND_CHIPS = useMemo(
    () =>
      [
        [70, t('filter.band.b70')],
        [60, t('filter.band.b60')],
        [50, t('filter.band.b50')],
        [40, t('filter.band.b40')],
        [UNRATED, t('filter.band.unrated')],
      ] as const,
    [t],
  )
  const OWN_CHIPS = useMemo(
    () =>
      [
        ['prefectural', t('filter.own.prefectural')],
        ['municipal', t('filter.own.municipal')],
        ['national', t('filter.own.national')],
        ['private', t('filter.own.private')],
        ['union', t('filter.own.union')],
      ] as const,
    [t],
  )
  const TYPE_CHIPS = useMemo(
    () =>
      [
        ['high_school', t('filter.type.high_school')],
        ['kosen', t('filter.type.kosen')],
      ] as const,
    [t],
  )
  const GEN_CHIPS = useMemo(
    () =>
      [
        ['coed', t('filter.gen.coed')],
        ['boys', t('filter.gen.boys')],
        ['girls', t('filter.gen.girls')],
      ] as const,
    [t],
  )
  const COURSE_TIME_CHIPS = useMemo(
    () =>
      [
        ['fulltime', t('filter.course.fulltime')],
        ['parttime', t('filter.course.parttime')],
        ['correspondence', t('filter.course.correspondence')],
      ] as const,
    [t],
  )
  const DEPT_CHIPS = useMemo(
    () => DEPT_KEYS.map((k) => [k, t(`filter.dept.${k}`)] as const),
    [t],
  )

  const [filters, setFilters] = useState<Filters>({
    radius: 50,
    bands: new Set([...ALL_BANDS, UNRATED as number]),
    own: new Set(['prefectural', 'municipal', 'national', 'private', 'union']),
    gen: new Set(['coed', 'boys', 'girls']),
    types: new Set(['high_school', 'kosen']),
    courseTimes: new Set<CourseTime>(['fulltime', 'parttime']),
    depts: new Set(DEPT_KEYS),
    onlyIntegrated: false,
  })
  const [popover, setPopover] = useState<PopoverKey>(null)

  const center = useMemo<[number, number]>(
    () => (home ? [home.lat, home.lng] : [36.3907, 139.0604]),
    [home],
  )

  const visibleSchools = useMemo(() => {
    return schools.filter((s) => {
      const isFav = !!favorites[s.id]
      const top = topDev(s)
      const dist = home ? haversine(home, { lat: s.latitude, lng: s.longitude }) : 0
      // 志望校は半径フィルタを無視して常時表示（§7.6.3）
      const passRadius = isFav || !home || dist <= filters.radius
      // 偏差値未測定校は sentinel UNRATED として明示的にフィルタ制御可能
      const passBand = top == null ? filters.bands.has(UNRATED) : filters.bands.has(band(top))
      const passOwn = filters.own.has(s.ownership)
      const passGen = filters.gen.has(s.gender_type)
      const passType = filters.types.has(s.type)
      const passCourseTime = s.course_times.some((courseTime) => filters.courseTimes.has(courseTime))
      const passInt = !filters.onlyIntegrated || s.is_integrated
      // 学科: 少なくとも 1 学科がグループにマッチすれば通す。全学科の course_type が
      // どのグループにも当てはまらない校（deptGroupOf=null。都立の家政・工芸・デュアル
      // システム等の特殊学科・course_type='other'）は「未分類」として、フィルタが
      // 既定（全選択）の時だけ通す。特定のカテゴリだけ選択された時は隠す
      // （そうしないと「商業系」だけ選んでも 筑駒 のような無関係な学校が
      // 素通りしてしまう）。
      const groups = s.departments
        .map((d) => deptGroupOf(d.course_type))
        .filter((g): g is (typeof DEPT_KEYS)[number] => g != null)
      const passDept =
        groups.length === 0
          ? filters.depts.size === DEPT_KEYS.length
          : groups.some((g) => filters.depts.has(g))
      return passRadius && passBand && passOwn && passGen && passType && passCourseTime && passDept && passInt
    })
  }, [schools, favorites, home, filters])

  const favSchools = useMemo(
    () => schools.filter((s) => favorites[s.id]),
    [schools, favorites],
  )

  const toggleSet = (key: 'bands' | 'own' | 'gen' | 'types' | 'courseTimes' | 'depts', value: never) => {
    setFilters((f) => {
      const next = new Set(f[key] as Set<unknown>)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return { ...f, [key]: next }
    })
  }

  const activeCount = <T,>(set: Set<T>, all: readonly (readonly [T, string])[]) =>
    set.size === all.length ? t('map.filterAll') : String(set.size)

  useEffect(() => {
    if (!mapNodeRef.current) return

    const map = L.map(mapNodeRef.current, { zoomControl: false }).setView([36.3907, 139.0604], 10)
    map.attributionControl.setPrefix(false)
    const cancelBaseLayer = attachBaseTileLayer(map)

    markerLayerRef.current = L.layerGroup().addTo(map)
    clusterLayerRef.current = L.markerClusterGroup({
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      maxClusterRadius: 40,
      iconCreateFunction: (cluster) => {
        const n = cluster.getChildCount()
        return L.divIcon({
          className: '',
          iconSize: [40, 40],
          iconAnchor: [20, 20],
          html: `<div class="school-cluster"><span>${n}</span></div>`,
        })
      },
    }).addTo(map)
    setMapRef(map)

    return () => {
      cancelBaseLayer()
      markerLayerRef.current = null
      clusterLayerRef.current = null
      setMapRef(null)
      map.remove()
    }
  }, [])

  useEffect(() => {
    if (!mapRef) return
    mapRef.setView(center, mapRef.getZoom())
  }, [center, mapRef])

  // 共有 URL で開かれたら、学校データ到着後に 1 回だけ該当校の詳細シートを開いて寄せる
  useEffect(() => {
    if (!sharedSchoolId || sharedOpenedRef.current || !mapRef || schools.length === 0) return
    sharedOpenedRef.current = true
    const school = schools.find((s) => s.id === sharedSchoolId)
    if (school) {
      setDetail(school)
      mapRef.setView([school.latitude, school.longitude], 13)
    }
  }, [sharedSchoolId, schools, mapRef])

  useEffect(() => {
    document.body.dataset.sheetOpen = detail ? 'true' : 'false'
    return () => {
      delete document.body.dataset.sheetOpen
    }
  }, [detail])

  useEffect(() => {
    const homeLayer = markerLayerRef.current
    const cluster = clusterLayerRef.current
    if (!homeLayer || !cluster) return

    homeLayer.clearLayers()
    cluster.clearLayers()
    if (home) {
      L.marker([home.lat, home.lng], { icon: homeIcon(t('map.recenter')) }).addTo(homeLayer)
    }
    const kosenBadge = t('labels.kosenBadge')
    const integratedBadge = t('labels.integratedBadge')
    const schoolMarkers = visibleSchools.map((s) =>
      L.marker([s.latitude, s.longitude], {
        icon: schoolIcon(
          s,
          !!favorites[s.id],
          home,
          fmt.displayCode(s),
          fmt.devLabel(s),
          kosenBadge,
          integratedBadge,
        ),
      }).on('click', () => setDetail(s)),
    )
    cluster.addLayers(schoolMarkers)
  }, [favorites, home, visibleSchools, fmt, t])

  const sortedVisible = useMemo(
    () => [...visibleSchools].sort((a, b) => shortSchoolName(a.name).localeCompare(shortSchoolName(b.name), 'ja')),
    [visibleSchools],
  )

  return (
    <div className="screen map-screen">
      <div className="header">
        <button className="icon-btn" onClick={() => navigate('/')} aria-label={t('map.backHome')}>
          ←
        </button>
        <div className="brand">
          {home ? t('map.nearby', { label: shortLabel(home.label) }) : t('map.title')}
        </div>
        <button className="icon-btn" onClick={() => navigate('/favorites')} aria-label={t('header.favList')}>
          ★
        </button>
      </div>

      <div className="map-canvas" aria-hidden={schoolListOpen}>
        <div
          ref={mapNodeRef}
          className="leaflet-map"
          role="application"
          aria-label={t('map.title')}
          tabIndex={0}
        />
      </div>

      <div className="float-bar">
        <div className="radius-slider" aria-label={t('map.radiusAria')}>
          <span className="rs-label">{t('map.radius')}</span>
          <input
            type="range"
            min={RADIUS_MIN}
            max={RADIUS_MAX}
            step={5}
            value={filters.radius}
            aria-valuemin={RADIUS_MIN}
            aria-valuemax={RADIUS_MAX}
            aria-valuenow={filters.radius}
            aria-valuetext={`${filters.radius}km`}
            onChange={(e) => setFilters((f) => ({ ...f, radius: Number(e.target.value) }))}
            onMouseUp={() => toast(t('home.radiusToast', { km: filters.radius }))}
            onTouchEnd={() => toast(t('home.radiusToast', { km: filters.radius }))}
          />
          <span className="rs-value">{filters.radius}km</span>
        </div>
        {(
          [
            ['own', t('map.filterCategory.own'), OWN_CHIPS, filters.own],
            ['bands', t('map.filterCategory.bands'), BAND_CHIPS, filters.bands],
            ['gen', t('map.filterCategory.gen'), GEN_CHIPS, filters.gen],
            ['courseTimes', t('map.filterCategory.courseTimes'), COURSE_TIME_CHIPS, filters.courseTimes],
            ['depts', t('map.filterCategory.depts'), DEPT_CHIPS, filters.depts],
          ] as const
        ).map(([key, label, list, set]) => (
          <div className="dropdown" key={key}>
            <button
              type="button"
              className={`chip drop ${popover === key ? 'open' : ''}`}
              aria-expanded={popover === key}
              aria-haspopup="listbox"
              onClick={() => setPopover((p) => (p === key ? null : (key as PopoverKey)))}
            >
              {label} ({activeCount(set as Set<unknown>, list as unknown as readonly (readonly [unknown, string])[])}) ▾
            </button>
            {popover === key && (
              <div className="popover" role="listbox" aria-label={label}>
                {(list as readonly (readonly [unknown, string])[]).map(([k, l]) => (
                  <button
                    type="button"
                    key={String(k)}
                    role="option"
                    aria-selected={(set as Set<unknown>).has(k)}
                    className={`chip ${(set as Set<unknown>).has(k) ? 'on' : ''}`}
                    onClick={() => toggleSet(key as 'own', k as never)}
                  >
                    {l}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {popover && (
        <div className="popover-scrim" onClick={() => setPopover(null)} aria-hidden="true" />
      )}

      <div className="map-controls">
        <button type="button" onClick={() => mapRef?.setZoom(mapRef.getZoom() + 1)} aria-label={t('map.zoomIn')}>
          ＋
        </button>
        <button type="button" onClick={() => mapRef?.setZoom(mapRef.getZoom() - 1)} aria-label={t('map.zoomOut')}>
          −
        </button>
        <button
          type="button"
          onClick={() => home && mapRef?.setView([home.lat, home.lng], 10)}
          title={t('map.recenter')}
          aria-label={t('map.recenter')}
        >
          ⌂
        </button>
        <button
          type="button"
          className={schoolListOpen ? 'on' : ''}
          onClick={() => setSchoolListOpen((v) => !v)}
          aria-expanded={schoolListOpen}
          aria-controls="school-list-panel"
          aria-label={t('map.schoolList')}
        >
          ☰
        </button>
      </div>

      {schoolListOpen && (
        <section
          id="school-list-panel"
          className="school-list-panel"
          role="region"
          aria-label={t('map.schoolListTitle', { count: sortedVisible.length })}
        >
          <div className="school-list-head">
            <strong>{t('map.schoolListTitle', { count: sortedVisible.length })}</strong>
            <button type="button" className="link-btn" onClick={() => setSchoolListOpen(false)}>
              {t('map.schoolListClose')}
            </button>
          </div>
          <p className="school-list-hint">{t('map.schoolListHint')}</p>
          <ul className="school-list">
            {sortedVisible.map((s) => (
              <li key={s.id}>
                <button type="button" className="school-list-item" onClick={() => setDetail(s)}>
                  <span className="school-list-name">{shortSchoolName(s.name)}</span>
                  <span className="school-list-meta">
                    {fmt.displayCode(s)}：{fmt.devLabel(s)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(loading || error) && (
        <div className="float-bar" style={{ top: 108 }} role="status">
          {loading && <span className="chip">{t('map.loadingSchools')}</span>}
          {error && <span className="chip" style={{ color: 'var(--bad)' }}>{error}</span>}
        </div>
      )}

      <div className={`sheet ${sheetExpanded ? 'expanded' : ''}`}>
        <button
          type="button"
          className="handle"
          onClick={() => setSheetExpanded((v) => !v)}
          aria-expanded={sheetExpanded}
          aria-label={t('map.toggleSheet')}
        />
        <div className="head">
          <span className="grow">
            <span style={{ color: 'var(--fav-yellow)' }} aria-hidden="true">★</span>{' '}
            {t('map.favCount', { count: favSchools.length })}
          </span>
          <button type="button" className="link-btn" onClick={() => navigate('/favorites')}>
            {t('map.listLink')}
          </button>
        </div>
        <main id="main-content" className="body" tabIndex={-1}>
          <div className="fav-mini">
            {favSchools.length === 0 ? (
              <div className="fav-mini-empty">{t('map.favEmpty')}</div>
            ) : (
              favSchools.map((s) => (
                <button type="button" className="row" key={s.id} onClick={() => setDetail(s)}>
                  <span className="star" aria-hidden="true">★</span>
                  <span className="name">{shortSchoolName(s.name)}</span>
                  <span className="badge">
                    {fmt.displayCode(s)}：{fmt.devLabel(s)}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="filter-group">
            <div className="label">{t('map.filterOwn')}</div>
            <div className="chips">
              {OWN_CHIPS.map(([k, label]) => (
                <button
                  key={k}
                  className={`chip ${filters.own.has(k) ? 'on' : ''}`}
                  onClick={() => toggleSet('own', k as never)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-group">
            <div className="label">{t('map.filterType')}</div>
            <div className="chips">
              {TYPE_CHIPS.map(([k, label]) => (
                <button
                  key={k}
                  className={`chip ${filters.types.has(k) ? 'on' : ''}`}
                  onClick={() => toggleSet('types', k as never)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-group">
            <div className="label">{t('map.filterCourse')}</div>
            <div className="chips">
              {COURSE_TIME_CHIPS.map(([k, label]) => (
                <button
                  key={k}
                  className={`chip ${filters.courseTimes.has(k) ? 'on' : ''}`}
                  onClick={() => toggleSet('courseTimes', k as never)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-group">
            <div className="label">{t('map.filterGender')}</div>
            <div className="chips">
              {GEN_CHIPS.map(([k, label]) => (
                <button
                  key={k}
                  className={`chip ${filters.gen.has(k) ? 'on' : ''}`}
                  onClick={() => toggleSet('gen', k as never)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-group">
            <div className="label">{t('map.filterDept')}</div>
            <div className="chips">
              {DEPT_CHIPS.map(([k, label]) => (
                <button
                  key={k}
                  className={`chip ${filters.depts.has(k) ? 'on' : ''}`}
                  onClick={() => toggleSet('depts', k as never)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="filter-group">
            <div className="label">{t('map.filterOther')}</div>
            <div className="chips">
              <button
                type="button"
                className={`chip ${filters.onlyIntegrated ? 'on' : ''}`}
                aria-pressed={filters.onlyIntegrated}
                onClick={() => setFilters((f) => ({ ...f, onlyIntegrated: !f.onlyIntegrated }))}
              >
                {t('map.integratedOnly')}
              </button>
            </div>
          </div>

          {slotsForPlacement('map').map((s) => (
            <AdSlot key={s.id} slot={s} categoryLabel={t('map.adCategory')} className="mt-2" />
          ))}
        </main>
      </div>

      {detail && (
        <SchoolDetailSheet
          school={detail}
          onClose={() => {
            setDetail(null)
            // 共有 URL 経由なら、シートを閉じた時点で通常の地図 URL に戻す
            if (sharedSchoolId) navigate('/map', { replace: true })
          }}
          userData={userData}
        />
      )}
    </div>
  )
}
