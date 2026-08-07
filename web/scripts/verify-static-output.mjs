// 静的出力（dist/）の検証ゲート。`pnpm build` の末尾で必ず実行される。
//
// 全プリレンダー HTML（学校ページ全件 + トップ / 全域ハブ / 県ハブ / press / legal / 404）を
// ループ検査する。代表 1 校だけの検査では「一部のページだけ壊れる」事故
// （例: /search の canonical がトップを指したままリリースされた件）を検出できない。
// 検査は数千ファイルでも数秒で終わる。
//
// 禁止語検査は「ランキングサイト化しない」線をビルドで固定するためのもの
// （docs/local/plan_seo-growth-strategy.md §やらないこと）。文書ページ（/legal/* /press）は
// 方針説明のために「偏差値」等の語を正当に含むので対象外。

import { lstat, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { loadCivicData, resolveCityGroup } from './lib/municipalities.mjs'
import {
  DATASET_CLAIM,
  DATASET_LICENSE_URL,
  formatDatasetCoverage,
  isPublicSchoolRecord,
} from './lib/public-api.mjs'

const DEFAULT_MAX_FILE_MIB = 25
const SITE_ORIGIN = 'https://manabi-map.app'

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

async function collectFiles(dir, root = dir) {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`static output must not contain symbolic links: ${path}`)
    }
    if (entry.isDirectory()) files.push(...await collectFiles(path, root))
    else if (entry.isFile()) {
      const stat = await lstat(path)
      files.push({ path, relativePath: path.slice(root.length + 1).replaceAll('\\', '/'), bytes: stat.size })
    }
  }
  return files
}

function decodeSchoolsPayload(buffer) {
  const isGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
  const text = (isGzip ? gunzipSync(buffer) : buffer).toString('utf8')
  const payload = JSON.parse(text)
  const schools = Array.isArray(payload) ? payload : payload?.schools
  if (!Array.isArray(schools)) throw new Error('schools payload has an unsupported format')
  return { payload, schools, isGzip }
}

function sitemapLocations(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])
}

function extractCanonical(html) {
  return html.match(/<link rel="canonical" href="([^"]*)"/)?.[1] ?? null
}

function extractOgUrl(html) {
  return html.match(/<meta property="og:url" content="([^"]*)"/)?.[1] ?? null
}

function extractTitle(html) {
  return html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? null
}

function extractMain(html) {
  return html.match(/<main[\s\S]*?<\/main>/)?.[0] ?? null
}

function extractJsonLdBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
    (match) => JSON.parse(match[1]),
  )
}

// 一覧・ハブ・学校ページの本文（<main>）に出てはいけない語。
// ランキングサイト化の禁止線をビルドで固定する。「通学時間」は実乗換データを
// 持たないためプリレンダーに書かない（c4 C1。距離は「直線距離」と明記する）。
//
// 「偏差値」は 2026-08-07 に本リストから外した（plan_ssr-hydration.md）。
// プリレンダーが「手書きの別 HTML」から「React の実出力」に変わり、画面に出している値が
// そのまま HTML に載るようになったため、HTML 側で数値を伏せることは原理的にできない
// （伏せると hydration が食い違い、初期表示のちらつきが戻る）。
//
// 「偏差値を出さない」線は公開 API 側で守る。findDeviationLeak() が /api/v1/ の
// 全 JSON を走査し、deviation を含むキーが 1 つでもあればビルドを落とす（本ファイル 526-530 行）。
const FORBIDDEN_WORDS = ['ランキング', 'TOP', '狙い目', 'おすすめ', '通学時間']
// ガイドは「通学時間」を説明する一次目的のページなので、その語だけは対象外。
// 序列化を助長する語は、本文にも引き続き出さない。
const GUIDE_FORBIDDEN_WORDS = ['ランキング', 'TOP', '狙い目', 'おすすめ']
// /data/ と llms.txt は「偏差値を API に含めない」という除外方針を説明するため、
// 「おすすめ」等の緩い語も許可する。序列化を促す語は引き続き禁止する。
const DATASET_FORBIDDEN_WORDS = ['ランキング', 'TOP', '狙い目']
// 「◯◯市から通える」型の断定は学区データを保有するまで禁止（/pref/ 配下と全域ハブ）。
// トップ・学校ページの定型文「住所を入れると通える高校が…」はサービス説明なので対象外。
const FORBIDDEN_COMMUTE_PHRASE = 'から通える'

function checkForbiddenWords(main, pageLabel, { includeCommutePhrase, words = FORBIDDEN_WORDS }) {
  for (const word of words) {
    if (main.includes(word)) {
      throw new Error(`forbidden word "${word}" found in <main> of ${pageLabel}`)
    }
  }
  if (includeCommutePhrase && main.includes(FORBIDDEN_COMMUTE_PHRASE)) {
    throw new Error(`forbidden phrase "${FORBIDDEN_COMMUTE_PHRASE}" found in <main> of ${pageLabel}`)
  }
}

/** canonical / og:url / <main> の存在という全ページ共通の骨格を検査する。 */
function checkPageSkeleton(html, pageLabel, expectedCanonical) {
  const canonical = extractCanonical(html)
  if (canonical !== expectedCanonical) {
    throw new Error(`canonical mismatch on ${pageLabel}: expected=${expectedCanonical} actual=${canonical}`)
  }
  const ogUrl = extractOgUrl(html)
  if (ogUrl !== expectedCanonical) {
    throw new Error(`og:url mismatch on ${pageLabel}: expected=${expectedCanonical} actual=${ogUrl}`)
  }
  const main = extractMain(html)
  if (!main) throw new Error(`missing <main> content on ${pageLabel}`)
  return main
}

function checkSafeHrefAttributes(html, pageLabel) {
  for (const [, href] of html.matchAll(/\bhref="([^"]*)"/gi)) {
    if (!/^(?:https?:\/\/|\/|#|mailto:|tel:)/i.test(href)) {
      throw new Error(`unsafe href scheme on ${pageLabel}: ${href}`)
    }
  }
}

function urlHost(value, label) {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('unsupported protocol')
    return parsed.hostname.toLowerCase()
  } catch {
    throw new Error(`invalid source URL in ${label}: ${value}`)
  }
}

const FORBIDDEN_SOURCE_HOSTS = [
  /(^|\.)wikipedia\.org$/,
  /(^|\.)minkou\.jp$/,
  /(^|\.)shingakunet\.com$/,
  /(^|\.)zyuken\.net$/,
]

// URL ではなく本文に出典名が書かれていても、公開データの出典方針に反する。
// ホスト名の検査（FORBIDDEN_SOURCE_HOSTS）とは別に、すべての文字列値を走査する。
const FORBIDDEN_SOURCE_TEXT_PATTERNS = [
  { label: 'Wikipedia', pattern: /wikipedia(?:\.org)?/iu },
  { label: 'ウィキペディア', pattern: /ウィキペディア/iu },
  { label: 'みんこう', pattern: /(?:みんこう|minkou\.jp)/iu },
  { label: 'みんなの高校情報', pattern: /みんなの高校情報/iu },
  { label: 'スタディサプリ', pattern: /(?:スタディサプリ|shingakunet\.com)/iu },
  { label: '高校受験ナビ', pattern: /(?:高校受験ナビ|zyuken\.net)/iu },
]

// 私学協会・教育情報ポータル等は一次資料の発行主体でも、自治体向けの
// ed/ac/lg/go.jp suffix を持たない。任意の .or.jp / .gr.jp を広く許可せず、
// 収集時に確認した公式カタログの host だけを明示する。
const TRUSTED_OFFICIAL_SOURCE_HOSTS = new Set([
  'iwakisogo-hs.note.jp',
  'k-shigaku.com',
  'kagoshima-shigaku.com',
  'kumamoto-pref-hs.jp',
  'www.aichi-shigaku.gr.jp',
  'www.f-sigaku.com',
  'www.hyogo-shigaku.or.jp',
  'www.kagawa-shigaku.jp',
  'www.kyotoshigaku.gr.jp',
  'www.miyazaki-shigaku.jp',
  'www.nagasaki-shigaku.jp',
  'www.oitachuko.info',
  'www.osaka-shigaku.gr.jp',
  'www.saga-ed.jp',
  'www.shizuoka-shigaku.net',
])

function isInstitutionalHost(host) {
  return (
    /\.(?:ed|ac|lg|go)\.jp$/.test(host) ||
    /(^|\.)pref\.[a-z0-9-]+\.jp$/.test(host) ||
    /(^|\.)city(?:[.-])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.jp$/.test(host) ||
    TRUSTED_OFFICIAL_SOURCE_HOSTS.has(host)
  )
}

function collectOfficialUrls(value, urls = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectOfficialUrls(item, urls)
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'official_url' || key === 'status_official_url') urls.push(item)
      collectOfficialUrls(item, urls)
    }
  }
  return urls
}

function findDeviationLeak(value, path = '$') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const leak = findDeviationLeak(value[index], `${path}[${index}]`)
      if (leak) return leak
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  for (const [key, item] of Object.entries(value)) {
    if (/deviation/i.test(key)) return `${path}.${key}`
    const leak = findDeviationLeak(item, `${path}.${key}`)
    if (leak) return leak
  }
  return null
}

function findForbiddenSourceMention(value, path = '$') {
  if (typeof value === 'string') {
    const match = FORBIDDEN_SOURCE_TEXT_PATTERNS.find(({ pattern }) => pattern.test(value))
    return match ? { label: match.label, path } : null
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const leak = findForbiddenSourceMention(value[index], `${path}[${index}]`)
      if (leak) return leak
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  for (const [key, item] of Object.entries(value)) {
    const leak = findForbiddenSourceMention(item, `${path}.${key}`)
    if (leak) return leak
  }
  return null
}

async function readPage(absoluteDist, relativePath, label) {
  const path = join(absoluteDist, relativePath)
  let stat
  try {
    stat = await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`prerendered page is missing: ${label} (${relativePath})`)
    throw error
  }
  if (!stat.isFile()) throw new Error(`prerendered page is not a regular file: ${label}`)
  return readFile(path, 'utf8')
}

export async function verifyStaticOutput({
  distDir,
  maxFileBytes = DEFAULT_MAX_FILE_MIB * 1024 * 1024,
} = {}) {
  if (!distDir) throw new Error('distDir is required')
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new Error('maxFileBytes must be a positive safe integer')
  }

  const absoluteDist = resolve(distDir)
  const files = await collectFiles(absoluteDist)
  if (files.length === 0) throw new Error(`static output is empty: ${absoluteDist}`)
  const largest = files.reduce((current, file) => file.bytes > current.bytes ? file : current)
  const oversized = files.filter((file) => file.bytes >= maxFileBytes)
  if (oversized.length > 0) {
    throw new Error(
      `static file must be smaller than ${maxFileBytes} bytes: ` +
      oversized.map((file) => `${file.relativePath}=${file.bytes}`).join(', '),
    )
  }

  const manifest = JSON.parse(await readFile(join(absoluteDist, 'schools-manifest.json'), 'utf8'))
  if (!Number.isInteger(manifest.count) || manifest.count < 0) {
    throw new Error('schools-manifest.json count is invalid')
  }
  if (typeof manifest.url !== 'string' || !/^\/schools(?:-[0-9a-f]+)?\.json(?:\.gz)?$/i.test(manifest.url)) {
    throw new Error('schools-manifest.json url is invalid')
  }
  // 統合検索の軽量索引（市区町村・校名）。manifest から実体まで辿れることを保証する。
  if (typeof manifest.cityIndexUrl !== 'string' || !/^\/city-index-[0-9a-f]+\.json$/i.test(manifest.cityIndexUrl)) {
    throw new Error('schools-manifest.json cityIndexUrl is invalid')
  }
  if (typeof manifest.nameIndexUrl !== 'string' || !/^\/school-name-index-[0-9a-f]+\.json$/i.test(manifest.nameIndexUrl)) {
    throw new Error('schools-manifest.json nameIndexUrl is invalid')
  }
  // 学校単体 JSON / 県別分割 JSON（c7 C1）。固定パス + `?v=` バストの前提となる
  // schoolDataVersion と、単体 JSON の枚数・県別台帳を manifest で保証する。
  if (typeof manifest.schoolDataVersion !== 'string' || !/^[0-9a-f]{6,64}$/i.test(manifest.schoolDataVersion)) {
    throw new Error('schools-manifest.json schoolDataVersion is invalid')
  }
  if (!Number.isInteger(manifest.schoolDataCount) || manifest.schoolDataCount < 0) {
    throw new Error('schools-manifest.json schoolDataCount is invalid')
  }
  if (manifest.prefDataUrls == null || typeof manifest.prefDataUrls !== 'object') {
    throw new Error('schools-manifest.json prefDataUrls is invalid')
  }
  const cityIndex = JSON.parse(await readFile(join(absoluteDist, manifest.cityIndexUrl.slice(1)), 'utf8'))
  if (!Array.isArray(cityIndex)) throw new Error('city index payload is not an array')
  const nameIndex = JSON.parse(await readFile(join(absoluteDist, manifest.nameIndexUrl.slice(1)), 'utf8'))
  if (!Array.isArray(nameIndex) || nameIndex.length !== manifest.count) {
    throw new Error(`name index count mismatch: manifest=${manifest.count} payload=${nameIndex?.length}`)
  }

  const schoolsPath = join(absoluteDist, manifest.url.slice(1))
  const { schools, isGzip } = decodeSchoolsPayload(await readFile(schoolsPath))
  if (schools.length !== manifest.count) {
    throw new Error(`manifest count mismatch: manifest=${manifest.count} payload=${schools.length}`)
  }
  if (manifest.compression === 'gzip' && !isGzip) {
    throw new Error('manifest declares gzip but payload does not have gzip magic bytes')
  }

  // gen-seo-pages.mjs が og:description の収録範囲を差し替え損ねると、
  // 本番の OGP カードにプレースホルダがそのまま出る。dist 全体で 0 件であることを保証する。
  const topHtml = await readFile(join(absoluteDist, 'index.html'), 'utf8')
  if (topHtml.includes('__COVERAGE__')) {
    throw new Error('dist/index.html に未置換の __COVERAGE__ が残っている（gen-seo-pages が走っていない可能性）')
  }

  const targets = schools.filter((school) => school?.latitude != null && school?.longitude != null)

  // 県ハブは prefectures.json（総務省コード表由来）とデータの突き合わせで決まる。
  const { prefectures, muniByPref } = await loadCivicData(join(dirname(fileURLToPath(import.meta.url)), '..'))
  const activePrefectures = prefectures.filter((p) => targets.some((s) => s.prefecture === p.name))

  const LEGAL_DOCS = ['terms', 'privacy', 'third-party', 'deviation-methodology']
  const GUIDE_SLUGS = ['commute-time', 'school-visit', 'deviation-with-care']
  const staticRoutes = [
    '/schools/',
    ...activePrefectures.map((p) => `/pref/${p.slug}/`),
    '/data/',
    '/press/',
    ...LEGAL_DOCS.map((doc) => `/legal/${doc}/`),
    ...GUIDE_SLUGS.map((slug) => `/guide/${slug}/`),
  ]

  const expectedLocations = new Set([
    `${SITE_ORIGIN}/`,
    ...staticRoutes.map((path) => `${SITE_ORIGIN}${path}`),
    ...targets.map((school) => `${SITE_ORIGIN}/school/${school.id}/`),
  ])
  const locations = sitemapLocations(await readFile(join(absoluteDist, 'sitemap.xml'), 'utf8'))
  const actualLocations = new Set(locations)
  if (actualLocations.size !== locations.length) {
    throw new Error(`sitemap contains duplicate URLs: entries=${locations.length} unique=${actualLocations.size}`)
  }
  if (
    actualLocations.size !== expectedLocations.size ||
    [...actualLocations].some((url) => !expectedLocations.has(url)) ||
    [...expectedLocations].some((url) => !actualLocations.has(url))
  ) {
    throw new Error(`sitemap mismatch: expected=${expectedLocations.size} actual=${actualLocations.size}`)
  }

  const schoolRoot = join(absoluteDist, 'school')
  const generatedIds = new Set(await readdir(schoolRoot))
  if (generatedIds.size !== targets.length || targets.some((school) => !generatedIds.has(String(school.id)))) {
    throw new Error(`SEO school page count mismatch: expected=${targets.length} actual=${generatedIds.size}`)
  }

  // 近隣校リストの最低リンク数。過疎地フォールバック（c4 C1）で最低 3 校出るが、
  // 収録校数がそれ未満のとき（テスト fixture 等）は「他の全校」が下限。
  const minNeighborLinks = Math.min(3, targets.length - 1)

  // --- 学校単体 JSON / 県別分割 JSON（c7 C1） ---
  // 学校詳細ページの初期描画が依存する単体 JSON が、個別ページと同じ集合で
  // 1 枚残らず存在し、自校 + 近隣校 + 出典 catalog を持つことを保証する。
  const schoolDataRoot = join(absoluteDist, 'school-data')
  let schoolDataNames
  try {
    schoolDataNames = await readdir(schoolDataRoot)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('school-data directory is missing in static output')
    throw error
  }
  const perSchoolFiles = schoolDataNames.filter((name) => !name.startsWith('pref-'))
  if (perSchoolFiles.length !== targets.length || manifest.schoolDataCount !== targets.length) {
    throw new Error(
      `school-data count mismatch: files=${perSchoolFiles.length} ` +
      `manifest=${manifest.schoolDataCount} expected=${targets.length}`,
    )
  }
  for (const target of targets) {
    let singleText
    try {
      singleText = await readFile(join(schoolDataRoot, `${target.id}.json`), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`school-data JSON is missing: /school-data/${target.id}.json`)
      }
      throw error
    }
    const single = JSON.parse(singleText)
    if (!Array.isArray(single?.schools) || single.schools.length !== 1 || single.schools[0]?.id !== target.id) {
      throw new Error(`school-data JSON does not contain the school itself: /school-data/${target.id}.json`)
    }
    if (!Array.isArray(single.sourceCatalog)) {
      throw new Error(`school-data JSON has no sourceCatalog: /school-data/${target.id}.json`)
    }
    if (!Array.isArray(single.neighbors) || single.neighbors.length < minNeighborLinks) {
      throw new Error(`school-data JSON has too few neighbors: /school-data/${target.id}.json`)
    }
  }
  // 県別分割: 全県ぶん存在し、合計が全件 JSON と一致する（分割の取りこぼし検出）。
  let prefRowTotal = 0
  for (const pref of activePrefectures) {
    const prefUrl = manifest.prefDataUrls[pref.slug]
    if (prefUrl !== `/school-data/pref-${pref.slug}.json`) {
      throw new Error(`schools-manifest.json prefDataUrls is wrong for ${pref.slug}: ${prefUrl}`)
    }
    const prefPayload = JSON.parse(
      await readFile(join(schoolDataRoot, `pref-${pref.slug}.json`), 'utf8'),
    )
    const expectedPrefCount = schools.filter((school) => school.prefecture === pref.name).length
    if (!Array.isArray(prefPayload?.schools) || prefPayload.schools.length !== expectedPrefCount) {
      throw new Error(
        `pref split count mismatch on ${pref.slug}: ` +
        `expected=${expectedPrefCount} actual=${prefPayload?.schools?.length}`,
      )
    }
    prefRowTotal += prefPayload.schools.length
  }
  if (prefRowTotal !== schools.length) {
    throw new Error(`pref split total mismatch: prefTotal=${prefRowTotal} schools=${schools.length}`)
  }

  // 県ページ用軽量インデックス（SSR 埋め込み用・短縮キー）。
  // 件数は lat/lng ありの校（地図・詳細ページと同じ集合）と一致させる。
  if (!manifest.prefIndexUrls || typeof manifest.prefIndexUrls !== 'object') {
    throw new Error('schools-manifest.json is missing prefIndexUrls')
  }
  for (const pref of activePrefectures) {
    const prefIndexUrl = manifest.prefIndexUrls[pref.slug]
    if (prefIndexUrl !== `/school-data/pref-index-${pref.slug}.json`) {
      throw new Error(`schools-manifest.json prefIndexUrls is wrong for ${pref.slug}: ${prefIndexUrl}`)
    }
    const prefIndex = JSON.parse(
      await readFile(join(schoolDataRoot, `pref-index-${pref.slug}.json`), 'utf8'),
    )
    const expectedTargets = schools.filter(
      (school) =>
        school.prefecture === pref.name && school.latitude != null && school.longitude != null,
    ).length
    if (
      prefIndex?.slug !== pref.slug ||
      !Array.isArray(prefIndex.cities) ||
      !Array.isArray(prefIndex.schools) ||
      prefIndex.schools.length !== expectedTargets
    ) {
      throw new Error(
        `pref-index mismatch on ${pref.slug}: ` +
        `expected=${expectedTargets} actual=${prefIndex?.schools?.length}`,
      )
    }
    // 短縮キーが崩れて HTML が肥大しないよう、少なくとも 1 校は i/n 形であること
    if (prefIndex.schools.length > 0) {
      const sample = prefIndex.schools[0]
      if (typeof sample?.i !== 'string' || typeof sample?.n !== 'string') {
        throw new Error(`pref-index ${pref.slug} is not using compact keys (expected i/n)`)
      }
    }
  }

  // NULL 自体は段階的な収集を妨げないが、公開 API の対象外になるため見逃さない。
  const officialUrlGaps = schools.filter((school) => school.is_active !== false && !school.official_url)
  if (officialUrlGaps.length > 0) {
    const byPrefecture = Object.entries(Object.groupBy(officialUrlGaps, (school) => school.prefecture))
      .map(([prefecture, rows]) => `${prefecture}:${rows.length}`)
      .join('、')
    console.warn(
      `[official_url] static output に未登録の現行校が ${officialUrlGaps.length}/${schools.length} 校あります` +
      `（${byPrefecture}）。公開 API からは除外されます。`,
    )
  }

  // --- 出典追跡可能な公開 API（plan_public-api-readiness C3/C4） ---
  const apiRoot = join(absoluteDist, 'api', 'v1')
  const datasetMetadata = JSON.parse(await readFile(join(apiRoot, 'dataset.json'), 'utf8'))
  const publicPayload = JSON.parse(await readFile(join(apiRoot, 'schools.json'), 'utf8'))
  if (!Array.isArray(publicPayload?.schools) || publicPayload.count !== publicPayload.schools.length) {
    throw new Error('/api/v1/schools.json count is invalid')
  }
  if (
    datasetMetadata.school_count !== publicPayload.schools.length ||
    datasetMetadata.provenance_policy !== DATASET_CLAIM ||
    datasetMetadata.license_url !== DATASET_LICENSE_URL
  ) {
    throw new Error('/api/v1/dataset.json metadata does not match the public payload contract')
  }

  const publicIds = new Set()
  const registeredOfficialHosts = new Set()
  for (const record of publicPayload.schools) {
    if (!record?.id || publicIds.has(record.id)) throw new Error(`duplicate or missing public school id: ${record?.id}`)
    publicIds.add(record.id)
    if (!record.official_url || record.provenance?.official_url !== record.official_url) {
      throw new Error(`public API record is missing official_url or provenance: ${record.id}`)
    }
    registeredOfficialHosts.add(urlHost(record.official_url, `school:${record.id}`))
    if (record.provenance?.last_built_at !== publicPayload.generated_at) {
      throw new Error(`public API record has inconsistent build provenance: ${record.id}`)
    }
    for (const unit of record.admission_recruitment_units ?? []) {
      for (const stat of unit.statistics ?? []) {
        if (!Array.isArray(stat.sources) || stat.sources.length === 0) {
          throw new Error(`public admission statistic is missing sources: ${record.id}`)
        }
        for (const metric of ['capacity', 'applicants', 'examinees', 'admitted']) {
          if (
            stat[metric] != null &&
            !stat.sources.some((source) => source?.fact_kind_code === metric && source?.official_url)
          ) {
            throw new Error(`public admission metric is missing its source: ${record.id}/${metric}`)
          }
        }
      }
    }
  }

  // 生成側と同じ唯一のゲートを再利用し、対象校の欠落・余分な混入の両方を防ぐ。
  // public payload だけの自己整合では、全件 JSON と県別 JSON から同じ学校を
  // 丸ごと落とした場合に検知できないため、アプリ用の元 payload と突き合わせる。
  const expectedPublicIds = new Set(schools.filter(isPublicSchoolRecord).map((school) => school.id))
  if (
    expectedPublicIds.size !== publicIds.size ||
    [...expectedPublicIds].some((id) => !publicIds.has(id)) ||
    [...publicIds].some((id) => !expectedPublicIds.has(id))
  ) {
    throw new Error(
      `public API inclusion gate mismatch: expected=${expectedPublicIds.size} actual=${publicIds.size}`,
    )
  }

  const apiJsonFiles = files.filter(
    (file) => file.relativePath.startsWith('api/v1/') && file.relativePath.endsWith('.json'),
  )
  const expectedPrefApiSlugs = new Set(
    prefectures
      .filter((prefecture) =>
        schools.some(
          (school) => school.is_active !== false && school.prefecture === prefecture.name,
        ),
      )
      .map((prefecture) => prefecture.slug),
  )
  const actualPrefApiSlugs = new Set(
    apiJsonFiles
      .map((file) => file.relativePath.match(/^api\/v1\/schools\/([^/]+)\.json$/)?.[1])
      .filter(Boolean),
  )
  const missingPrefApiSlugs = [...expectedPrefApiSlugs].filter(
    (slug) => !actualPrefApiSlugs.has(slug),
  )
  if (missingPrefApiSlugs.length > 0) {
    throw new Error(
      `public prefecture API is missing source prefectures: ${missingPrefApiSlugs.join(', ')}`,
    )
  }
  if (apiJsonFiles.length < 3) throw new Error('/api/v1/ static JSON files are missing')
  for (const file of apiJsonFiles) {
    const value = JSON.parse(await readFile(file.path, 'utf8'))
    const leakPath = findDeviationLeak(value)
    if (leakPath) throw new Error(`deviation data found in ${file.relativePath} at ${leakPath}`)
    for (const sourceUrl of collectOfficialUrls(value)) {
      const host = urlHost(sourceUrl, file.relativePath)
      if (FORBIDDEN_SOURCE_HOSTS.some((pattern) => pattern.test(host))) {
        throw new Error(`forbidden source domain in ${file.relativePath}: ${host}`)
      }
      if (!isInstitutionalHost(host) && !registeredOfficialHosts.has(host)) {
        throw new Error(`unregistered source domain in ${file.relativePath}: ${host}`)
      }
    }
    const sourceMention = findForbiddenSourceMention(value)
    if (sourceMention) {
      throw new Error(
        `forbidden source mention "${sourceMention.label}" in ${file.relativePath} at ${sourceMention.path}`,
      )
    }
  }

  const prefApiFiles = apiJsonFiles.filter((file) => /^api\/v1\/schools\/[^/]+\.json$/.test(file.relativePath))
  let publicPrefTotal = 0
  const publicPrefIds = new Set()
  const actualPrefCounts = {}
  for (const file of prefApiFiles) {
    const value = JSON.parse(await readFile(file.path, 'utf8'))
    if (!Array.isArray(value?.schools) || value.count !== value.schools.length) {
      throw new Error(`public prefecture API count is invalid: ${file.relativePath}`)
    }
    if (value.api_version !== publicPayload.api_version || value.generated_at !== publicPayload.generated_at) {
      throw new Error(`public prefecture API version or generated_at mismatch: ${file.relativePath}`)
    }
    const slug = file.relativePath.match(/^api\/v1\/schools\/([^/]+)\.json$/)?.[1]
    actualPrefCounts[slug] = value.count
    if (value.schools.some((record) => record.prefecture !== value.prefecture)) {
      throw new Error(`public prefecture API contains another prefecture: ${file.relativePath}`)
    }
    publicPrefTotal += value.schools.length
    for (const record of value.schools) {
      if (publicPrefIds.has(record.id)) throw new Error(`duplicate school across prefecture APIs: ${record.id}`)
      publicPrefIds.add(record.id)
    }
  }
  if (
    publicPrefTotal !== publicPayload.schools.length ||
    publicPrefIds.size !== publicIds.size ||
    [...publicIds].some((id) => !publicPrefIds.has(id))
  ) {
    throw new Error(`public prefecture API total mismatch: pref=${publicPrefTotal} all=${publicPayload.schools.length}`)
  }
  if (
    datasetMetadata.api_version !== publicPayload.api_version ||
    datasetMetadata.generated_at !== publicPayload.generated_at ||
    datasetMetadata.prefecture_count !== prefApiFiles.length ||
    !datasetMetadata.prefectures ||
    Object.keys(datasetMetadata.prefectures).length !== Object.keys(actualPrefCounts).length ||
    Object.entries(actualPrefCounts).some(
      ([slug, count]) => datasetMetadata.prefectures[slug] !== count,
    )
  ) {
    throw new Error('/api/v1/dataset.json prefecture metadata does not match the public API files')
  }

  // --- 学校ページ全件検査 ---
  let neighborLinkTotal = 0
  for (const target of targets) {
    const html = await readPage(absoluteDist, join('school', String(target.id), 'index.html'), `school:${target.id}`)
    const pageLabel = `/school/${target.id}/`
    const main = checkPageSkeleton(html, pageLabel, `${SITE_ORIGIN}/school/${target.id}/`)
    checkSafeHrefAttributes(main, pageLabel)
    const escapedName = escapeHtml(target.name)
    const title = extractTitle(html)
    if (!title || !title.includes(escapedName)) {
      throw new Error(`title is missing school name on ${pageLabel}: ${title}`)
    }
    // h1 は React の実出力（<h1 class="detail-title">校名（県共：58〜62）</h1>）なので、
    // タグの完全一致ではなく「h1 があり、その中に校名が入っている」で判定する
    // （plan_ssr-hydration.md でプリレンダーを手書き HTML から React 出力へ切り替えた）。
    const h1 = main.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)
    if (!h1 || !h1[1].includes(escapedName)) {
      throw new Error(`missing <h1> school heading on ${pageLabel}`)
    }
    const jsonLdBlocks = extractJsonLdBlocks(html)
    const schoolJsonLd = jsonLdBlocks.find((block) => block?.name === target.name)
    if (!schoolJsonLd) {
      throw new Error(`JSON-LD with school name is missing or unparsable on ${pageLabel}`)
    }
    if (schoolJsonLd.license !== DATASET_LICENSE_URL || typeof schoolJsonLd.creditText !== 'string') {
      throw new Error(`school JSON-LD is missing license or creditText on ${pageLabel}`)
    }
    // BreadcrumbList（UUID URL の検索結果表示の救済・c7 C4）: ホーム › 県 ›（市区町村）› 校名。
    const breadcrumb = jsonLdBlocks.find((block) => block?.['@type'] === 'BreadcrumbList')
    const cityGroup = resolveCityGroup(target, muniByPref)
    const expectedBreadcrumbLength = cityGroup ? 4 : 3
    if (
      !breadcrumb ||
      !Array.isArray(breadcrumb.itemListElement) ||
      breadcrumb.itemListElement.length !== expectedBreadcrumbLength
    ) {
      throw new Error(
        `BreadcrumbList JSON-LD is missing or too short (expected ${expectedBreadcrumbLength} items) on ${pageLabel}`,
      )
    }
    const breadcrumbLast = breadcrumb.itemListElement[breadcrumb.itemListElement.length - 1]
    if (breadcrumbLast?.name !== target.name) {
      throw new Error(`BreadcrumbList last item must be the school name on ${pageLabel}`)
    }
    checkForbiddenWords(main, pageLabel, { includeCommutePhrase: false })
    // 近隣校節（内部リンク網の本体・c4 C1）: 見出しと「直線距離」の明記、
    // 自分以外の学校ページへの最低リンク数を全件で保証する。
    // 見出しは React の実出力（<h4>📍 近くにある高校</h4>）。旧手書き HTML は
    // 「<校名>の近くにある高校」だったが、シート内では校名が直上にあるため繰り返さない。
    if (!main.includes('近くにある高校')) {
      throw new Error(`missing neighbor section heading on ${pageLabel}`)
    }
    if (!main.includes('直線距離')) {
      throw new Error(`neighbor section must state 直線距離 on ${pageLabel}`)
    }
    const schoolLinks = new Set(
      [...main.matchAll(/href="\/school\/([^"]+)\/"/g)]
        .map((match) => match[1])
        .filter((id) => id !== String(target.id)),
    )
    if (schoolLinks.size < minNeighborLinks) {
      throw new Error(
        `too few school links on ${pageLabel}: expected>=${minNeighborLinks} actual=${schoolLinks.size}`,
      )
    }
    neighborLinkTotal += schoolLinks.size
    // 選抜実績の年度表を出すページには公式出典が必須（c4 C3 完了条件）。
    if (main.includes('年度別志願状況')) {
      // React の実出力は <div class="admission-sources"> の中に出典リストを持つ
      // （SchoolDetailSheet.tsx の admission-sources ブロック）。
      // 旧手書き HTML の <p>出典: …</p> 形式ではない。
      const sourceBlock = main.match(/<div class="admission-sources">[\s\S]*?<\/div>/i)?.[0] ?? ''
      if (!/<a\b[^>]*\bhref="https?:\/\/[^" ]+/i.test(sourceBlock)) {
        throw new Error(`admission table without 出典 URL on ${pageLabel}`)
      }
    }
  }

  // --- トップ ---
  {
    const main = checkPageSkeleton(topHtml, '/', `${SITE_ORIGIN}/`)
    if (!/<h1[\s>]/.test(main)) throw new Error('missing <h1> on /')
    checkForbiddenWords(main, '/', { includeCommutePhrase: false })
    for (const pref of activePrefectures) {
      if (!main.includes(`href="/pref/${pref.slug}/"`)) {
        throw new Error(`top page is missing crawl link to /pref/${pref.slug}/`)
      }
    }
    // WebSite（テンプレート由来）+ Organization（gen-seo-pages 注入・/press と @id で同一実体）。
    const topJsonLd = extractJsonLdBlocks(topHtml)
    if (!topJsonLd.some((block) => block?.['@type'] === 'WebSite')) {
      throw new Error('top page is missing WebSite JSON-LD')
    }
    if (!topJsonLd.some((block) => block?.['@type'] === 'Organization')) {
      throw new Error('top page is missing Organization JSON-LD')
    }
  }

  // --- 全域ハブ / 県ハブ ---
  {
    const html = await readPage(absoluteDist, join('schools', 'index.html'), '/schools/')
    const main = checkPageSkeleton(html, '/schools/', `${SITE_ORIGIN}/schools/`)
    if (!/<h1[\s>]/.test(main)) throw new Error('missing <h1> on /schools/')
    checkForbiddenWords(main, '/schools/', { includeCommutePhrase: true })
    for (const pref of activePrefectures) {
      if (!main.includes(`href="/pref/${pref.slug}/"`)) {
        throw new Error(`/schools/ is missing link to /pref/${pref.slug}/`)
      }
    }
  }
  for (const pref of activePrefectures) {
    const html = await readPage(absoluteDist, join('pref', pref.slug, 'index.html'), `/pref/${pref.slug}/`)
    const pageLabel = `/pref/${pref.slug}/`
    const main = checkPageSkeleton(html, pageLabel, `${SITE_ORIGIN}/pref/${pref.slug}/`)
    // SSR 後は class 付き h1 になるため、完全一致ではなく「h1 があり県名が入る」で見る
    // （plan_ssr-hydration_c3_initial-data.md 手順 6）。
    if (!/<h1[\s>]/.test(main) || !main.includes(escapeHtml(pref.name))) {
      throw new Error(`missing <h1> with prefecture name on ${pageLabel}`)
    }
    checkForbiddenWords(main, pageLabel, { includeCommutePhrase: true })
    // 県内全校へのリンクが 1 校残らず載っていること（内部リンク経路の本体）。
    for (const school of targets) {
      if (school.prefecture !== pref.name) continue
      if (!main.includes(`href="/school/${school.id}/"`)) {
        throw new Error(`${pageLabel} is missing link to /school/${school.id}/`)
      }
    }
    // ジャンプリンク（#市区町村）の先に対応する id があること。
    for (const anchorMatch of main.matchAll(/href="#([^"]+)"/g)) {
      const id = decodeURIComponent(anchorMatch[1])
      if (!main.includes(`id="${escapeHtml(id)}"`)) {
        throw new Error(`${pageLabel} has jump link to missing section: #${id}`)
      }
    }
  }

  // --- /data/・/press・/legal/* ---
  {
    const html = await readPage(absoluteDist, join('data', 'index.html'), '/data/')
    const main = checkPageSkeleton(html, '/data/', `${SITE_ORIGIN}/data/`)
    if (!/<h1[\s>]/.test(main)) throw new Error('missing <h1> on /data/')
    checkSafeHrefAttributes(main, '/data/')
    checkForbiddenWords(main, '/data/', { includeCommutePhrase: false, words: DATASET_FORBIDDEN_WORDS })
    if (!main.includes(DATASET_CLAIM)) throw new Error('/data/ is missing the approved dataset claim')
    const expectedCoverage = formatDatasetCoverage(
      datasetMetadata.prefecture_count,
      datasetMetadata.school_count,
      prefectures.length,
    )
    if (datasetMetadata.prefecture_count !== prefectures.length && main.includes('全国')) {
      throw new Error('/data/ must not claim nationwide coverage for a partial-prefecture dataset')
    }
    if (!main.includes(expectedCoverage)) {
      throw new Error(`/data/ is missing dataset coverage: ${expectedCoverage}`)
    }
    const datasetLd = extractJsonLdBlocks(html).find((block) => block?.['@type'] === 'Dataset')
    if (
      !datasetLd ||
      datasetLd.license !== DATASET_LICENSE_URL ||
      !Array.isArray(datasetLd.distribution) ||
      !datasetLd.distribution.some(
        (item) => item?.['@type'] === 'DataDownload' && item.contentUrl === `${SITE_ORIGIN}/api/v1/schools.json`,
      )
    ) {
      throw new Error('/data/ is missing required Dataset JSON-LD')
    }
  }
  {
    const html = await readPage(absoluteDist, join('press', 'index.html'), '/press/')
    const main = checkPageSkeleton(html, '/press/', `${SITE_ORIGIN}/press/`)
    if (!/<h1[\s>]/.test(main)) throw new Error('missing <h1> on /press/')
    if (!main.includes(DATASET_CLAIM)) throw new Error('/press/ is missing the approved dataset claim')
    const jsonLdBlocks = extractJsonLdBlocks(html)
    if (!jsonLdBlocks.some((block) => block?.['@type'] === 'Organization')) {
      throw new Error('/press/ is missing Organization JSON-LD')
    }
  }
  for (const doc of LEGAL_DOCS) {
    const html = await readPage(absoluteDist, join('legal', doc, 'index.html'), `/legal/${doc}/`)
    const main = checkPageSkeleton(html, `/legal/${doc}/`, `${SITE_ORIGIN}/legal/${doc}/`)
    if (!/<h1[\s>]/.test(main)) throw new Error(`missing <h1> on /legal/${doc}/`)
  }
  for (const slug of GUIDE_SLUGS) {
    const html = await readPage(absoluteDist, join('guide', slug, 'index.html'), `/guide/${slug}/`)
    const pageLabel = `/guide/${slug}/`
    const main = checkPageSkeleton(html, pageLabel, `${SITE_ORIGIN}${pageLabel}`)
    if (!/<h1[\s>]/.test(main)) throw new Error(`missing <h1> on ${pageLabel}`)
    checkForbiddenWords(main, pageLabel, { includeCommutePhrase: false, words: GUIDE_FORBIDDEN_WORDS })
  }

  // llms.txt は AI 向けの入口。必須のライセンス・公式 URL を持ち、序列化語を含まない。
  const llms = await readFile(join(absoluteDist, 'llms.txt'), 'utf8')
  if (!llms.includes('CC BY-SA') || !llms.includes('manabi-map.app')) {
    throw new Error('llms.txt is missing required license or official URL')
  }
  if (
    !llms.includes(DATASET_CLAIM) ||
    !llms.includes(`${SITE_ORIGIN}/data/`) ||
    !llms.includes(`${SITE_ORIGIN}/api/v1/schools.json`)
  ) {
    throw new Error('llms.txt is missing dataset claim or public API URLs')
  }
  for (const word of DATASET_FORBIDDEN_WORDS) {
    if (llms.includes(word)) throw new Error(`forbidden word "${word}" found in llms.txt`)
  }

  // --- 404.html（ソフト 404 対策の実体） ---
  {
    const html = await readPage(absoluteDist, '404.html', '/404.html')
    if (extractCanonical(html) != null) {
      throw new Error('404.html must not declare a canonical URL')
    }
    if (!html.includes('<meta name="robots" content="noindex"')) {
      throw new Error('404.html must declare noindex')
    }
    if (!extractMain(html)) throw new Error('missing <main> content on 404.html')
  }

  return {
    fileCount: files.length,
    largestFile: largest.relativePath,
    largestFileBytes: largest.bytes,
    schoolCount: schools.length,
    seoSchoolCount: targets.length,
    prefPageCount: activePrefectures.length,
    staticRouteCount: staticRoutes.length + 1,
    sitemapUrlCount: locations.length,
    sitemapUniqueUrlCount: actualLocations.size,
    schoolsPayloadGzip: isGzip,
    neighborLinkTotal,
    schoolDataCount: perSchoolFiles.length,
    prefDataCount: activePrefectures.length,
    publicApiSchoolCount: publicPayload.schools.length,
    publicApiPrefCount: prefApiFiles.length,
  }
}

function parseArgs(argv) {
  const here = dirname(fileURLToPath(import.meta.url))
  const args = { distDir: join(here, '..', 'dist'), maxFileBytes: DEFAULT_MAX_FILE_MIB * 1024 * 1024 }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dist') args.distDir = argv[++i]
    else if (argv[i] === '--max-file-mib') {
      const mib = Number(argv[++i])
      if (!Number.isFinite(mib) || mib <= 0) throw new Error('--max-file-mib must be positive')
      args.maxFileBytes = Math.floor(mib * 1024 * 1024)
    } else throw new Error(`unknown argument: ${argv[i]}`)
  }
  return args
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = await verifyStaticOutput(parseArgs(process.argv.slice(2)))
  console.log(
    `static output verified: files=${result.fileCount} schools=${result.schoolCount} ` +
    `seo=${result.seoSchoolCount} prefHubs=${result.prefPageCount} static=${result.staticRouteCount} ` +
      `sitemap=${result.sitemapUrlCount} neighborLinks=${result.neighborLinkTotal} ` +
      `schoolData=${result.schoolDataCount} prefData=${result.prefDataCount} ` +
      `publicApi=${result.publicApiSchoolCount}/${result.publicApiPrefCount} ` +
      `largest=${result.largestFile} (${result.largestFileBytes} bytes) ` +
    `gzip=${result.schoolsPayloadGzip}`,
  )
}
