/* eslint-disable react-refresh/only-export-components */
import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from 'react'
import type { HomeLocation } from '../types/school'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'

const HOME_KEY = 'mm.home'
const PERSISTED_HOME_LABEL = '設定地点'

export type HomeLoadState = 'loading' | 'ready' | 'error'

interface AppState {
  /** 地図の原点（自宅 or 検索した中心地点）。§7.6.5: 未ログイン時は LocalStorage の仮住所 */
  home: HomeLocation | null
  /** home が未設定なのか、まだ復元中なのかを区別する状態 */
  homeLoadState: HomeLoadState
  setHome: (h: HomeLocation) => void
  toast: (msg: string) => void
  toastMsg: string
  toastShow: boolean
  loginOpen: boolean
  setLoginOpen: (v: boolean) => void
  sidebarOpen: boolean
  setSidebarOpen: (v: boolean) => void
}

const AppContext = createContext<AppState | null>(null)

export function isValidHomeLocation(value: unknown): value is HomeLocation {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<HomeLocation>
  return (
    typeof candidate.label === 'string' &&
    Number.isFinite(candidate.lat) &&
    candidate.lat! >= -90 &&
    candidate.lat! <= 90 &&
    Number.isFinite(candidate.lng) &&
    candidate.lng! >= -180 &&
    candidate.lng! <= 180
  )
}

/**
 * 端末・DBに残す中心地点を必要最小限の形にする。
 * geocoderの詳細labelとexact coordinateはこの関数の外へ永続化しない。
 */
export function normalizeHomeForPersistence(value: unknown): HomeLocation | null {
  if (!isValidHomeLocation(value)) return null
  const roundCoordinate = (coordinate: number) => {
    const rounded = Number(coordinate.toFixed(3))
    return Object.is(rounded, -0) ? 0 : rounded
  }
  return {
    label: PERSISTED_HOME_LABEL,
    lat: roundCoordinate(value.lat),
    lng: roundCoordinate(value.lng),
  }
}

/** 表示用の座標を固定小数点に整形する。無効な地点は表示へ渡さない。 */
export function formatHomeCoordinates(value: unknown): { lat: string; lng: string } | null {
  if (!isValidHomeLocation(value)) return null
  return { lat: value.lat.toFixed(3), lng: value.lng.toFixed(3) }
}

/** localStorage の値を検証する純粋関数。壊れた JSON/形状は地図へ渡さない。 */
export function parseStoredHome(raw: string | null): HomeLocation | null {
  try {
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    return normalizeHomeForPersistence(value)
  } catch {
    return null
  }
}

export function loadLocalHome(): HomeLocation | null {
  try {
    const raw = localStorage.getItem(HOME_KEY)
    const home = parseStoredHome(raw)
    if (raw && !home) {
      localStorage.removeItem(HOME_KEY)
    } else if (home) {
      // 旧形式の詳細label/高精度座標も読込み時に縮約する。
      localStorage.setItem(HOME_KEY, JSON.stringify(home))
    }
    return home
  } catch {
    try { localStorage.removeItem(HOME_KEY) } catch { /* noop */ }
    return null
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  // 初回 render は必ず null。localStorage を初期値に使うとビルド時プリレンダーと食い違い、
  // hydration が壊れる（plan_ssr-hydration.md C2）。
  // 復元は下の [session] effect が担う（未ログイン時に loadLocalHome() を読む経路が既にある）。
  const [home, setHomeState] = useState<HomeLocation | null>(null)
  const [homeLoadState, setHomeLoadState] = useState<HomeLoadState>('loading')
  const [toastMsg, setToastMsg] = useState('')
  const [toastShow, setToastShow] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const migratedFor = useRef<string | null>(null)
  const activeHomeUserId = useRef<string | null>(null)

  const toast = useCallback((msg: string) => {
    setToastMsg(msg)
    setToastShow(true)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToastShow(false), 1600)
  }, [])

  /**
   * 自宅（中心地点）を DB に保存する。§16.5: 「自宅住所」ではなく「中心地点」として扱う。
   * home_locations の一意性は partial unique index（is_primary=true 限定）のため
   * upsert の onConflict が使えず、select → update / insert で分岐する。
   */
  const persistHome = useCallback(async (h: HomeLocation, userId: string) => {
    const persisted = normalizeHomeForPersistence(h)
    if (!persisted) return
    // fire-and-forget 設計のため UI には出さないが、静かなデータ欠落を追えるよう失敗は記録する
    // （住所値は PII のためログに出さない）
    const { data, error: selErr } = await supabase
      .from('home_locations')
      .select('id')
      .eq('user_id', userId)
      .eq('is_primary', true)
      .maybeSingle()
    if (selErr) {
      console.error('home_locations select failed:', selErr.message)
      return
    }
    if (data) {
      const { error } = await supabase
        .from('home_locations')
        .update({
          label: persisted.label,
          address: persisted.label,
          latitude: persisted.lat,
          longitude: persisted.lng,
          updated_at: new Date().toISOString(),
        })
        .eq('id', data.id)
      if (error) console.error('home_locations update failed:', error.message)
    } else {
      const { error } = await supabase.from('home_locations').insert({
        user_id: userId,
        label: persisted.label,
        address: persisted.label,
        latitude: persisted.lat,
        longitude: persisted.lng,
        is_primary: true,
      })
      if (error) console.error('home_locations insert failed:', error.message)
    }
  }, [])

  const setHome = useCallback(
    (h: HomeLocation) => {
      const persisted = normalizeHomeForPersistence(h)
      if (!persisted) return
      setHomeState(persisted)
      setHomeLoadState('ready')
      try {
        localStorage.setItem(HOME_KEY, JSON.stringify(persisted))
      } catch { /* localStorage 不可の環境では仮住所は揮発で良い */ }
      if (session) void persistHome(persisted, session.user.id)
    },
    [session, persistHome],
  )

  // ログイン時: DB の自宅を読み込み。無ければ LocalStorage の仮住所を移送（§7.6.5）
  // migratedFor は成功時のみ立てる（失敗時に再試行できるよう、エラーで固定しない）
  useEffect(() => {
    setHomeLoadState('loading')
    if (!session) {
      // 実ログインからのサインアウト後は、前ユーザーの地点を次のユーザーへ移送しない。
      // 初回の未ログイン状態では activeHomeUserId が null のため、匿名利用の引き継ぎは残る。
      if (activeHomeUserId.current !== null) {
        try { localStorage.removeItem(HOME_KEY) } catch { /* noop */ }
        activeHomeUserId.current = null
        migratedFor.current = null
        setHomeState(null)
        setHomeLoadState('ready')
        return
      }
      activeHomeUserId.current = null
      migratedFor.current = null
      setHomeState(loadLocalHome())
      setHomeLoadState('ready')
      return
    }
    const userId = session.user.id
    if (activeHomeUserId.current !== userId) {
      // DB 応答がまだ返っていない切替でも、前ユーザーの自宅地点を消す。
      setHomeState(null)
      migratedFor.current = null
    }
    activeHomeUserId.current = userId
    if (migratedFor.current === userId) {
      setHomeLoadState('ready')
      return
    }
    let cancelled = false
    void (async () => {
      const { data, error: selErr } = await supabase
        .from('home_locations')
        .select('address, latitude, longitude')
        .eq('is_primary', true)
        .maybeSingle()
      if (selErr) {
        console.error('home_locations load failed:', selErr.message)
        if (!cancelled) {
          setHomeState(null)
          setHomeLoadState('error')
        }
        return
      }
      if (cancelled) return
      if (data) {
        const h = normalizeHomeForPersistence({
          label: data.address,
          lat: Number(data.latitude),
          lng: Number(data.longitude),
        })
        if (!h) {
          console.error('home_locations load returned invalid coordinates')
          setHomeState(null)
          setHomeLoadState('error')
          return
        }
        if (cancelled) return
        migratedFor.current = userId
        setHomeState(h)
        setHomeLoadState('ready')
        try { localStorage.setItem(HOME_KEY, JSON.stringify(h)) } catch { /* noop */ }
      } else {
        const local = loadLocalHome()
        if (local) {
          if (cancelled) return
          setHomeState(local)
          if (cancelled) return
          const { error } = await supabase.from('home_locations').insert({
            user_id: userId,
            label: local.label,
            address: local.label,
            latitude: local.lat,
            longitude: local.lng,
            is_primary: true,
          })
          if (error) console.error('home_locations migrate failed:', error.message)
          if (cancelled) return
          setHomeLoadState('ready')
          if (error) return
        }
        if (cancelled) return
        if (!local) setHomeState(null)
        migratedFor.current = userId
        setHomeLoadState('ready')
      }
    })()
    return () => { cancelled = true }
  }, [session])

  // session が切り替わってから復元 effect が走るまでの render でも、前ユーザーの地点を公開しない。
  const homeSessionReady = session
    ? activeHomeUserId.current === session.user.id
    : activeHomeUserId.current === null

  return (
    <AppContext.Provider
      value={{
        home: homeSessionReady ? home : null,
        homeLoadState: homeSessionReady ? homeLoadState : 'loading',
        setHome,
        toast,
        toastMsg,
        toastShow,
        loginOpen,
        setLoginOpen,
        sidebarOpen,
        setSidebarOpen,
      }}
    >
      {children}
    </AppContext.Provider>
  )
}

export function useApp(): AppState {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
