import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

export interface AdminStatus {
  isAdmin: boolean
  checking: boolean
}

export function useIsAdmin(): AdminStatus {
  const { session, loading } = useAuth()
  const [isAdmin, setIsAdmin] = useState(false)
  const [checking, setChecking] = useState(true)
  const previousUserId = useRef<string | null>(null)
  const userId = session?.user.id ?? null
  const accessToken = session?.access_token ?? null

  useEffect(() => {
    if (loading) {
      setChecking(true)
      return
    }
    if (!accessToken || !userId) {
      setIsAdmin(false)
      setChecking(false)
      return
    }

    if (previousUserId.current !== userId) setIsAdmin(false)
    previousUserId.current = userId
    let cancelled = false
    setChecking(true)
    void fetch('/api/admin/me', { headers: { authorization: `Bearer ${accessToken}` } })
      .then((response) => {
        if (cancelled) return
        if (response.ok) setIsAdmin(true)
        else if (response.status === 401 || response.status === 403) setIsAdmin(false)
        // 404 は maintenance/API 経路や一時的な edge 不調でも返り得るため、
        // 5xx/429 と同じく直前に確認できた管理者状態を保持する。
        setChecking(false)
      })
      .catch(() => {
        if (cancelled) return
        // ネットワーク断で管理者を強制退去させない。次回の照会で再確認する。
        setChecking(false)
      })
    return () => { cancelled = true }
  }, [loading, accessToken, userId])

  return { isAdmin, checking }
}
