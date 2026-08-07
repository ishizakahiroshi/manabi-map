import { useEffect, useMemo, useRef, useState } from 'react'
import type { School } from '../types/school'
import type { SchoolDetailExtras } from '../components/SchoolDetailSheet'
import {
  ensureSchoolsLoaded,
  hydrateAdmissionSourceRefs,
  mapSchoolRows,
  useSchoolsCache,
} from './useSchools'
import { getInitialData, type SingleSchoolPayload } from '../lib/initialData'

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

interface FetchedDetail {
  school: School
  extras: SchoolDetailExtras
}

/**
 * 単体 JSON payload を描画用の形へ写す。fetch 経路と、
 * プリレンダー同梱の初期データ経路（initialDetail）で共用する。フォーク禁止。
 */
function toDetail(payload: SingleSchoolPayload, id: string): FetchedDetail {
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

/** プリレンダーが埋め込んだ payload から初期表示を作る。無ければ null（従来の fetch 経路）。 */
function initialDetail(id: string | null): FetchedDetail | null {
  if (!id || !SCHOOL_ID_PATTERN.test(id)) return null
  const payload = getInitialData()?.schoolDetail
  if (!payload) return null
  try {
    return toDetail(payload, id)
  } catch {
    return null
  }
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
  return toDetail(payload, id)
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
  // プリレンダーが埋め込んだ payload があれば初回 render から使う。
  // ここを null 始まりにすると、プリレンダー（データあり）と食い違って hydration が壊れる
  // （plan_ssr-hydration_c3_initial-data.md）。
  //
  // 埋め込みはビルド時点の値でしかない。school-data JSON だけ差し替える運用や
  // HTML が CDN キャッシュに残っている状況では古くなるので、**正典は常に
  // /school-data/<id>.json 側**とし、hydration 後に必ず取り直して上書きする。
  // 値が同じなら React が bail out する。
  const [fetched, setFetched] = useState<FetchedDetail | null>(() => initialDetail(id))
  const [fetching, setFetching] = useState(false)
  const [fallback, setFallback] = useState(false)
  const cache = useSchoolsCache()
  // 直前に表示していた id。切り替わったときだけ fetched をクリアする
  // （単純に毎 effect で setFetched(null) すると埋め込み直後に読み込み中へ戻る）。
  const lastId = useRef<string | null>(fetched?.school.id ?? null)

  useEffect(() => {
    if (!id || !SCHOOL_ID_PATTERN.test(id)) return
    const idChanged = lastId.current !== id
    if (idChanged) {
      setFetched(null)
      setFallback(false)
      lastId.current = id
    }
    let cancelled = false
    setFetching(true)
    void (async () => {
      try {
        const result = await fetchSingleSchool(id)
        if (cancelled) return
        setFetched(result)
        setFallback(false)
      } catch {
        if (cancelled) return
        // 単体 JSON が無い / 壊れている環境は全件ロードへフォールバックする。
        // ただし埋め込みで既に描けている id の取り直し失敗では画面を潰さない。
        if (idChanged) {
          setFallback(true)
          void ensureSchoolsLoaded()
        }
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
