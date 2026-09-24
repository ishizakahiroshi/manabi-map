// 学習者の状態（いまの学習者・一覧）の純粋な決定ロジックと、C2 の保存（KanjiStore）へつなぐ
// 操作をまとめたファイル（C5・子 plan「作業内容」）。ProfileProvider.tsx（コンポーネント）から
// 呼ぶ。profileReducer 等の関数をコンポーネントのファイルから export すると react-refresh の
// only-export-components 警告が出るため、C4 の decideLang.ts / pruneRequested と同じやり方で
// コンポーネントのファイルから分けてある（2026-09-23/24 の C4 レビューに合わせた判断）。

import type { Dispatch } from 'react'
import type { LearnerProfile } from '../types'
import type { KanjiStore } from '../lib/store'
import { normalizeProfile } from '../lib/store'

/** ProfileProvider が持つ状態（子 plan「作業内容」1） */
export interface ProfileState {
  /** createdAt の古い順 */
  profiles: LearnerProfile[]
  currentId: string | null
  /** 保存（KanjiStore）の volatile をそのまま持つ。reducer では変えない */
  volatile: boolean
  /** 学習者がまだいないとき（はじめての画面など）に使う画面の言語 */
  uiLang: string
}

export type ProfileAction =
  | { type: 'add'; profile: LearnerProfile }
  | { type: 'update'; profile: LearnerProfile }
  | { type: 'remove'; id: string }
  | { type: 'switch'; id: string }
  | { type: 'setUiLang'; lang: string }

/** 呼ばれた時点での最新の状態を返す関数。作られたときの状態を閉じ込めないための受け渡し方
 * （2026-09-24 レビュー should 3）。ProfileProvider.tsx が ref から読む関数を渡す。 */
export type GetProfileState = () => ProfileState

/**
 * localeCompare は実行環境のロケールに依存しうるため使わず、ISO 8601 文字列を単純比較する
 * （web/src/kanji/lib/store.ts の listProfiles と同じ考え方）。
 */
function sortByCreatedAt(profiles: LearnerProfile[]): LearnerProfile[] {
  return [...profiles].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
}

/**
 * id で置き換え、無ければ足す（2026-09-24 レビュー should 1: 同じ学習者で add が 2 回呼ばれても
 * 一覧に重複を作らない）。
 */
function upsertProfile(profiles: LearnerProfile[], profile: LearnerProfile): LearnerProfile[] {
  const exists = profiles.some((p) => p.id === profile.id)
  const next = exists ? profiles.map((p) => (p.id === profile.id ? profile : p)) : [...profiles, profile]
  return sortByCreatedAt(next)
}

/** 状態の変更だけを行う純粋な関数（テストのため export する。子 plan「作業内容」1） */
export function profileReducer(state: ProfileState, action: ProfileAction): ProfileState {
  switch (action.type) {
    case 'add': {
      const profiles = upsertProfile(state.profiles, action.profile)
      return { ...state, profiles, currentId: action.profile.id }
    }
    case 'update': {
      const profiles = upsertProfile(state.profiles, action.profile)
      return { ...state, profiles }
    }
    case 'remove': {
      const profiles = state.profiles.filter((p) => p.id !== action.id)
      const currentId = state.currentId === action.id ? (profiles[0]?.id ?? null) : state.currentId
      return { ...state, profiles, currentId }
    }
    case 'switch':
      return { ...state, currentId: action.id }
    case 'setUiLang':
      return { ...state, uiLang: action.lang }
    default:
      return state
  }
}

/**
 * 起動時の「いまの学習者」を決める（子 plan「作業内容」1）。
 * lastProfileId の学習者がいればその id、いなくて学習者が 1 人ならその id、それ以外は null。
 */
export function pickInitialCurrent(profiles: LearnerProfile[], lastProfileId: string | undefined): string | null {
  if (lastProfileId !== undefined && profiles.some((p) => p.id === lastProfileId)) {
    return lastProfileId
  }
  if (profiles.length === 1) return profiles[0].id
  return null
}

/**
 * 保存 → 状態の更新、の順に行う。normalizeProfile を先に通し、通った値（trim されたニックネーム・
 * 正規化された lang 等）を保存にも dispatch にも同じものを使う（2026-09-24 レビュー must 1:
 * store.saveProfile は正規化した値を保存するが、以前は正規化前の値を dispatch していたため、
 * 画面の状態と保存の中身が食い違っていた）。不正なら例外を投げ、何もしない。
 *
 * 順番は子 plan「作業内容」1 のとおり「保存 → 一覧に足す → いまにする → lastProfileId を更新」。
 * lastProfileId の書き込みが失敗しても、学習者の追加自体は例外にしない
 * （2026-09-24 レビュー must 2。pickInitialCurrent は一覧に無い lastProfileId を無視する設計
 * なので、古い指し先が残っても次回の起動で実害が無い）。
 */
export async function addProfileAction(
  store: KanjiStore,
  dispatch: Dispatch<ProfileAction>,
  profile: LearnerProfile,
): Promise<void> {
  const normalized = normalizeProfile(profile)
  if (!normalized) throw new Error('addProfileAction: 不正な学習者データです')
  await store.saveProfile(normalized)
  dispatch({ type: 'add', profile: normalized })
  try {
    await store.setMeta('lastProfileId', normalized.id)
  } catch {
    // 上のコメントの通り、ここの失敗は無視してよい
  }
}

/**
 * updatedAt を now に更新してから normalizeProfile を通し、通った値を保存・dispatch の両方に使う
 * （2026-09-24 レビュー must 1）。
 */
export async function updateProfileAction(
  store: KanjiStore,
  dispatch: Dispatch<ProfileAction>,
  profile: LearnerProfile,
  now: string,
): Promise<void> {
  const normalized = normalizeProfile({ ...profile, updatedAt: now })
  if (!normalized) throw new Error('updateProfileAction: 不正な学習者データです')
  await store.saveProfile(normalized)
  dispatch({ type: 'update', profile: normalized })
}

/**
 * 保存から消す。いまの学習者を消した場合の「残りの最初の学習者をいまにする」判断は
 * profileReducer の remove が行う（削除後の一覧の先頭＝ createdAt が一番古い学習者）。
 *
 * deleteProfile が例外を出しても、書き込みが途中まで進んでいる（実際にはもう消えている）
 * ことがあるため、store.getProfile(id) で確かめる。もう無ければ削除は成功したとみなして
 * dispatch し、例外は出さない。残っていれば状態を変えずに例外を返す
 * （2026-09-24 レビュー must 2）。
 *
 * いまの学習者を消して次の学習者がいるときは lastProfileId をその id に進める。この書き込みが
 * 失敗しても例外にしない（2026-09-24 レビュー should 2。addProfileAction と同じ理由）。
 * 「消したのがいまの学習者か」は await store.deleteProfile の後（＝ dispatch の直前）に
 * getState() で読み直す。関数の最初で読んだ値のままだと、削除を待っている間に別の switch や
 * remove が割り込んだ場合に古い判定のまま進んでしまう（2026-09-24 再レビュー should 1）。
 * dispatch の後の次の学習者も同じ理由で getState() を読み直す（reducer が決めた最新の currentId）。
 */
export async function removeProfileAction(
  store: KanjiStore,
  dispatch: Dispatch<ProfileAction>,
  getState: GetProfileState,
  id: string,
): Promise<void> {
  try {
    await store.deleteProfile(id)
  } catch (error) {
    const remaining = await store.getProfile(id)
    if (remaining !== undefined) throw error
  }

  const wasCurrent = getState().currentId === id
  dispatch({ type: 'remove', id })

  if (wasCurrent) {
    const nextId = getState().currentId
    if (nextId) {
      try {
        await store.setMeta('lastProfileId', nextId)
      } catch {
        // 上の addProfileAction と同じ理由で無視してよい
      }
    }
  }
}

/** いまの学習者を替えて lastProfileId を更新する */
export async function switchProfileAction(
  store: KanjiStore,
  dispatch: Dispatch<ProfileAction>,
  id: string,
): Promise<void> {
  await store.setMeta('lastProfileId', id)
  dispatch({ type: 'switch', id })
}

/**
 * いまの学習者がいればその学習者の lang を更新して保存し、いなければ meta の uiLang を更新する
 * （子 plan「作業内容」1）。いまの学習者は getState を呼んだ時点の最新の状態から求める
 * （作られたときの状態を閉じ込めない。2026-09-24 レビュー should 3。例えば switchProfile の
 * 直後に setUiLang を呼んでも、切り替え後の学習者に対して働く）。
 * 保存する値は normalizeProfile を通したものを使う（2026-09-24 レビュー must 1）。
 */
export async function setUiLangAction(
  store: KanjiStore,
  dispatch: Dispatch<ProfileAction>,
  lang: string,
  getState: GetProfileState,
  now: string,
): Promise<void> {
  const { profiles, currentId } = getState()
  const currentProfile = profiles.find((p) => p.id === currentId) ?? null

  if (currentProfile) {
    const normalized = normalizeProfile({ ...currentProfile, lang, updatedAt: now })
    if (!normalized) throw new Error('setUiLangAction: 不正な学習者データです')
    await store.saveProfile(normalized)
    dispatch({ type: 'update', profile: normalized })
    return
  }
  await store.setMeta('uiLang', lang)
  dispatch({ type: 'setUiLang', lang })
}
