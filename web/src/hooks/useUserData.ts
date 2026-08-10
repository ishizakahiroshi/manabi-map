import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { trackEvent } from '../lib/analytics'
import { useMaintenanceMode } from './useMaintenanceMode'
import { useApp } from '../contexts/AppContext'
import { useAuth } from '../contexts/AuthContext'
import { useI18n } from '../contexts/I18nContext'
import type { Favorite, MineRecord, SchoolNote } from '../types/school'

export type UserDataMutationStatus = 'success' | 'blocked'

export interface FavoriteMutationResult {
  status: UserDataMutationStatus
  isFavorite: boolean
}

interface UserData {
  /** school_id → Favorite */
  favorites: Record<string, Favorite>
  /** school_id → SchoolNote */
  notes: Record<string, SchoolNote>
  /** school_id → MineRecord（個人偏差値記録） */
  mine: Record<string, MineRecord>
  /** 返却する個人データの owner。session と一致しない間は個人データを公開しない。 */
  dataUserId: string | null
  loading: boolean
  /** 初期ロードまたは再読み込みに失敗している間は保存を許可しない。 */
  loadError: boolean
  reload: () => void
  toggleFavorite: (schoolId: string) => Promise<boolean>
  /** boolean 契約を維持する toggleFavorite に、blocked を区別できる結果を併設する。 */
  toggleFavoriteWithResult: (schoolId: string) => Promise<FavoriteMutationResult>
  setPriority: (schoolId: string, priority: number) => Promise<UserDataMutationStatus>
  saveNote: (schoolId: string, note: string, commuteNote: string) => Promise<UserDataMutationStatus>
  deleteNote: (schoolId: string) => Promise<UserDataMutationStatus>
  deleteMine: (schoolId: string) => Promise<UserDataMutationStatus>
  saveMineValue: (schoolId: string, departmentId: string, value: number | null) => Promise<UserDataMutationStatus>
  saveMineNote: (schoolId: string, note: string) => Promise<UserDataMutationStatus>
  saveMineConsent: (schoolId: string, submit: boolean) => Promise<UserDataMutationStatus>
}

const EMPTY_MINE: MineRecord = { depts: {}, note: '', visibility: 'private' }
const EMPTY_FAVORITES: Record<string, Favorite> = {}
const EMPTY_NOTES: Record<string, SchoolNote> = {}
const EMPTY_MINES: Record<string, MineRecord> = {}

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
  const [loadedUserId, setLoadedUserId] = useState<string | null>(null)
  /** state の owner。render 境界の state 更新前にも mutation を止めるため ref でも持つ。 */
  const loadedUserIdRef = useRef<string | null>(null)
  const activeUserIdRef = useRef(userId)
  const loadErrorRef = useRef(loadError)
  const loadErrorUserIdRef = useRef<string | null>(null)
  const maintenanceModeRef = useRef(maintenanceMode)
  const dataReadyRef = useRef(loadedUserId === userId)
  const loadGeneration = useRef(0)
  /** 連打で insert が二重に走らないよう user_id + school_id 単位で排他する */
  const favoriteInFlight = useRef(new Set<string>())
  /** 削除の二重送信と成功通知の重複を user_id + school_id 単位で抑止する。 */
  const noteDeleteInFlight = useRef(new Set<string>())
  const mineDeleteInFlight = useRef(new Set<string>())
  /** 志望度の連打は user_id + school_id 単位で順番に DB へ送り、完了順逆転を防ぐ。 */
  const priorityInFlight = useRef(new Map<string, Promise<UserDataMutationStatus>>())
  const favoritesRef = useRef(favorites)
  const notesRef = useRef(notes)
  const mineRef = useRef(mine)
  activeUserIdRef.current = userId
  loadErrorRef.current = loadError
  maintenanceModeRef.current = maintenanceMode
  dataReadyRef.current = loadedUserId === userId
  favoritesRef.current = favorites
  notesRef.current = notes
  mineRef.current = mine

  /**
   * メンテナンスモード中の書き込みガード。全 mutation の先頭で呼び、
   * 読み取り専用トーストを出して true を返した場合は呼び出し側が早期 return する。
   * true 応答時は Supabase に一切書き込まない。
   */
  const blockedByMaintenance = useCallback((): boolean => {
    if (!maintenanceModeRef.current) return false
    toast(t('maintenance.toast'))
    return true
  }, [toast, t])

  const isDataReadyFor = useCallback((expectedUserId: string): boolean => (
    activeUserIdRef.current === expectedUserId
      && loadedUserIdRef.current === expectedUserId
      && dataReadyRef.current
  ), [])

  /**
   * loadError は前ユーザーのものを新ユーザーへ持ち越さない。
   * 現在ユーザーのロード失敗だけを blocked の理由として通知する。
   */
  const blockedByLoadError = useCallback((): boolean => {
    const currentUserId = activeUserIdRef.current
    if (!loadErrorRef.current || loadErrorUserIdRef.current !== currentUserId) return false
    toast(t('common.dataLoadFailed'))
    return true
  }, [toast, t])

  const mutationBlocked = useCallback((): boolean => {
    if (blockedByLoadError()) return true
    if (blockedByMaintenance()) return true
    const currentUserId = activeUserIdRef.current
    return !currentUserId || !isDataReadyFor(currentUserId)
  }, [blockedByLoadError, blockedByMaintenance, isDataReadyFor])

  const loadData = useCallback(async () => {
    if (activeUserIdRef.current !== userId) return
    const generation = ++loadGeneration.current
    if (!userId) {
      loadedUserIdRef.current = null
      loadErrorRef.current = false
      loadErrorUserIdRef.current = null
      setFavorites({})
      setNotes({})
      setMine({})
      setLoadedUserId(null)
      setLoadError(false)
      setLoading(false)
      return
    }
    if (loadedUserIdRef.current !== userId) {
      // ユーザー切替時に前ユーザーのデータを一瞬でも見せない。
      loadedUserIdRef.current = null
      loadErrorRef.current = false
      loadErrorUserIdRef.current = null
      setFavorites({})
      setNotes({})
      setMine({})
      setLoadedUserId(null)
      setLoadError(false)
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
      if (generation !== loadGeneration.current || activeUserIdRef.current !== userId) return
      console.error('user data load failed:', (err as Error)?.message)
      loadErrorRef.current = true
      loadErrorUserIdRef.current = userId
      setLoadError(true)
      setLoading(false)
      return
    }
    const [favRes, noteRes, mineRes] = responses
    if (generation !== loadGeneration.current || activeUserIdRef.current !== userId) return

    const failed = Boolean(favRes.error || noteRes.error || mineRes.error)
    if (failed) {
      // 失敗を空データと誤認させない。特にメモ保存を止め、既存値の空上書きを防ぐ。
      console.error('user data load failed:', (favRes.error ?? noteRes.error ?? mineRes.error)?.message)
      loadErrorRef.current = true
      loadErrorUserIdRef.current = userId
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
    loadedUserIdRef.current = userId
    setLoadedUserId(userId)
    loadErrorRef.current = false
    loadErrorUserIdRef.current = null
    setLoadError(false)
    setLoading(false)
  }, [userId])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const reload = useCallback(() => {
    void loadData()
  }, [loadData])

  /**
   * @returns 登録後の状態と、blocked で DB を呼ばなかったかどうか。
   * 既存の toggleFavorite boolean 契約は下の wrapper で維持する。
   */
  const toggleFavoriteWithResult = useCallback(
    async (schoolId: string): Promise<FavoriteMutationResult> => {
      const activeUserId = activeUserIdRef.current
      if (!activeUserId) throw new Error('not signed in')
      const currentFavorite = () => (
        isDataReadyFor(activeUserId) ? Boolean(favoritesRef.current[schoolId]) : false
      )
      if (mutationBlocked()) return { status: 'blocked', isFavorite: currentFavorite() }
      // 連打で同一 school の insert/delete が競合しないよう in-flight 排他
      const operationKey = `${activeUserId}:${schoolId}`
      if (favoriteInFlight.current.has(operationKey)) {
        return { status: 'blocked', isFavorite: currentFavorite() }
      }
      favoriteInFlight.current.add(operationKey)
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
            .eq('user_id', activeUserId)
            .eq('school_id', schoolId)
          if (error) {
            // DB 失敗時は楽観更新を巻き戻す（UI と DB の乖離防止）
            if (isDataReadyFor(activeUserId)) setFavorites((cur) => ({ ...cur, [schoolId]: prev }))
            throw error
          }
          return isDataReadyFor(activeUserId)
            ? { status: 'success', isFavorite: false }
            : { status: 'blocked', isFavorite: false }
        }
        const fav: Favorite = { school_id: schoolId, priority: 3, status: 'interested' }
        setFavorites((cur) => ({ ...cur, [schoolId]: fav }))
        const { error } = await supabase.from('user_school_favorites').insert({
          user_id: activeUserId,
          school_id: schoolId,
          priority: fav.priority,
          status: fav.status,
        })
        if (error) {
          // unique 違反 = 既に登録済み（競合で先勝ちした insert）。UI はお気に入り済のまま成功扱い
          const code = (error as { code?: string }).code
          if (code === '23505') {
            if (!isDataReadyFor(activeUserId)) return { status: 'blocked', isFavorite: false }
            trackEvent('favorite_add', { school_id: schoolId })
            return { status: 'success', isFavorite: true }
          }
          if (isDataReadyFor(activeUserId)) {
            setFavorites((cur) => {
              const next = { ...cur }
              delete next[schoolId]
              return next
            })
          }
          throw error
        }
        if (!isDataReadyFor(activeUserId)) return { status: 'blocked', isFavorite: false }
        trackEvent('favorite_add', { school_id: schoolId })
        return { status: 'success', isFavorite: true }
      } finally {
        favoriteInFlight.current.delete(operationKey)
      }
    },
    [isDataReadyFor, mutationBlocked],
  )

  /** @returns 登録後の状態（true = お気に入り済） */
  const toggleFavorite = useCallback(
    async (schoolId: string): Promise<boolean> => (
      (await toggleFavoriteWithResult(schoolId)).isFavorite
    ),
    [toggleFavoriteWithResult],
  )

  const setPriority = useCallback(
    async (schoolId: string, priority: number): Promise<UserDataMutationStatus> => {
      const activeUserId = activeUserIdRef.current
      if (!activeUserId) throw new Error('not signed in')
      if (mutationBlocked()) return 'blocked'

      const operationKey = `${activeUserId}:${schoolId}`
      const previous = priorityInFlight.current.get(operationKey) ?? Promise.resolve()
      const operation = previous.catch(() => undefined).then(async () => {
        if (!isDataReadyFor(activeUserId)) return 'blocked'
        const existing = favoritesRef.current[schoolId]
        setFavorites((cur) => ({
          ...cur,
          [schoolId]: { school_id: schoolId, priority, status: existing?.status ?? 'interested' },
        }))
        const { error } = await supabase.from('user_school_favorites').upsert(
          { user_id: activeUserId, school_id: schoolId, priority, status: existing?.status ?? 'interested' },
          { onConflict: 'user_id,school_id' },
        )
        if (error) {
          if (isDataReadyFor(activeUserId)) {
            setFavorites((cur) => {
              const next = { ...cur }
              if (existing) next[schoolId] = existing
              else delete next[schoolId]
              return next
            })
          }
          throw error
        }
        return isDataReadyFor(activeUserId) ? 'success' : 'blocked'
      })
      let tracked: Promise<UserDataMutationStatus>
      tracked = operation.finally(() => {
        if (priorityInFlight.current.get(operationKey) === tracked) priorityInFlight.current.delete(operationKey)
      })
      priorityInFlight.current.set(operationKey, tracked)
      return tracked
    },
    [isDataReadyFor, mutationBlocked],
  )

  const saveNote = useCallback(
    async (schoolId: string, note: string, commuteNote: string): Promise<UserDataMutationStatus> => {
      const activeUserId = activeUserIdRef.current
      if (!activeUserId) throw new Error('not signed in')
      if (mutationBlocked()) return 'blocked'
      const prev = notesRef.current[schoolId]
      setNotes((cur) => ({ ...cur, [schoolId]: { school_id: schoolId, note, commute_note: commuteNote } }))
      const { error } = await supabase.from('user_school_notes').upsert(
        {
          user_id: activeUserId,
          school_id: schoolId,
          note,
          commute_note: commuteNote,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,school_id' },
      )
      if (error) {
        if (isDataReadyFor(activeUserId)) {
          setNotes((cur) => {
            const next = { ...cur }
            if (prev) next[schoolId] = prev
            else delete next[schoolId]
            return next
          })
        }
        throw error
      }
      if (isDataReadyFor(activeUserId)) trackEvent('memo_save', { school_id: schoolId })
      return isDataReadyFor(activeUserId) ? 'success' : 'blocked'
    },
    [isDataReadyFor, mutationBlocked],
  )

  const deleteNote = useCallback(
    async (schoolId: string): Promise<UserDataMutationStatus> => {
      const activeUserId = activeUserIdRef.current
      if (!activeUserId) throw new Error('not signed in')
      if (mutationBlocked()) return 'blocked'
      const prev = notesRef.current[schoolId]
      if (!prev) return 'blocked'
      const operationKey = `${activeUserId}:${schoolId}`
      if (noteDeleteInFlight.current.has(operationKey)) return 'blocked'
      noteDeleteInFlight.current.add(operationKey)

      try {
        setNotes((cur) => {
          const next = { ...cur }
          delete next[schoolId]
          return next
        })
        const { error } = await supabase
          .from('user_school_notes')
          .delete()
          .eq('user_id', activeUserId)
          .eq('school_id', schoolId)
        if (error) {
          if (isDataReadyFor(activeUserId)) setNotes((cur) => ({ ...cur, [schoolId]: prev }))
          throw error
        }
        return isDataReadyFor(activeUserId) ? 'success' : 'blocked'
      } finally {
        noteDeleteInFlight.current.delete(operationKey)
      }
    },
    [isDataReadyFor, mutationBlocked],
  )

  /**
   * 個人偏差値の保存。学科行と学校単位のセンチネル行を同じ一意キーで扱う。
   */
  const saveMineValue = useCallback(
    async (schoolId: string, departmentId: string, value: number | null): Promise<UserDataMutationStatus> => {
      const activeUserId = activeUserIdRef.current
      if (!activeUserId) throw new Error('not signed in')
      if (mutationBlocked()) return 'blocked'
      const prev = mineRef.current[schoolId]
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
          .eq('user_id', activeUserId)
          .eq('school_id', schoolId)
          .eq('department_id', departmentId)
        if (error) {
          if (isDataReadyFor(activeUserId)) rollback()
          throw error
        }
      } else {
        const { error } = await supabase.from('user_school_deviations').upsert(
          {
            user_id: activeUserId,
            school_id: schoolId,
            department_id: departmentId,
            value,
            visibility: cur.visibility,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,school_id,department_id' },
        )
        if (error) {
          if (isDataReadyFor(activeUserId)) rollback()
          throw error
        }
      }
      return isDataReadyFor(activeUserId) ? 'success' : 'blocked'
    },
    [isDataReadyFor, mutationBlocked],
  )

  const deleteMine = useCallback(
    async (schoolId: string): Promise<UserDataMutationStatus> => {
      const activeUserId = activeUserIdRef.current
      if (!activeUserId) throw new Error('not signed in')
      if (mutationBlocked()) return 'blocked'
      const prev = mineRef.current[schoolId]
      if (!prev) return 'blocked'
      const operationKey = `${activeUserId}:${schoolId}`
      if (mineDeleteInFlight.current.has(operationKey)) return 'blocked'
      mineDeleteInFlight.current.add(operationKey)

      try {
        setMine((cur) => {
          const next = { ...cur }
          delete next[schoolId]
          return next
        })
        const { error } = await supabase
          .from('user_school_deviations')
          .delete()
          .eq('user_id', activeUserId)
          .eq('school_id', schoolId)
        if (error) {
          if (isDataReadyFor(activeUserId)) setMine((cur) => ({ ...cur, [schoolId]: prev }))
          throw error
        }
        return isDataReadyFor(activeUserId) ? 'success' : 'blocked'
      } finally {
        mineDeleteInFlight.current.delete(operationKey)
      }
    },
    [isDataReadyFor, mutationBlocked],
  )

  const saveMineNote = useCallback(
    async (schoolId: string, note: string): Promise<UserDataMutationStatus> => {
      const activeUserId = activeUserIdRef.current
      if (!activeUserId) throw new Error('not signed in')
      if (mutationBlocked()) return 'blocked'
      const prev = mineRef.current[schoolId]
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
            user_id: activeUserId,
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
        if (isDataReadyFor(activeUserId)) rollback()
        throw err
      }
      return isDataReadyFor(activeUserId) ? 'success' : 'blocked'
    },
    [isDataReadyFor, mutationBlocked],
  )

  const saveMineConsent = useCallback(
    async (schoolId: string, submit: boolean): Promise<UserDataMutationStatus> => {
      const activeUserId = activeUserIdRef.current
      if (!activeUserId) throw new Error('not signed in')
      if (mutationBlocked()) return 'blocked'
      const visibility = submit ? 'submit_to_manabi' : 'private'
      const prev = mineRef.current[schoolId]
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
            user_id: activeUserId,
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
        if (!isDataReadyFor(activeUserId)) return 'blocked'
        const { error: departmentError } = await supabase
          .from('user_school_deviations')
          .update({ visibility, updated_at: new Date().toISOString() })
          .eq('user_id', activeUserId)
          .eq('school_id', schoolId)
          .not('department_id', 'is', null)
        if (departmentError) throw departmentError
      } catch (err) {
        if (isDataReadyFor(activeUserId)) rollback()
        throw err
      }
      return isDataReadyFor(activeUserId) ? 'success' : 'blocked'
    },
    [isDataReadyFor, mutationBlocked],
  )

  const dataReadyForSession = loadedUserId === userId
  const visibleLoadError = loadError && loadErrorUserIdRef.current === userId
  const visibleLoading = loading || (userId !== null && !dataReadyForSession && !visibleLoadError)
  const visibleFavorites = dataReadyForSession ? favorites : EMPTY_FAVORITES
  const visibleNotes = dataReadyForSession ? notes : EMPTY_NOTES
  const visibleMine = dataReadyForSession ? mine : EMPTY_MINES

  return {
    favorites: visibleFavorites,
    notes: visibleNotes,
    mine: visibleMine,
    dataUserId: loadedUserId,
    loading: visibleLoading,
    loadError: visibleLoadError,
    reload,
    toggleFavorite,
    toggleFavoriteWithResult,
    setPriority,
    saveNote,
    deleteNote,
    deleteMine, saveMineValue, saveMineNote, saveMineConsent,
  }
}
