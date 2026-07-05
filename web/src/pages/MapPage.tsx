import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { School } from '../types/school'
import { band, topDev, displayCode, devLabel, shortSchoolName } from '../lib/format'
import { haversine, shortLabel } from '../lib/geo'
import { useApp } from '../contexts/AppContext'
import { useSchools } from '../hooks/useSchools'
import type { useUserData } from '../hooks/useUserData'
import { SchoolDetailSheet } from '../components/SchoolDetailSheet'
import { AdSlot } from '../components/AdSlot'

const RADIUS_OPTIONS = [20, 30, 50, 70] as const
const ALL_BANDS = [70, 60, 50, 40] as const
const OWN_CHIPS = [
  ['prefectural', '県立'], ['municipal', '市立'], ['national', '国立'],
  ['private', '私立'], ['union', '組合立'],
] as const
const TYPE_CHIPS = [['high_school', '高校'], ['kosen', '高専(5年制)']] as const
const GEN_CHIPS = [['coed', '共学'], ['boys', '男子'], ['girls', '女子']] as const

function schoolIcon(s: School, isFav: boolean): L.DivIcon {
  const top = topDev(s)
  const b = top != null ? band(top) : null
  const badge = s.type === 'kosen' ? ' <small>[高専]</small>' : s.is_integrated ? ' <small>[一貫]</small>' : ''
  return L.divIcon({
    className: '',
    iconSize: [200, 56],
    iconAnchor: [100, 56],
    html: `<div class="pin ${isFav ? 'fav' : ''}" ${b != null ? `data-band="${b}"` : ''}>
      <div class="label">
        <div class="label-name">${shortSchoolName(s.name)}</div>
        <div class="label-dev">${displayCode(s)}<span class="dev-value">${devLabel(s)}</span>${badge}</div>
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
  onlyIntegrated: boolean
}

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
  const [mapRef, setMapRef] = useState<L.Map | null>(null)
  const [sheetExpanded, setSheetExpanded] = useState(false)
  const [detail, setDetail] = useState<School | null>(null)
  const [filters, setFilters] = useState<Filters>({
    radius: 50,
    bands: new Set(ALL_BANDS),
    own: new Set(OWN_CHIPS.map(([k]) => k)),
    gen: new Set(GEN_CHIPS.map(([k]) => k)),
    types: new Set(TYPE_CHIPS.map(([k]) => k)),
    onlyIntegrated: false,
  })

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
      return passRadius && passBand && passOwn && passGen && passType && passInt
    })
  }, [schools, favorites, home, filters])

  const favSchools = useMemo(
    () => schools.filter((s) => favorites[s.id]),
    [schools, favorites],
  )

  const toggleSet = (key: 'bands' | 'own' | 'gen' | 'types', value: never) => {
    setFilters((f) => {
      const next = new Set(f[key] as Set<unknown>)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return { ...f, [key]: next }
    })
  }

  const cycleRadius = () => {
    setFilters((f) => {
      const i = RADIUS_OPTIONS.indexOf(f.radius as (typeof RADIUS_OPTIONS)[number])
      const next = RADIUS_OPTIONS[(i + 1) % RADIUS_OPTIONS.length]
      toast(`半径 ${next}km`)
      return { ...f, radius: next }
    })
  }

  useEffect(() => {
    if (!mapNodeRef.current) return

    const map = L.map(mapNodeRef.current, { zoomControl: false }).setView([36.3907, 139.0604], 10)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    }).addTo(map)

    markerLayerRef.current = L.layerGroup().addTo(map)
    setMapRef(map)

    return () => {
      markerLayerRef.current = null
      setMapRef(null)
      map.remove()
    }
  }, [])

  useEffect(() => {
    if (!mapRef) return
    mapRef.setView(center, mapRef.getZoom())
  }, [center, mapRef])

  useEffect(() => {
    const layer = markerLayerRef.current
    if (!layer) return

    layer.clearLayers()
    if (home) {
      L.marker([home.lat, home.lng], { icon: homeIcon() }).addTo(layer)
    }
    visibleSchools.forEach((s) => {
      L.marker([s.latitude, s.longitude], { icon: schoolIcon(s, !!favorites[s.id]) })
        .on('click', () => setDetail(s))
        .addTo(layer)
    })
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
        <button className="chip" onClick={cycleRadius}>
          半径 {filters.radius}km
        </button>
        {ALL_BANDS.map((b) => (
          <button
            key={b}
            className={`chip ${filters.bands.has(b) ? 'on' : ''}`}
            onClick={() => toggleSet('bands', b as never)}
          >
            {b === 70 ? '70+' : `${b}台`}
          </button>
        ))}
      </div>

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
