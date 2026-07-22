import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

export interface AdminStatus {
  isAdmin: boolean
  checking: boolean
}

export function useIsAdmin(): AdminStatus {
  const { session, loading } = useAuth()
  const [isAdmin, setIsAdmin] = useState(false)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    if (loading) {
      setChecking(true)
      return
    }
    if (!session) {
      setIsAdmin(false)
      setChecking(false)
      return
    }

    let cancelled = false
    setChecking(true)
    void fetch('/api/admin/me', { headers: { authorization: `Bearer ${session.access_token}` } })
      .then((response) => {
        if (cancelled) return
        setIsAdmin(response.ok)
        setChecking(false)
      })
      .catch(() => {
        if (cancelled) return
        setIsAdmin(false)
        setChecking(false)
      })
    return () => { cancelled = true }
  }, [loading, session])

  return { isAdmin, checking }
}
