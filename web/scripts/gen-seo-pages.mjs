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
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { loadCivicData, groupSchoolsByCity, resolveCityGroup } from './lib/municipalities.mjs'
import {
  DATASET_ATTRIBUTION,
  DATASET_CLAIM,
  DATASET_LICENSE_URL,
  formatDatasetCoverage,
} from './lib/public-api.mjs'
// 近隣校の選定・距離計算と選抜実績の集計・後継校の逆引きは React 側と同一実装を共有する
// （tsx 経由で .ts を直 import（package.json の scripts が tsx で起動する。Node の type stripping には依存しない — Cloudflare Pages のビルドイメージは pnpm 同梱の preinstall Node しか使えないため）。フォーク禁止 —
// 静的 HTML と JS mount 後で校名・距離・倍率が食い違う事故を防ぐ。
// docs/local/plan_seo-growth-strategy_c4 C1 / C3）。
import { selectNeighbors, neighborPlaceLabel } from '../src/lib/neighbors.ts'
import { flattenRecruitmentUnits } from '../src/lib/admissionUnits.ts'
import { primaryAdmissionTrend } from '../src/lib/admission.ts'
import { successorsByPredecessorId } from '../src/lib/successors.ts'
import { GUIDES } from '../src/lib/guides.ts'

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

/** #root に静的コンテンツ（クローラー向けの初期 HTML。mount 時に React が置き換える）を注入。 */
function withRootContent(html, content) {
  return replaceOrThrow(html, /<div id="root"><\/div>/, () => `<div id="root">${content}</div>`, '#root')
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

function renderSchoolPage(school) {
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
  // 県までは実 URL（/pref/<slug>/）へリンクし、市区町村ハブは存在しないため
  // item を省略した name のみの ListItem にする（schema.org 的に有効）。
  // 市区町村名は県ページの見出しと同じ resolveCityGroup の label を使う。
  const prefSlug = prefSlugByName.get(school.prefecture)
  const cityGroup = resolveCityGroup(school, muniByPref)
  const breadcrumbEntries = [
    { name: 'ホーム', item: `${SITE_ORIGIN}/` },
    prefSlug
      ? { name: school.prefecture, item: `${SITE_ORIGIN}/pref/${prefSlug}/` }
      : { name: school.prefecture },
    ...(cityGroup ? [{ name: cityGroup.label }] : []),
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

  const withHead = renderHead(template, { title, description, url })
  return withRootContent(withJsonLd(withJsonLd(withHead, jsonLd), breadcrumbLd), staticContent)
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
const REGION_LABELS = {
  'hokkaido-tohoku': '北海道・東北',
  kanto: '関東',
  chubu: '中部',
  kinki: '近畿',
  'chugoku-shikoku': '中国・四国',
  'kyushu-okinawa': '九州・沖縄',
}

/** サイト共通フッター（プリレンダー用）。React の SiteFooter と項目を一致させる。 */
const FOOTER_HTML =
  '<footer><nav aria-label="サイト情報">' +
  '<a href="/press/">プレスキット</a> ' +
  '<a href="/legal/terms/">利用規約</a> ' +
  '<a href="/legal/privacy/">プライバシーポリシー</a> ' +
  '<a href="/legal/deviation-methodology/">偏差値の方法と限界</a> ' +
  '<a href="/legal/third-party/">サードパーティライセンス</a> ' +
  '<a href="/guide/school-visit/">学校選びガイド</a>' +
  '</nav></footer>'

/** 設置区分・課程・共学別学の内訳（県ハブの事実の集計。序列は作らない）。 */
function breakdownText(list) {
  const count = (fn) => list.filter(fn).length
  const parts = []
  const publicCount = count((s) => ['prefectural', 'municipal', 'union'].includes(s.ownership))
  const privateCount = count((s) => s.ownership === 'private')
  const nationalCount = count((s) => s.ownership === 'national')
  const own = [`公立 ${publicCount} 校`, `私立 ${privateCount} 校`]
  if (nationalCount > 0) own.push(`国立 ${nationalCount} 校`)
  parts.push(own.join('・'))
  const courses = ['fulltime', 'parttime', 'correspondence']
    .map((c) => [COURSE_LABELS[c], count((s) => (s.course_times ?? ['fulltime']).includes(c))])
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label} ${n}`)
  if (courses.length) parts.push(courses.join('・'))
  const genders = ['coed', 'girls', 'boys']
    .map((g) => [GENDER_LABELS[g], count((s) => s.gender_type === g)])
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label} ${n}`)
  if (genders.length) parts.push(genders.join('・'))
  return parts.join(' ／ ')
}

/** 学校 1 校ぶんのリスト行（県ハブ用）。閉校予定・募集停止は一覧でも隠さない。 */
function schoolListItem(school) {
  const meta = [
    ownershipLabel(school),
    ...(school.course_times ?? ['fulltime']).map((c) => COURSE_LABELS[c]).filter(Boolean),
  ].filter(Boolean)
  const statusLabels = []
  if (school.lifecycle_status_code !== 'active') {
    statusLabels.push(LIFECYCLE_LABELS[school.lifecycle_status_code] ?? '')
  }
  if (school.recruitment_status_code !== 'recruiting') {
    statusLabels.push(RECRUITMENT_LABELS[school.recruitment_status_code] ?? '')
  }
  const status = statusLabels.filter(Boolean).length
    ? `〔${escapeHtml(statusLabels.filter(Boolean).join('・'))}〕`
    : ''
  return (
    `<li><a href="/school/${escapeHtml(school.id)}/">${escapeHtml(school.name)}</a>` +
    (meta.length ? `（${escapeHtml(meta.join('・'))}）` : '') +
    status +
    '</li>'
  )
}

function renderPrefPage(pref, prefSchools) {
  const url = `${SITE_ORIGIN}/pref/${pref.slug}/`
  const title = `${pref.name}の高校一覧（${prefSchools.length} 校） | Manabi Map`
  const description =
    `${pref.name}の高校一覧（${prefSchools.length} 校）。市区町村ごとに校名・設置区分・課程を掲載。` +
    '地図で場所を確認し、気になる学校の保存や家族での見学メモ共有ができる無料の学校選びサービスです。'
  const groups = groupSchoolsByCity(prefSchools, muniByPref)

  const jumpLinks = groups
    .map((g) => `<a href="#${encodeURIComponent(g.label)}">${escapeHtml(g.label)}（${g.schools.length}）</a>`)
    .join(' ')
  const sections = groups
    .map(
      (g) =>
        `<section id="${escapeHtml(g.label)}">` +
        `<h2>${escapeHtml(g.label)}（${g.schools.length} 校）</h2>` +
        `<ul>${g.schools.map(schoolListItem).join('')}</ul>` +
        '</section>',
    )
    .join('')

  const main =
    '<main>' +
    `<nav aria-label="パンくず"><a href="/">トップ</a> › <a href="/schools/">都道府県一覧</a> › ${escapeHtml(pref.name)}</nav>` +
    `<h1>${escapeHtml(pref.name)}の高校一覧（${prefSchools.length} 校）</h1>` +
    '<p>掲載は市区町村ごと・五十音順で、学校の序列ではありません。' +
    '出願できる学校は学区・募集要項により異なるため、必ず各校の募集要項でご確認ください。</p>' +
    `<p>内訳: ${escapeHtml(breakdownText(prefSchools))}</p>` +
    `<nav aria-label="市区町村へ移動">${jumpLinks}</nav>` +
    sections +
    '<p><a href="/schools/">都道府県一覧へ</a> ／ <a href="/">住所から地図でさがす</a></p>' +
    '</main>'

  const withHead = renderHead(template, { title, description, url })
  return withRootContent(withHead, main + FOOTER_HTML)
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
  const regions = Object.entries(REGION_LABELS)
    .map(([key, label]) => {
      const prefs = activePrefectures.filter((p) => p.region === key)
      if (prefs.length === 0) return ''
      const links = prefs
        .map((p) => {
          const count = targets.filter((s) => s.prefecture === p.name).length
          return `<li><a href="/pref/${p.slug}/">${escapeHtml(p.name)}の高校一覧（${count} 校）</a></li>`
        })
        .join('')
      return `<section><h2>${escapeHtml(label)}</h2><ul>${links}</ul></section>`
    })
    .join('')
  const main =
    '<main>' +
    `<nav aria-label="パンくず"><a href="/">トップ</a> › 都道府県一覧</nav>` +
    `<h1>${escapeHtml(heading)}</h1>` +
    '<p>都道府県を選ぶと、市区町村ごとの高校一覧が開きます。掲載は所在地の列挙で、学校の序列ではありません。</p>' +
    regions +
    '<p><a href="/">住所から地図でさがす</a></p>' +
    '</main>'
  const withHead = renderHead(template, { title, description, url })
  return withRootContent(withHead, main + FOOTER_HTML)
}

// --- /press と /legal/*（E-E-A-T の機械可読化） ------------------------------

/** public/legal/*.md をビルド時に HTML 化する（React 側 LegalPage と同じ react-markdown で変換）。 */
async function renderLegalHtml(doc) {
  const md = await readFile(join(distDir, 'legal', `${doc}.md`), 'utf8')
  return renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm] }, md))
}

/** public/guide/*.md を React 側 GuidePage と同じ Markdown 実装で HTML 化する。 */
async function renderGuideHtml(slug) {
  const md = await readFile(join(distDir, 'guide', `${slug}.md`), 'utf8')
  return renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm] }, md))
}

const LEGAL_DOCS = [
  { doc: 'terms', title: '利用規約' },
  { doc: 'privacy', title: 'プライバシーポリシー' },
  { doc: 'third-party', title: 'サードパーティライセンス' },
  { doc: 'deviation-methodology', title: '偏差値の方法と限界' },
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
  const main =
    '<main>' +
    '<h1>学校基本情報データセット・公開 API</h1>' +
    `<p>${datasetCoverage}の学校基本情報を、` +
    '出典へ戻れる形で公開しています。</p>' +
    `<p><strong>${escapeHtml(DATASET_CLAIM)}</strong></p>` +
    '<h2>収録基準</h2>' +
    '<p>学校公式 URL を確認できる学校と、学校・教育委員会・官公庁の一次資料へたどれる項目だけを収録します。' +
    '出典を確認できない項目は公開側へ出しません。</p>' +
    '<p>偏差値の編集推計は、数値だけを切り出した序列化を避けるため公開 API には含めません。' +
    'アプリ上では方法と限界の説明と組み合わせて扱います。</p>' +
    '<h2>安定エンドポイント</h2>' +
    '<ul>' +
    '<li><a href="/api/v1/schools.json">全都道府県: /api/v1/schools.json</a></li>' +
    '<li><a href="/api/v1/schools/gunma.json">県別の例: /api/v1/schools/gunma.json</a></li>' +
    '<li><a href="/api/v1/dataset.json">メタデータ: /api/v1/dataset.json</a></li>' +
    '</ul>' +
    '<p>いずれも静的 JSON です。検索条件付きリクエストや POST は提供しません。' +
    '互換性を壊す変更が必要な場合は /api/v2/ を新設し、/api/v1/ は維持します。</p>' +
    '<h2>ライセンスと出典表記</h2>' +
    `<p>データは <a href="${DATASET_LICENSE_URL}">CC BY-SA 4.0</a> です。` +
    `利用・再配布時は「${escapeHtml(DATASET_ATTRIBUTION)}」と表記してください。</p>` +
    '<p><a href="https://github.com/ishizakahiroshi/manabi-map/blob/main/DATA.md" rel="noopener">' +
    '生成方法と詳しい収録方針（DATA.md）</a></p>' +
    '<h2>訂正窓口</h2>' +
    '<p>掲載情報の削除・訂正は <a href="mailto:takedown@manabi-map.app">takedown@manabi-map.app</a> へお知らせください。</p>' +
    '</main>'
  const withHead = renderHead(template, { title, description, url })
  return withRootContent(withJsonLd(withHead, datasetJsonLd), main + FOOTER_HTML)
}

function renderPressPage() {
  const url = `${SITE_ORIGIN}/press/`
  const title = '配布素材・プレスキット | Manabi Map'
  const description =
    'Manabi Map（まなびマップ）のメディア関係者・教育関係者向け基礎情報。運営者・連絡先・配布素材・' +
    '掲載情報の訂正窓口（takedown@manabi-map.app）を公開しています。'
  const main =
    '<main>' +
    '<h1>メディア関係者・教育関係者の方へ</h1>' +
    '<p>Manabi Map（まなびマップ）は、親子で使う「学校選びの地図ノート」です。' +
    '住所を入れると通える高校が地図に表示され、気になる学校をお気に入り保存し、' +
    '文化祭・説明会・通学経路・親子の感想を学校ごとに家族でメモできます。</p>' +
    '<p>序列づけや合否煽りではなく、中学生と保護者が納得して進路を選ぶための管理ツールを目指した' +
    '個人 OSS プロジェクトです。広告は進路・教育関連のみで、無差別アドネットワークは使用しません。</p>' +
    '<h2>サービス基礎情報</h2>' +
    '<dl>' +
    '<dt>サービス名</dt><dd>Manabi Map（まなびマップ）</dd>' +
    `<dt>URL</dt><dd><a href="${SITE_ORIGIN}/">${SITE_ORIGIN}</a></dd>` +
    '<dt>初回公開</dt><dd>2026-07-05（群馬県版）。2026-07-31 に全国 47 都道府県へ拡大</dd>' +
    '<dt>開発者</dt><dd>ishizakahiroshi（個人 OSS）</dd>' +
    '<dt>ライセンス</dt><dd>コード AGPL-3.0 ／ データ CC BY-SA 4.0</dd>' +
    '<dt>料金</dt><dd>無料（広告は進路・教育関連のみ控えめに掲載）</dd>' +
    '<dt>対象</dt><dd>中学生・高校生とその保護者</dd>' +
    '</dl>' +
    '<h2>配布素材</h2>' +
    '<ul>' +
    '<li><a href="/press/manabi-map-poster.pdf">掲示ポスター（A3 縦・PDF）</a></li>' +
    '<li><a href="/press/manabi-map-handout.pdf">保護者配布・面談用 handout（A4 縦・PDF）</a></li>' +
    '</ul>' +
    '<p>進路指導部の先生や保護者へ紹介いただく際に、ご自由にダウンロード・印刷・配布いただけます（改変は不可）。</p>' +
    '<h2>プレスキット</h2>' +
    '<ul>' +
    '<li><a href="/press/press-release.pdf">プレスリリース（PDF）</a></li>' +
    '<li><a href="/press/logo-pack.zip">ロゴ一式（SVG / PNG・ZIP）</a></li>' +
    '</ul>' +
    '<h2>学校・教育委員会向け</h2>' +
    '<p><a href="/press/listing-checklist.html">掲載可否チェックシート（印刷用 HTML）</a>を、校内・保護者向けの紹介前確認にご利用いただけます。</p>' +
    '<h2>取材・お問い合わせ</h2>' +
    '<ul>' +
    '<li>一般のお問い合わせ・取材依頼: <a href="mailto:hello@manabi-map.app">hello@manabi-map.app</a></li>' +
    '<li>掲載情報の削除・訂正要請: <a href="mailto:takedown@manabi-map.app">takedown@manabi-map.app</a>' +
    '（24 時間以内に受信確認 ／ 7 日以内に対応）</li>' +
    '</ul>' +
    '<h2>掲載データについて</h2>' +
    `<p><strong>${escapeHtml(DATASET_CLAIM)}</strong>を公開方針としています。` +
    '学校・教育委員会・官公庁が自ら公表した資料を根拠に編集しています。' +
    '数値の考え方と限界は <a href="/legal/deviation-methodology/">偏差値の方法と限界</a> で公開しています。' +
    'コードは <a href="https://github.com/ishizakahiroshi/manabi-map" rel="noopener">GitHub</a> で公開中です。' +
    '<a href="/data/">公開データセットと API</a> も参照できます。</p>' +
    '</main>'
  const withHead = renderHead(template, { title, description, url })
  return withRootContent(withJsonLd(withHead, ORGANIZATION_JSON_LD), main + FOOTER_HTML)
}

// --- トップへの静的ブロック注入 ---------------------------------------------

function renderTopContent() {
  const regions = Object.entries(REGION_LABELS)
    .map(([key, label]) => {
      const prefs = activePrefectures.filter((p) => p.region === key)
      if (prefs.length === 0) return ''
      const links = prefs
        .map((p) => `<a href="/pref/${p.slug}/">${escapeHtml(p.name)}</a>`)
        .join(' ')
      return `<section><h3>${escapeHtml(label)}</h3><p>${links}</p></section>`
    })
    .join('')
  return (
    '<main>' +
    '<h1>親子で使う、学校選びの地図ノート。</h1>' +
    '<p>住所を入れると、通える高校が地図に表示されます。気になる学校を保存して、家族でメモを残せます。</p>' +
    `<p>${escapeHtml(coverageText(schools))}</p>` +
    `<nav aria-label="一覧から探す"><h2><a href="/schools/">一覧から探す（都道府県）</a></h2>${regions}</nav>` +
    '<section><h2>学校選びガイド</h2><ul>' +
    GUIDES.map((guide) => `<li><a href="/guide/${guide.slug}/">${escapeHtml(guide.navLabel)}</a></li>`).join('') +
    '</ul></section>' +
    '</main>' +
    FOOTER_HTML
  )
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
  const main =
    '<main>' +
    '<h1>ページが見つかりません</h1>' +
    '<p>URL が変更されたか、ページが存在しません。</p>' +
    '<p><a href="/">トップへ（住所から地図でさがす）</a> ／ <a href="/schools/">都道府県一覧</a></p>' +
    '</main>'
  return withRootContent(html, main + FOOTER_HTML)
}

// --- 書き出し ----------------------------------------------------------------

// トップの index.html は収録範囲を差し替え、一覧導線とフッターの静的ブロックを注入した版で上書きする。
// （template は各ページの雛形として使うだけで dist には書き戻らないため、
//   これをやらないとトップだけプレースホルダのまま残る）
// WebSite JSON-LD はテンプレート（index.html）由来。Organization をトップにも注入し、
// /press と `@id` で同一実体として紐づける（c7 C4）。
await writeFile(
  join(distDir, 'index.html'),
  withRootContent(withJsonLd(template, ORGANIZATION_JSON_LD), renderTopContent()),
)

for (const school of targets) {
  const outDir = join(distDir, 'school', school.id)
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'index.html'), renderSchoolPage(school))
}

const prefPages = []
for (const pref of activePrefectures) {
  const prefSchools = targets.filter((s) => s.prefecture === pref.name)
  const outDir = join(distDir, 'pref', pref.slug)
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'index.html'), renderPrefPage(pref, prefSchools))
  prefPages.push(`/pref/${pref.slug}/`)
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
  const body = await renderLegalHtml(doc)
  const withHead = renderHead(template, { title: `${title} | Manabi Map`, description, url })
  const outDir = join(distDir, 'legal', doc)
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'index.html'), withRootContent(withHead, `<main>${body}</main>${FOOTER_HTML}`))
}

for (const guide of GUIDES) {
  const url = `${SITE_ORIGIN}/guide/${guide.slug}/`
  const body = await renderGuideHtml(guide.slug)
  const withHead = renderHead(template, {
    title: `${guide.title} | Manabi Map`,
    description: guide.description,
    url,
  })
  const outDir = join(distDir, 'guide', guide.slug)
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'index.html'), withRootContent(withHead, `<main>${body}</main>${FOOTER_HTML}`))
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
  '- 出典表記: 出典: Manabi Map（まなびマップ） https://manabi-map.app （CC BY-SA 4.0）',
  '- 全件 API: https://manabi-map.app/api/v1/schools.json',
  '- 県別 API: https://manabi-map.app/api/v1/schools/{prefecture}.json',
  '- API メタデータ: https://manabi-map.app/api/v1/dataset.json',
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
