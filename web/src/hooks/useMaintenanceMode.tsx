/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { MAINTENANCE_MODE } from '../lib/maintenance'

interface MaintenanceModeState {
  /** DB の runtime フラグと env 保険を合成した、現在の書込ブロック状態。 */
  isOn: boolean
  /** app_config から読み取った runtime フラグ。env 保険は含まない。 */
  dbOn: boolean
  /** VITE_MAINTENANCE_MODE=1 が有効か。 */
  envForced: boolean
  loading: boolean
}

const MaintenanceModeContext = createContext<MaintenanceModeState | null>(null)

function readOn(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  return (value as { on?: unknown }).on === true
}

export function MaintenanceProvider({ children }: { children: ReactNode }) {
  const [dbOn, setDbOn] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const { data, error } = await supabase
          .from('app_config')
          .select('value')
          .eq('key', 'maintenance_mode')
          .single()
        if (cancelled) return
        // DB が未適用・停止中・ネットワーク断のときは false に倒す。
        // env 保険は Provider の value 側で常に OR される。
        setDbOn(!error && readOn(data?.value))
      } catch {
        if (!cancelled) setDbOn(false)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()

    const channel = supabase
      .channel('app_config_maintenance')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'app_config', filter: 'key=eq.maintenance_mode' },
        (payload) => {
          if (!cancelled) setDbOn(readOn(payload.new && (payload.new as { value?: unknown }).value))
        },
      )
      .subscribe()

    return () => {
      cancelled = true
      void supabase.removeChannel(channel)
    }
  }, [])

  const value: MaintenanceModeState = {
    isOn: MAINTENANCE_MODE || dbOn,
    dbOn,
    envForced: MAINTENANCE_MODE,
    loading,
  }

  return <MaintenanceModeContext.Provider value={value}>{children}</MaintenanceModeContext.Provider>
}

export function useMaintenanceMode(): MaintenanceModeState {
  const context = useContext(MaintenanceModeContext)
  if (!context) throw new Error('useMaintenanceMode must be used within MaintenanceProvider')
  return context
}
