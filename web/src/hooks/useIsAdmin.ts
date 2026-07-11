import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

export function useIsAdmin(): boolean {
  const { session, loading } = useAuth()
  const [isAdmin, setIsAdmin] = useState(false)
  useEffect(() => {
    if (loading || !session) { setIsAdmin(false); return }
    let cancelled = false
    void fetch('/api/admin/me', { headers: { authorization: `Bearer ${session.access_token}` } })
      .then((response) => { if (!cancelled) setIsAdmin(response.ok) })
      .catch(() => { if (!cancelled) setIsAdmin(false) })
    return () => { cancelled = true }
  }, [loading, session])
  return isAdmin
}
