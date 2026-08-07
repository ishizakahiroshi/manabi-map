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
  GenderType,
  Ownership,
  SchoolLifecycleStatus,
  SchoolRecruitmentStatus,
} from '../types/school'

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
  latitude: number | null
  longitude: number | null
}

export interface PrefIndexPayload {
  slug: string
  /** 市区町村コード順の見出しラベル（city-index と同じ並び）。 */
  cities: string[]
  schools: CompactPrefSchool[]
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
