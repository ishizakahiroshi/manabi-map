import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import type { School } from '../types/school'
import { band, topDev, displayCode, devLabel, shortSchoolName } from '../lib/format'
import {
  haversine,
  shortLabel,
  estimateWalkMinutes,
  estimateBikeMinutes,
  estimateCarMinutes,
  estimateTransitMinutes,
} from '../lib/geo'
import type { HomeLocation } from '../types/school'
import { useApp } from '../contexts/AppContext'
import { useSchools } from '../hooks/useSchools'
import type { useUserData } from '../hooks/useUserData'
import { SchoolDetailSheet } from '../components/SchoolDetailSheet'
import { AdSlot } from '../components/AdSlot'

const RADIUS_MIN = 5
const RADIUS_MAX = 80
const ALL_BANDS = [70, 60, 50, 40] as const
const OWN_CHIPS = [
  ['prefectural', '県立'], ['municipal', '市立'], ['national', '国立'],
  ['private', '私立'], ['union', '組合立'],
] as const
const TYPE_CHIPS = [['high_school', '高校'], ['kosen', '高専(5年制)']] as const
const GEN_CHIPS = [['coed', '共学'], ['boys', '男子'], ['girls', '女子']] as const
const DEPT_CHIPS = [
  ['general', '普通科系'],
  ['comprehensive', '総合学科'],
  ['commercial', '商業系'],
  ['industrial', '工業系'],
  ['agricultural', '農業系'],
  ['welfare', '福祉・看護'],
] as const

function deptGroupOf(courseType: string | null): (typeof DEPT_CHIPS)[number][0] | null {
  if (!courseType) return null
  const c = courseType
  if (c === 'comprehensive') return 'comprehensive'
  if (c === 'general' || c === 'science' || c === 'international' || c === 'chuko_ikkan') return 'general'
  if (c === 'commercial' || c === 'accounting' || c === 'information_processing') return 'commercial'
  if (c.startsWith('industrial') || c.startsWith('kosen') || c === 'civil') return 'industrial'
  if (c.startsWith('agricultural')) return 'agricultural'
  if (c === 'health_nursing' || c === 'human_service') return 'welfare'
  return null
}

function schoolIcon(s: School, isFav: boolean, home: HomeLocation | null): L.DivIcon {
  const top = topDev(s)
  const b = top != null ? band(top) : null
  const badge = s.type === 'kosen' ? ' <small>[高専]</small>' : s.is_integrated ? ' <small>[一貫]</small>' : ''
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
        <div class="label-name">${shortSchoolName(s.name)}</div>
        <div class="label-dev">${displayCode(s)}<span class="dev-value">${devLabel(s)}</span>${badge}</div>
        ${commute}
      </div>
      <div class="dot"></div>
    </div>`,
  })
}

function homeIcon(): L.DivIcon {
  return L.divIcon({
    className: '',
    iconSize: [80, 44],
    iconAnchor: [40, 44],
    html: `<div class="pin home"><div class="label">自宅 ⌂</div><div class="dot">⌂</div></div>`,
  })
}

interface Filters {
  radius: number
  bands: Set<number>
  own: Set<string>
  gen: Set<string>
  types: Set<string>
  depts: Set<string>
  onlyIntegrated: boolean
}

type PopoverKey = 'own' | 'bands' | 'gen' | 'depts' | null

interface Props {
  userData: ReturnType<typeof useUserData>
}

export function MapPage({ userData }: Props) {
  const navigate = useNavigate()
  const { home, toast } = useApp()
  const { schools, loading, error } = useSchools()
  const { favorites } = userData
  const mapNodeRef = useRef<HTMLDivElement | null>(null)
  const markerLayerRef = useRef<L.LayerGroup | null>(null)
  const clusterLayerRef = useRef<L.MarkerClusterGroup | null>(null)
  const [mapRef, setMapRef] = useState<L.Map | null>(null)
  const [sheetExpanded, setSheetExpanded] = useState(false)
  const [detail, setDetail] = useState<School | null>(null)
  const [filters, setFilters] = useState<Filters>({
    radius: 50,
    bands: new Set(ALL_BANDS),
    own: new Set(OWN_CHIPS.map(([k]) => k)),
    gen: new Set(GEN_CHIPS.map(([k]) => k)),
    types: new Set(TYPE_CHIPS.map(([k]) => k)),
    depts: new Set(DEPT_CHIPS.map(([k]) => k)),
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
      // 偏差値未確定校は帯フィルタの対象外にせず常に表示（0 埋めしない方針と整合）
      const passBand = top == null || filters.bands.has(band(top))
      const passOwn = filters.own.has(s.ownership)
      const passGen = filters.gen.has(s.gender_type)
      const passType = filters.types.has(s.type)
      const passInt = !filters.onlyIntegrated || s.is_integrated
      // 学科: 少なくとも 1 学科がグループにマッチすれば通す。全学科の course_type が
      // 不明（deptGroupOf=null）の校は「未分類」として常に通す（除外しない）。
      const groups = s.departments
        .map((d) => deptGroupOf(d.course_type))
        .filter((g): g is (typeof DEPT_CHIPS)[number][0] => g != null)
      const passDept = groups.length === 0 || groups.some((g) => filters.depts.has(g))
      return passRadius && passBand && passOwn && passGen && passType && passDept && passInt
    })
  }, [schools, favorites, home, filters])

  const favSchools = useMemo(
    () => schools.filter((s) => favorites[s.id]),
    [schools, favorites],
  )

  const toggleSet = (key: 'bands' | 'own' | 'gen' | 'types' | 'depts', value: never) => {
    setFilters((f) => {
      const next = new Set(f[key] as Set<unknown>)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return { ...f, [key]: next }
    })
  }

  const activeCount = <T,>(set: Set<T>, all: readonly (readonly [T, string])[]) =>
    set.size === all.length ? '全' : String(set.size)

  useEffect(() => {
    if (!mapNodeRef.current) return

    const map = L.map(mapNodeRef.current, { zoomControl: false }).setView([36.3907, 139.0604], 10)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    }).addTo(map)

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

  useEffect(() => {
    const homeLayer = markerLayerRef.current
    const cluster = clusterLayerRef.current
    if (!homeLayer || !cluster) return

    homeLayer.clearLayers()
    cluster.clearLayers()
    if (home) {
      L.marker([home.lat, home.lng], { icon: homeIcon() }).addTo(homeLayer)
    }
    const schoolMarkers = visibleSchools.map((s) =>
      L.marker([s.latitude, s.longitude], { icon: schoolIcon(s, !!favorites[s.id], home) })
        .on('click', () => setDetail(s)),
    )
    cluster.addLayers(schoolMarkers)
  }, [favorites, home, visibleSchools])

  return (
    <div className="screen map-screen">
      <div className="header">
        <button className="icon-btn" onClick={() => navigate('/')} aria-label="トップに戻る">
          ←
        </button>
        <div className="brand">{home ? shortLabel(home.label) + '周辺' : '地図'}</div>
        <button className="icon-btn" onClick={() => navigate('/favorites')} aria-label="お気に入り一覧">
          ★
        </button>
      </div>

      <div className="map-canvas">
        <div ref={mapNodeRef} className="leaflet-map" />
      </div>

      <div className="float-bar">
        <div className="radius-slider" aria-label="表示半径">
          <span className="rs-label">半径</span>
          <input
            type="range"
            min={RADIUS_MIN}
            max={RADIUS_MAX}
            step={5}
            value={filters.radius}
            onChange={(e) => setFilters((f) => ({ ...f, radius: Number(e.target.value) }))}
            onMouseUp={() => toast(`半径 ${filters.radius}km`)}
            onTouchEnd={() => toast(`半径 ${filters.radius}km`)}
          />
          <span className="rs-value">{filters.radius}km</span>
        </div>
        {(
          [
            ['own', '種別', OWN_CHIPS, filters.own],
            ['bands', '偏差値', ALL_BANDS.map((b) => [b, b === 70 ? '70+' : `${b}台`] as const), filters.bands],
            ['gen', '性別', GEN_CHIPS, filters.gen],
            ['depts', '学科', DEPT_CHIPS, filters.depts],
          ] as const
        ).map(([key, label, list, set]) => (
          <div className="dropdown" key={key}>
            <button
              className={`chip drop ${popover === key ? 'open' : ''}`}
              onClick={() => setPopover((p) => (p === key ? null : (key as PopoverKey)))}
            >
              {label} ({activeCount(set as Set<unknown>, list as unknown as readonly (readonly [unknown, string])[])}) ▾
            </button>
            {popover === key && (
              <div className="popover">
                {(list as readonly (readonly [unknown, string])[]).map(([k, l]) => (
                  <button
                    key={String(k)}
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
      {popover && <div className="popover-scrim" onClick={() => setPopover(null)} />}

      <div className="map-controls">
        <button onClick={() => mapRef?.setZoom(mapRef.getZoom() + 1)} aria-label="ズームイン">
          ＋
        </button>
        <button onClick={() => mapRef?.setZoom(mapRef.getZoom() - 1)} aria-label="ズームアウト">
          −
        </button>
        <button
          onClick={() => home && mapRef?.setView([home.lat, home.lng], 10)}
          title="自宅に戻す"
          aria-label="自宅に戻す"
        >
          ⌂
        </button>
      </div>

      {(loading || error) && (
        <div className="float-bar" style={{ top: 108 }}>
          {loading && <span className="chip">学校データを読み込み中…</span>}
          {error && <span className="chip" style={{ color: 'var(--bad)' }}>{error}</span>}
        </div>
      )}

      <div className={`sheet ${sheetExpanded ? 'expanded' : ''}`}>
        <button className="handle" onClick={() => setSheetExpanded((v) => !v)} aria-label="シートを開閉" />
        <div className="head">
          <span className="grow">
            <span style={{ color: 'var(--fav-yellow)' }}>★</span> お気に入り {favSchools.length}件
          </span>
          <button className="link-btn" onClick={() => navigate('/favorites')}>
            一覧 ›
          </button>
        </div>
        <div className="body">
          <div className="fav-mini">
            {favSchools.length === 0 ? (
              <div className="fav-mini-empty">ピンをタップして志望校を追加してください</div>
            ) : (
              favSchools.map((s) => (
                <button className="row" key={s.id} onClick={() => setDetail(s)}>
                  <span className="star">★</span>
                  <span className="name">{shortSchoolName(s.name)}</span>
                  <span className="badge">
                    {displayCode(s)}：{devLabel(s)}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="filter-group">
            <div className="label">運営</div>
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
            <div className="label">学校種別</div>
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
            <div className="label">性別</div>
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
            <div className="label">学科</div>
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
            <div className="label">その他</div>
            <div className="chips">
              <button
                className={`chip ${filters.onlyIntegrated ? 'on' : ''}`}
                onClick={() => setFilters((f) => ({ ...f, onlyIntegrated: !f.onlyIntegrated }))}
              >
                中高一貫のみ
              </button>
            </div>
          </div>

          <AdSlot
            className="mt-2"
            category="受験対策"
            title="群馬県公立高校 過去問集"
            description="志望校対策に。過去5年分＋解説付き。"
            cta="見る"
          />
        </div>
      </div>

      {detail && <SchoolDetailSheet school={detail} onClose={() => setDetail(null)} userData={userData} />}
    </div>
  )
}
