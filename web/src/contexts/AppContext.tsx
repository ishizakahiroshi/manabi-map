/* eslint-disable react-refresh/only-export-components */
import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from 'react'
import type { HomeLocation } from '../types/school'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'

const HOME_KEY = 'mm.home'

interface AppState {
  /** 地図の原点（自宅 or 検索した中心地点）。§7.6.5: 未ログイン時は LocalStorage の仮住所 */
  home: HomeLocation | null
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

function loadLocalHome(): HomeLocation | null {
  try {
    const raw = localStorage.getItem(HOME_KEY)
    return raw ? (JSON.parse(raw) as HomeLocation) : null
  } catch {
    return null
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const [home, setHomeState] = useState<HomeLocation | null>(loadLocalHome)
  const [toastMsg, setToastMsg] = useState('')
  const [toastShow, setToastShow] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const migratedFor = useRef<string | null>(null)

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
        .update({ address: h.label, latitude: h.lat, longitude: h.lng, updated_at: new Date().toISOString() })
        .eq('id', data.id)
      if (error) console.error('home_locations update failed:', error.message)
    } else {
      const { error } = await supabase.from('home_locations').insert({
        user_id: userId,
        label: '自宅',
        address: h.label,
        latitude: h.lat,
        longitude: h.lng,
        is_primary: true,
      })
      if (error) console.error('home_locations insert failed:', error.message)
    }
  }, [])

  const setHome = useCallback(
    (h: HomeLocation) => {
      setHomeState(h)
      try {
        localStorage.setItem(HOME_KEY, JSON.stringify(h))
      } catch { /* localStorage 不可の環境では仮住所は揮発で良い */ }
      if (session) void persistHome(h, session.user.id)
    },
    [session, persistHome],
  )

  // ログイン時: DB の自宅を読み込み。無ければ LocalStorage の仮住所を移送（§7.6.5）
  // migratedFor は成功時のみ立てる（失敗時に再試行できるよう、エラーで固定しない）
  useEffect(() => {
    if (!session || migratedFor.current === session.user.id) return
    const userId = session.user.id
    void (async () => {
      const { data, error: selErr } = await supabase
        .from('home_locations')
        .select('address, latitude, longitude')
        .eq('is_primary', true)
        .maybeSingle()
      if (selErr) {
        console.error('home_locations load failed:', selErr.message)
        return
      }
      migratedFor.current = userId
      if (data) {
        const h = { label: data.address, lat: Number(data.latitude), lng: Number(data.longitude) }
        setHomeState(h)
        try { localStorage.setItem(HOME_KEY, JSON.stringify(h)) } catch { /* noop */ }
      } else {
        const local = loadLocalHome()
        if (local) {
          const { error } = await supabase.from('home_locations').insert({
            user_id: userId,
            label: '自宅',
            address: local.label,
            latitude: local.lat,
            longitude: local.lng,
            is_primary: true,
          })
          if (error) console.error('home_locations migrate failed:', error.message)
        }
      }
    })()
  }, [session])

  return (
    <AppContext.Provider
      value={{ home, setHome, toast, toastMsg, toastShow, loginOpen, setLoginOpen, sidebarOpen, setSidebarOpen }}
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
