/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { MAINTENANCE_MODE, readMaintenanceOn, watchMaintenanceFlag } from '../lib/maintenance'

interface MaintenanceModeState {
  /** DB の runtime フラグと env 保険を合成した、現在の書込ブロック状態。 */
  isOn: boolean
  /** app_config から読み取った runtime フラグ。env 保険は含まない。 */
  dbOn: boolean
  /** VITE_MAINTENANCE_MODE=1 が有効か。 */
  envForced: boolean
  loading: boolean
  /**
   * 直近の app_config の読み直しに失敗しているか。true の間は、いま開いているこのタブの
   * 表示が最新でない可能性がある。次に読めた時点で false に戻る。初回は読み込み前なので false。
   */
  lastReadFailed: boolean
  /**
   * 管理画面で切り替えた結果（API の応答）を、次の読み直しを待たずにこのタブの dbOn へ入れる。
   * realtime の購読をやめたので、これが無いと自分で切り替えたタブにも最大で読み直し間隔ぶん届かない。
   */
  applyDbOn: (on: boolean) => void
}

const MaintenanceModeContext = createContext<MaintenanceModeState | null>(null)

export function MaintenanceProvider({ children }: { children: ReactNode }) {
  const [dbOn, setDbOn] = useState(false)
  const [loading, setLoading] = useState(true)
  // 読めなかったことを状態として持ち、OFF のままと区別が付くようにする。
  const [lastReadFailed, setLastReadFailed] = useState(false)

  useEffect(() => {
    // 読み直すきっかけ・間隔・重複防止は watchMaintenanceFlag（lib/maintenance.ts）にまとめてある。
    // realtime の購読は張らない（同時接続を使わない）。
    return watchMaintenanceFlag({
      fetchOn: async () => {
        const { data, error } = await supabase
          .from('app_config')
          .select('value')
          .eq('key', 'maintenance_mode')
          .single()
        if (error) throw error
        return readMaintenanceOn(data?.value)
      },
      onRead: (result) => {
        // 読めなかったときは直前に読めた値を保つ。一度も読めていなければ初期値の OFF のまま
        // （DB が未適用・停止中・ネットワーク断でも閲覧を止めない）。env 保険は value 側で常に OR される。
        if (!result.failed) setDbOn(result.on)
        setLastReadFailed(result.failed)
        setLoading(false)
      },
      isVisible: () => document.visibilityState === 'visible',
      doc: document,
      win: window,
    })
  }, [])

  const value: MaintenanceModeState = {
    isOn: MAINTENANCE_MODE || dbOn,
    dbOn,
    envForced: MAINTENANCE_MODE,
    loading,
    lastReadFailed,
    applyDbOn: setDbOn,
  }

  return <MaintenanceModeContext.Provider value={value}>{children}</MaintenanceModeContext.Provider>
}

export function useMaintenanceMode(): MaintenanceModeState {
  const context = useContext(MaintenanceModeContext)
  if (!context) throw new Error('useMaintenanceMode must be used within MaintenanceProvider')
  return context
}
