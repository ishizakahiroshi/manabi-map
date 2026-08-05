import { useEffect, useMemo, useState } from 'react'
import type { AdmissionSelectionSource, School } from '../types/school'
import type { SchoolDetailExtras } from '../components/SchoolDetailSheet'
import type { SuccessorRef } from '../lib/successors'
import {
  ensureSchoolsLoaded,
  hydrateAdmissionSourceRefs,
  mapSchoolRows,
  useSchoolsCache,
  type SchoolRow,
} from './useSchools'

// 学校詳細ページ（/school/:id 直リンク着地）のデータ取得。
//
// 全件 JSON（gzip 約 1.7MB / 展開約 28MB）は読まず、gen-schools-json.mjs が出力する
// 学校単体 JSON（/school-data/<id>.json・数 KB〜数十 KB）だけで初期描画を完結させる
// （docs/local/plan_seo-growth-strategy_c7 C1）。全件 JSON は地図表示時のみ遅延取得。
//
// URL は固定パス + `?v=<schoolDataVersion>`（manifest 経由）でキャッシュバストする
// （public/_headers の /school-data/* immutable とセット）。
//
// フォールバック: 単体 JSON が取れない環境（gen 前の dev サーバー・旧デプロイ・
// VITE_SCHOOLS_SOURCE=supabase）では全件ロード（useSchools と同一キャッシュ）へ落ちる。

/** DB の学校 id（UUID 等）以外の文字列を school-data パスへ通さない。 */
const SCHOOL_ID_PATTERN = /^[0-9a-zA-Z-]+$/

interface SingleSchoolPayload {
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

interface FetchedDetail {
  school: School
  extras: SchoolDetailExtras
}

async function fetchSingleSchool(id: string): Promise<FetchedDetail> {
  // manifest から school-data のバージョンを取る（取れなくても本体は取りに行く）。
  let version: string | null = null
  try {
    const manifestRes = await fetch('/schools-manifest.json', { cache: 'no-store' })
    if (manifestRes.ok) {
      const manifest = (await manifestRes.json()) as { schoolDataVersion?: string }
      if (
        typeof manifest.schoolDataVersion === 'string' &&
        /^[0-9a-f]{6,64}$/i.test(manifest.schoolDataVersion)
      ) {
        version = manifest.schoolDataVersion
      }
    }
  } catch {
    // manifest が無い環境（gen 前の dev サーバー等）はバージョン無しで取得する。
  }

  const url = `/school-data/${id}.json${version ? `?v=${version}` : ''}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`school detail fetch failed: ${response.status} (${url})`)
  // 存在しないファイルが SPA fallback で HTML 200 になる環境でも、
  // JSON.parse 失敗 → throw → 全件フォールバックで拾える。
  const payload = (await response.json()) as SingleSchoolPayload
  if (
    payload == null ||
    typeof payload !== 'object' ||
    !Array.isArray(payload.schools) ||
    !Array.isArray(payload.sourceCatalog)
  ) {
    throw new Error('school detail payload has an unsupported format')
  }

  // 出典復元と行の写像は全件 JSON 経路（useSchools）と同じ共有実装。フォーク禁止。
  hydrateAdmissionSourceRefs(payload.schools, payload.sourceCatalog)
  const [school] = mapSchoolRows(payload.schools)
  if (!school || school.id !== id) {
    throw new Error('school detail payload does not contain the requested school')
  }

  const extras: SchoolDetailExtras = {
    neighbors: (payload.neighbors ?? []).map((neighbor) => ({
      school: {
        id: neighbor.id,
        name: neighbor.name,
        prefecture: neighbor.prefecture,
        city: neighbor.city,
      },
      distanceKm: neighbor.distanceKm,
    })),
    successors: payload.successors ?? [],
    linkableSchoolIds: new Set(payload.linkableSchoolIds ?? []),
  }
  return { school, extras }
}

export interface SchoolDetailState {
  school: School | null
  /** 単体 JSON 経路のときのみ非 null。フォールバック時は sheet 側が全件キャッシュから計算する。 */
  extras: SchoolDetailExtras | null
  loading: boolean
  notFound: boolean
  error: string | null
}

export function useSchoolDetail(id: string | null): SchoolDetailState {
  const [fetched, setFetched] = useState<FetchedDetail | null>(null)
  const [fetching, setFetching] = useState(false)
  const [fallback, setFallback] = useState(false)
  const cache = useSchoolsCache()

  useEffect(() => {
    setFetched(null)
    setFallback(false)
    if (!id || !SCHOOL_ID_PATTERN.test(id)) return
    let cancelled = false
    setFetching(true)
    void (async () => {
      try {
        const result = await fetchSingleSchool(id)
        if (cancelled) return
        setFetched(result)
      } catch {
        if (cancelled) return
        // 単体 JSON が無い / 壊れている環境は全件ロードへフォールバックする。
        setFallback(true)
        void ensureSchoolsLoaded()
      } finally {
        if (!cancelled) setFetching(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id])

  const fallbackSchool = useMemo(
    () => (fallback && id ? (cache.schools.find((s) => s.id === id) ?? null) : null),
    [fallback, id, cache.schools],
  )

  if (!id || !SCHOOL_ID_PATTERN.test(id)) {
    return { school: null, extras: null, loading: false, notFound: true, error: null }
  }
  if (!fallback) {
    return {
      school: fetched?.school ?? null,
      extras: fetched?.extras ?? null,
      loading: fetching && fetched == null,
      notFound: false,
      error: null,
    }
  }
  return {
    school: fallbackSchool,
    extras: null,
    loading: cache.loading,
    notFound: !cache.loading && cache.error == null && fallbackSchool == null,
    error: fallbackSchool == null ? (cache.error ?? null) : null,
  }
}
