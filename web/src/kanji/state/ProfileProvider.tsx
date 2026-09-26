// 学習者の状態（いまの学習者・一覧）を画面全体へ配る React の部品（C5・子 plan「作業内容」1）。
// 状態の正本は C2 の保存（KanjiStore）で、画面の状態は保存に成功した後に変える
// （子 plan「維持する仕様」）。純粋な決定ロジックと store 呼び出しは同じディレクトリの
// profileState.ts に分けてある（react-refresh の only-export-components 警告を避けるため。
// C4 の I18nProvider.tsx / decideLang.ts と同じやり方）。
// 学校サイトの web/src/contexts/AppContext.tsx を Context + hook の形の見本として読んだが、
// コードは共有しない（子 plan「このファイルを開いた AI へ」）。

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
} from 'react'
import type { KanjiStore } from '../lib/store'
import type { LearnerProfile } from '../types'
import {
  addProfileAction,
  profileReducer,
  removeProfileAction,
  setUiLangAction,
  switchProfileAction,
  updateProfileAction,
  type ProfileAction,
  type ProfileState,
} from './profileState'

/** useProfiles() が返す値 */
export interface ProfilesValue {
  /** createdAt の古い順 */
  profiles: LearnerProfile[]
  currentId: string | null
  /** true なら端末に残せない（C2 の KanjiStore.volatile） */
  volatile: boolean
  /** 学習者がまだいないときの画面の言語 */
  uiLang: string
  addProfile: (profile: LearnerProfile) => Promise<void>
  updateProfile: (profile: LearnerProfile) => Promise<void>
  removeProfile: (id: string) => Promise<void>
  switchProfile: (id: string) => Promise<void>
  setUiLang: (lang: string) => Promise<void>
}

const ProfilesContext = createContext<ProfilesValue | null>(null)

export interface ProfileProviderProps {
  store: KanjiStore
  /** 起動処理（親 plan C6）が KanjiStore.listProfiles() で読んだ初期値 */
  initialProfiles: LearnerProfile[]
  /** 起動処理が pickInitialCurrent（profileState.ts）で決めた初期値 */
  initialCurrentId: string | null
  initialUiLang: string
  children?: ReactNode
}

export function ProfileProvider({
  store,
  initialProfiles,
  initialCurrentId,
  initialUiLang,
  children,
}: ProfileProviderProps) {
  // useState の初期値は最初の描画でしか使われないので、毎回オブジェクトを作っても無駄になるだけで
  // 動作には影響しない。ref の初期値も同じ理由でそのまま渡してよい。
  const [state, setState] = useState<ProfileState>({
    profiles: initialProfiles,
    currentId: initialCurrentId,
    volatile: store.volatile,
    uiLang: initialUiLang,
  })

  // dispatch のたびに ref を同期的に更新する。setUiLang・removeProfile 等の操作が「作られたときの
  // 状態」を閉じ込めず、呼ばれた時点の最新の状態を読めるようにするため（2026-09-24 レビュー
  // should 3）。React の再描画（setState）を待つと、同じ tick の中で switchProfile の直後に
  // setUiLang を呼んだときに古い学習者を読んでしまう。
  const stateRef = useRef(state)
  const dispatch = useCallback<Dispatch<ProfileAction>>((action) => {
    const next = profileReducer(stateRef.current, action)
    stateRef.current = next
    setState(next)
  }, [])
  const getState = useCallback((): ProfileState => stateRef.current, [])

  const addProfile = useCallback(
    (profile: LearnerProfile) => addProfileAction(store, dispatch, profile),
    [store, dispatch],
  )

  const updateProfile = useCallback(
    (profile: LearnerProfile) => updateProfileAction(store, dispatch, profile, new Date().toISOString()),
    [store, dispatch],
  )

  const removeProfile = useCallback(
    (id: string) => removeProfileAction(store, dispatch, getState, id),
    [store, dispatch, getState],
  )

  const switchProfile = useCallback(
    (id: string) => switchProfileAction(store, dispatch, id),
    [store, dispatch],
  )

  const setUiLang = useCallback(
    (lang: string) => setUiLangAction(store, dispatch, lang, getState, new Date().toISOString()),
    [store, dispatch, getState],
  )

  const value = useMemo<ProfilesValue>(
    () => ({
      profiles: state.profiles,
      currentId: state.currentId,
      volatile: state.volatile,
      uiLang: state.uiLang,
      addProfile,
      updateProfile,
      removeProfile,
      switchProfile,
      setUiLang,
    }),
    [state, addProfile, updateProfile, removeProfile, switchProfile, setUiLang],
  )

  return <ProfilesContext.Provider value={value}>{children}</ProfilesContext.Provider>
}

export function useProfiles(): ProfilesValue {
  const value = useContext(ProfilesContext)
  if (!value) throw new Error('useProfiles は ProfileProvider の中で呼んでください')
  return value
}

/** いまの学習者（いなければ null） */
export function useCurrentProfile(): LearnerProfile | null {
  const { profiles, currentId } = useProfiles()
  return profiles.find((p) => p.id === currentId) ?? null
}
