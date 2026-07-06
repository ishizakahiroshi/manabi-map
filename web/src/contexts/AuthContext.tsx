/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, LINE_PROVIDER } from '../lib/supabase'

export type UserKind = 'line' | 'google' | 'anon' | null

interface AuthState {
  session: Session | null
  loading: boolean
  kind: UserKind
  displayName: string
  signInAnonymous: () => Promise<void>
  signInLINE: () => Promise<void>
  signInGoogle: () => Promise<void>
  /** Anonymous → LINE アップグレード（データ引き継ぎ） */
  linkLINE: () => Promise<void>
  /** Anonymous → Google アップグレード（データ引き継ぎ） */
  linkGoogle: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

function kindOf(session: Session | null): UserKind {
  if (!session) return null
  if (session.user.is_anonymous) return 'anon'
  // app_metadata.provider は Google なら 'google'、LINE（Custom OIDC）なら custom identifier。
  const provider = (session.user.app_metadata as Record<string, unknown>).provider
  return provider === 'google' ? 'google' : 'line'
}

function nameOf(session: Session | null): string {
  if (!session) return 'ゲスト'
  if (session.user.is_anonymous) return 'ゲスト（匿名）'
  const meta = session.user.user_metadata as Record<string, unknown>
  const fallback = kindOf(session) === 'google' ? 'Google ユーザー' : 'LINE ユーザー'
  return (meta.name as string) || (meta.full_name as string) || fallback
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data }) => {
        setSession(data.session)
        setLoading(false)
      })
      .catch(() => {
        // 異常系（ストレージアダプタ例外等）でも loading を解除してスタックさせない
        setLoading(false)
      })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      setLoading(false)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const signInAnonymous = async () => {
    const { error } = await supabase.auth.signInAnonymously()
    if (error) throw error
  }

  const signInLINE = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      // Supabase Custom OIDC Provider（identifier: custom:line）。
      // supabase-js の Provider 型 union に custom provider が無いため cast する。
      provider: LINE_PROVIDER as 'google',
      options: { redirectTo: `${location.origin}/auth/callback` },
    })
    if (error) throw error
  }

  const signInGoogle = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      // Supabase 標準の Google provider。LINE とは別アカウント扱い（自動統合しない）。
      provider: 'google',
      options: { redirectTo: `${location.origin}/auth/callback` },
    })
    if (error) throw error
  }

  const linkLINE = async () => {
    const { error } = await supabase.auth.linkIdentity({
      provider: LINE_PROVIDER as 'google',
      options: { redirectTo: `${location.origin}/auth/callback` },
    })
    if (error) throw error
  }

  const linkGoogle = async () => {
    const { error } = await supabase.auth.linkIdentity({
      provider: 'google',
      options: { redirectTo: `${location.origin}/auth/callback` },
    })
    if (error) throw error
  }

  const signOut = async () => {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
  }

  return (
    <AuthContext.Provider
      value={{
        session,
        loading,
        kind: kindOf(session),
        displayName: nameOf(session),
        signInAnonymous,
        signInLINE,
        signInGoogle,
        linkLINE,
        linkGoogle,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
