// 学習者の追加・編集フォームの「保存」の一連の流れ（検証 → 追加/更新 → 保存後の後始末）を、
// React から切り離した純粋な async 関数にしたもの（C8 レビュー must 2・should 4）。
//
// 二重送信を防ぐ guard（{ current: boolean } の形。React の useRef をそのまま渡せる）を必ず
// 呼び出し側から渡してもらい、この関数の中で「すでに進行中なら即座に skipped を返す」ことを
// 保証する。guard.current の設定はこの関数の最初の同期部分（await より前）で行うため、
// 呼び出し側が待たずに連続して 2 回呼んでも（例: ボタンの連打）、2 回目は必ず skipped になる
// （pages/ProfileEditPage.tsx の handleSubmit も同じ guard を先に見て 2 回目を捨てるが、
// この関数自身にも同じ保証を持たせることで、handleSubmit を経由しない直接呼び出しのテストでも
// 二重送信が起きないことを確かめられる）。
//
// requestPersistence は完了を待たずに 1 回だけ呼び、失敗は無視する（子 plan「作業内容」4 の元の
// 設計のまま。待つと保存の完了がその分遅く見える）。
//
// 2026-09-24 C8 再レビュー・申し送り 1:
// - 新規追加の id 作りは、呼び出し側（handleSubmit）ではなくこの関数の try の中で行う。呼び出し側で
//   先に crypto.randomUUID() を呼んでいると、それが例外を投げたときに guard が立ったまま・送信中の
//   表示のまま画面が固まってしまうため。id を作る関数（createId）は呼び出し側から渡してもらい、
//   既定として使う実装はこのファイルの createProfileId。
// - 保存に成功した（'saved'）ときは guard.current を false に戻さない。呼び出し側
//   （pages/ProfileEditPage.tsx）は保存成功後すぐ画面を離れる（goBack または navigate）ため、
//   guard を戻す必要が無いばかりか、戻すと画面遷移が終わるまでの一瞬にもう一度送信できてしまう。
//   validation・error のときは入力を直して再送信できる必要があるので、これまでどおり guard を戻す。

import type { LearnerProfile } from '../types'
import { formToProfile, type ProfileFormErrors, type ProfileFormInput } from './profileForm'
import { requestPersistence as defaultRequestPersistence, type KanjiStore } from './store'

export interface SaveProfileFormDeps {
  addProfile: (profile: LearnerProfile) => Promise<void>
  updateProfile: (profile: LearnerProfile) => Promise<void>
  store: KanjiStore
  /** テストで差し替えられるように依存として受け取る（既定は lib/store.ts の requestPersistence） */
  requestPersistence?: (store: KanjiStore) => Promise<boolean>
}

/** React の useRef をそのまま渡せる形（{ current: boolean }） */
export interface SubmitGuard {
  current: boolean
}

export type SaveProfileFormOutcome =
  | { kind: 'skipped' }
  | { kind: 'validation'; errors: ProfileFormErrors }
  | { kind: 'saved'; mode: 'new' | 'edit'; profile: LearnerProfile }
  | { kind: 'error' }

/**
 * 新しい学習者の id を作る既定の関数（申し送り 1）。crypto.randomUUID が使えない環境
 * （対応していない古いブラウザ・安全でないコンテキスト等）でも動くように、無ければ
 * crypto.getRandomValues で 16 バイトを作って 16 進文字列にする作り方へ落ちる。
 */
export function createProfileId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function saveProfileForm(
  form: ProfileFormInput,
  existing: LearnerProfile | null,
  now: string,
  createId: () => string,
  guard: SubmitGuard,
  deps: SaveProfileFormDeps,
): Promise<SaveProfileFormOutcome> {
  if (guard.current) return { kind: 'skipped' }
  guard.current = true
  try {
    // id 作りもこの try の中で行う（申し送り 1）。createId が例外を投げても catch で拾い、
    // guard を確実に戻して error を返す。
    const id = existing?.id ?? createId()
    const result = formToProfile(form, existing, now, id)
    if (!result.ok) {
      guard.current = false
      return { kind: 'validation', errors: result.errors }
    }

    if (existing) {
      await deps.updateProfile(result.profile)
      // 保存成功時は guard を戻さない（ファイル冒頭のコメント・申し送り 1）。
      return { kind: 'saved', mode: 'edit', profile: result.profile }
    }
    await deps.addProfile(result.profile)
    const requestPersistenceFn = deps.requestPersistence ?? defaultRequestPersistence
    // 完了を待たずに 1 回だけ呼ぶ（このファイル冒頭のコメント）。失敗は無視する。
    void requestPersistenceFn(deps.store).catch(() => {})
    return { kind: 'saved', mode: 'new', profile: result.profile }
  } catch {
    guard.current = false
    return { kind: 'error' }
  }
}
