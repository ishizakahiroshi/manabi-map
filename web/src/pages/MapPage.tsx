import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import type { CourseTime, DeptUiGroup, School } from '../types/school'
import { band, topDev, shortSchoolName, escapeHtml } from '../lib/format'
import { APPLICANT_RATIO_BANDS, applicantRatioBand, primaryAdmissionTrend, type ApplicantRatioBand } from '../lib/admission'
import { useI18n } from '../contexts/I18nContext'
import { useFormat } from '../hooks/useFormat'
import {
  haversine,
  homeViewRadiusKm,
  shortLabel,
  estimateWalkMinutes,
  estimateBikeMinutes,
  estimateCarMinutes,
  estimateTransitMinutes,
} from '../lib/geo'
import type { HomeLocation } from '../types/school'
import { ACTIVE_REGION } from '../lib/region'
import { OSM_ATTRIBUTION_HTML, PROTOMAPS_ATTRIBUTION_HTML } from '../lib/attribution'
import { useApp } from '../contexts/AppContext'
import { useSchools } from '../hooks/useSchools'
import type { useUserData } from '../hooks/useUserData'
import { SchoolDetailSheet } from '../components/SchoolDetailSheet'

function normalizeQuery(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/\s+/g, '')
}
const ALL_BANDS = [70, 60, 50, 40, 30] as const
const UNRATED = -1 as const
// 学科フィルタ 10 分類（course_type_master.ui_group / types/school.ts DeptUiGroup と一致）
// 並びは plan_v0.2.0_taxonomy-mext.md D2「進路検討 想起順」に従う。
// 上段（普通科系 4 chip）と下段（専門学科 6 chip = 専門 5 + その他）は
// UI で薄い区切りを入れる（D3）。
const DEPT_KEYS_ACADEMIC = [
  'general',
  'comprehensive',
  'sciences_langs',
  'arts_sports',
] as const
const DEPT_KEYS_SPECIALIZED = [
  'industrial',
  'informatics',
  'commercial',
  'agriculture_marine',
  'home_welfare_nursing',
  'other',
] as const
// 学科情報未収集校（京都・兵庫等）を独立 chip として扱う。既定 ON なので
// 全 chip 選択時の表示件数は従来と変わらない。
const DEPT_KEYS_META = ['unknown'] as const
const DEPT_KEYS = [...DEPT_KEYS_ACADEMIC, ...DEPT_KEYS_SPECIALIZED, ...DEPT_KEYS_META] as const

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

// 学科の UI 6 分類は course_type_master.ui_group を DB 側 trigger で
// school_departments.ui_group に非正規化してあるので、フロントでは
// department.ui_group をそのまま読むだけでよい（旧 deptGroupOf() は撤去）。

function schoolIcon(
  s: School,
  isFav: boolean,
  home: HomeLocation | null,
  code: string,
  dev: string,
  applicantRatio: string,
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
  const height = 56 + (home ? 14 : 0) + (applicantRatio ? 12 : 0)
  return L.divIcon({
    className: '',
    iconSize: [200, height],
    iconAnchor: [100, height],
    html: `<div class="pin ${isFav ? 'fav' : ''}" ${b != null ? `data-band="${b}"` : ''}>
      <div class="label">
        <div class="label-name">${escapeHtml(shortSchoolName(s.name, s))}${badge}</div>
        <div class="label-dev">${escapeHtml(code)}<span class="dev-value">${escapeHtml(dev)}</span>${applicantRatio ? `<span class="label-admission">${escapeHtml(applicantRatio)}</span>` : ''}</div>
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

/** 自宅を中心に、最寄り校が収まる「通学圏」の正方形 bounds（fitBounds 用） */
function homeViewBounds(home: HomeLocation, schools: School[]): L.LatLngBounds {
  const radiusKm = homeViewRadiusKm(
    home,
    schools.map((s) => ({ lat: s.latitude, lng: s.longitude })),
  )
  return L.latLng(home.lat, home.lng).toBounds(radiusKm * 2 * 1000)
}

interface Filters {
  bands: Set<number>
  ratios: Set<ApplicantRatioBand>
  own: Set<string>
  gen: Set<string>
  types: Set<string>
  courseTimes: Set<CourseTime>
  depts: Set<string>
  onlyIntegrated: boolean
}

type PopoverKey = 'own' | 'types' | 'bands' | 'ratios' | 'gen' | 'courseTimes' | 'depts' | null

interface Props {
  userData: ReturnType<typeof useUserData>
}

export function MapPage({ userData }: Props) {
  const navigate = useNavigate()
  const { id: sharedSchoolId } = useParams<{ id: string }>()
  const sharedOpenedRef = useRef(false)
  const { home } = useApp()
  const { t } = useI18n()
  const fmt = useFormat()
  const { schools, loading, error } = useSchools()
  const { favorites } = userData
  const mapNodeRef = useRef<HTMLDivElement | null>(null)
  const markerLayerRef = useRef<L.LayerGroup | null>(null)
  const clusterLayerRef = useRef<L.MarkerClusterGroup | null>(null)
  const [mapRef, setMapRef] = useState<L.Map | null>(null)
  const [mapBounds, setMapBounds] = useState<L.LatLngBounds | null>(null)
  const [schoolListOpen, setSchoolListOpen] = useState(false)
  const [detail, setDetail] = useState<School | null>(null)

  const BAND_CHIPS = useMemo(
    () =>
      [
        [70, t('filter.band.b70')],
        [60, t('filter.band.b60')],
        [50, t('filter.band.b50')],
        [40, t('filter.band.b40')],
        [30, t('filter.band.b30')],
        [UNRATED, t('filter.band.unrated')],
      ] as const,
    [t],
  )
  const RATIO_CHIPS = useMemo(
    () => APPLICANT_RATIO_BANDS.map((k) => [k, t(`filter.ratio.${k}`)] as const),
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
    bands: new Set([...ALL_BANDS, UNRATED as number]),
    ratios: new Set<ApplicantRatioBand>(APPLICANT_RATIO_BANDS),
    own: new Set(['prefectural', 'municipal', 'national', 'private', 'union']),
    gen: new Set(['coed', 'boys', 'girls']),
    types: new Set(['high_school', 'kosen']),
    courseTimes: new Set<CourseTime>(['fulltime', 'parttime']),
    depts: new Set(DEPT_KEYS),
    onlyIntegrated: false,
  })
  const [popover, setPopover] = useState<PopoverKey>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const [filterSheetOpen, setFilterSheetOpen] = useState(false)

  const normalizedQuery = useMemo(() => normalizeQuery(query.trim()), [query])

  // 最新年度の一次募集区分は学校データが変わらない限り不変なので、フィルタ評価のたびに再計算しない
  const ratioBands = useMemo(() => {
    const bands = new Map<string, ApplicantRatioBand>()
    for (const s of schools) bands.set(s.id, applicantRatioBand(s))
    return bands
  }, [schools])

  const visibleSchools = useMemo(() => {
    return schools.filter((s) => {
      const isFav = !!favorites[s.id]
      const top = topDev(s)
      // 志望校は表示範囲フィルタを無視して常時表示（§7.6.3）
      const passBounds = isFav || !mapBounds || mapBounds.contains([s.latitude, s.longitude])
      // フリーワード（学校名 / かな / 学科名 / 都道府県 / 市区町村 / 住所）
      let passQuery = true
      if (normalizedQuery.length >= 1) {
        const deptNames = s.departments.map((d) => d.name).join(' ')
        const hay = normalizeQuery(
          `${s.name} ${s.name_kana ?? ''} ${deptNames} ${s.prefecture} ${s.city ?? ''} ${s.address}`,
        )
        passQuery = hay.includes(normalizedQuery)
      }
      // 偏差値未測定校は sentinel UNRATED として明示的にフィルタ制御可能
      const passBand = top == null ? filters.bands.has(UNRATED) : filters.bands.has(band(top))
      const passRatio = filters.ratios.has(ratioBands.get(s.id) ?? 'unknown')
      const passOwn = filters.own.has(s.ownership)
      const passGen = filters.gen.has(s.gender_type)
      const passType = filters.types.has(s.type)
      const passCourseTime = s.course_times.some((courseTime) => filters.courseTimes.has(courseTime))
      const passInt = !filters.onlyIntegrated || s.is_integrated
      // 学科: 少なくとも 1 学科がグループ（course_type_master.ui_group）にマッチすれば通す。
      // ui_group が null（master に未登録の code）は従来どおり 'other'（専門学科の分類外）。
      // 学科自体が 1 件も無い校（京都・兵庫等 学科未収集県）は独立 sentinel 'unknown' に
      // 畳み、「学科情報なし」chip の ON/OFF で明示制御する（既定 ON なので回帰なし）。
      const groups: DeptUiGroup[] =
        s.departments.length > 0
          ? s.departments.map((d) => d.ui_group ?? 'other')
          : ['unknown']
      const passDept = groups.some((g) => filters.depts.has(g))
      return passBounds && passBand && passRatio && passOwn && passGen && passType && passCourseTime && passDept && passInt && passQuery
    })
  }, [schools, favorites, mapBounds, filters, normalizedQuery, ratioBands])

  const toggleSet = (key: 'bands' | 'ratios' | 'own' | 'gen' | 'types' | 'courseTimes' | 'depts', value: never) => {
    setFilters((f) => {
      const next = new Set(f[key] as Set<unknown>)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return { ...f, [key]: next }
    })
  }

  const clearFilters = () => {
    setFilters((f) => ({
      ...f,
      bands: new Set([...ALL_BANDS, UNRATED as number]),
      ratios: new Set<ApplicantRatioBand>(APPLICANT_RATIO_BANDS),
      own: new Set(['prefectural', 'municipal', 'national', 'private', 'union']),
      types: new Set(['high_school', 'kosen']),
      gen: new Set(['coed', 'boys', 'girls']),
      courseTimes: new Set<CourseTime>(['fulltime', 'parttime']),
      depts: new Set(DEPT_KEYS),
      onlyIntegrated: false,
    }))
  }

  const activeCount = <T,>(set: Set<T>, all: readonly (readonly [T, string])[]) =>
    set.size === all.length ? t('map.filterAll') : String(set.size)

  const FILTER_CATEGORIES = useMemo(
    () =>
      [
        ['own', t('map.filterCategory.own'), OWN_CHIPS, filters.own],
        ['types', t('map.filterCategory.types'), TYPE_CHIPS, filters.types],
        ['bands', t('map.filterCategory.bands'), BAND_CHIPS, filters.bands],
        ['ratios', t('map.filterCategory.ratios'), RATIO_CHIPS, filters.ratios],
        ['gen', t('map.filterCategory.gen'), GEN_CHIPS, filters.gen],
        ['courseTimes', t('map.filterCategory.courseTimes'), COURSE_TIME_CHIPS, filters.courseTimes],
        ['depts', t('map.filterCategory.depts'), DEPT_CHIPS, filters.depts],
      ] as const,
    [t, OWN_CHIPS, TYPE_CHIPS, BAND_CHIPS, RATIO_CHIPS, GEN_CHIPS, COURSE_TIME_CHIPS, DEPT_CHIPS, filters],
  )

  const activeFilterCount =
    FILTER_CATEGORIES.reduce((n, [, , list, set]) => (set.size < list.length ? n + 1 : n), 0) +
    (filters.onlyIntegrated ? 1 : 0)

  useEffect(() => {
    if (!mapNodeRef.current) return

    const map = L.map(mapNodeRef.current, { zoomControl: false }).setView(
      [ACTIVE_REGION.mapCenter.lat, ACTIVE_REGION.mapCenter.lng],
      ACTIVE_REGION.mapZoom,
    )
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
    setMapBounds(map.getBounds())
    const onMoveEnd = () => setMapBounds(map.getBounds())
    map.on('moveend', onMoveEnd)

    return () => {
      map.off('moveend', onMoveEnd)
      cancelBaseLayer()
      markerLayerRef.current = null
      clusterLayerRef.current = null
      setMapRef(null)
      setMapBounds(null)
      map.remove()
    }
  }, [])

  // 自宅が決まったら、最寄り校が収まる「通学圏」へ自動ズームする（半径は学校密度で
  // 自動決定・都道府県別の設定は持たない）。保存済み自宅の復元は学校データ到着より
  // 先に来ることがあるため、両方そろった時点で自宅地点ごとに 1 回だけ適用する。
  // 共有 URL で開いた場合は後続の effect の「該当校へ寄せる」が後から走って優先される。
  const appliedHomeViewRef = useRef<string | null>(null)
  useEffect(() => {
    if (!mapRef) return
    if (!home) {
      mapRef.setView([ACTIVE_REGION.mapCenter.lat, ACTIVE_REGION.mapCenter.lng], mapRef.getZoom())
      return
    }
    if (schools.length === 0) {
      // データ到着前は中心だけ自宅へ追従（到着後に下の fitBounds が走る）
      mapRef.setView([home.lat, home.lng], mapRef.getZoom())
      return
    }
    const key = `${home.lat},${home.lng}`
    if (appliedHomeViewRef.current === key) return
    appliedHomeViewRef.current = key
    mapRef.fitBounds(homeViewBounds(home, schools))
  }, [home, schools, mapRef])

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
          (() => {
            const latest = primaryAdmissionTrend(s)?.annual[0]
            return latest
              ? t('map.primaryAdmissionLatest', { year: latest.year, ratio: latest.ratio.toFixed(2) })
              : ''
          })(),
          kosenBadge,
          integratedBadge,
        ),
      }).on('click', () => setDetail(s)),
    )
    cluster.addLayers(schoolMarkers)
  }, [favorites, home, visibleSchools, fmt, t])

  const sortedVisible = useMemo(
    () => [...visibleSchools].sort((a, b) => shortSchoolName(a.name, a).localeCompare(shortSchoolName(b.name, b), 'ja')),
    [visibleSchools],
  )

  return (
    <div className="screen map-screen">
      <div className="header compact">
        <div className="brand">
          {home ? t('map.nearby', { label: shortLabel(home.label) }) : t('map.title')}
        </div>
      </div>

      <main id="main-content" className="map-canvas" aria-hidden={schoolListOpen} tabIndex={-1}>
        <div
          ref={mapNodeRef}
          className="leaflet-map"
          role="application"
          aria-label={t('map.title')}
          tabIndex={0}
        />
      </main>

      <div className="float-bar">
        <div className={`map-search ${searchOpen ? 'open' : ''}`}>
          <button
            type="button"
            className={`chip search-btn ${query ? 'on' : ''}`}
            aria-label={searchOpen ? t('map.searchClose') : t('map.searchOpen')}
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen((v) => {
                const next = !v
                if (next) setTimeout(() => searchInputRef.current?.focus(), 0)
                return next
              })
            }}
          >
            🔍
          </button>
          {searchOpen && (
            <>
              <input
                ref={searchInputRef}
                type="search"
                className="map-search-input"
                value={query}
                placeholder={t('map.searchPlaceholder')}
                aria-label={t('map.searchPlaceholder')}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setQuery('')
                    setSearchOpen(false)
                  }
                }}
              />
              {query && (
                <button
                  type="button"
                  className="map-search-clear"
                  aria-label={t('map.searchClear')}
                  onClick={() => {
                    setQuery('')
                    searchInputRef.current?.focus()
                  }}
                >
                  ×
                </button>
              )}
            </>
          )}
        </div>
        {FILTER_CATEGORIES.map(([key, label, list, set]) => (
          <div className="dropdown desktop-only" key={key}>
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
        <button
          type="button"
          className={`chip desktop-only ${filters.onlyIntegrated ? 'on' : ''}`}
          aria-pressed={filters.onlyIntegrated}
          onClick={() => setFilters((f) => ({ ...f, onlyIntegrated: !f.onlyIntegrated }))}
        >
          {t('map.integratedOnly')}
        </button>
        <button
          type="button"
          className="chip drop mobile-only filters-btn"
          aria-label={filterSheetOpen ? t('map.filtersClose') : t('map.filtersOpen')}
          aria-expanded={filterSheetOpen}
          onClick={() => setFilterSheetOpen(true)}
        >
          {t('map.filters')}
          {activeFilterCount > 0 && <span className="filters-badge"> ({activeFilterCount})</span>}
          {' '}▾
        </button>
      </div>
      {popover && (
        <div className="popover-scrim" onClick={() => setPopover(null)} aria-hidden="true" />
      )}

      {filterSheetOpen && (
        <>
          <div
            className="filter-sheet-scrim"
            onClick={() => setFilterSheetOpen(false)}
            aria-hidden="true"
          />
          <div className="filter-sheet" role="dialog" aria-label={t('map.filters')}>
            <div className="filter-sheet-head">
              <div className="filter-sheet-title">{t('map.filters')}</div>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setFilterSheetOpen(false)}
                aria-label={t('map.filtersClose')}
              >
                ×
              </button>
            </div>
            <div className="filter-sheet-body">
              {FILTER_CATEGORIES.map(([key, label, list, set]) => (
                <section className="filter-sheet-section" key={key}>
                  <h3 className="filter-sheet-section-title">
                    {label}
                    <span className="filter-sheet-section-count">
                      ({activeCount(set as Set<unknown>, list as unknown as readonly (readonly [unknown, string])[])})
                    </span>
                  </h3>
                  <div className="filter-sheet-chips">
                    {(list as readonly (readonly [unknown, string])[]).map(([k, l]) => (
                      <button
                        type="button"
                        key={String(k)}
                        aria-pressed={(set as Set<unknown>).has(k)}
                        className={`chip ${(set as Set<unknown>).has(k) ? 'on' : ''}`}
                        onClick={() => toggleSet(key as 'own', k as never)}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
              {/* Set で表せない単発トグルなので FILTER_CATEGORIES の外に置く */}
              <section className="filter-sheet-section">
                <h3 className="filter-sheet-section-title">{t('map.filterOther')}</h3>
                <div className="filter-sheet-chips">
                  <button
                    type="button"
                    aria-pressed={filters.onlyIntegrated}
                    className={`chip ${filters.onlyIntegrated ? 'on' : ''}`}
                    onClick={() => setFilters((f) => ({ ...f, onlyIntegrated: !f.onlyIntegrated }))}
                  >
                    {t('map.integratedOnly')}
                  </button>
                </div>
              </section>
            </div>
            <div className="filter-sheet-foot">
              <button
                type="button"
                className="cta secondary filter-sheet-clear"
                onClick={clearFilters}
              >
                {t('map.filtersClear')}
              </button>
              <button
                type="button"
                className="cta filter-sheet-apply"
                onClick={() => setFilterSheetOpen(false)}
              >
                {t('map.filtersApply')}
              </button>
            </div>
          </div>
        </>
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
          onClick={() => home && mapRef?.fitBounds(homeViewBounds(home, schools))}
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
                  <span className="school-list-name">{shortSchoolName(s.name, s)}</span>
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
