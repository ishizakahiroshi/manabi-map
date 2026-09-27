import { createHash } from 'node:crypto'
import { schoolBrand } from './lib/brands.mjs'
import { mkdir, readdir, readFile, rm, unlink, writeFile, lstat, open } from 'node:fs/promises'
import { dirname, join, resolve, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync, gunzipSync } from 'node:zlib'
import { buildSchoolPayload, loadSchoolSource, parseSchoolSourceArgs, parseSchoolSnapshot, parseObservedSchoolSnapshot, snapshotToGeneratorRows, canonicalSchoolSourceJSON } from './lib/school-source.mjs'
import { stageSchoolCandidate, checkedFile, checkedOutput, checkedPath } from './lib/school-candidate.mjs'
import { schoolResourceBudget } from './lib/school-resource-budget.mjs'
import { verifySchoolProjection } from './lib/school-release-producer.mjs'
import { assertNoInternalSchoolFields } from './verify-static-output.mjs'
import { loadCivicData, resolveCityGroup, UNRESOLVED_CITY_LABEL } from './lib/municipalities.mjs'

// 近隣校の選定と後継校の逆引きは React 側・gen-seo-pages.mjs と同一実装を共有する
// （tsx 経由で .ts を直 import（package.json の scripts が tsx で起動する。Node の type stripping には依存しない — Cloudflare Pages のビルドイメージは pnpm 同梱の preinstall Node しか使えないため）。フォーク禁止 —
// 学校単体 JSON と静的 HTML・JS mount 後で校名・距離が食い違う事故を防ぐ。
// docs/local/plan_seo-growth-strategy_c7 C1）。
import { selectNeighbors } from '../src/lib/neighbors.ts'
import { successorsByPredecessorId } from '../src/lib/successors.ts'
import { GENERATOR_SCHOOL_SELECT } from '../src/lib/school-select.ts'
import { buildMapPayload } from '../src/lib/mapPayload.ts'
import { encodeDeptGroups } from './lib/dept-groups-shared.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, '..')

async function readEnvFile(path) {
  try {
    const text = await readFile(path, 'utf8')
    return Object.fromEntries(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const [key, ...rest] = line.split('=')
          const value = rest.join('=').trim().replace(/^(['"])(.*)\1$/, '$2')
          return [key.trim(), value]
        }),
    )
  } catch (err) {
    if (err?.code === 'ENOENT') return {}
    throw err
  }
}

/** Bounded read-only transport for the observed path. A failed/redirected source
 * response cannot move credentials to another origin or continue unbounded JSON.
 */
export function observedSourceFetch({ origin, signal, fetchImpl = fetch, maxResponseBytes = 8 * 1024 * 1024,
  maxTotalBytes = 128 * 1024 * 1024 }) {
  if (new URL(origin).origin !== origin || !origin.startsWith('https://') || !signal ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 || maxResponseBytes > 8 * 1024 * 1024 ||
      !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0 || maxTotalBytes > 128 * 1024 * 1024) throw new Error('Observed source transport refused')
  let total = 0
  return async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (signal.aborted || url.origin !== origin || (options.method ?? input.method ?? 'GET').toUpperCase() !== 'GET') throw new Error('Observed source transport refused')
    const response = await fetchImpl(input, { ...options, signal, redirect: 'error' })
    let reader
    try {
      if (response.redirected || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new Error('Observed source response refused')
      const length = response.headers.get('content-length')
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxResponseBytes)) throw new Error('Observed source response refused')
      reader = response.body?.getReader()
      if (!reader) throw new Error('Observed source response refused')
      let size = 0; const parts = []
      while (true) {
        if (signal.aborted) throw new Error('Observed source stopped')
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength; total += value.byteLength
        if (size > maxResponseBytes || total > maxTotalBytes) throw new Error('Observed source response refused')
        parts.push(Buffer.from(value))
      }
      const headers = new Headers(response.headers)
      headers.delete('content-encoding'); headers.set('content-length', String(size))
      return new Response(Buffer.concat(parts), { status: response.status, headers })
    } finally { if (reader) void reader.cancel().catch(() => {}); else if (response.body) void response.body.cancel().catch(() => {}) }
  }
}

async function fetchSupabaseRows({ signal, quiet = false } = {}) {
  // .env の探索先。既定は web/（従来どおり）。MANABI_MAP_ENV_DIR を設定するとリポジトリ外を見る
  // （秘密をリポジトリ配下に置かないための仕組み。vite.config.ts の envDir と同じ変数を使う）。
  const { createClient } = await import('@supabase/supabase-js')
  const envDir = process.env.MANABI_MAP_ENV_DIR || webRoot

  const env = {
    ...(await readEnvFile(join(envDir, '.env'))),
    ...(await readEnvFile(join(envDir, '.env.local'))),
    ...process.env,
  }

  const url = env.VITE_SUPABASE_URL
  const anonKey = env.VITE_SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    throw new Error(
      'VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY を web/.env.local か環境変数に設定してください。',
    )
  }

  const supabase = createClient(url, anonKey, {
    ...(signal ? { global: { fetch: observedSourceFetch({ origin: new URL(url).origin, signal }) } } : {}),
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })

  /**
   * Supabase の statement timeout（3 秒）は、DB のキャッシュが冷えていると
   * 深い nest の 1 ページだけで到達しうる。
   *
   * 2026-07-31 実測: 入試履歴の 1 ページ目が cold 3.17 秒 / warm 0.30 秒。
   * ローカルでは事前アクセスで warm だったため通り、Cloudflare の本番ビルドは
   * cold で当たって失敗した（v0.4.0 リリース時）。同じページを少し待って引き直せば
   * warm になって通るので、タイムアウト系のエラーは再試行する。
   */
  async function runWithRetry(label, run, attempts = 4) {
    let lastMessage = ''
    for (let i = 1; i <= attempts; i += 1) {
      signal?.throwIfAborted()
      const { data, error } = await run()
      if (!error) return data ?? []
      lastMessage = error.message
      const retriable = /timeout|timed out|57014|fetch failed|ECONNRESET|502|503|504/i.test(error.message)
      if (!retriable || i === attempts) break
      const waitMs = 1500 * i
      if (!quiet) console.error(`${label}: ${error.message} — ${waitMs}ms 待って再試行 (${i}/${attempts - 1})`)
      if (signal) await (await import('node:timers/promises')).setTimeout(waitMs, undefined, { signal })
      else await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
    throw new Error(`${label}に失敗しました: ${lastMessage}`)
  }

  const select = GENERATOR_SCHOOL_SELECT
  // このページサイズは school_departments(school_id) の索引に依存する（migration 202607310101）。
  // 索引が無いと embed が親 1 行ごとに全件走査になり、全国 47 都道府県（学科 7,798 行）では
  // 250 件/ページでも 3.1 秒かかって Supabase の statement timeout（3 秒）に達する。
  //
  // 索引追加後も 1,000 件/ページでは 1 リクエスト 1.6〜2.9 秒と予算の大半を使ってしまうため
  // 500 件に下げる（2026-07-31 実測）。件数が増えたらここを先に疑うこと。
  const pageSize = 500
  const rows = []

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1
    const data = await runWithRetry(`schools の取得（${from}〜${to}）`, () =>
      supabase
        .from('schools')
        .select(select)
        .eq('is_active', true)
        .order('prefecture', { ascending: true })
        .order('name', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    )

    rows.push(...data)
    if (data.length < pageSize) break
  }

  // 全校＋全入試を1クエリへ深くnestするとPostgRESTのstatement timeoutに達する。
  // 募集単位は小さくページ分割して取得し、現行校と前身校へschool_idで結合する。
  // ページングは OFFSET ではなく keyset（id の続きから取る）にする。
  // OFFSET 方式だと深いページほど読み飛ばしコストが乗り、全国 47 都道府県のデータ量では
  // offset=2000 以降が軒並み statement timeout になった（2026-07-31 実測。offset=0 は 0.7 秒、
  // offset=2000 は 3 秒超で失敗）。keyset ならページ位置に関係なく一定時間で返る。
  // ページサイズは cold の 1 ページ目が timeout に収まる大きさにする。
  // 2026-07-31 実測（warm）: 250 件/ページで 1 ページ目 3.17 秒・2 ページ目以降 0.25〜0.62 秒。
  // 1 ページ目だけ突出するのは巨大な子テーブル（出典 83,957 行等）への初回アクセスのため。
  // 100 件へ下げて 1 ページ目の実測を約 1/3 にし、加えて runWithRetry で取りこぼしを拾う。
  const admissionsBySchool = new Map()
  const admissionPageSize = 100
  let lastUnitId = null
  let admissionPage = 0
  for (;;) {
    admissionPage += 1
    const cursor = lastUnitId
    const data = await runWithRetry(`入試履歴の取得（page ${admissionPage}）`, () => {
      let query = supabase
        .from('admission_recruitment_units')
        .select('school_id, id, unit_key, unit_kind_code, label, course_time, valid_from_year, valid_to_year, admission_recruitment_unit_departments(department_id), school_admission_selection_stats(id, year, selection_stage_code, selection_track_code, stage_label_raw, track_label_raw, selection_scope_raw, population_scope_raw, scope_key, map_role_code, is_ratio_comparable, capacity, applicants, examinees, admitted, exam_scope_raw, school_admission_stat_exam_components(component_code), school_admission_stat_quality_flags(metric_code, reason_code, note), school_admission_stat_sources(fact_kind_code, official_url, doc_title, published_at, source_page_or_table, quoted_evidence, last_verified_at, last_http_status))')
        .order('id', { ascending: true })
        .limit(admissionPageSize)
      if (cursor !== null) query = query.gt('id', cursor)
      return query
    })
    for (const unit of data) {
      const units = admissionsBySchool.get(unit.school_id) ?? []
      units.push(unit)
      admissionsBySchool.set(unit.school_id, units)
    }
    if (data.length < admissionPageSize) break
    lastUnitId = data[data.length - 1].id
  }
  for (const row of rows) {
    row.admission_recruitment_units = admissionsBySchool.get(row.id) ?? []
    for (const relationship of row.predecessor_relationships ?? []) {
      if (relationship.predecessor) {
        relationship.predecessor.admission_recruitment_units =
          admissionsBySchool.get(relationship.predecessor.id) ?? []
      }
    }
  }


  return rows
}
const productionSchoolIO = { mkdir, readdir, writeFile, rm, unlink }
async function writeSchoolFiles(inputRows, publicDir, generatedAt, logger = console, io = productionSchoolIO) {
  const { mkdir, readdir, writeFile, rm, unlink } = io
  const {
  buildOpenApiDocument,
  buildPublicSchoolRecords,
  DATASET_ATTRIBUTION,
  DATASET_CLAIM,
  DATASET_LICENSE_URL,
  DATASET_ORIGIN,
  } = await import('./lib/public-api.mjs')
  const payload = buildSchoolPayload(inputRows)
  const { schools: rows, sourceCatalog } = payload

  // official_url は公開 API の学校採用ゲートでもある。NULL を許容して生成は続けるが、
  // 県追加時の取りこぼしがビルドログで必ず見えるように全件数と県別件数を警告する。
  const officialUrlGaps = rows.filter((row) => row.is_active !== false && !row.official_url)
  if (officialUrlGaps.length > 0) {
    const byPrefecture = Object.entries(Object.groupBy(officialUrlGaps, (row) => row.prefecture))
      .map(([prefecture, schools]) => `${prefecture}:${schools.length}`)
      .join('、')
    logger.warn(
      `[official_url] 現行校 ${officialUrlGaps.length}/${rows.length} 校が未登録です（${byPrefecture}）。` +
      '公開 API から除外されるため、県教委・私学協会の公式一覧から補完してください。',
    )
  }

  // --- build hash 付き URL 化 -------------------------------------------------
  // 内容から sha256 の先頭 10 桁を hash とし、`schools-<hash>.json` を出力する。
  // あわせて `schools-manifest.json` を「常に fresh に取る」ポインタとして書き、
  // フロント側は manifest → hash 付き URL の 2 段 fetch で反映ラグを解消する。
  // 過去の hash 付き JSON は build 時に掃除して重複配信を防ぐ。
  // 詳細: docs/local/plan_schools-json-cache-strategy.md
  await mkdir(publicDir, { recursive: true })

  const body = `${JSON.stringify(payload)}\n`
  const contentSha256 = createHash('sha256').update(body).digest('hex')
  const hash = contentSha256.slice(0, 10)
  const filename = `schools-${hash}.json.gz`
  const outputPath = join(publicDir, filename)

  // --- 地図・一覧用の全国データ（docs/local/plan_data-usage-audit.md C2）-----------
  // 上の全件 JSON は入試履歴と出典で 3.79MB あり、`/map` へ入るたびに毎回落ちていた。
  // 実際に地図・お気に入り・比較・マイページ・統合検索が読むのはピンと一覧に出る列だけで、
  // 入試履歴の本体は詳細シートでしか使わない（シートは単体 JSON で補う）。
  // 列の選定と最新年度倍率の畳み込みは src/lib/mapPayload.ts に置く（React 側と共有）。
  //
  // **全件 JSON は残す。** ビルド時の静的生成（gen-seo-pages.mjs）が読む正典で、
  // 公開データとしても配り続ける。ブラウザが毎回読むのを止めるだけ。
  const mapPayload = buildMapPayload(rows)
  const mapBody = `${JSON.stringify(mapPayload)}\n`
  const mapHash = createHash('sha256').update(mapBody).digest('hex').slice(0, 10)
  const mapFilename = `schools-map-${mapHash}.json.gz`
  const mapOutputPath = join(publicDir, mapFilename)

  // --- 検索用の軽量索引 -------------------------------------------------------
  // トップの統合検索は schools.json 全体を読まない（plan_seo-growth-strategy_c5 C3）。
  // - 市区町村索引: 高校が 1 校以上ある市区町村。ふりがな付き（かな入力対応）で
  //   市区町村コード順。地名候補 → 県ページ（/pref/<slug>/#<市区町村>）への導線に使う。
  // - 校名索引: 全収録校の校名・ふりがな・所在地・座標のみ（検索欄フォーカス時に遅延読込）。
  const { prefectures, muniByPref } = await loadCivicData(webRoot)
  const prefBySlugName = new Map(prefectures.map((p) => [p.name, p]))

  // --- 出典追跡可能な公開 API（plan_public-api-readiness C4） ------------------
  // アプリ用 payload は変更せず、明示的な許可リストを通した派生物だけを固定 URL で配る。
  // public/ に生成してから Vite が dist/ へコピーするため、動的 API や Pages Functions は不要。
  const publicApiRecords = buildPublicSchoolRecords(rows, sourceCatalog, generatedAt)
  const publicApiPrefectures = new Set(publicApiRecords.map((row) => row.prefecture))
  const missingPublicApiPrefectures = prefectures
    .filter((pref) => rows.some((row) => row.prefecture === pref.name) && !publicApiPrefectures.has(pref.name))
    .map((pref) => pref.name)
  if (missingPublicApiPrefectures.length > 0) {
    throw new Error(
      '公開 API の official_url ゲートで都道府県が全欠落しました。' +
      `公開仕様を確定するまで生成を停止します: ${missingPublicApiPrefectures.join('、')}`,
    )
  }
  const publicApiRoot = join(publicDir, 'api', 'v1')
  const publicApiSchoolsDir = join(publicApiRoot, 'schools')
  await rm(publicApiRoot, { recursive: true, force: true })
  await mkdir(publicApiSchoolsDir, { recursive: true })

  const publicApiPayload = {
    api_version: 'v1',
    generated_at: generatedAt,
    count: publicApiRecords.length,
    schools: publicApiRecords,
  }
  await writeFile(join(publicApiRoot, 'schools.json'), `${JSON.stringify(publicApiPayload)}\n`)

  const prefApiCounts = {}
  for (const pref of prefectures) {
    const prefRecords = publicApiRecords.filter((row) => row.prefecture === pref.name)
    if (prefRecords.length === 0) continue
    prefApiCounts[pref.slug] = prefRecords.length
    await writeFile(
      join(publicApiSchoolsDir, `${pref.slug}.json`),
      `${JSON.stringify({
        api_version: 'v1',
        generated_at: generatedAt,
        prefecture: pref.name,
        count: prefRecords.length,
        schools: prefRecords,
      })}\n`,
    )
  }

  const packageJson = JSON.parse(await readFile(join(webRoot, 'package.json'), 'utf8'))
  await writeFile(
    join(publicApiRoot, 'dataset.json'),
    `${JSON.stringify({
      name: `${schoolBrand.name} 学校基本情報データセット`,
      version: packageJson.version,
      api_version: 'v1',
      generated_at: generatedAt,
      school_count: publicApiRecords.length,
      prefecture_count: Object.keys(prefApiCounts).length,
      prefectures: prefApiCounts,
      license: 'CC BY-SA 4.0',
      license_url: DATASET_LICENSE_URL,
      attribution: DATASET_ATTRIBUTION,
      provenance_policy: DATASET_CLAIM,
      inclusion_policy: '学校公式 URL を持つ現行校と、追跡可能な公式出典を伴う項目のみを収録します。',
      exclusion_policy: '偏差値の編集推計と、出典 URL を確認できない項目は収録しません。',
      distributions: [
        { content_url: `${DATASET_ORIGIN}/api/v1/schools.json`, encoding_format: 'application/json' },
        { content_url_template: `${DATASET_ORIGIN}/api/v1/schools/{prefecture}.json`, encoding_format: 'application/json' },
      ],
    }, null, 2)}\n`,
  )

  // --- 呼び方の契約（OpenAPI）--------------------------------------------------
  // dataset.json が「何が入っているか」の台帳、openapi.json が「どう呼ぶか」の契約。
  // 記述の実体は scripts/lib/public-api.mjs に置く（DATA.md の生成元と同じ場所に集め、
  // 公開する項目とその説明が別々の場所で食い違わないようにする）。
  await writeFile(
    join(publicApiRoot, 'openapi.json'),
    `${JSON.stringify(
      buildOpenApiDocument({
        version: packageJson.version,
        prefectureSlugs: Object.keys(prefApiCounts),
      }),
      null,
      2,
    )}\n`,
  )

  const detailRows = rows.filter((row) => row.latitude != null && row.longitude != null)
  const cityGroups = new Map()
  const unresolvedByPref = new Map()
  for (const row of detailRows) {
    const resolved = resolveCityGroup(row, muniByPref)
    if (!resolved) {
      unresolvedByPref.set(row.prefecture, (unresolvedByPref.get(row.prefecture) ?? 0) + 1)
      continue
    }
    const key = `${row.prefecture}|${resolved.label}`
    const entry = cityGroups.get(key) ?? {
      pref: row.prefecture,
      prefSlug: prefBySlugName.get(row.prefecture)?.slug ?? null,
      city: resolved.label,
      kana: resolved.kana,
      code: resolved.code,
      count: 0,
    }
    entry.count += 1
    cityGroups.set(key, entry)
  }
  const cityIndex = [...cityGroups.values()]
    .filter((entry) => entry.prefSlug != null)
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map(({ code: _code, ...entry }) => entry)

  const nameIndex = detailRows.map((row) => ({
    i: row.id,
    n: row.name,
    k: row.name_kana ?? null,
    p: row.prefecture,
    c: resolveCityGroup(row, muniByPref)?.label ?? row.city ?? null,
    lat: row.latitude != null ? Number(row.latitude) : null,
    lng: row.longitude != null ? Number(row.longitude) : null,
  }))

  const cityIndexBody = `${JSON.stringify(cityIndex)}\n`
  const cityIndexFilename = `city-index-${createHash('sha256').update(cityIndexBody).digest('hex').slice(0, 10)}.json`
  const nameIndexBody = `${JSON.stringify(nameIndex)}\n`
  const nameIndexFilename = `school-name-index-${createHash('sha256').update(nameIndexBody).digest('hex').slice(0, 10)}.json`

  // 古い schools-*.json / 索引を掃除（本 build で出力する分だけ残す）。
  const keep = new Set([filename, mapFilename, cityIndexFilename, nameIndexFilename])
  const existing = await readdir(publicDir)
  for (const name of existing) {
    if (keep.has(name)) continue
    if (
      name === 'schools.json' ||
      /^schools-map-[0-9a-f]+\.json(?:\.gz)?$/.test(name) ||
      /^schools-[0-9a-f]+\.json(?:\.gz)?$/.test(name) ||
      /^city-index-[0-9a-f]+\.json$/.test(name) ||
      /^school-name-index-[0-9a-f]+\.json$/.test(name)
    ) {
      await unlink(join(publicDir, name))
    }
  }

  await writeFile(outputPath, gzipSync(body, { level: 9 }))
  await writeFile(mapOutputPath, gzipSync(mapBody, { level: 9 }))
  await writeFile(join(publicDir, cityIndexFilename), cityIndexBody)
  await writeFile(join(publicDir, nameIndexFilename), nameIndexBody)

  // --- 学校単体 JSON / 県別分割 JSON（plan_seo-growth-strategy_c7 C1） ---------
  // 学校詳細ページ（/school/<id>/ 直リンク着地）は全件 JSON（gzip 約 1.7MB / 展開約 28MB）
  // を読まず、単体 JSON（数 KB〜数十 KB）だけで初期描画を完結させる。全件 JSON は
  // 地図表示時のみ遅延取得する。県別分割は将来の地図の分県ロード用に同形式で置く。
  // ファイル名は固定パス（/school-data/<id>.json）とし、フロントは manifest の
  // schoolDataVersion を `?v=` に付けて取得する（public/_headers の immutable とセット）。
  const schoolDataDir = join(publicDir, 'school-data')
  await rm(schoolDataDir, { recursive: true, force: true })
  await mkdir(schoolDataDir, { recursive: true })

  // 出典 index は全件 catalog（sourceCatalog）基準で振られているため、部分出力ごとに
  // ローカル catalog へ振り直す。rows は全件 payload（出力済み body）とオブジェクトを
  // 共有しているので、必ず structuredClone した行に対してだけ書き換える。
  // visited は同一 stat の二重 remap 防止。同じ前身校を複数の関係行が参照すると
  // unit 配列がクローン内でも共有され、2 回目の remap が「ローカル index を全件 index と
  // 誤読する」壊れ方をする（compactUnitSources の二重圧縮事故と同型）。
  function remapSourceRefs(units, localCatalog, localIndex, visited) {
    for (const unit of units ?? []) {
      for (const stat of unit.school_admission_selection_stats ?? []) {
        if (visited.has(stat)) continue
        visited.add(stat)
        stat.school_admission_stat_sources = (stat.school_admission_stat_sources ?? []).map((ref) => {
          if (typeof ref !== 'number') return ref
          let local = localIndex.get(ref)
          if (local == null) {
            local = localCatalog.length
            localCatalog.push(sourceCatalog[ref])
            localIndex.set(ref, local)
          }
          return local
        })
      }
    }
  }

  /** rows の部分集合を、全件 JSON と同じ形（formatVersion / sourceCatalog / schools）で切り出す。 */
  function subsetPayload(subsetRows) {
    const localCatalog = []
    const localIndex = new Map()
    const visited = new WeakSet()
    const cloned = subsetRows.map((row) => {
      const clone = structuredClone(row)
      remapSourceRefs(clone.admission_recruitment_units, localCatalog, localIndex, visited)
      for (const relationship of clone.predecessor_relationships ?? []) {
        remapSourceRefs(relationship.predecessor?.admission_recruitment_units, localCatalog, localIndex, visited)
      }
      return clone
    })
    return { formatVersion: payload.formatVersion, sourceCatalog: localCatalog, schools: cloned }
  }

  // 単体 JSON は個別ページを持つ学校（緯度経度あり = gen-seo-pages.mjs の生成対象・
  // React 側 mapSchoolRows のフィルタと同一集合）だけ出力する。近隣校の母集合も同じ。
  const detailIds = new Set(detailRows.map((row) => row.id))
  const neighborUniverse = detailRows.map((row) => ({
    id: row.id,
    name: row.name,
    prefecture: row.prefecture,
    city: row.city ?? null,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
  }))
  const subjectById = new Map(neighborUniverse.map((subject) => [subject.id, subject]))
  const successorsById = successorsByPredecessorId(detailRows)

  for (const row of detailRows) {
    const single = subsetPayload([row])
    // Keep the generation with the values, including SSR and CDN-cached detail responses.
    single.contentSha256 = contentSha256
    // 近隣校（距離は raw の double のまま持つ。丸めると静的 HTML の toFixed(1) 表示と
    // 端数の丸め方向がずれうるため、丸めは表示側だけで行う）。
    single.neighbors = selectNeighbors(subjectById.get(row.id), neighborUniverse).map(
      ({ school, distanceKm }) => ({
        id: school.id,
        name: school.name,
        prefecture: school.prefecture,
        city: school.city,
        distanceKm,
      }),
    )
    single.successors = successorsById.get(row.id) ?? []
    // 所属市区町村ページ（/pref/<slug>/<市区町村>/）への導線用。row.city の生値は表記が
    // 揺れている（郡付き・政令市の区・null）ので、県ページ見出しと同じ解決済みラベルを別に持つ。
    // 解決できない校（広域通信制のキャンパス列挙住所など）は null＝リンクを出さない。
    single.cityGroup = resolveCityGroup(row, muniByPref)?.label ?? null
    // 前身校のうち個別ページが存在する id（詳細シートのリンク可否判定用）。
    single.linkableSchoolIds = (row.predecessor_relationships ?? [])
      .map((relationship) => relationship.predecessor?.id)
      .filter((id) => id != null && detailIds.has(id))
    await writeFile(join(schoolDataDir, `${row.id}.json`), `${JSON.stringify(single)}\n`)
  }

  // 県別分割（全 rows を prefecture ごとに全件 JSON と同形式で分割）。
  // 取りこぼし（prefectures.json に無い県名の行）は verify-static-output.mjs の
  // 合計突き合わせで build を落として検出する。
  const prefDataUrls = {}
  for (const pref of prefectures) {
    const prefRows = rows.filter((row) => row.prefecture === pref.name)
    if (prefRows.length === 0) continue
    const prefFilename = `pref-${pref.slug}.json`
    await writeFile(join(schoolDataDir, prefFilename), `${JSON.stringify(subsetPayload(prefRows))}\n`)
    prefDataUrls[pref.slug] = `/school-data/${prefFilename}`
  }

  /**
   * pref-index に載せる所在地を作る。
   *
   * address は県名始まりが大半だが、市区町村から始まる行が混ざっている
   * （神奈川県 28 校・2026-08-25 実測）。県ページと市区町村ページの一覧は
   * この 1 本の文字列をそのまま出すので、県名の有無をここで揃えておく。
   *
   * **市区町村を解決できなかった行は住所を載せない。** その手の行は address が
   * 住所として機能しておらず、拠点の列挙が入っている（「東京都池袋・新宿代々木 ほか」
   * のような広域通信制 8 校・2026-08-25 実測）。所在地が単一に定まらない学校に
   * 代表を 1 つ選んで載せる根拠が無いので、出さないほうを採る。
   * 判定は resolveCityGroup の結果をそのまま使う（住所文字列を見る規則は足さない）。
   */
  function compactAddress(row, city) {
    if (city === UNRESOLVED_CITY_LABEL) return null
    const address = row.address?.trim()
    if (!address) return null
    return address.startsWith(row.prefecture) ? address : `${row.prefecture}${address}`
  }

  // 県ページ用の軽量インデックス（docs/local/plan_ssr-hydration_c3_initial-data.md）。
  // PrefecturePage が実際に参照するフィールドだけを短縮キーで持つ（searchIndex と同手法）。
  // 上の pref-<slug>.json は学校詳細と同じ全項目で東京 2.8MB / 北海道 6.5MB あり、
  // プリレンダー HTML へ埋め込めないため、埋め込み用にこれを別途作る。
  // 地図・詳細ページと同じく lat/lng がある校だけ（mapSchoolRows / gen-seo-pages の targets と一致）。
  // cities は city-index と同じ市区町村コード順。school.c は resolveCityGroup のラベル。
  const prefIndexUrls = {}
  for (const pref of prefectures) {
    const prefRows = rows.filter(
      (row) => row.prefecture === pref.name && row.latitude != null && row.longitude != null,
    )
    if (prefRows.length === 0) continue
    const cities = cityIndex.filter((entry) => entry.prefSlug === pref.slug).map((entry) => entry.city)
    const compactSchools = prefRows.map((row) => {
      // 学科系統と中高一貫は「持っているときだけ」キーを置く。学科ゼロの学校に dg: [] を
      // 置くと 47 県で無駄が乗るうえ、「空配列」と「キー無し」の 2 通りを表示側で
      // 判定することになる。無いものは書かない。
      const deptGroups = encodeDeptGroups(row.school_departments)
      const city = resolveCityGroup(row, muniByPref)?.label ?? row.city ?? UNRESOLVED_CITY_LABEL
      return {
        i: row.id,
        n: row.name,
        k: row.name_kana ?? null,
        c: city,
        o: row.ownership,
        ls: row.lifecycle_status_code ?? null,
        rs: row.recruitment_status_code ?? null,
        ct: row.course_times?.length ? row.course_times : ['fulltime'],
        g: row.gender_type ?? null,
        // 一覧に出す所在地（県名から始まる 1 本の文字列。出せない行は null）。
        // **正規化はこの 1 箇所だけで行う。** 表示側で県名や市区町村名を足し引き
        // し始めると、同じ表記ゆれを画面ごとに別々の regex で吸収することになる。
        a: compactAddress(row, city),
        ...(deptGroups.length ? { dg: deptGroups } : {}),
        ...(row.is_integrated ? { ig: true } : {}),
        lat: row.latitude != null ? Number(row.latitude) : null,
        lng: row.longitude != null ? Number(row.longitude) : null,
      }
    })
    const prefIndexBody = {
      slug: pref.slug,
      cities,
      schools: compactSchools,
    }
    const prefIndexFilename = `pref-index-${pref.slug}.json`
    await writeFile(join(schoolDataDir, prefIndexFilename), `${JSON.stringify(prefIndexBody)}\n`)
    prefIndexUrls[pref.slug] = `/school-data/${prefIndexFilename}`
  }

  const manifest = {
    url: `/${filename}`,
    hash,
    contentSha256,
    count: rows.length,
    formatVersion: payload.formatVersion,
    compression: 'gzip',
    // 地図・一覧用の全国データ（plan_data-usage-audit.md C2）。ブラウザはこちらを読む。
    mapUrl: `/${mapFilename}`,
    mapHash,
    mapCount: mapPayload.schools.length,
    mapFormatVersion: mapPayload.formatVersion,
    sourceCatalogCount: sourceCatalog.length,
    cityIndexUrl: `/${cityIndexFilename}`,
    cityIndexCount: cityIndex.length,
    nameIndexUrl: `/${nameIndexFilename}`,
    // 学校単体 JSON / 県別分割 JSON（/school-data/）のキャッシュバスト用バージョンと台帳。
    // URL は固定パスなので、取得時に `?v=<schoolDataVersion>` を付ける。
    schoolDataVersion: hash,
    schoolDataCount: detailRows.length,
    prefDataUrls,
    prefIndexUrls,
    generatedAt,
  }
  await writeFile(join(publicDir, 'schools-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  logger.log(
    `wrote ${mapPayload.schools.length} schools to ${mapOutputPath} ` +
    `(map url=${manifest.mapUrl})`,
  )
  logger.log(
    `wrote ${rows.length} schools to ${outputPath} (manifest url=${manifest.url}, ` +
    `cityIndex=${cityIndex.length}, nameIndex=${nameIndex.length}, ` +
    `schoolData=${detailRows.length}, prefData=${Object.keys(prefDataUrls).length}, ` +
    `prefIndex=${Object.keys(prefIndexUrls).length}, ` +
    `publicApi=${publicApiRecords.length})`,
  )

  // 市区町村を解決できず県ページの「その他」へ落ちる校数。新県データ投入後にここが
  // 跳ねたら city/address の表記異常（県名二重・欠損表記等）を疑うこと。
  if (unresolvedByPref.size > 0) {
    const detail = [...unresolvedByPref.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([pref, count]) => `${pref}=${count}`)
      .join(', ')
    const total = [...unresolvedByPref.values()].reduce((a, b) => a + b, 0)
    logger.warn(`city 未解決（「その他」行き）: ${total} 校 (${detail})`)
  }
  return manifest
}

// This identity covers the generator, its local runtime dependencies and static configuration.
// It records provenance; it is not a signature or a claim of deployed/reviewed code.
const GENERATOR_FILES = [
  'web/scripts/gen-schools-json.mjs', 'web/scripts/lib/school-candidate.mjs',
  'web/scripts/lib/school-source.mjs', 'web/scripts/lib/municipalities.mjs',
  'web/scripts/lib/school-resource-budget.mjs', 'web/scripts/lib/school-release-producer.mjs',
  'web/scripts/lib/school-functions-package.mjs', 'web/scripts/lib/school-release.mjs', 'web/scripts/verify-static-output.mjs',
  'web/scripts/lib/public-api.mjs', 'web/scripts/lib/dept-groups-shared.mjs',
  'web/scripts/lib/city-index-shared.mjs', 'web/scripts/lib/site.mjs',
  'web/src/lib/neighbors.ts', 'web/src/lib/haversine.ts', 'web/src/lib/successors.ts',
  'web/src/lib/school-select.ts', 'web/src/lib/mapPayload.ts',
  'web/src/lib/admissionUnits.ts', 'web/src/lib/admission.ts',
  'web/data/prefectures.json', 'web/data/municipalities.json',
  'web/data/site.json', 'web/data/brands.json', 'web/scripts/lib/brands.mjs', 'web/scripts/lib/json-ld.mjs', 'web/data/dataset-claims.json', 'web/package.json',
].sort()
const repoRoot = resolve(webRoot, '..')
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function generatorIdentity() {
  const files = await Promise.all(GENERATOR_FILES.map(async (path) => ({ path, sha256: digest(await readFile(await checkedFile(join(repoRoot, path)))) })))
  return { files, sha256: digest(canonicalSchoolSourceJSON(files)) }
}

// Pin before accepting input so a modified disk file is not labelled as the
// code already imported in this process. An immutable reviewed checkout remains
// required; this identity is not a complete transitive dependency attestation.
const loadedGeneratorIdentity = await generatorIdentity()

async function boundedSnapshotFile(path, maximum) {
  const handle = await open(await checkedFile(path), 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size <= 0 || before.size > maximum) throw new Error('Observed snapshot size refused')
    const bytes = Buffer.alloc(before.size + 1)
    let used = 0
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null)
      if (!bytesRead) break
      used += bytesRead
    }
    const after = await lstat(await checkedFile(path))
    if (used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ino !== before.ino || after.dev !== before.dev) throw new Error('Observed snapshot changed')
    return bytes.subarray(0, used)
  } finally { await handle.close() }
}

// Used only by the new external observed writer. Never removes anything and
// never adopts existing directories except its explicitly owned output root.
// Node path checks detect ordinary competing writers, not hostile OS-level races.
function createOnlySchoolIO(root, identity, limits) {
  const directories = new Map([[root, identity]])
  let publicBytes = 0, publicFiles = 0
  const check = (ok) => { if (!ok) throw new Error('Observed generation output identity changed') }
  function inside(path) { const part = relative(root, path); check(part && !part.startsWith('..') && !part.includes(':')); return part }
  async function confirm() {
    for (const [path, expected] of directories) {
      await checkedPath(path)
      const info = await lstat(path)
      check(info.isDirectory() && info.dev === expected.dev && info.ino === expected.ino)
    }
  }
  async function make(path) {
    path = resolve(path)
    if (path === root) { await confirm(); return }
    const parts = inside(path).split(sep)
    let current = root
    for (const part of parts) {
      current = join(current, part)
      await confirm()
      if (!directories.has(current)) {
        await mkdir(current) // Exclusive, including when callers request recursive.
        await checkedPath(current)
        const info = await lstat(current)
        check(info.isDirectory() && !info.isSymbolicLink())
        directories.set(current, info)
      }
    }
    await confirm()
  }
  async function absent(path) {
    inside(resolve(path)); await confirm()
    try { await lstat(path) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    throw new Error('Observed generation refuses to remove an existing path')
  }
  return {
    mkdir: make, rm: absent, unlink: absent,
    async readdir(path, options) { await confirm(); await checkedPath(path); return readdir(path, options) },
    async writeFile(path, bytes) {
      path = resolve(path); inside(path); await confirm()
      const size = Buffer.byteLength(bytes)
      if (relative(root, path).split(sep)[0] === 'public-data') {
        check(size > 0 && size <= limits.maxFileBytes &&
          (publicBytes += size) <= limits.maxTotalBytes && ++publicFiles <= limits.maxFiles)
      } else check(size <= limits.maxDecodedBytes)
      check(directories.has(dirname(path)))
      await checkedPath(path, { missing: true })
      const handle = await open(path, 'wx')
      try { await confirm(); await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    },
  }
}

/** Explicit observed source -> private external JSON generation. This does not
 * build HTML/JS, deploy, or turn an observed row capture into a DB transaction.
 * Supabase callers must hold sourceLease across ALL paginated source reads.
 * SQLite snapshot callers provide a verified false-labelled pair instead; that
 * path never loads credentials or calls fetchRows. Source hashes are rechecked
 * before completion. Neither source label authenticates who supplied the data.
 * Incomplete output is retained without a completion receipt for diagnosis.
 */
export async function generateObservedSchoolJSON({ source, fetchRows, outputRoot, generatedAt,
  sourceLease, snapshotPath, manifestPath, candidateRevision, resourceBudget, sourceTimeoutMs = 300000 }) {
  const check = (ok) => { if (!ok) throw new Error('Observed school generation refused') }
  const sqlite = source === 'sqlite-snapshot'
  check((sqlite ? snapshotPath && manifestPath && fetchRows === undefined && sourceLease === undefined :
    source === 'supabase' && typeof fetchRows === 'function' && snapshotPath === undefined && manifestPath === undefined &&
    typeof sourceLease === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(sourceLease)) &&
    /^[a-f0-9]{40}$/.test(candidateRevision) && typeof generatedAt === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(generatedAt) && Number.isFinite(Date.parse(generatedAt)))
  check(Number.isSafeInteger(sourceTimeoutMs) && sourceTimeoutMs > 0 && sourceTimeoutMs <= 3600000)
  const limits = schoolResourceBudget(resourceBudget)
  // Destination and code checks precede credentials/source access.
  const inputs = sqlite ? await Promise.all([snapshotPath, manifestPath].map(checkedFile)) : []
  check(!sqlite || inputs[0] !== inputs[1])
  const output = await checkedOutput(outputRoot, inputs, repoRoot)
  check((await generatorIdentity()).sha256 === loadedGeneratorIdentity.sha256)
  await mkdir(output)
  await checkedPath(output)
  const identity = await lstat(output)
  const io = createOnlySchoolIO(output, identity, limits)
  async function ownOutput() {
    await checkedPath(output)
    const current = await lstat(output)
    check(current.dev === identity.dev && current.ino === identity.ino && current.isDirectory())
  }
  async function exclusiveFile(path, bytes) {
    await ownOutput()
    await io.writeFile(path, bytes)
  }
  try {
    let sourceIdentity
    async function selectedRows(signal) {
      if (!sqlite) return loadSchoolSource({ source, fetchSupabase: () => fetchRows({ signal }) })
      const [snapshotBytes, manifestBytes] = await Promise.all([
        boundedSnapshotFile(inputs[0], limits.maxDecodedBytes), boundedSnapshotFile(inputs[1], 65536),
      ])
      const snapshot = parseObservedSchoolSnapshot(snapshotBytes, manifestBytes)
      check(snapshot.tables.schools.every((row) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.id)))
      const manifest = JSON.parse(manifestBytes)
      sourceIdentity = { snapshotSha256: digest(snapshotBytes), manifestSha256: digest(manifestBytes),
        contentSha256: manifest.content_sha256, datasetVersion: snapshot.dataset_version, sourceVersion: snapshot.source_version }
      return snapshotToGeneratorRows(snapshot)
    }
    const controller = new AbortController()
    const sourceDeadline = performance.now() + sourceTimeoutMs
    let timer
    let rows
    try {
      rows = await Promise.race([
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Observed source timeout')) }, sourceTimeoutMs) }),
        Promise.resolve().then(() => selectedRows(controller.signal)),
      ])
      check(performance.now() < sourceDeadline && !controller.signal.aborted)
    } finally { clearTimeout(timer); controller.abort() }
    const captured = Buffer.from(`${canonicalSchoolSourceJSON(rows)}\n`)
    check(captured.length <= limits.maxDecodedBytes)
    const { prefectures } = await loadCivicData(webRoot)
    check(rows.length > 0 && rows.every((row) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.id) &&
      prefectures.some((pref) => pref.name === row.prefecture)))
    check(new Set(rows.map((row) => row.id)).size === rows.length)
    const privateDir = join(output, 'private-source'), publicDir = join(output, 'public-data')
    await ownOutput(); await io.mkdir(privateDir); await io.mkdir(publicDir)
    // A source capture is deliberately outside the directory handed to Vite or
    // any public packager. The row JSON may contain non-public provenance fields.
    await exclusiveFile(join(privateDir, 'rows.json'), captured)
    await writeSchoolFiles(rows, publicDir, generatedAt, { log() {}, warn() {} }, io)
    const files = new Map()
    let total = 0
    async function inventory(prefix = '') {
      for (const entry of await readdir(await checkedPath(join(publicDir, prefix)), { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) await inventory(path)
        else {
          const file = await checkedFile(join(publicDir, path)), info = await lstat(file)
          check(info.size > 0 && info.size <= limits.maxFileBytes && (total += info.size) <= limits.maxTotalBytes && files.size < limits.maxFiles)
          const bytes = await readFile(file)
          check(bytes.length === info.size)
          // Reuse the existing recursive private-field gate for every emitted
          // JSON representation, including compressed full/map payloads.
          const decoded = path.endsWith('.gz') ? gunzipSync(bytes, { maxOutputLength: limits.maxDecodedBytes }) : bytes
          check(decoded.length <= limits.maxDecodedBytes)
          assertNoInternalSchoolFields(JSON.parse(decoded), path)
          files.set(path, bytes)
        }
      }
    }
    await inventory()
    const generatorSnapshot = Buffer.from(`${JSON.stringify(buildSchoolPayload(rows))}\n`)
    check(generatorSnapshot.length <= limits.maxDecodedBytes)
    const projection = verifySchoolProjection({ generatorSnapshot, files, resourceBudget: limits })
    check((await generatorIdentity()).sha256 === loadedGeneratorIdentity.sha256)
    await ownOutput()
    // Check every saved byte again before the sole completion marker is written.
    for (const [path, bytes] of files) check((await readFile(await checkedFile(join(publicDir, path)))).equals(bytes))
    check((await readFile(await checkedFile(join(privateDir, 'rows.json')))).equals(captured))
    if (sqlite) {
      const current = await Promise.all([boundedSnapshotFile(inputs[0], limits.maxDecodedBytes), boundedSnapshotFile(inputs[1], 65536)])
      check(digest(current[0]) === sourceIdentity.snapshotSha256 && digest(current[1]) === sourceIdentity.manifestSha256)
    }
    const artifacts = [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: digest(bytes) })).sort((a, b) => a.path.localeCompare(b.path, 'en'))
    const receipt = { format: 'observed-school-json', version: 1, evidence: 'observed', scope: 'school-json-only',
      generatedAt, candidateRevision, source: { type: source, ...(sqlite ? sourceIdentity : { lease: sourceLease }), rowsSha256: digest(captured), rowCount: rows.length },
      generatorSnapshotSha256: digest(generatorSnapshot), generator: loadedGeneratorIdentity,
      resourceBudget: limits, artifacts, artifactsSha256: digest(canonicalSchoolSourceJSON(artifacts)), projection }
    await exclusiveFile(join(privateDir, 'generator-payload.json'), generatorSnapshot)
    await exclusiveFile(join(output, 'observed-generation.json'), `${canonicalSchoolSourceJSON(receipt)}\n`)
    return receipt
  } catch {
    // Do not print rows, paths, upstream diagnostics or credentials.
    throw new Error('Observed school generation failed; no completed generation confirmed')
  }
}

/** Generate only school JSON into a fresh external directory from a synthetic pair.
 * Neither importing this module nor this path reads credentials or invokes Supabase.
 * SEO generation, the application build and publication are separate acceptance steps.
 */
export async function generateSchoolCandidate({ snapshotPath, manifestPath, outputRoot }) {
  const inputs = await Promise.all([snapshotPath, manifestPath].map(checkedFile))
  if (inputs[0] === inputs[1]) throw new Error('Separate snapshot and source manifest required')
  await checkedOutput(outputRoot, inputs, repoRoot)
  const [snapshotBytes, manifestBytes] = await Promise.all(inputs.map((path) => readFile(path)))
  const snapshot = parseSchoolSnapshot(snapshotBytes, manifestBytes)
  const sourceManifest = JSON.parse(manifestBytes)
  // IDs are used as detail filenames. Validate before writing even to the private stage.
  if (snapshot.tables.schools.some((row) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.id))) {
    throw new Error('Invalid school candidate: canonical lowercase UUID required for every school')
  }
  const rows = snapshotToGeneratorRows(snapshot)
  const { prefectures } = await loadCivicData(webRoot)
  if (rows.some((row) => !prefectures.some((pref) => pref.name === row.prefecture))) {
    throw new Error('Invalid school candidate: unknown prefecture would omit partition output')
  }
  const generator = await generatorIdentity()
  const metadata = {
    datasetVersion: snapshot.dataset_version, sourceVersion: snapshot.source_version,
    generatedAt: sourceManifest.created_at,
    source: { snapshotSha256: digest(snapshotBytes), manifestSha256: digest(manifestBytes), contentSha256: sourceManifest.content_sha256 },
  }
  return stageSchoolCandidate({ outputRoot, inputPaths: inputs, protectedRoot: repoRoot, metadata, generator,
    build: async (stage) => {
      await writeSchoolFiles(rows, stage, metadata.generatedAt, { log() {}, warn() {} })
      // Detect input/config edits while generating. Never label that mixture complete.
      const current = await Promise.all(inputs.map(async (path) => digest(await readFile(await checkedFile(path)))))
      if (current[0] !== metadata.source.snapshotSha256 || current[1] !== metadata.source.manifestSha256 ||
          (await generatorIdentity()).sha256 !== generator.sha256) throw new Error('School candidate inputs changed during generation')
    },
  })
}

export async function main(args = process.argv.slice(2)) {
  const explicitSupabase = args.includes('--school-source=supabase')
  const observedFlags = {}
  args = args.filter((arg) => {
    const match = /^--(generation-time|source-lease|candidate-revision|max-total-bytes|max-decoded-bytes)=(.+)$/.exec(arg)
    if (!match) return true
    if (Object.hasOwn(observedFlags, match[1])) throw new Error('Duplicate observed generation option')
    observedFlags[match[1]] = match[2]
    return false
  })
  const outputArgs = args.filter((arg) => arg.startsWith('--output-root='))
  if (outputArgs.length > 1) throw new Error('Only one output root is allowed')
  const options = parseSchoolSourceArgs(args.filter((arg) => !arg.startsWith('--output-root=')))
  const resourceBudget = {
    ...(observedFlags['max-total-bytes'] === undefined ? {} : { maxTotalBytes: Number(observedFlags['max-total-bytes']) }),
    ...(observedFlags['max-decoded-bytes'] === undefined ? {} : { maxDecodedBytes: Number(observedFlags['max-decoded-bytes']) }),
  }
  if (options.source === 'sqlite-snapshot') {
    if (!outputArgs.length || Object.hasOwn(observedFlags, 'source-lease')) throw new Error('SQLite snapshot generation requires isolated output and no database lease')
    const receipt = await generateObservedSchoolJSON({ ...options,
      outputRoot: outputArgs[0].slice('--output-root='.length), generatedAt: observedFlags['generation-time'],
      candidateRevision: observedFlags['candidate-revision'],
      resourceBudget })
    console.log(JSON.stringify({ status: 'generated', scope: receipt.scope, evidence: receipt.evidence,
      artifactsSha256: receipt.artifactsSha256, artifacts: receipt.artifacts.length }))
    return receipt
  }
  if (options.source === 'snapshot') {
    if (Object.keys(observedFlags).length) throw new Error('Observed options cannot relabel a synthetic snapshot')
    const outputRoot = outputArgs[0]?.slice('--output-root='.length)
    if (!outputRoot) throw new Error('Snapshot generation requires an explicit external --output-root')
    const receipt = await generateSchoolCandidate({ snapshotPath: options.snapshotPath, manifestPath: options.manifestPath, outputRoot })
    console.log(JSON.stringify({ status: 'generated', scope: receipt.scope, artifactsSha256: receipt.artifactsSha256, artifacts: receipt.artifacts.length }))
    return receipt
  }
  if (outputArgs.length) {
    if (!explicitSupabase) throw new Error('Observed generation requires explicit --school-source=supabase')
    const receipt = await generateObservedSchoolJSON({ source: 'supabase', fetchRows: ({ signal }) => fetchSupabaseRows({ signal, quiet: true }),
      outputRoot: outputArgs[0].slice('--output-root='.length), generatedAt: observedFlags['generation-time'],
      sourceLease: observedFlags['source-lease'], candidateRevision: observedFlags['candidate-revision'],
      resourceBudget })
    console.log(JSON.stringify({ status: 'generated', scope: receipt.scope, evidence: receipt.evidence,
      artifactsSha256: receipt.artifactsSha256, artifacts: receipt.artifacts.length }))
    return receipt
  }
  if (Object.keys(observedFlags).length) throw new Error('Observed generation requires an external output root')
  // Existing production generation remains explicitly selected and unchanged.
  const rows = await loadSchoolSource({ ...options, fetchSupabase: fetchSupabaseRows })
  return writeSchoolFiles(rows, join(webRoot, 'public'), new Date().toISOString())
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    // Avoid echoing input values, paths or credentials through a CLI exception stack.
    console.error('School generation failed; no completed candidate was confirmed.')
    process.exitCode = 1
  })
}
