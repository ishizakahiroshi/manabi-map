/**
 * 県ページ（/pref/:pref）用の軽量インデックス。
 *
 * 全件 schools.json（展開 28MB）や pref-<slug>.json（東京 2.8MB）は HTML に埋め込めない。
 * PrefecturePage が実際に参照する 12 フィールドだけを、searchIndex と同じ短縮キーで持つ
 * （plan_ssr-hydration_c3_initial-data.md「県ページの設計」）。
 *
 * ファイル形: dist/school-data/pref-index-<slug>.json
 *   { slug, cities: string[], schools: CompactPrefSchool[] }
 */

import type {
  CourseTime,
  DeptUiGroup,
  GenderType,
  Ownership,
  SchoolLifecycleStatus,
  SchoolRecruitmentStatus,
} from '../types/school'
import {
  buildCityCounts as buildSharedCityCounts,
  cityPagePath,
} from '../../scripts/lib/city-index-shared.mjs'
import { decodeDeptGroups } from '../../scripts/lib/dept-groups-shared.mjs'

export { cityPagePath }

/** ディスク／埋め込み用の短縮キー。展開は expandPrefSchool だけが行う（フォーク禁止）。 */
export interface CompactPrefSchool {
  i: string
  n: string
  k: string | null
  /** 解決済み市区町村ラベル（県ページ見出しと同一。未解決は「その他」） */
  c: string | null
  o: Ownership
  ls: SchoolLifecycleStatus | null
  rs: SchoolRecruitmentStatus | null
  ct: CourseTime[]
  g: GenderType | null
  /**
   * 学科系統の 1 文字コード（dept-groups-shared.mjs の DEPT_GROUP_CODES）。
   * **学科が 1 件も無い学校ではキーごと存在しない。** 空配列は作らない。
   */
  dg?: string[]
  /** 中高一貫。true のときだけ存在する。 */
  ig?: true
  lat: number | null
  lng: number | null
}

/** PrefecturePage が描画に使う展開後の行。School の部分集合。 */
export interface PrefListSchool {
  id: string
  name: string
  name_kana: string | null
  city: string | null
  prefecture: string
  ownership: Ownership
  lifecycle_status_code: SchoolLifecycleStatus
  recruitment_status_code: SchoolRecruitmentStatus
  course_times: CourseTime[]
  gender_type: GenderType
  /** 学科系統。学科情報が無い学校は空配列（MapPage の 'unknown' sentinel は使わない）。 */
  dept_groups: Exclude<DeptUiGroup, 'unknown'>[]
  is_integrated: boolean
  latitude: number | null
  longitude: number | null
}

export interface PrefIndexPayload {
  slug: string
  /** 市区町村コード順の見出しラベル（city-index と同じ並び）。 */
  cities: string[]
  schools: CompactPrefSchool[]
}

/** 県内の市区町村 1 件と、その掲載校数。市区町村ページの近隣導線に使う。 */
export interface CityCount {
  c: string
  n: number
}

/**
 * 市区町村ページ（/pref/:pref/:city）の埋め込み payload。
 *
 * schools は**その市区町村の分だけ**。県全体を入れると東京 430 校 × 62 ページで
 * dist が数 MB 膨らむため（plan_seo-growth-strategy_c5_static-routes.md C6）。
 * 近隣導線に要る「県内の他の市区町村」は件数だけの cityCounts で持つ。
 */
export interface CityPagePayload {
  slug: string
  /** 市区町村ラベル（県ページ見出し・city-index と同一表記）。 */
  city: string
  schools: CompactPrefSchool[]
  /** 市区町村コード順（pref-index の cities 順）。掲載校が 0 の市区町村は含まない。 */
  cityCounts: CityCount[]
}

/**
 * pref-index から市区町村ごとの掲載校数を、コード順で作る。
 *
 * **gen-seo-pages.mjs の埋め込み生成と同じ結果になること**（違うと hydration が食い違う）。
 * 実装は Node 側と共有する純粋な .mjs モジュールに置く。
 */
export function buildCityCounts(payload: PrefIndexPayload): CityCount[] {
  return buildSharedCityCounts(payload)
}

/**
 * 市区町村ページの URL パス。
 *
 * 日本語ラベルを percent-encode する。canonical・sitemap・BreadcrumbList の item も
 * すべてこの表記で統一すること（gen-seo-pages.mjs 側も同じ形を作る）。
 */
/** 近隣導線に出す市区町村の数（前後それぞれ）。 */
export const CITY_SIBLING_SPAN = 3

/**
 * コード順で前後にある市区町村を返す。総務省コードは地域順に並ぶので、
 * 前後を取ると地理的にも近い市区町村になる（距離計算を持ち込まずに済む）。
 */
export function selectCitySiblings(cityCounts: CityCount[], city: string): CityCount[] {
  const index = cityCounts.findIndex((entry) => entry.c === city)
  if (index < 0) return []
  return cityCounts
    .slice(Math.max(0, index - CITY_SIBLING_SPAN), index + CITY_SIBLING_SPAN + 1)
    .filter((entry) => entry.c !== city)
}

export function expandPrefSchool(entry: CompactPrefSchool, prefecture: string): PrefListSchool {
  return {
    id: entry.i,
    name: entry.n,
    name_kana: entry.k,
    city: entry.c,
    prefecture,
    ownership: entry.o,
    lifecycle_status_code: entry.ls ?? 'active',
    recruitment_status_code: entry.rs ?? 'recruiting',
    course_times: entry.ct?.length ? entry.ct : ['fulltime'],
    gender_type: entry.g ?? 'coed',
    dept_groups: decodeDeptGroups(entry.dg),
    is_integrated: entry.ig === true,
    latitude: entry.lat,
    longitude: entry.lng,
  }
}

export function expandPrefIndex(payload: PrefIndexPayload, prefecture: string): PrefListSchool[] {
  return payload.schools.map((entry) => expandPrefSchool(entry, prefecture))
}

/**
 * manifest 経由で県ページ用インデックスを取る。
 * URL は固定パス + `?v=<schoolDataVersion>`（school-data の immutable キャッシュとセット）。
 */
export async function loadPrefIndex(slug: string): Promise<PrefIndexPayload> {
  const manifestRes = await fetch('/schools-manifest.json', { cache: 'no-store' })
  if (!manifestRes.ok) throw new Error(`manifest fetch failed: ${manifestRes.status}`)
  const manifest = (await manifestRes.json()) as {
    prefIndexUrls?: Record<string, string>
    schoolDataVersion?: string
  }
  const path =
    typeof manifest.prefIndexUrls?.[slug] === 'string' &&
    /^\/school-data\/pref-index-[a-z0-9-]+\.json$/i.test(manifest.prefIndexUrls[slug])
      ? manifest.prefIndexUrls[slug]
      : null
  if (!path) throw new Error(`pref index url missing for ${slug}`)
  const version =
    typeof manifest.schoolDataVersion === 'string' && /^[0-9a-f]+$/i.test(manifest.schoolDataVersion)
      ? manifest.schoolDataVersion
      : null
  const url = version ? `${path}?v=${version}` : path
  const res = await fetch(url)
  if (!res.ok) throw new Error(`pref index fetch failed: ${res.status}`)
  const payload = (await res.json()) as PrefIndexPayload
  if (
    payload == null ||
    typeof payload !== 'object' ||
    payload.slug !== slug ||
    !Array.isArray(payload.cities) ||
    !Array.isArray(payload.schools)
  ) {
    throw new Error(`pref index payload is invalid for ${slug}`)
  }
  return payload
}
