import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { trackEvent } from '../lib/analytics'
import { useMaintenanceMode } from './useMaintenanceMode'
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
  /** 初期ロードまたは再読み込みに失敗している間は保存を許可しない。 */
  loadError: boolean
  reload: () => void
  toggleFavorite: (schoolId: string) => Promise<boolean>
  setPriority: (schoolId: string, priority: number) => Promise<void>
  saveNote: (schoolId: string, note: string, commuteNote: string) => Promise<void>
  deleteNote: (schoolId: string) => Promise<void>
  deleteMine: (schoolId: string) => Promise<void>
  saveMineValue: (schoolId: string, departmentId: string, value: number | null) => Promise<void>
  saveMineNote: (schoolId: string, note: string) => Promise<void>
  saveMineConsent: (schoolId: string, submit: boolean) => Promise<void>
}

const EMPTY_MINE: MineRecord = { depts: {}, note: '', visibility: 'private' }

export function useUserData(): UserData {
  const { session } = useAuth()
  const { toast } = useApp()
  const { t } = useI18n()
  const { isOn: maintenanceMode } = useMaintenanceMode()
  const userId = session?.user.id ?? null
  const [favorites, setFavorites] = useState<Record<string, Favorite>>({})
  const [notes, setNotes] = useState<Record<string, SchoolNote>>({})
  const [mine, setMine] = useState<Record<string, MineRecord>>({})
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const loadedUserId = useRef<string | null>(null)
  const loadGeneration = useRef(0)
  /** 連打で insert が二重に走らないよう school_id 単位で排他する */
  const favoriteInFlight = useRef(new Set<string>())
  /** 志望度の連打は学校単位で順番に DB へ送り、完了順逆転を防ぐ。 */
  const priorityInFlight = useRef(new Map<string, Promise<void>>())
  const favoritesRef = useRef(favorites)
  favoritesRef.current = favorites

  /**
   * メンテナンスモード中の書き込みガード。全 mutation の先頭で呼び、
   * 読み取り専用トーストを出して true を返した場合は呼び出し側が早期 return する。
   * true 応答時は Supabase に一切書き込まない。
   */
  const blockedByMaintenance = useCallback((): boolean => {
    if (!maintenanceMode) return false
    toast(t('maintenance.toast'))
    return true
  }, [maintenanceMode, toast, t])

  const loadData = useCallback(async () => {
    const generation = ++loadGeneration.current
    if (!userId) {
      setFavorites({})
      setNotes({})
      setMine({})
      setLoadError(false)
      setLoading(false)
      loadedUserId.current = null
      return
    }
    if (loadedUserId.current !== userId) {
      // ユーザー切替時に前ユーザーのデータを一瞬でも見せない。
      setFavorites({})
      setNotes({})
      setMine({})
      setLoadError(false)
      loadedUserId.current = userId
    }
    setLoading(true)
    let responses
    try {
      responses = await Promise.all([
        supabase.from('user_school_favorites').select('school_id, priority, status'),
        supabase.from('user_school_notes').select('school_id, note, commute_note'),
        supabase.from('user_school_deviations').select('school_id, department_id, value, note, visibility'),
      ])
    } catch (err) {
      if (generation !== loadGeneration.current) return
      console.error('user data load failed:', (err as Error)?.message)
      setLoadError(true)
      setLoading(false)
      return
    }
    const [favRes, noteRes, mineRes] = responses
    if (generation !== loadGeneration.current) return

    const failed = Boolean(favRes.error || noteRes.error || mineRes.error)
    if (failed) {
      // 失敗を空データと誤認させない。特にメモ保存を止め、既存値の空上書きを防ぐ。
      console.error('user data load failed:', (favRes.error ?? noteRes.error ?? mineRes.error)?.message)
      setLoadError(true)
      setLoading(false)
      return
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
    setFavorites(favs)
    setNotes(ns)
    setMine(ms)
    setLoadError(false)
    setLoading(false)
  }, [userId])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const reload = useCallback(() => {
    void loadData()
  }, [loadData])

  const blockedByLoadError = useCallback((): boolean => {
    if (!loadError) return false
    toast(t('common.dataLoadFailed'))
    return true
  }, [loadError, toast, t])

  /** @returns 登録後の状態（true = お気に入り済） */
  const toggleFavorite = useCallback(
    async (schoolId: string): Promise<boolean> => {
      if (!userId) throw new Error('not signed in')
      if (blockedByLoadError()) return Boolean(favoritesRef.current[schoolId])
      if (blockedByMaintenance()) return Boolean(favoritesRef.current[schoolId])
      // 連打で同一 school の insert/delete が競合しないよう in-flight 排他
      if (favoriteInFlight.current.has(schoolId)) {
        return Boolean(favoritesRef.current[schoolId])
      }
      favoriteInFlight.current.add(schoolId)
      try {
        const prev = favoritesRef.current[schoolId]
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
          // unique 違反 = 既に登録済み（競合で先勝ちした insert）。UI はお気に入り済のまま成功扱い
          const code = (error as { code?: string }).code
          if (code === '23505') {
            trackEvent('favorite_add', { school_id: schoolId })
            return true
          }
          setFavorites((cur) => {
            const next = { ...cur }
            delete next[schoolId]
            return next
          })
          throw error
        }
        trackEvent('favorite_add', { school_id: schoolId })
        return true
      } finally {
        favoriteInFlight.current.delete(schoolId)
      }
    },
    [userId, blockedByLoadError, blockedByMaintenance],
  )

  const setPriority = useCallback(
    async (schoolId: string, priority: number) => {
      if (!userId) throw new Error('not signed in')
      if (blockedByLoadError()) return
      if (blockedByMaintenance()) return

      const previous = priorityInFlight.current.get(schoolId) ?? Promise.resolve()
      const operation = previous.catch(() => undefined).then(async () => {
        const existing = favoritesRef.current[schoolId]
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
      })
      let tracked: Promise<void>
      tracked = operation.finally(() => {
        if (priorityInFlight.current.get(schoolId) === tracked) priorityInFlight.current.delete(schoolId)
      })
      priorityInFlight.current.set(schoolId, tracked)
      await tracked
    },
    [userId, blockedByLoadError, blockedByMaintenance],
  )

  const saveNote = useCallback(
    async (schoolId: string, note: string, commuteNote: string) => {
      if (!userId) throw new Error('not signed in')
      if (blockedByLoadError()) return
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
    [userId, notes, blockedByLoadError, blockedByMaintenance],
  )

  const deleteNote = useCallback(
    async (schoolId: string) => {
      if (!userId) throw new Error('not signed in')
      if (blockedByLoadError()) return
      if (blockedByMaintenance()) return
      const prev = notes[schoolId]
      if (!prev) return

      setNotes((cur) => {
        const next = { ...cur }
        delete next[schoolId]
        return next
      })
      const { error } = await supabase
        .from('user_school_notes')
        .delete()
        .eq('user_id', userId)
        .eq('school_id', schoolId)
      if (error) {
        setNotes((cur) => ({ ...cur, [schoolId]: prev }))
        throw error
      }
    },
    [userId, notes, blockedByLoadError, blockedByMaintenance],
  )

  /**
   * 個人偏差値の保存。学科行と学校単位のセンチネル行を同じ一意キーで扱う。
   */
  const saveMineValue = useCallback(
    async (schoolId: string, departmentId: string, value: number | null) => {
      if (!userId) throw new Error('not signed in')
      if (blockedByLoadError()) return
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
    [userId, mine, blockedByLoadError, blockedByMaintenance],
  )

  const deleteMine = useCallback(
    async (schoolId: string) => {
      if (!userId) throw new Error('not signed in')
      if (blockedByLoadError()) return
      if (blockedByMaintenance()) return
      const prev = mine[schoolId]
      if (!prev) return

      setMine((cur) => {
        const next = { ...cur }
        delete next[schoolId]
        return next
      })
      const { error } = await supabase
        .from('user_school_deviations')
        .delete()
        .eq('user_id', userId)
        .eq('school_id', schoolId)
      if (error) {
        setMine((cur) => ({ ...cur, [schoolId]: prev }))
        throw error
      }
    },
    [userId, mine, blockedByLoadError, blockedByMaintenance],
  )

  const saveMineNote = useCallback(
    async (schoolId: string, note: string) => {
      if (!userId) throw new Error('not signed in')
      if (blockedByLoadError()) return
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
        // 202608040104 の UNIQUE NULLS NOT DISTINCT により、note 行も同じ
        // user/school/null department キーで競合なく upsert できる。
        const { error } = await supabase.from('user_school_deviations').upsert(
          {
            user_id: userId,
            school_id: schoolId,
            department_id: null,
            value: 0,
            note,
            visibility: cur.visibility,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,school_id,department_id' },
        )
        if (error) throw error
      } catch (err) {
        rollback()
        throw err
      }
    },
    [userId, mine, blockedByLoadError, blockedByMaintenance],
  )

  const saveMineConsent = useCallback(
    async (schoolId: string, submit: boolean) => {
      if (!userId) throw new Error('not signed in')
      if (blockedByLoadError()) return
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
        // 同意だけの切替も note と同じセンチネル行へ upsert する。
        const { error } = await supabase.from('user_school_deviations').upsert(
          {
            user_id: userId,
            school_id: schoolId,
            department_id: null,
            value: 0,
            note: cur.note,
            visibility,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,school_id,department_id' },
        )
        if (error) throw error

        // 同意撤回はセンチネル行だけでなく、既存の学科行にも反映する。
        // 学科行が submit_to_manabi のままだと、集計キューと再読込時の OR 集約に残る。
        const { error: departmentError } = await supabase
          .from('user_school_deviations')
          .update({ visibility, updated_at: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('school_id', schoolId)
          .not('department_id', 'is', null)
        if (departmentError) throw departmentError
      } catch (err) {
        rollback()
        throw err
      }
    },
    [userId, mine, blockedByLoadError, blockedByMaintenance],
  )

  return {
    favorites, notes, mine, loading, loadError, reload,
    toggleFavorite, setPriority, saveNote, deleteNote,
    deleteMine, saveMineValue, saveMineNote, saveMineConsent,
  }
}
