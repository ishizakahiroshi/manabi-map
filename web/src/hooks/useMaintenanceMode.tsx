/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import {
  MAINTENANCE_MODE,
  isMaintenanceChannelBroken,
  isMaintenanceChannelLive,
  readMaintenanceOn,
  shouldRefetchForChannelStatus,
  shouldRefetchNow,
} from '../lib/maintenance'

interface MaintenanceModeState {
  /** DB の runtime フラグと env 保険を合成した、現在の書込ブロック状態。 */
  isOn: boolean
  /** app_config から読み取った runtime フラグ。env 保険は含まない。 */
  dbOn: boolean
  /** VITE_MAINTENANCE_MODE=1 が有効か。 */
  envForced: boolean
  loading: boolean
  /**
   * 切替の購読（realtime）が生きているか。false は「いま開いているこのタブへ
   * 切替が届かない可能性がある」ことを表す。初回は購読成立まで false。
   */
  liveUpdates: boolean
}

const MaintenanceModeContext = createContext<MaintenanceModeState | null>(null)

export function MaintenanceProvider({ children }: { children: ReactNode }) {
  const [dbOn, setDbOn] = useState(false)
  const [loading, setLoading] = useState(true)
  // 購読は黙って切れる。切れたことを状態として持ち、成功と区別が付くようにする。
  const [liveUpdates, setLiveUpdates] = useState(false)

  useEffect(() => {
    let cancelled = false
    let lastFetchedAt: number | null = null

    /**
     * runtime フラグを読み直す。force は初回読み込み（間隔の下限を無視する）。
     * 読み直す機会は初回・購読の状態変化・画面復帰だけで、常時ポーリングはしない。
     */
    const load = async (force = false) => {
      const now = Date.now()
      if (!force && !shouldRefetchNow(lastFetchedAt, now)) return
      lastFetchedAt = now
      try {
        const { data, error } = await supabase
          .from('app_config')
          .select('value')
          .eq('key', 'maintenance_mode')
          .single()
        if (cancelled) return
        // DB が未適用・停止中・ネットワーク断のときは false に倒す。
        // env 保険は Provider の value 側で常に OR される。
        setDbOn(!error && readMaintenanceOn(data?.value))
      } catch {
        if (!cancelled) setDbOn(false)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load(true)

    const channel = supabase
      .channel('app_config_maintenance')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'app_config', filter: 'key=eq.maintenance_mode' },
        (payload) => {
          if (!cancelled) {
            setDbOn(readMaintenanceOn(payload.new && (payload.new as { value?: unknown }).value))
          }
        },
      )
      // 状態を受け取らずに呼ぶと、購読が張れなかった場合も成功と見分けが付かない。
      .subscribe((status) => {
        if (cancelled) return
        setLiveUpdates(isMaintenanceChannelLive(status))
        if (isMaintenanceChannelBroken(status)) {
          // 画面には何も出ないまま切替が届かなくなるので、追える形で記録する。
          console.warn(`maintenance realtime subscription ${status}: falling back to a re-read`)
        }
        if (shouldRefetchForChannelStatus(status)) void load()
      })

    // 画面に戻った時・回線が戻った時に読み直す（購読が切れている間の切替はここで拾う）。
    const refetchOnReturn = () => {
      if (cancelled) return
      if (document.visibilityState !== 'visible') return
      void load()
    }
    document.addEventListener('visibilitychange', refetchOnReturn)
    window.addEventListener('online', refetchOnReturn)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', refetchOnReturn)
      window.removeEventListener('online', refetchOnReturn)
      void supabase.removeChannel(channel)
    }
  }, [])

  const value: MaintenanceModeState = {
    isOn: MAINTENANCE_MODE || dbOn,
    dbOn,
    envForced: MAINTENANCE_MODE,
    loading,
    liveUpdates,
  }

  return <MaintenanceModeContext.Provider value={value}>{children}</MaintenanceModeContext.Provider>
}

export function useMaintenanceMode(): MaintenanceModeState {
  const context = useContext(MaintenanceModeContext)
  if (!context) throw new Error('useMaintenanceMode must be used within MaintenanceProvider')
  return context
}
