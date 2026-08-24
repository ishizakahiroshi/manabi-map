// ビルド後に実行する SEO ページ生成スクリプト。
//
//   node scripts/gen-seo-pages.mjs [--dist <dir>]
//
// dist/index.html をテンプレートに、以下を生成する:
//   - dist/school/<id>/index.html（全校分。固有 title / description / OGP / canonical /
//     JSON-LD / 静的コンテンツ）
//   - dist/schools/index.html（全域ハブ）と dist/pref/<slug>/index.html（都道府県ハブ）
//     … トップ → 県 → 学校の 2 ホップのクロール経路（plan_seo-growth-strategy_c5 C3）
//   - dist/press/index.html（Organization JSON-LD 付き）と dist/legal/*/index.html
//     … E-E-A-T シグナルの機械可読化（同 C2。GPTBot / ClaudeBot は JS を実行しない）
//   - dist/404.html … ソフト 404 の解消（同 C4。Cloudflare Pages が 404 時に自動で使う）
//   - dist/sitemap.xml
// トップの dist/index.html にも「一覧から探す」リンクとフッターの静的ブロックを注入する。
// Cloudflare Pages は静的ファイルを _redirects の SPA fallback より優先して配信する。
//
// 注意: §7.7 表示規約により、偏差値はプリレンダー内容に一切含めない。
// 偏差値順・倍率順の一覧も作らない（ランキングサイト化の禁止線・
// docs/local/plan_seo-growth-strategy.md §やらないこと）。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import {
  buildCityCounts,
  cityPagePath,
  loadCivicData,
  resolveCityGroup,
} from './lib/municipalities.mjs'
import {
  DATASET_ATTRIBUTION,
  DATASET_CLAIM,
  DATASET_LICENSE_URL,
  formatDatasetCoverage,
} from './lib/public-api.mjs'
import { cityPageDescription } from './lib/city-breakdown.mjs'
// 近隣校の選定・距離計算と選抜実績の集計・後継校の逆引きは React 側と同一実装を共有する
// （tsx 経由で .ts を直 import（package.json の scripts が tsx で起動する。Node の type stripping には依存しない — Cloudflare Pages のビルドイメージは pnpm 同梱の preinstall Node しか使えないため）。フォーク禁止 —
// 静的 HTML と JS mount 後で校名・距離・倍率が食い違う事故を防ぐ。
// docs/local/plan_seo-growth-strategy_c4 C1 / C3）。
import { selectNeighbors, neighborPlaceLabel } from '../src/lib/neighbors.ts'
import { flattenRecruitmentUnits } from '../src/lib/admissionUnits.ts'
import { primaryAdmissionTrend } from '../src/lib/admission.ts'
import { successorsByPredecessorId } from '../src/lib/successors.ts'
import { GUIDES } from '../src/lib/guides.ts'

// ビルド時プリレンダー本体（plan_ssr-hydration.md）。React の実出力をそのまま #root へ入れ、
// ブラウザ側は hydrateRoot で引き継ぐ。dist-ssr は package.json の build:ssr が作る。
// src/entry-server.tsx を tsx で直 import しないのは、src/lib/supabase.ts の
// import.meta.env が Vite のビルドを通らないと解決できないため。
const ssrEntryUrl = new URL('../dist-ssr/entry-server.js', import.meta.url)
let renderApp
try {
  ;({ render: renderApp } = await import(ssrEntryUrl.href))
} catch (cause) {
  throw new Error(
    'dist-ssr/entry-server.js を読み込めませんでした。先に `pnpm build:ssr` を実行してください。',
    { cause },
  )
}

const SITE_ORIGIN = 'https://manabi-map.app'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, '..')
const distArgIndex = process.argv.indexOf('--dist')
const distDir = distArgIndex >= 0 ? process.argv[distArgIndex + 1] : join(webRoot, 'dist')

const rawTemplate = await readFile(join(distDir, 'index.html'), 'utf8')

// トップの og:description に入る収録範囲プレースホルダ。
// index.html に手書きすると県追加のたびに版ずれするため、ビルド時に実データから差し替える。
const COVERAGE_PLACEHOLDER = '__COVERAGE__'

// schools.json は build hash 付き URL 化されている（gen-schools-json.mjs）。
// manifest → hash 付きファイル名の順で解決する。旧経路との互換として、
// manifest が無い場合は従来の `schools.json` にフォールバックする。
async function resolveSchoolsPath() {
  try {
    const manifestText = await readFile(join(distDir, 'schools-manifest.json'), 'utf8')
    const manifest = JSON.parse(manifestText)
    if (manifest?.url) return join(distDir, manifest.url.replace(/^\//, ''))
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  return join(distDir, 'schools.json')
}
const schoolsPath = await resolveSchoolsPath()
const schoolsFile = await readFile(schoolsPath)
const schoolsText = schoolsPath.endsWith('.gz') ? gunzipSync(schoolsFile).toString('utf8') : schoolsFile.toString('utf8')
const schoolsPayload = JSON.parse(schoolsText)
const schools = Array.isArray(schoolsPayload) ? schoolsPayload : schoolsPayload.schools
if (!Array.isArray(schools)) throw new Error('schools payload has an unsupported format')
const publicDataset = JSON.parse(await readFile(join(distDir, 'api', 'v1', 'dataset.json'), 'utf8'))

// gen-schools-json.mjs は出典 object を sourceCatalog の index へ圧縮している。
// 選抜実績の出典脚注に使うため、useSchools.ts の hydrateUnitSources と同様に
// index → object へ復元してから集計へ流す。
const sourceCatalog = Array.isArray(schoolsPayload?.sourceCatalog) ? schoolsPayload.sourceCatalog : []
for (const row of schools) {
  for (const unit of row.admission_recruitment_units ?? []) {
    for (const stat of unit.school_admission_selection_stats ?? []) {
      stat.school_admission_stat_sources = (stat.school_admission_stat_sources ?? [])
        .map((ref) => (typeof ref === 'number' ? sourceCatalog[ref] : ref))
        .filter((source) => source != null && typeof source === 'object')
    }
  }
}

const { prefectures, muniByPref } = await loadCivicData(webRoot)
/** 都道府県名 → URL slug（BreadcrumbList の県リンク用）。 */
const prefSlugByName = new Map(prefectures.map((p) => [p.name, p.slug]))

// 収録範囲を実データで確定させてからテンプレートにする。
// String.replace はマッチしなくても元の文字列を返す（＝無言で失敗する）ので、
// 差し替えが起きたことを明示的に確認する。プレースホルダを消し忘れて
// 本番の OGP カードに「__COVERAGE__」が出る事故を防ぐ。
if (!rawTemplate.includes(COVERAGE_PLACEHOLDER)) {
  throw new Error(
    `gen-seo-pages: index.html に ${COVERAGE_PLACEHOLDER} が無い。` +
    'og:description の収録範囲プレースホルダが消えている可能性がある'
  )
}
const template = rawTemplate.replaceAll(COVERAGE_PLACEHOLDER, escapeHtml(coverageText(schools)))

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * 収録範囲の文言を実データから作る。
 * 47 都道府県すべて揃ったら「全国」を冠する。それ未満は件数のみ（「東日本」等の
 * 地域名は県追加で嘘になるので入れない）。
 */
function coverageText(schools) {
  const prefectures = new Set(schools.map((s) => s.prefecture).filter(Boolean))
  const schoolCount = schools.length.toLocaleString('en-US')
  const prefix = prefectures.size >= 47 ? '全国 47 都道府県' : `${prefectures.size} 都道府県`
  return `${prefix}・${schoolCount} 校に対応。`
}

function ownershipLabel(school) {
  switch (school.ownership) {
    case 'prefectural':
      if (school.prefecture === '東京都') return '都立'
      if (school.prefecture === '北海道') return '道立'
      if (school.prefecture === '大阪府' || school.prefecture === '京都府') return '府立'
      return '県立'
    case 'municipal':
      return '市立'
    case 'national':
      return '国立'
    case 'private':
      return '私立'
    case 'union':
      return '組合立'
    default:
      return null
  }
}

const GENDER_LABELS = { coed: '共学', boys: '男子校', girls: '女子校' }
const COURSE_LABELS = { fulltime: '全日制', parttime: '定時制', correspondence: '通信制' }

// SchoolDetailSheet.tsx の lifecycleLabel / recruitmentLabel と同じ文言（i18n/ja.ts 準拠）。
// プリレンダー HTML と mount 後 DOM の内容を一致させるため、React 側に無い項目
// （status_note / status_official_url）はここにも入れない。
const LIFECYCLE_LABELS = { planned: '開校予定', active: '在校', closing: '在校生のみ', closed: '閉校' }
const RECRUITMENT_LABELS = {
  unknown: '未確認',
  not_started: '募集開始前',
  recruiting: '募集中',
  no_external_high_school_intake: '高校段階の外部募集なし',
  stopped: '募集終了',
}

/** javascript: 等のスキームを href に通さない（DB 由来 URL の多層防御）。 */
function safeUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null
}

/**
 * String.replace はパターンにマッチしなくても元の文字列をそのまま返す（＝無言で失敗する）。
 * `/search` の canonical がトップを指したままリリースまで気づかれなかった構造的原因が
 * これなので、head 置換は必ずマッチ確認付きで行い、不発ならビルドを落とす。
 * 置換結果の同値比較ではなくマッチ有無で判定する（canonical がトップの URL のままで
 * よいトップページのような「置換結果が元と同じ」正常系を誤検知しないため）。
 */
function replaceOrThrow(html, pattern, replacement, label) {
  if (!pattern.test(html)) {
    throw new Error(`gen-seo-pages: head 置換が不発: ${label}（index.html の書式変更を確認）`)
  }
  return html.replace(pattern, replacement)
}

/** テンプレートの head 部をページ固有の値に置き換える。 */
function renderHead(html, { title, description, url }) {
  const t = escapeHtml(title)
  const d = escapeHtml(description)
  const u = escapeHtml(url)
  let out = html
  out = replaceOrThrow(out, /<title>[\s\S]*?<\/title>/, () => `<title>${t}</title>`, 'title')
  out = replaceOrThrow(out, /(<meta name="description" content=")[^"]*(")/, (_m, p1, p2) => `${p1}${d}${p2}`, 'meta description')
  out = replaceOrThrow(out, /(<link rel="canonical" href=")[^"]*(")/, (_m, p1, p2) => `${p1}${u}${p2}`, 'canonical')
  out = replaceOrThrow(out, /(<meta property="og:title" content=")[^"]*(")/, (_m, p1, p2) => `${p1}${t}${p2}`, 'og:title')
  out = replaceOrThrow(out, /(<meta property="og:description" content=")[^"]*(")/, (_m, p1, p2) => `${p1}${d}${p2}`, 'og:description')
  out = replaceOrThrow(out, /(<meta property="og:url" content=")[^"]*(")/, (_m, p1, p2) => `${p1}${u}${p2}`, 'og:url')
  out = replaceOrThrow(out, /(<meta name="twitter:title" content=")[^"]*(")/, (_m, p1, p2) => `${p1}${t}${p2}`, 'twitter:title')
  out = replaceOrThrow(out, /(<meta name="twitter:description" content=")[^"]*(")/, (_m, p1, p2) => `${p1}${d}${p2}`, 'twitter:description')
  return out
}

/** JSON-LD を head 閉じタグ直前に注入する。"</script" で script が閉じないようエスケープ。 */
function withJsonLd(html, jsonLd) {
  const script = `<script type="application/ld+json">${JSON.stringify(jsonLd).replaceAll('</', '<\\/')}</script>`
  return replaceOrThrow(html, /<\/head>/, () => `    ${script}\n  </head>`, 'head 閉じタグ')
}

/**
 * #root にプリレンダー済みの React 出力を入れる（mount 時に hydrateRoot が引き継ぐ）。
 *
 * afterRoot（初期データの JSON script）は必ず #root の **外** に置く。
 * 中に入れると React の管理下に無い要素が紛れて hydration が食い違う
 * （plan_ssr-hydration.md）。
 */
function withRootContent(html, content, afterRoot = '', route = '/') {
  return replaceOrThrow(
    html,
    /<div id="root"><\/div>/,
    () => `<div id="root" data-mm-route="${escapeHtml(route)}">${content}</div>${afterRoot}`,
    '#root',
  )
}

/**
 * 「都道府県 + 市区町村」を組み立てる。
 * city 側に県名の接頭辞が入っている行があると「京都府京都府京都市」のように二重になるため、
 * 連結時に落とす（2026-07-31 に 222 行で実際に発生。データ側も是正済みだが、
 * 府県追加のたびに同じ形で入ってくるのでここでも防ぐ）。
 */
function placeLabel(prefecture, city) {
  const pref = prefecture ?? ''
  const rest = (city ?? '').startsWith(pref) ? (city ?? '').slice(pref.length) : (city ?? '')
  return `${pref}${rest}`
}

/**
 * address の県名二重接頭辞を 1 つに畳む（「東京都東京都町田市…」が実データに 11 行ある。
 * 所在地表示と JSON-LD streetAddress の両方に流れるためここで防ぐ）。
 */
function dedupePrefInAddress(address, prefecture) {
  const pref = prefecture ?? ''
  if (!address || !pref || !address.startsWith(pref)) return address
  let rest = address
  while (rest.startsWith(pref)) rest = rest.slice(pref.length)
  return `${pref}${rest}`
}

/** JSON-LD addressLocality 用の市区町村名（県名接頭辞の二重表記を剥がす）。 */
function localityOf(school) {
  const pref = school.prefecture ?? ''
  let city = school.city ?? ''
  while (pref && city.startsWith(pref)) city = city.slice(pref.length)
  return city || null
}

/**
 * JSON-LD streetAddress 用に、address から都道府県・市区町村の接頭辞を剥がす
 * （addressRegion / addressLocality と重複させない・plan_seo-growth-strategy_c7 C4）。
 * 市区町村は city 値と市区町村グループ label（郡付き表記）の最長一致で剥がし、
 * どちらにも一致しないときは県だけ剥がした残りを返す。
 */
function streetAddressOf(school) {
  const full = dedupePrefInAddress(school.address, school.prefecture)
  if (!full) return null
  const pref = school.prefecture ?? ''
  let rest = full
  while (pref && rest.startsWith(pref)) rest = rest.slice(pref.length)
  const candidates = [localityOf(school), resolveCityGroup(school, muniByPref)?.label ?? null]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  for (const candidate of candidates) {
    if (rest.startsWith(candidate)) {
      while (rest.startsWith(candidate)) rest = rest.slice(candidate.length)
      break
    }
  }
  return rest || null
}

async function renderSchoolPage(school) {
  const url = `${SITE_ORIGIN}/school/${school.id}/`
  const place = placeLabel(school.prefecture, school.city)
  const typeLabel = school.type === 'kosen' ? '高等専門学校' : '高校'
  // 学科データを持たない学校では title / description で「学科」を約束しない。
  // 2026-08-06 実測で 605 校が学科 0 件のまま「…の地図・アクセス・学科」と
  // 名乗っていた（docs/local/plan_open-issues-triage.md P0-1）。
  const departmentNames = (school.school_departments ?? []).map((d) => d.name).filter(Boolean)
  const hasDepartments = departmentNames.length > 0
  const title = hasDepartments
    ? `${school.name}（${place}）の地図・アクセス・学科 | Manabi Map`
    : `${school.name}（${place}）の地図・アクセス | Manabi Map`
  const description = hasDepartments
    ? `${school.name}（${place}）の場所・学科情報。住所を入れると通える${typeLabel}が地図に表示され、` +
      '通学時間の目安の確認や見学メモの家族共有ができる無料の学校選びサービスです。'
    : `${school.name}（${place}）の場所とアクセス。住所を入れると通える${typeLabel}が地図に表示され、` +
      '通学時間の目安の確認や見学メモの家族共有ができる無料の学校選びサービスです。'

  const rows = []
  // address は既に prefecture + city を含む完全表記が入っている想定。
  // 未設定のときだけ prefecture + city を組み立てて代替する。
  const addressText =
    dedupePrefInAddress(school.address, school.prefecture) ??
    placeLabel(school.prefecture, school.city)
  const addressWithPostal = school.postal_code ? `〒${school.postal_code} ${addressText}` : addressText
  rows.push(['所在地', addressWithPostal])
  const ownership = ownershipLabel(school)
  if (ownership) rows.push(['設置区分', ownership])
  if (GENDER_LABELS[school.gender_type]) rows.push(['共学・別学', GENDER_LABELS[school.gender_type]])
  const courses = (school.course_times ?? ['fulltime'])
    .map((c) => COURSE_LABELS[c])
    .filter(Boolean)
  if (courses.length) rows.push(['課程', courses.join('・')])
  if (hasDepartments) rows.push(['学科', departmentNames.join('、')])

  // 学校規模（c4 C4）: 事実の数値のみを出す。「大規模校」等のラベル付けはしない
  // （plan_school-scale-band.md の分類方針と衝突させない）。文言は
  // format.ts の enrollmentLabel / genderRatioLabel（i18n/ja.ts 準拠）と同一にする。
  if (school.total_students != null && school.enrollment_year != null) {
    rows.push(['生徒数', `約 ${Number(school.total_students).toLocaleString('en-US')} 人（${school.enrollment_year} 年）`])
  }
  // 男子校・女子校には男女比を出さない（自明で冗長）。
  if (school.male_ratio != null && school.gender_type === 'coed') {
    const male = Number(school.male_ratio)
    const ratioSource =
      school.enrollment_year != null ? `${school.enrollment_year} 年・学校基本調査ベース` : '学校公表情報ベース'
    rows.push(['男女比', `男 ${male}% / 女 ${100 - male}%（${ratioSource}）`])
  }
  if (school.is_integrated) rows.push(['中高一貫', 'あり'])

  const dl = rows
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
    .join('')
  const officialHref = safeUrl(school.official_url)
  const officialLink = officialHref
    ? `<p><a href="${escapeHtml(officialHref)}" rel="noopener">公式サイト</a></p>`
    : ''

  // SchoolDetailSheet.tsx の showLifecycle と同じ条件（+ 後継校の逆引き）。
  // 閉校予定・募集停止校が現役校と同じ体裁で出るのを防ぎ、沿革データを持つ学校には
  // 固有の沿革ブロックを出す（plan_seo-growth-strategy_c4 C2）。
  const lifecycleLabel = LIFECYCLE_LABELS[school.lifecycle_status_code]
  const recruitmentLabel = RECRUITMENT_LABELS[school.recruitment_status_code]
  const predecessors = school.predecessor_relationships ?? []
  const nameHistory = school.school_name_history ?? []
  const successors = successorsById.get(school.id) ?? []
  const showLifecycle =
    school.lifecycle_status_code !== 'active' ||
    school.recruitment_status_code !== 'recruiting' ||
    predecessors.length > 0 ||
    nameHistory.length > 0 ||
    school.legally_established_on != null ||
    school.opened_on != null ||
    successors.length > 0

  let lifecycleSection = ''
  if (showLifecycle) {
    pageStats.historySections += 1
    const lifecycleRows = [['学校状態', lifecycleLabel], ['募集状態', recruitmentLabel]]
    if (school.legally_established_on) lifecycleRows.push(['法的設置日', school.legally_established_on])
    if (school.opened_on) lifecycleRows.push(['開校日', school.opened_on])
    const lifecycleDl = lifecycleRows
      .filter(([, v]) => v)
      .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
      .join('')
    // 開校年月の 1 文（データが無い学校には出さない）。時計に依存させず、
    // lifecycle_status_code=planned のときだけ「開校予定です」にする。
    let openedSentence = ''
    const openedMatch = school.opened_on ? String(school.opened_on).match(/^(\d{4})-(\d{2})/) : null
    if (openedMatch) {
      const verb = school.lifecycle_status_code === 'planned' ? '開校予定です' : '開校しました'
      openedSentence = `<p>この高校は ${Number(openedMatch[1])} 年 ${Number(openedMatch[2])} 月に${verb}。</p>`
    }
    const predecessorList = predecessors.length
      ? '<p>前身校</p><ul>' +
        predecessors
          .map((r) => {
            const link = safeUrl(r.official_url)
            const predecessorId = r.predecessor?.id
            const predecessorName = escapeHtml(r.predecessor?.name ?? '')
            // 前身校が収録済みならページ間の内部リンクにする（沿革の相互リンク網）。
            const nameHtml =
              predecessorId && schoolPageIds.has(predecessorId)
                ? `<a href="/school/${escapeHtml(predecessorId)}/">${predecessorName}</a>`
                : predecessorName
            return (
              `<li>${nameHtml}` +
              (r.effective_on ? `（${escapeHtml(r.effective_on)}から）` : '') +
              (link ? ` <a href="${escapeHtml(link)}" rel="noopener">公式根拠</a>` : '') +
              (r.notes ? ` — ${escapeHtml(r.notes)}` : '') +
              `</li>`
            )
          })
          .join('') +
        '</ul>'
      : ''
    const successorLine = successors.length
      ? '<p>この高校の募集は ' +
        successors
          .map((entry) => `<a href="/school/${escapeHtml(entry.id)}/">${escapeHtml(entry.name)}</a>`)
          .join('、') +
        ' に引き継がれています。</p>'
      : ''
    if (successors.length) pageStats.successorLinks += successors.length
    const nameHistoryList = nameHistory.length
      ? '<p>旧名称</p><ul>' +
        nameHistory
          .map((h) => `<li>${escapeHtml(h.name)}${h.valid_to ? `（〜${escapeHtml(h.valid_to)}）` : ''}</li>`)
          .join('') +
        '</ul>'
      : ''
    lifecycleSection =
      `<section><h2>${escapeHtml(school.name)}の沿革・募集状態</h2>` +
      `<dl>${lifecycleDl}</dl>${openedSentence}${predecessorList}${successorLine}${nameHistoryList}</section>`
  }

  // --- 選抜実績の年度表（c4 C3）。集計は React 側と共有の primaryAdmissionTrend。 ---
  // 倍率は表内の 1 列にとどめ、単独で大きく見せない。一覧の倍率順ソートは実装しない
  // （ランキングサイト化の禁止線・docs/local/plan_seo-growth-strategy.md §やらないこと）。
  const trend = primaryAdmissionTrend({
    admission_selections: flattenRecruitmentUnits(school.admission_recruitment_units),
  })
  let admissionSection = ''
  if (trend) {
    pageStats.admissionTables += 1
    const numCell = (value) => (value == null ? '—' : Number(value).toLocaleString('en-US'))
    const tableRows = trend.annual
      .map(
        (annual) =>
          `<tr><th scope="row">${annual.year}年度</th>` +
          `<td>${numCell(annual.capacity)}</td><td>${numCell(annual.applicants)}</td>` +
          `<td>${numCell(annual.examinees)}</td><td>${numCell(annual.admitted)}</td>` +
          `<td>${annual.ratio.toFixed(2)}</td></tr>`,
      )
      .join('')
    const averageLine =
      trend.average != null ? `<p>3年平均（補助値）: ${trend.average.toFixed(2)}</p>` : ''
    // 出典（重複除去）。全ての数値に公式出典リンクを付ける（c4 C3 完了条件）。
    const seenSources = new Set()
    const sourceParts = []
    let sourceLinkCount = 0
    for (const source of trend.annual.flatMap((annual) => annual.sources)) {
      const key = `${source.official_url}|${source.doc_title}`
      if (seenSources.has(key)) continue
      seenSources.add(key)
      const href = safeUrl(source.official_url)
      const label = escapeHtml(source.doc_title || '公式資料')
      const published = source.published_at ? `（公表日: ${escapeHtml(source.published_at)}）` : ''
      if (href) sourceLinkCount += 1
      sourceParts.push(
        href ? `<a href="${escapeHtml(href)}" rel="noopener">${label}</a>${published}` : `${label}${published}`,
      )
    }
    if (sourceLinkCount === 0) pageStats.admissionTablesWithoutSource += 1
    const sourceLine = sourceParts.length ? `<p>出典: ${sourceParts.join(' ／ ')}</p>` : ''
    admissionSection =
      `<section><h2>${escapeHtml(school.name)}の年度別志願状況（一次募集）</h2>` +
      '<table><thead><tr><th>年度</th><th>募集人員</th><th>志願者数</th><th>受検者数</th><th>合格者数</th><th>倍率</th></tr></thead>' +
      `<tbody>${tableRows}</tbody></table>` +
      `<p>${escapeHtml(TREND_DESCRIPTIONS[trend.continuity] ?? '')}</p>` +
      averageLine +
      sourceLine +
      '</section>'
  } else {
    // 選抜実績が公立にしか無い非対称を「情報が無い＝劣る」と見せないため、
    // 空の表ではなく v0.4.0 の「情報提供募集中」原則の案内を出す（c4 C3）。
    pageStats.admissionGuidance += 1
    const officialHref = safeUrl(school.official_url)
    const guidance = officialHref
      ? `入試の実施状況は<a href="${escapeHtml(officialHref)}" rel="noopener">公式サイト</a>の募集要項をご確認ください。`
      : '入試の実施状況は学校の公表資料をご確認ください。'
    admissionSection =
      `<section><h2>${escapeHtml(school.name)}の入試情報</h2>` +
      `<p>選抜実績 情報提供募集中 — ${guidance}</p></section>`
  }

  // --- 近隣校リスト（c4 C1）。距離は「直線距離」と明記し、「通える」「通学時間」は書かない。 ---
  const neighbors = neighborIndex.get(school.id) ?? []
  pageStats.neighborLinks += neighbors.length
  const neighborItems = neighbors
    .map(
      ({ school: neighbor, distanceKm }) =>
        `<li><a href="/school/${escapeHtml(neighbor.id)}/">${escapeHtml(neighbor.name)}</a>` +
        `（${escapeHtml(neighborPlaceLabel(school, neighbor))}・約 ${distanceKm.toFixed(1)} km）</li>`,
    )
    .join('')
  const neighborSection = neighbors.length
    ? `<section><h2>${escapeHtml(school.name)}の近くにある高校</h2>` +
      `<p>直線距離の近い順に ${neighbors.length} 校。実際の通学経路・所要時間は交通手段により異なります。</p>` +
      `<ul>${neighborItems}</ul></section>`
    : ''

  // #root の中身はアプリ mount 時に置き換わる（クローラー向けの初期 HTML）。
  const staticContent =
    `<main><h1>${escapeHtml(school.name)}</h1>` +
    (school.name_kana ? `<p>${escapeHtml(school.name_kana)}</p>` : '') +
    `<dl>${dl}</dl>${officialLink}${lifecycleSection}` +
    admissionSection +
    neighborSection +
    `<p>Manabi Map（まなびマップ）は、住所を入れると通える${typeLabel}が地図に表示される無料の学校選びサービスです。` +
    `お気に入り保存・見学メモ・家族での共有ができます。</p>` +
    `<p><a href="/">地図で通える学校をさがす</a></p></main>`

  // --- JSON-LD（c7 C4: 実データで埋まるプロパティを拡充。偏差値・倍率は載せない） ---
  // alternateName: ふりがな + 旧校名（school_name_history）。校名そのものと重複させない。
  const alternateNames = [
    ...new Set(
      [school.name_kana, ...nameHistory.map((h) => h.name)].filter(
        (name) => name && name !== school.name,
      ),
    ),
  ]
  const locality = localityOf(school)
  const streetAddress = streetAddressOf(school)
  const officialLinkUrl = officialHref
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': school.type === 'kosen' ? 'EducationalOrganization' : 'HighSchool',
    '@id': url,
    name: school.name,
    ...(alternateNames.length ? { alternateName: alternateNames } : {}),
    url,
    description,
    image: `${SITE_ORIGIN}/og-hero.png`,
    license: DATASET_LICENSE_URL,
    creditText: DATASET_ATTRIBUTION,
    address: {
      '@type': 'PostalAddress',
      addressCountry: 'JP',
      addressRegion: school.prefecture,
      ...(locality ? { addressLocality: locality } : {}),
      ...(streetAddress ? { streetAddress } : {}),
      ...(school.postal_code ? { postalCode: school.postal_code } : {}),
    },
    ...(school.latitude != null && school.longitude != null
      ? {
          geo: {
            '@type': 'GeoCoordinates',
            latitude: Number(school.latitude),
            longitude: Number(school.longitude),
          },
        }
      : {}),
    ...(school.total_students != null
      ? { numberOfStudents: Number(school.total_students) }
      : {}),
    ...(school.opened_on ? { foundingDate: String(school.opened_on) } : {}),
    // sameAs は将来 Wikipedia 等を足せるよう配列で出す。
    ...(officialLinkUrl ? { sameAs: [officialLinkUrl] } : {}),
  }

  // BreadcrumbList（UUID URL の検索結果表示を救済する唯一の手段・c7 C4）。
  //
  // **最後の要素以外は必ず item を持たせる。** Google の要件は
  // 「position / name / item が必須。最後の項目だけ item を省略できる」で、
  // 中間段の item 欠落は無効アイテム＝リッチリザルト対象外になる。
  // schema.org の語彙としては name のみの ListItem も有効なため、
  // 2026-08-08 に GSC が「項目「item」がありません」を検出するまで気づけなかった
  // （旧実装は市区町村ハブが無いことを理由に 3 段目の item を省いていた）。
  //
  // 市区町村は専用ページ（/pref/<slug>/<市区町村>/・c5 C6）へリンクする。
  // item を与えられない中間段は段ごと出さない（県 slug が解決できない場合は 2 段へ縮める）。
  const prefSlug = prefSlugByName.get(school.prefecture)
  const prefUrl = prefSlug ? `${SITE_ORIGIN}/pref/${prefSlug}/` : null
  const cityGroup = resolveCityGroup(school, muniByPref)
  const breadcrumbEntries = [
    { name: 'ホーム', item: `${SITE_ORIGIN}/` },
    ...(prefUrl ? [{ name: school.prefecture, item: prefUrl }] : []),
    ...(prefUrl && cityGroup
      ? [{ name: cityGroup.label, item: `${SITE_ORIGIN}${cityPagePath(prefSlug, cityGroup.label)}` }]
      : []),
    { name: school.name },
  ]
  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: breadcrumbEntries.map((entry, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      ...entry,
    })),
  }

  void staticContent
  const withHead = renderHead(template, { title, description, url })
  // 単体 JSON（gen-schools-json.mjs が dist へ出したもの）をそのまま渡して SSR する。
  // 同じ payload を #root の外へ埋め、ブラウザの初回 render でも同じ内容を描かせる。
  const payload = JSON.parse(
    await readFile(join(distDir, 'school-data', `${school.id}.json`), 'utf8'),
  )
  const rendered = renderApp(`/school/${school.id}`, { schoolDetail: payload })
  return withRootContent(
    withJsonLd(withJsonLd(withHead, jsonLd), breadcrumbLd),
    rendered.html,
    rendered.initialScript,
    `/school/${school.id}`,
  )
}

const targets = schools.filter((s) => s.latitude != null && s.longitude != null)

// H1 ハーネス（関東以降の各地方展開でも自動発火）:
// 生成 0 件は schools.json 取得失敗、下限未満はデータ大幅欠損の疑い。build を落として気付く。
// 関東 7 都県 = 1,362 校を基準に下方硬直の下限を置く（新県追加で増える方向は許容）。
if (targets.length === 0) {
  throw new Error('gen-seo-pages: 生成対象 0 件。schools.json の取得に失敗している可能性あり')
}
const MIN_EXPECTED = 1000
if (targets.length < MIN_EXPECTED) {
  throw new Error(
    `gen-seo-pages: 生成 ${targets.length} 件は下限 ${MIN_EXPECTED} 未満。データ大幅欠損の疑い`
  )
}

// --- 近隣校インデックス / 沿革の逆引き（plan_seo-growth-strategy_c4 C1 / C2） ----

// 全校の緯度経度から、各校の近隣校を 1 回だけ計算する（2026-08-04 実測:
// 約 5,100 校の総当たり ≒ 2,600 万回でも Node で数秒）。空間索引は不要。
// 選定・並び順のロジックは src/lib/neighbors.ts（React 側と共有）にあり、
// 距離順ソートのみ。偏差値順・倍率順は実装しない（ランキングサイト化の禁止線・
// docs/local/plan_seo-growth-strategy.md §やらないこと）。
const neighborUniverse = targets.map((s) => ({
  id: s.id,
  name: s.name,
  prefecture: s.prefecture,
  city: s.city ?? null,
  latitude: Number(s.latitude),
  longitude: Number(s.longitude),
}))
const neighborIndex = new Map()
for (const subject of neighborUniverse) {
  neighborIndex.set(subject.id, selectNeighbors(subject, neighborUniverse))
}

/** 生成対象に個別ページがある学校 id（前身校・後継校リンクの張り先判定用）。 */
const schoolPageIds = new Set(targets.map((s) => s.id))

// 前身校 id → 後継校の逆引き。前身校側のページに
// 「この高校の募集は◯◯に引き継がれています」の逆方向リンクを出す。
// 逆引きは React 側・gen-schools-json.mjs と共有（lib/successors.ts）。
const successorsById = successorsByPredecessorId(targets)

// SchoolDetailSheet.tsx の admissionTrend 説明文と同じ文言（i18n/ja.ts 準拠）。
const TREND_DESCRIPTIONS = {
  three: '3年連続で確認できます。年度別の数値を主に見てください。',
  two: '2年連続で確認できます。平均は出さず、各年度を表示しています。',
  gapped: '隔年のデータです。飛び飛びの年を平均せず、確認できる年度だけを表示しています。',
  one: '1年分を確認できます。他の年度は推測で補っていません。',
}

// 実測レポート用の集計（生成ログに出す）。
const pageStats = {
  neighborLinks: 0,
  admissionTables: 0,
  admissionGuidance: 0,
  admissionTablesWithoutSource: 0,
  historySections: 0,
  successorLinks: 0,
}

// --- 県ハブ / 全域ハブ ------------------------------------------------------

/** データに存在する都道府県だけを、都道府県コード順で返す。 */
const activePrefectures = prefectures.filter((p) =>
  targets.some((s) => s.prefecture === p.name),
)
if (activePrefectures.length === 0) {
  throw new Error('gen-seo-pages: 都道府県が 1 件も解決できない（prefectures.json と実データの不一致）')
}
/**
 * 県別軽量インデックスを読む。県ページと市区町村ページの共通の正典
 * （plan_ssr-hydration_c3_initial-data.md「県ページの設計」）。
 */
async function readPrefIndex(pref, prefSchools) {
  const prefIndex = JSON.parse(
    await readFile(join(distDir, 'school-data', `pref-index-${pref.slug}.json`), 'utf8'),
  )
  if (prefIndex?.slug !== pref.slug || !Array.isArray(prefIndex.schools) || !Array.isArray(prefIndex.cities)) {
    throw new Error(`gen-seo-pages: pref-index が不正です: ${pref.slug}`)
  }
  if (prefIndex.schools.length !== prefSchools.length) {
    throw new Error(
      `gen-seo-pages: pref-index 件数不一致 ${pref.slug}: ` +
      `index=${prefIndex.schools.length} targets=${prefSchools.length}`,
    )
  }
  return prefIndex
}

function renderPrefPage(pref, prefIndex) {
  const url = `${SITE_ORIGIN}/pref/${pref.slug}/`
  const count = prefIndex.schools.length
  const title = `${pref.name}の高校一覧（${count} 校） | Manabi Map`
  const description =
    `${pref.name}の高校一覧（${count} 校）。市区町村ごとに校名・設置区分・課程を掲載。` +
    '地図で場所を確認し、気になる学校の保存や家族での見学メモ共有ができる無料の学校選びサービスです。'
  const withHead = renderHead(template, { title, description, url })
  const rendered = renderApp(`/pref/${pref.slug}`, { prefPage: prefIndex })
  return withRootContent(withHead, rendered.html, rendered.initialScript, `/pref/${pref.slug}`)
}

/**
 * 市区町村ページ（/pref/<県 slug>/<市区町村>/・c5 C6）。
 *
 * 掲載は **所在地の列挙**。「◯◯市から通える高校」型の見出し・本文は書かない
 * （学区データを保有しないため。docs/local/plan_seo-growth-strategy.md §やらないこと）。
 * 並び順は五十音順固定で、偏差値順・倍率順のソートは実装しない。
 *
 * 埋め込みは該当市区町村の学校だけに絞る（県全体を入れると東京 430 校 × 62 ページで
 * dist が数 MB 膨らむ）。近隣導線に要る県内の他市区町村は件数だけの cityCounts で渡す。
 */
function renderCityPage(pref, prefIndex, cityCounts, city, count) {
  const path = cityPagePath(pref.slug, city)
  const url = `${SITE_ORIGIN}${path}`
  const title = `${city}の高校一覧（${count} 校） | Manabi Map`
  const cityEntries = prefIndex.schools.filter((entry) => entry.c === city)
  const description = cityPageDescription(pref.name, city, cityEntries)
  const payload = {
    slug: pref.slug,
    city,
    // description の集計と同じ配列を使う。別々に絞り込むと、片方だけ条件が変わったときに
    // 「description の数字」と「画面の数字」が静かにずれる。
    schools: cityEntries,
    cityCounts,
  }
  if (payload.schools.length !== count) {
    throw new Error(
      `gen-seo-pages: 市区町村の件数不一致 ${pref.slug}/${city}: ` +
      `payload=${payload.schools.length} cityCounts=${count}`,
    )
  }
  // 最終段（市区町村）は item 省略が正しい形（Google は現在ページの URL を使う）。
  // 中間段の県は必ず item を持たせる（学校ページの breadcrumbEntries と同じ不変条件）。
  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { name: 'ホーム', item: `${SITE_ORIGIN}/` },
      { name: pref.name, item: `${SITE_ORIGIN}/pref/${pref.slug}/` },
      { name: city },
    ].map((entry, index) => ({ '@type': 'ListItem', position: index + 1, ...entry })),
  }
  const withHead = renderHead(template, { title, description, url })
  const rendered = renderApp(path, { cityPage: payload })
  return withRootContent(withJsonLd(withHead, breadcrumbLd), rendered.html, rendered.initialScript, path)
}

function renderSchoolsHubPage() {
  const url = `${SITE_ORIGIN}/schools/`
  const allCovered = activePrefectures.length >= 47
  const heading = allCovered
    ? `全国の高校一覧（47 都道府県・${targets.length.toLocaleString('en-US')} 校）`
    : `高校一覧（${activePrefectures.length} 都道府県・${targets.length.toLocaleString('en-US')} 校）`
  const title = `${heading} | Manabi Map`
  const description =
    `${coverageText(schools)}都道府県から高校一覧を開き、市区町村ごとの学校と地図を確認できます。` +
    'お気に入り保存・見学メモの家族共有ができる無料の学校選びサービスです。'
  const withHead = renderHead(template, { title, description, url })
  return withRootContent(withHead, renderApp('/schools').html, '', '/schools')
}

// --- /press と /legal/*（E-E-A-T の機械可読化） ------------------------------

const LEGAL_DOCS = [
  { doc: 'terms', title: '利用規約' },
  { doc: 'privacy', title: 'プライバシーポリシー' },
  { doc: 'third-party', title: 'サードパーティライセンス' },
  { doc: 'deviation-methodology', title: '推計の方法と限界' },
]

// Organization はトップと /press の両方に出し、`@id` で同一実体として紐づける
// （c7 C4。WebSite JSON-LD は index.html テンプレート側にあり publisher で参照する）。
const ORGANIZATION_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  '@id': `${SITE_ORIGIN}/#organization`,
  name: 'Manabi Map',
  alternateName: 'まなびマップ',
  url: `${SITE_ORIGIN}/`,
  email: 'hello@manabi-map.app',
  contactPoint: [
    {
      '@type': 'ContactPoint',
      contactType: 'customer support',
      email: 'hello@manabi-map.app',
      availableLanguage: 'ja',
    },
    {
      '@type': 'ContactPoint',
      contactType: 'content correction',
      email: 'takedown@manabi-map.app',
      availableLanguage: 'ja',
    },
  ],
  sameAs: [
    'https://x.com/manabi_map',
    'https://note.com/ishizakahiroshi',
    'https://qiita.com/ishizakahiroshi',
    'https://github.com/ishizakahiroshi/manabi-map',
  ],
}

function renderDataPage() {
  const url = `${SITE_ORIGIN}/data/`
  const title = '学校基本情報データセット・公開 API | Manabi Map'
  const datasetCoverage = formatDatasetCoverage(
    Number(publicDataset.prefecture_count),
    Number(publicDataset.school_count),
    prefectures.length,
  )
  const description =
    `${datasetCoverage}の学校基本情報を、` +
    '出典 URL とともに CC BY-SA 4.0 で公開する静的 JSON API です。'
  // 県別エンドポイントの一覧は DataPage が publicDataset.prefectures から描く
  // （初期データとして埋め込む。この関数では head と JSON-LD だけを組み立てる）。
  const datasetJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    '@id': `${url}#dataset`,
    name: 'Manabi Map 学校基本情報データセット',
    description,
    url,
    license: DATASET_LICENSE_URL,
    creator: {
      '@type': 'Organization',
      '@id': ORGANIZATION_JSON_LD['@id'],
      name: ORGANIZATION_JSON_LD.name,
      url: ORGANIZATION_JSON_LD.url,
    },
    distribution: [
      {
        '@type': 'DataDownload',
        contentUrl: `${SITE_ORIGIN}/api/v1/schools.json`,
        encodingFormat: 'application/json',
      },
    ],
    temporalCoverage: '2026/..',
    isAccessibleForFree: true,
    measurementTechnique: '学校・教育委員会・官公庁が公表した一次資料を項目単位で記録し、出典 URL を同梱',
  }
  const withHead = renderHead(template, { title, description, url })
  // 収録件数は DataPage が /api/v1/dataset.json から取るので、同じものを埋め込む。
  const rendered = renderApp('/data', { datasetMetadata: publicDataset })
  return withRootContent(
    withJsonLd(withHead, datasetJsonLd),
    rendered.html,
    rendered.initialScript,
    '/data',
  )
}

function renderPressPage() {
  const url = `${SITE_ORIGIN}/press/`
  const title = '配布素材・プレスキット | Manabi Map'
  const description =
    'Manabi Map（まなびマップ）のメディア関係者・教育関係者向け基礎情報。運営者・連絡先・配布素材・' +
    '掲載情報の訂正窓口（takedown@manabi-map.app）を公開しています。'
  const withHead = renderHead(template, { title, description, url })
  return withRootContent(withJsonLd(withHead, ORGANIZATION_JSON_LD), renderApp('/press').html, '', '/press')
}

// --- 404（ソフト 404 の解消） ------------------------------------------------

function render404Page() {
  const title = 'ページが見つかりません | Manabi Map'
  const description =
    'お探しのページは見つかりませんでした。トップから住所を入れて地図でさがすか、都道府県一覧からお進みください。'
  // 404 は canonical を持たせない（存在しない URL がトップの canonical を名乗っていたのが
  // ソフト 404 の一因）。noindex を明示する。
  let html = renderHead(template, { title, description, url: `${SITE_ORIGIN}/` })
  html = replaceOrThrow(html, /[ \t]*<link rel="canonical"[^>]*>\r?\n?/, '', 'canonical 除去(404)')
  html = replaceOrThrow(
    html,
    /<meta name="description"/,
    '<meta name="robots" content="noindex" />\n    <meta name="description"',
    'noindex(404)',
  )
  // 存在しない URL を渡して NotFoundPage を描かせる（React Router の * ルート）。
  return withRootContent(html, renderApp('/__not-found__').html, '', '/__not-found__')
}

// --- 書き出し ----------------------------------------------------------------

// トップの index.html は収録範囲を差し替え、一覧導線とフッターの静的ブロックを注入した版で上書きする。
// （template は各ページの雛形として使うだけで dist には書き戻らないため、
//   これをやらないとトップだけプレースホルダのまま残る）
// WebSite JSON-LD はテンプレート（index.html）由来。Organization をトップにも注入し、
// /press と `@id` で同一実体として紐づける（c7 C4）。
const topRendered = renderApp('/')
await writeFile(
  join(distDir, 'index.html'),
  withRootContent(
    withJsonLd(template, ORGANIZATION_JSON_LD),
    topRendered.html,
    topRendered.initialScript,
    '/',
  ),
)

for (const school of targets) {
  const outDir = join(distDir, 'school', school.id)
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'index.html'), await renderSchoolPage(school))
}

const prefPages = []
const cityPages = []
for (const pref of activePrefectures) {
  const prefSchools = targets.filter((s) => s.prefecture === pref.name)
  const prefIndex = await readPrefIndex(pref, prefSchools)
  const outDir = join(distDir, 'pref', pref.slug)
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'index.html'), renderPrefPage(pref, prefIndex))
  prefPages.push(`/pref/${pref.slug}/`)

  // 市区町村ページ（c5 C6）。対象は pref-index の cities に載っている市区町村だけ＝
  // 総務省コードへ解決できたもの。「その他」（解決不能の受け皿）にはページを作らない。
  // ディレクトリ名は日本語のまま置き、URL では percent-encode される（cityPagePath と対応）。
  const cityCounts = buildCityCounts(prefIndex)
  for (const { c: city, n } of cityCounts) {
    const cityDir = join(distDir, 'pref', pref.slug, city)
    await mkdir(cityDir, { recursive: true })
    await writeFile(
      join(cityDir, 'index.html'),
      renderCityPage(pref, prefIndex, cityCounts, city, n),
    )
    cityPages.push(cityPagePath(pref.slug, city))
  }
}

await mkdir(join(distDir, 'schools'), { recursive: true })
await writeFile(join(distDir, 'schools', 'index.html'), renderSchoolsHubPage())

await mkdir(join(distDir, 'press'), { recursive: true })
await writeFile(join(distDir, 'press', 'index.html'), renderPressPage())

await mkdir(join(distDir, 'data'), { recursive: true })
await writeFile(join(distDir, 'data', 'index.html'), renderDataPage())

for (const { doc, title } of LEGAL_DOCS) {
  const url = `${SITE_ORIGIN}/legal/${doc}/`
  const description = `Manabi Map（まなびマップ）の${title}。運営方針・データの扱い・お問い合わせ窓口を公開しています。`
  // 本文は生 Markdown のまま React へ渡す（LegalPage が react-markdown で描く）。
  // node 側で HTML 化して流し込むと、React の出力と 1 文字でも違った時点で hydration が壊れる。
  const markdown = await readFile(join(distDir, 'legal', `${doc}.md`), 'utf8')
  const withHead = renderHead(template, { title: `${title} | Manabi Map`, description, url })
  const rendered = renderApp(`/legal/${doc}`, {
    docMarkdown: { key: `legal/${doc}`, text: markdown },
  })
  const outDir = join(distDir, 'legal', doc)
  await mkdir(outDir, { recursive: true })
  await writeFile(
    join(outDir, 'index.html'),
    withRootContent(withHead, rendered.html, rendered.initialScript, `/legal/${doc}`),
  )
}

for (const guide of GUIDES) {
  const url = `${SITE_ORIGIN}/guide/${guide.slug}/`
  const markdown = await readFile(join(distDir, 'guide', `${guide.slug}.md`), 'utf8')
  const withHead = renderHead(template, {
    title: `${guide.title} | Manabi Map`,
    description: guide.description,
    url,
  })
  const rendered = renderApp(`/guide/${guide.slug}`, {
    docMarkdown: { key: `guide/${guide.slug}`, text: markdown },
  })
  const outDir = join(distDir, 'guide', guide.slug)
  await mkdir(outDir, { recursive: true })
  await writeFile(
    join(outDir, 'index.html'),
    withRootContent(withHead, rendered.html, rendered.initialScript, `/guide/${guide.slug}`),
  )
}

await writeFile(join(distDir, '404.html'), render404Page())

// sitemap には '/search' を含めない（サイト内検索結果はインデックスさせないのが Google の案内）。
// lastmod は school.updated_at を使い、無い URL（トップ・ハブ・固定ページ）は要素ごと省略する
// （sitemap プロトコルで lastmod は任意要素。ビルド日で埋めると Google が sitemap の lastmod を
// 丸ごと無視するようになる）。
const urls = [
  { path: '/' },
  { path: '/schools/' },
  ...prefPages.map((path) => ({ path })),
  ...cityPages.map((path) => ({ path })),
  { path: '/data/' },
  { path: '/press/' },
  ...LEGAL_DOCS.map(({ doc }) => ({ path: `/legal/${doc}/` })),
  ...GUIDES.map((guide) => ({ path: `/guide/${guide.slug}/` })),
  ...targets.map((s) => ({ path: `/school/${s.id}/`, lastmod: s.updated_at?.slice(0, 10) })),
]
const sitemap =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  urls
    .map(
      ({ path, lastmod }) =>
        `  <url><loc>${SITE_ORIGIN}${escapeHtml(path)}</loc>` +
        (lastmod ? `<lastmod>${lastmod}</lastmod>` : '') +
        `</url>`,
    )
    .join('\n') +
  '\n</urlset>\n'
await writeFile(join(distDir, 'sitemap.xml'), sitemap)

// 出典なしの年度表は c4 C3 完了条件（全数値に出典）に反するのでビルドを落とす。
if (pageStats.admissionTablesWithoutSource > 0) {
  throw new Error(
    `gen-seo-pages: 出典リンクの無い選抜実績表が ${pageStats.admissionTablesWithoutSource} 校ある`,
  )
}

console.log(
  `wrote ${targets.length} school pages, ${prefPages.length} pref hubs, ` +
  `${cityPages.length} city pages, ` +
  `${LEGAL_DOCS.length} legal pages, ${GUIDES.length} guides, data, press, 404 and sitemap.xml (${urls.length} urls) to ${distDir}`,
)

const llms = [
  '# Manabi Map（まなびマップ）',
  '',
  '> 親子で使う、学校選びの地図ノート。学校を序列化せず、地図、見学、家族の対話を通じた進路検討を支援します。',
  '',
  `- 収録範囲: ${coverageText(schools)}`,
  '- 公式サイト: https://manabi-map.app/',
  '',
  '## 主要ページ',
  '',
  '- [トップ](https://manabi-map.app/): 地図と学校検索',
  '- [公開データセットと API](https://manabi-map.app/data/): 収録基準・ライセンス・安定エンドポイント',
  '- [プレスキット](https://manabi-map.app/press/): サービスの基礎情報と配布素材',
  '- [編集推計の方法と限界](https://manabi-map.app/legal/deviation-methodology/): 根拠と限界',
  '- [利用規約](https://manabi-map.app/legal/terms/)',
  '- [プライバシーポリシー](https://manabi-map.app/legal/privacy/)',
  '',
  '## データとライセンス',
  '',
  '- コード: AGPL-3.0-or-later',
  '- 学校基本情報: CC BY-SA 4.0',
  `- 収録方針: ${DATASET_CLAIM}`,
  `- 出典表記: ${DATASET_ATTRIBUTION}`,
  '- 全件 API: https://manabi-map.app/api/v1/schools.json',
  '- 県別 API: https://manabi-map.app/api/v1/schools/{prefecture}.json',
  '- API メタデータ: https://manabi-map.app/api/v1/dataset.json',
  '- API の呼び方（OpenAPI 3.1）: https://manabi-map.app/api/v1/openapi.json',
  '- 認証は不要です。CORS は全 origin に開いています。',
  '- 偏差値の編集推計は公開 API に含めません。',
  '- データセットの説明: https://github.com/ishizakahiroshi/manabi-map/blob/main/DATA.md',
  '',
  '## お問い合わせ',
  '',
  '- 一般のお問い合わせ・取材: hello@manabi-map.app',
  '- 掲載情報の削除・訂正: takedown@manabi-map.app',
  '',
].join('\n')
await writeFile(join(distDir, 'llms.txt'), llms)
console.log(
  `school page blocks: neighborLinks=${pageStats.neighborLinks} ` +
  `admissionTables=${pageStats.admissionTables} admissionGuidance=${pageStats.admissionGuidance} ` +
  `historySections=${pageStats.historySections} successorLinks=${pageStats.successorLinks}`,
)
