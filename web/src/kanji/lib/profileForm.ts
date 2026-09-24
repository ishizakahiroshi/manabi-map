// 学習者の追加・編集の画面（pages/ProfileEditPage.tsx）の入力を LearnerProfile に変える純粋な関数
// （C8・子 plan「作業内容」1）。
// ニックネームは文字列のまま、試験日は input[type=date] の値（''か YYYY-MM-DD）を受け取る。
// 検証（ニックネーム・試験日）に通ったら C2 の normalizeProfile / newProfile を通した値を返す。
// 検証・保存のロジックの正本は C2（lib/store.ts）に置き、ここでは画面の入力を C2 の形に変換する
// だけにする（子 plan「作業内容」1、親 plan D-5）。

import { isValidNickname, newProfile, normalizeProfile } from './store'
import type {
  DailyGoal,
  DisplayMode,
  FuriganaMode,
  LearnerProfile,
  Level,
  LangCode,
  WriteMode,
} from '../types'
import { PROFILE_COLORS } from '../types'

/** 画面の入力の形。examDate は input[type=date] の値（未入力は ''） */
export interface ProfileFormInput {
  nickname: string
  color: (typeof PROFILE_COLORS)[number]
  level: Level
  lang: LangCode
  furigana: FuriganaMode
  display: DisplayMode
  kanaKeyboard: boolean
  dailyGoal: DailyGoal
  examDate: string
  writeMode: WriteMode
}

export interface ProfileFormErrors {
  nickname?: 'edit.nickError'
  examDate?: 'edit.examError'
}

export type FormToProfileResult = { ok: true; profile: LearnerProfile } | { ok: false; errors: ProfileFormErrors }

/**
 * YYYY-MM-DD の形で、かつ実在する日付か。lib/store.ts の isValidDateStr と同じ判定だが、
 * store.ts はこの関数を export していない（C2 のファイルは変えない。子 plan「守ること」）ため、
 * ここに同じだけの短い実装を持つ。examDate の「エラーにする／null にする」の判断はこちら側の
 * 責務（store.ts の normalizeProfile は不正な examDate を黙って null にするだけで、画面が
 * edit.examError を出すための情報を返さない）。
 */
const EXAM_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
function isValidExamDate(value: string): boolean {
  if (!EXAM_DATE_RE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/** 新しい学習者の既定値（子 plan「作業内容」1）。lang はいまの画面の言語を渡す */
export function defaultProfileForm(lang: LangCode): ProfileFormInput {
  return {
    nickname: '',
    color: PROFILE_COLORS[0],
    level: '10',
    lang,
    furigana: 'all',
    display: 'child',
    kanaKeyboard: false,
    dailyGoal: 10,
    examDate: '',
    writeMode: 'auto',
  }
}

/**
 * フォームの 1 項目だけを書き換えた新しいフォームの値を返す（pages/ProfileEditPage.tsx の update
 * を React から切り離した純粋な形にしたもの。2026-09-24 C8 再レビュー・申し送り 4）。
 * EditLangField の onChange がこの関数を経由して呼ばれることを、ProfileEditPage.langWiring.test.ts
 * で vi.mock（importActual による部分モック）で確かめている。
 */
export function updateFormField<K extends keyof ProfileFormInput>(
  form: ProfileFormInput,
  key: K,
  value: ProfileFormInput[K],
): ProfileFormInput {
  return { ...form, [key]: value }
}

/** 既存の学習者を編集フォームの初期値にする */
export function profileToForm(profile: LearnerProfile): ProfileFormInput {
  return {
    nickname: profile.nickname,
    color: profile.color,
    level: profile.level,
    lang: profile.lang,
    furigana: profile.furigana,
    display: profile.display,
    kanaKeyboard: profile.kanaKeyboard,
    dailyGoal: profile.dailyGoal,
    examDate: profile.examDate ?? '',
    writeMode: profile.writeMode,
  }
}

/**
 * 画面の入力から LearnerProfile を作る。ニックネームが空白だけ・21 文字以上、または試験日の形が
 * 不正・実在しない日付なら、どちらのエラーかを errors で返す（両方不正なら両方を返す）。
 * existing が無ければ新規（id・createdAt は id・now を使う）、あれば編集（id・createdAt は既存の
 * ものを保つ。updatedAt はここでは now を入れるが、実際に保存する ProfileEditPage.tsx は
 * state/ProfileProvider.tsx の updateProfile 経由で呼び、そちらが保存直前の時刻で updatedAt を
 * 上書きする。C5 の profileState.ts と同じ約束）。
 */
export function formToProfile(
  form: ProfileFormInput,
  existing: LearnerProfile | null,
  now: string,
  id: string,
): FormToProfileResult {
  const errors: ProfileFormErrors = {}
  if (!isValidNickname(form.nickname)) errors.nickname = 'edit.nickError'

  const trimmedExamDate = form.examDate.trim()
  let examDate: string | null = null
  if (trimmedExamDate !== '') {
    if (!isValidExamDate(trimmedExamDate)) {
      errors.examDate = 'edit.examError'
    } else {
      examDate = trimmedExamDate
    }
  }

  if (errors.nickname || errors.examDate) return { ok: false, errors }

  const input = {
    nickname: form.nickname,
    color: form.color,
    level: form.level,
    lang: form.lang,
    furigana: form.furigana,
    display: form.display,
    kanaKeyboard: form.kanaKeyboard,
    dailyGoal: form.dailyGoal,
    examDate,
    writeMode: form.writeMode,
  }

  const profile = existing
    ? normalizeProfile({ ...input, id: existing.id, createdAt: existing.createdAt, updatedAt: now })
    : newProfile(input, now, id)

  if (!profile) {
    // ここには来ない想定（ニックネームは上で確かめ済み）。安全側として同じエラーにする。
    return { ok: false, errors: { nickname: 'edit.nickError' } }
  }

  return { ok: true, profile }
}

/** 「学年・立場で選ぶ」の 1 行（子 plan「調査で確認した現在の実装」の対応表）。順は見本のとおり */
export interface SchoolLevelEntry {
  /** i18n キーの school.<key> */
  key: string
  labelKey: string
  level: Level
}

export const SCHOOL_LEVEL_ENTRIES: SchoolLevelEntry[] = [
  { key: 'g1', labelKey: 'school.g1', level: '10' },
  { key: 'g2', labelKey: 'school.g2', level: '9' },
  { key: 'g3', labelKey: 'school.g3', level: '8' },
  { key: 'g4', labelKey: 'school.g4', level: '7' },
  { key: 'g5', labelKey: 'school.g5', level: '6' },
  { key: 'g6', labelKey: 'school.g6', level: '5' },
  { key: 'jh', labelKey: 'school.jh', level: '4' },
  { key: 'hs', labelKey: 'school.hs', level: 'pre2' },
  { key: 'adult', labelKey: 'school.adult', level: '2' },
  { key: 'jsl', labelKey: 'school.jsl', level: '10' },
]

/** SCHOOL_LEVEL_ENTRIES を key → level の対応表にしたもの（テスト・画面の両方で使う） */
export const SCHOOL_TO_LEVEL: Record<string, Level> = Object.fromEntries(
  SCHOOL_LEVEL_ENTRIES.map((entry) => [entry.key, entry.level]),
)
