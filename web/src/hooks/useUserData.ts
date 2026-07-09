import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { trackEvent } from '../lib/analytics'
import { MAINTENANCE_MODE } from '../lib/maintenance'
import { useApp } from '../contexts/AppContext'
import { useAuth } from '../contexts/AuthContext'
import { useI18n } from '../contexts/I18nContext'
import type { Favorite, MineRecord, SchoolNote } from '../types/school'

interface UserData {
  /** school_id → Favorite */
  favorites: Record<string, Favorite>
  /** school_id → SchoolNote */
  notes: Record<string, SchoolNote>
  /** school_id → MineRecord（個人偏差値記録） */
  mine: Record<string, MineRecord>
  loading: boolean
  toggleFavorite: (schoolId: string) => Promise<boolean>
  setPriority: (schoolId: string, priority: number) => Promise<void>
  saveNote: (schoolId: string, note: string, commuteNote: string) => Promise<void>
  saveMineValue: (schoolId: string, departmentId: string, value: number | null) => Promise<void>
  saveMineNote: (schoolId: string, note: string) => Promise<void>
  saveMineConsent: (schoolId: string, submit: boolean) => Promise<void>
}

const EMPTY_MINE: MineRecord = { depts: {}, note: '', visibility: 'private' }

export function useUserData(): UserData {
  const { session } = useAuth()
  const { toast } = useApp()
  const { t } = useI18n()
  const userId = session?.user.id ?? null
  const [favorites, setFavorites] = useState<Record<string, Favorite>>({})
  const [notes, setNotes] = useState<Record<string, SchoolNote>>({})
  const [mine, setMine] = useState<Record<string, MineRecord>>({})
  const [loading, setLoading] = useState(false)

  /**
   * メンテナンスモード中の書き込みガード。全 mutation の先頭で呼び、
   * 読み取り専用トーストを出して true を返した場合は呼び出し側が早期 return する。
   * true 応答時は Supabase に一切書き込まない。
   */
  const blockedByMaintenance = useCallback((): boolean => {
    if (!MAINTENANCE_MODE) return false
    toast(t('maintenance.toast'))
    return true
  }, [toast, t])

  useEffect(() => {
    if (!userId) {
      setFavorites({})
      setNotes({})
      setMine({})
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      const [favRes, noteRes, mineRes] = await Promise.all([
        supabase.from('user_school_favorites').select('school_id, priority, status'),
        supabase.from('user_school_notes').select('school_id, note, commute_note'),
        supabase.from('user_school_deviations').select('school_id, department_id, value, note, visibility'),
      ])
      if (cancelled) return
      // 取得失敗を空データと誤認させない（空扱いのまま toggle すると DB と乖離する）
      if (favRes.error || noteRes.error || mineRes.error) {
        console.error('user data load failed:', (favRes.error ?? noteRes.error ?? mineRes.error)?.message)
      }
      const favs: Record<string, Favorite> = {}
      for (const f of favRes.data ?? []) {
        favs[f.school_id] = { school_id: f.school_id, priority: f.priority ?? 0, status: f.status ?? 'interested' }
      }
      const ns: Record<string, SchoolNote> = {}
      for (const n of noteRes.data ?? []) {
        ns[n.school_id] = { school_id: n.school_id, note: n.note ?? '', commute_note: n.commute_note ?? '' }
      }
      const ms: Record<string, MineRecord> = {}
      for (const m of mineRes.data ?? []) {
        const cur = ms[m.school_id] ?? { depts: {}, note: '', visibility: 'private' as const }
        if (m.department_id) {
          cur.depts[m.department_id] = m.value
        } else {
          cur.note = m.note ?? ''
        }
        if (m.visibility === 'submit_to_manabi') cur.visibility = 'submit_to_manabi'
        ms[m.school_id] = cur
      }
      if (!favRes.error) setFavorites(favs)
      if (!noteRes.error) setNotes(ns)
      if (!mineRes.error) setMine(ms)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [userId])

  /** @returns 登録後の状態（true = お気に入り済） */
  const toggleFavorite = useCallback(
    async (schoolId: string): Promise<boolean> => {
      if (!userId) throw new Error('not signed in')
      if (blockedByMaintenance()) return Boolean(favorites[schoolId])
      const prev = favorites[schoolId]
      if (prev) {
        setFavorites((cur) => {
          const next = { ...cur }
          delete next[schoolId]
          return next
        })
        const { error } = await supabase
          .from('user_school_favorites')
          .delete()
          .eq('user_id', userId)
          .eq('school_id', schoolId)
        if (error) {
          // DB 失敗時は楽観更新を巻き戻す（UI と DB の乖離防止）
          setFavorites((cur) => ({ ...cur, [schoolId]: prev }))
          throw error
        }
        return false
      }
      const fav: Favorite = { school_id: schoolId, priority: 3, status: 'interested' }
      setFavorites((cur) => ({ ...cur, [schoolId]: fav }))
      const { error } = await supabase.from('user_school_favorites').insert({
        user_id: userId,
        school_id: schoolId,
        priority: fav.priority,
        status: fav.status,
      })
      if (error) {
        setFavorites((cur) => {
          const next = { ...cur }
          delete next[schoolId]
          return next
        })
        throw error
      }
      trackEvent('favorite_add', { school_id: schoolId })
      return true
    },
    [userId, favorites, blockedByMaintenance],
  )

  const setPriority = useCallback(
    async (schoolId: string, priority: number) => {
      if (!userId) throw new Error('not signed in')
      if (blockedByMaintenance()) return
      const existing = favorites[schoolId]
      setFavorites((cur) => ({
        ...cur,
        [schoolId]: { school_id: schoolId, priority, status: existing?.status ?? 'interested' },
      }))
      const { error } = await supabase.from('user_school_favorites').upsert(
        { user_id: userId, school_id: schoolId, priority, status: existing?.status ?? 'interested' },
        { onConflict: 'user_id,school_id' },
      )
      if (error) {
        setFavorites((cur) => {
          const next = { ...cur }
          if (existing) next[schoolId] = existing
          else delete next[schoolId]
          return next
        })
        throw error
      }
    },
    [userId, favorites, blockedByMaintenance],
  )

  const saveNote = useCallback(
    async (schoolId: string, note: string, commuteNote: string) => {
      if (!userId) throw new Error('not signed in')
      if (blockedByMaintenance()) return
      const prev = notes[schoolId]
      setNotes((cur) => ({ ...cur, [schoolId]: { school_id: schoolId, note, commute_note: commuteNote } }))
      const { error } = await supabase.from('user_school_notes').upsert(
        {
          user_id: userId,
          school_id: schoolId,
          note,
          commute_note: commuteNote,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,school_id' },
      )
      if (error) {
        setNotes((cur) => {
          const next = { ...cur }
          if (prev) next[schoolId] = prev
          else delete next[schoolId]
          return next
        })
        throw error
      }
      trackEvent('memo_save', { school_id: schoolId })
    },
    [userId, notes, blockedByMaintenance],
  )

  /**
   * 個人偏差値の保存。unique(user_id, school_id, department_id) は department_id が
   * NULL の行に効かないため、学科行のみ upsert し school 単位の note 行は手動分岐する。
   */
  const saveMineValue = useCallback(
    async (schoolId: string, departmentId: string, value: number | null) => {
      if (!userId) throw new Error('not signed in')
      if (blockedByMaintenance()) return
      const prev = mine[schoolId]
      const cur = prev ?? EMPTY_MINE
      const nextDepts = { ...cur.depts }
      if (value == null) delete nextDepts[departmentId]
      else nextDepts[departmentId] = value
      setMine((m) => ({ ...m, [schoolId]: { ...cur, depts: nextDepts } }))
      const rollback = () =>
        setMine((m) => {
          const next = { ...m }
          if (prev) next[schoolId] = prev
          else delete next[schoolId]
          return next
        })
      if (value == null) {
        const { error } = await supabase
          .from('user_school_deviations')
          .delete()
          .eq('user_id', userId)
          .eq('school_id', schoolId)
          .eq('department_id', departmentId)
        if (error) {
          rollback()
          throw error
        }
      } else {
        const { error } = await supabase.from('user_school_deviations').upsert(
          {
            user_id: userId,
            school_id: schoolId,
            department_id: departmentId,
            value,
            visibility: cur.visibility,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,school_id,department_id' },
        )
        if (error) {
          rollback()
          throw error
        }
      }
    },
    [userId, mine, blockedByMaintenance],
  )

  const saveMineNote = useCallback(
    async (schoolId: string, note: string) => {
      if (!userId) throw new Error('not signed in')
      if (blockedByMaintenance()) return
      const prev = mine[schoolId]
      const cur = prev ?? EMPTY_MINE
      setMine((m) => ({ ...m, [schoolId]: { ...cur, note } }))
      const rollback = () =>
        setMine((m) => {
          const next = { ...m }
          if (prev) next[schoolId] = prev
          else delete next[schoolId]
          return next
        })
      try {
        const { data, error: selErr } = await supabase
          .from('user_school_deviations')
          .select('id')
          .eq('user_id', userId)
          .eq('school_id', schoolId)
          .is('department_id', null)
          .maybeSingle()
        if (selErr) throw selErr
        if (data) {
          const { error } = await supabase
            .from('user_school_deviations')
            .update({ note, updated_at: new Date().toISOString() })
            .eq('id', data.id)
          if (error) throw error
        } else {
          // 学校単位の note は department_id=null の行に持つ。value は not null 制約のため
          // 0 を「値なし」のセンチネルとして格納する（表示側は department_id 付き行しか値として扱わない）
          const { error } = await supabase.from('user_school_deviations').insert({
            user_id: userId,
            school_id: schoolId,
            department_id: null,
            value: 0,
            note,
            visibility: cur.visibility,
          })
          if (error) throw error
        }
      } catch (err) {
        rollback()
        throw err
      }
    },
    [userId, mine, blockedByMaintenance],
  )

  const saveMineConsent = useCallback(
    async (schoolId: string, submit: boolean) => {
      if (!userId) throw new Error('not signed in')
      if (blockedByMaintenance()) return
      const visibility = submit ? 'submit_to_manabi' : 'private'
      const prev = mine[schoolId]
      const cur = prev ?? EMPTY_MINE
      setMine((m) => ({ ...m, [schoolId]: { ...cur, visibility } }))
      const rollback = () =>
        setMine((m) => {
          const next = { ...m }
          if (prev) next[schoolId] = prev
          else delete next[schoolId]
          return next
        })
      try {
        const { data, error } = await supabase
          .from('user_school_deviations')
          .update({ visibility, updated_at: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('school_id', schoolId)
          .select('id')
        if (error) throw error
        if ((data ?? []).length === 0) {
          // 行が 1 つも無い状態で同意だけ切り替えた場合は、note と同じ
          // department_id=null のセンチネル行を作って同意状態を永続化する
          const { error: insErr } = await supabase.from('user_school_deviations').insert({
            user_id: userId,
            school_id: schoolId,
            department_id: null,
            value: 0,
            note: cur.note,
            visibility,
          })
          if (insErr) throw insErr
        }
      } catch (err) {
        rollback()
        throw err
      }
    },
    [userId, mine, blockedByMaintenance],
  )

  return {
    favorites, notes, mine, loading,
    toggleFavorite, setPriority, saveNote,
    saveMineValue, saveMineNote, saveMineConsent,
  }
}
