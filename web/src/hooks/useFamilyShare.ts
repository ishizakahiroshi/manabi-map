import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'

export type FamilyRole = 'owner' | 'member'
export type FamilyStatus = 'invited' | 'active'

export interface FamilyMemberView {
  id: string
  group_id: string
  user_id: string | null
  role: FamilyRole
  status: FamilyStatus
  share_favorites: boolean
  share_notes: boolean
  accepted_at: string | null
  /** 自分自身のメンバーシップ行か */
  is_me: boolean
}

export interface FamilyGroupView {
  id: string
  name: string
  /** 自分のこのグループでの役割 */
  myRole: FamilyRole
  /** 自分のこのグループでの共有設定 */
  myShareFavorites: boolean
  myShareNotes: boolean
  members: FamilyMemberView[]
}

export interface SharedFavorite {
  owner_id: string
  school_id: string
  priority: number
  status: string
}

export interface SharedNote {
  owner_id: string
  school_id: string
  note: string
  commute_note: string
}

/** family_members の SELECT で読む列（invite_token は grant されていないので含めない） */
const MEMBER_COLUMNS =
  'id, group_id, user_id, role, status, share_favorites, share_notes, accepted_at, created_at'

interface MemberRow {
  id: string
  group_id: string
  user_id: string | null
  role: FamilyRole
  status: FamilyStatus
  share_favorites: boolean
  share_notes: boolean
  accepted_at: string | null
}

export interface FamilyShareState {
  groups: FamilyGroupView[]
  loading: boolean
  reload: () => Promise<void>
  createGroup: (name?: string) => Promise<string>
  /** 招待を作成し、受諾用 URL を返す */
  createInviteUrl: (groupId: string) => Promise<string>
  acceptInvite: (token: string) => Promise<string>
  setShare: (groupId: string, shareFavorites: boolean, shareNotes: boolean) => Promise<void>
  leaveGroup: (groupId: string) => Promise<void>
  removeMember: (memberId: string) => Promise<void>
  deleteGroup: (groupId: string) => Promise<void>
  loadSharedFavorites: (groupId: string) => Promise<SharedFavorite[]>
  loadSharedNotes: (groupId: string) => Promise<SharedNote[]>
}

/** 受諾 URL の組み立て（本番/プレビュー両対応・token はクエリで渡す） */
export function inviteUrlFor(token: string): string {
  return `${location.origin}/family/join?token=${token}`
}

export function useFamilyShare(): FamilyShareState {
  const { session } = useAuth()
  const userId = session?.user.id ?? null
  const [groups, setGroups] = useState<FamilyGroupView[]>([])
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    if (!userId) {
      setGroups([])
      return
    }
    setLoading(true)
    try {
      const [memberRes, groupRes] = await Promise.all([
        supabase.from('family_members').select(MEMBER_COLUMNS),
        supabase.from('family_groups').select('id, name'),
      ])
      if (memberRes.error) throw memberRes.error
      if (groupRes.error) throw groupRes.error

      const rows = (memberRes.data ?? []) as MemberRow[]
      const names = new Map<string, string>()
      for (const g of groupRes.data ?? []) names.set(g.id, g.name)

      // 自分が active メンバーのグループだけを一覧化する
      const myActive = rows.filter((r) => r.user_id === userId && r.status === 'active')
      const views: FamilyGroupView[] = myActive.map((mine) => {
        const members = rows
          .filter((r) => r.group_id === mine.group_id)
          .map<FamilyMemberView>((r) => ({
            id: r.id,
            group_id: r.group_id,
            user_id: r.user_id,
            role: r.role,
            status: r.status,
            share_favorites: r.share_favorites,
            share_notes: r.share_notes,
            accepted_at: r.accepted_at,
            is_me: r.user_id === userId,
          }))
          // owner を先頭に、その後 active→invited の順
          .sort((a, b) => {
            if (a.role !== b.role) return a.role === 'owner' ? -1 : 1
            if (a.status !== b.status) return a.status === 'active' ? -1 : 1
            return 0
          })
        return {
          id: mine.group_id,
          name: names.get(mine.group_id) ?? '家族',
          myRole: mine.role,
          myShareFavorites: mine.share_favorites,
          myShareNotes: mine.share_notes,
          members,
        }
      })
      setGroups(views)
    } catch (err) {
      console.error('family share load failed:', (err as Error)?.message)
      setGroups([])
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    void reload()
  }, [reload])

  const createGroup = useCallback(
    async (name?: string): Promise<string> => {
      const { data, error } = await supabase.rpc('create_family_group', { p_name: name ?? '家族' })
      if (error) throw error
      await reload()
      return data as string
    },
    [reload],
  )

  const createInviteUrl = useCallback(async (groupId: string): Promise<string> => {
    const { data, error } = await supabase.rpc('create_family_invite', { p_group_id: groupId })
    if (error) throw error
    // 招待作成でメンバー一覧（未受諾行）が増えるので更新
    await reload()
    return inviteUrlFor(data as string)
  }, [reload])

  const acceptInvite = useCallback(
    async (token: string): Promise<string> => {
      const { data, error } = await supabase.rpc('accept_family_invite', { p_token: token })
      if (error) throw error
      await reload()
      return data as string
    },
    [reload],
  )

  const setShare = useCallback(
    async (groupId: string, shareFavorites: boolean, shareNotes: boolean): Promise<void> => {
      const { error } = await supabase.rpc('set_family_share', {
        p_group_id: groupId,
        p_share_favorites: shareFavorites,
        p_share_notes: shareNotes,
      })
      if (error) throw error
      await reload()
    },
    [reload],
  )

  const leaveGroup = useCallback(
    async (groupId: string): Promise<void> => {
      const { error } = await supabase.rpc('leave_family_group', { p_group_id: groupId })
      if (error) throw error
      await reload()
    },
    [reload],
  )

  const removeMember = useCallback(
    async (memberId: string): Promise<void> => {
      const { error } = await supabase.rpc('remove_family_member', { p_member_id: memberId })
      if (error) throw error
      await reload()
    },
    [reload],
  )

  const deleteGroup = useCallback(
    async (groupId: string): Promise<void> => {
      const { error } = await supabase.rpc('delete_family_group', { p_group_id: groupId })
      if (error) throw error
      await reload()
    },
    [reload],
  )

  const loadSharedFavorites = useCallback(async (groupId: string): Promise<SharedFavorite[]> => {
    const { data, error } = await supabase.rpc('get_family_shared_favorites', { p_group_id: groupId })
    if (error) throw error
    return (data ?? []) as SharedFavorite[]
  }, [])

  const loadSharedNotes = useCallback(async (groupId: string): Promise<SharedNote[]> => {
    const { data, error } = await supabase.rpc('get_family_shared_notes', { p_group_id: groupId })
    if (error) throw error
    return (data ?? []) as SharedNote[]
  }, [])

  return {
    groups,
    loading,
    reload,
    createGroup,
    createInviteUrl,
    acceptInvite,
    setShare,
    leaveGroup,
    removeMember,
    deleteGroup,
    loadSharedFavorites,
    loadSharedNotes,
  }
}
