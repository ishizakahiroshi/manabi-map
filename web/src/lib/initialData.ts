import type { AdmissionSelectionSource } from '../types/school'
import type { SchoolRow } from '../hooks/useSchools'
import type { PrefIndexPayload } from './prefIndex'
import type { SuccessorRef } from './successors'

/**
 * ビルド時プリレンダーが使ったデータを、ブラウザの初回 render でもそのまま使うための受け渡し。
 *
 * これが無いと「プリレンダーはデータあり・ブラウザ初回はデータなし（読み込み中）」で
 * hydration が必ず食い違い、React がツリーを描き直す＝ちらつきが形を変えて残る
 * （plan_ssr-hydration_c3_initial-data.md）。
 *
 * ブラウザでは `#__MM_INITIAL__` の JSON を読む。プリレンダー（node）では
 * entry-server が render 前に setInitialData() で流し込む。
 */
export const INITIAL_DATA_ELEMENT_ID = '__MM_INITIAL__'

/** `/school-data/<id>.json` の payload（学校詳細ページが読むもの）。 */
export interface SingleSchoolPayload {
  formatVersion: number
  sourceCatalog: AdmissionSelectionSource[]
  schools: SchoolRow[]
  neighbors?: Array<{
    id: string
    name: string
    prefecture: string
    city: string | null
    distanceKm: number
  }>
  successors?: SuccessorRef[]
  linkableSchoolIds?: string[]
}

export interface InitialData {
  /** 学校詳細ページ（/school/:id）用。単体 JSON と同じ形。 */
  schoolDetail?: SingleSchoolPayload
  /**
   * 県ページ（/pref/:pref）用。pref-index と同じ短縮形（全件・県別フル JSON ではない）。
   * 展開は PrefecturePage が expandPrefIndex で行う。
   */
  prefPage?: PrefIndexPayload
  /** 法務ページ（/legal/*）とガイド（/guide/*）の Markdown 本文。 */
  docMarkdown?: string
  /** /data 用。dist/api/v1/dataset.json と同じ形（収録件数と県別内訳）。 */
  datasetMetadata?: {
    school_count: number
    prefecture_count: number
    prefectures?: Record<string, number>
  }
}

/** 未解決を undefined、解決済みで無しを null で表す（DOM を毎回引かないため）。 */
let resolved: InitialData | null | undefined

/** プリレンダー（node）側から流し込む。ページごとに呼び直すこと。 */
export function setInitialData(data: InitialData | null): void {
  resolved = data
}

export function getInitialData(): InitialData | null {
  if (resolved === undefined) resolved = readFromDocument()
  return resolved
}

function readFromDocument(): InitialData | null {
  if (typeof document === 'undefined') return null
  const el = document.getElementById(INITIAL_DATA_ELEMENT_ID)
  const raw = el?.textContent
  if (!raw) return null
  try {
    return JSON.parse(raw) as InitialData
  } catch {
    // 壊れた埋め込みで白画面にはしない。通常の fetch 経路へ落ちる。
    return null
  }
}

/**
 * HTML へ埋め込む script タグを組み立てる。
 *
 * `type="application/json"` なので実行されない。データ中の `<` をエスケープするのは、
 * 校名や説明文に `</script` が含まれたときにタグが途中で閉じるのを防ぐため
 * （gen-seo-pages.mjs の JSON-LD 注入が `</` を潰しているのと同じ趣旨）。
 */
export function serializeInitialData(data: InitialData): string {
  const json = JSON.stringify(data).replaceAll('<', '\\u003c')
  return `<script type="application/json" id="${INITIAL_DATA_ELEMENT_ID}">${json}</script>`
}
