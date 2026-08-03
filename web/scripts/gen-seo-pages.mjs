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
import { loadCivicData, groupSchoolsByCity } from './lib/municipalities.mjs'

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

const { prefectures, muniByPref } = await loadCivicData(webRoot)

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
  out = replaceOrThrow(out, /<title>[\s\S]*?<\/title>/, `<title>${t}</title>`, 'title')
  out = replaceOrThrow(out, /(<meta name="description" content=")[^"]*(")/, `$1${d}$2`, 'meta description')
  out = replaceOrThrow(out, /(<link rel="canonical" href=")[^"]*(")/, `$1${u}$2`, 'canonical')
  out = replaceOrThrow(out, /(<meta property="og:title" content=")[^"]*(")/, `$1${t}$2`, 'og:title')
  out = replaceOrThrow(out, /(<meta property="og:description" content=")[^"]*(")/, `$1${d}$2`, 'og:description')
  out = replaceOrThrow(out, /(<meta property="og:url" content=")[^"]*(")/, `$1${u}$2`, 'og:url')
  out = replaceOrThrow(out, /(<meta name="twitter:title" content=")[^"]*(")/, `$1${t}$2`, 'twitter:title')
  out = replaceOrThrow(out, /(<meta name="twitter:description" content=")[^"]*(")/, `$1${d}$2`, 'twitter:description')
  return out
}

/** JSON-LD を head 閉じタグ直前に注入する。"</script" で script が閉じないようエスケープ。 */
function withJsonLd(html, jsonLd) {
  const script = `<script type="application/ld+json">${JSON.stringify(jsonLd).replaceAll('</', '<\\/')}</script>`
  return replaceOrThrow(html, /<\/head>/, `    ${script}\n  </head>`, 'head 閉じタグ')
}

/** #root に静的コンテンツ（クローラー向けの初期 HTML。mount 時に React が置き換える）を注入。 */
function withRootContent(html, content) {
  return replaceOrThrow(html, /<div id="root"><\/div>/, `<div id="root">${content}</div>`, '#root')
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

function renderSchoolPage(school) {
  const url = `${SITE_ORIGIN}/school/${school.id}/`
  const place = placeLabel(school.prefecture, school.city)
  const typeLabel = school.type === 'kosen' ? '高等専門学校' : '高校'
  const title = `${school.name}（${place}）の地図・アクセス・学科 | Manabi Map`
  const description =
    `${school.name}（${place}）の場所・学科情報。住所を入れると通える${typeLabel}が地図に表示され、` +
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
  const departments = (school.school_departments ?? []).map((d) => d.name).filter(Boolean)
  if (departments.length) rows.push(['学科', departments.join('、')])

  const dl = rows
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
    .join('')
  const officialLink = school.official_url
    ? `<p><a href="${escapeHtml(school.official_url)}" rel="noopener">公式サイト</a></p>`
    : ''

  // SchoolDetailSheet.tsx の showLifecycle と同じ条件。閉校予定・募集停止校が
  // 現役校と同じ体裁で出るのを防ぐ（進路検討サービスとしての信頼に直結するため）。
  const lifecycleLabel = LIFECYCLE_LABELS[school.lifecycle_status_code]
  const recruitmentLabel = RECRUITMENT_LABELS[school.recruitment_status_code]
  const predecessors = school.predecessor_relationships ?? []
  const nameHistory = school.school_name_history ?? []
  const showLifecycle =
    school.lifecycle_status_code !== 'active' ||
    school.recruitment_status_code !== 'recruiting' ||
    predecessors.length > 0 ||
    nameHistory.length > 0 ||
    school.legally_established_on != null ||
    school.opened_on != null

  let lifecycleSection = ''
  if (showLifecycle) {
    const lifecycleRows = [['学校状態', lifecycleLabel], ['募集状態', recruitmentLabel]]
    if (school.legally_established_on) lifecycleRows.push(['法的設置日', school.legally_established_on])
    if (school.opened_on) lifecycleRows.push(['開校日', school.opened_on])
    const lifecycleDl = lifecycleRows
      .filter(([, v]) => v)
      .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
      .join('')
    const predecessorList = predecessors.length
      ? '<p>前身校</p><ul>' +
        predecessors
          .map((r) => {
            const link = safeUrl(r.official_url)
            return (
              `<li>${escapeHtml(r.predecessor?.name ?? '')}` +
              (r.effective_on ? `（${escapeHtml(r.effective_on)}から）` : '') +
              (link ? ` <a href="${escapeHtml(link)}" rel="noopener">公式根拠</a>` : '') +
              `</li>`
            )
          })
          .join('') +
        '</ul>'
      : ''
    const nameHistoryList = nameHistory.length
      ? '<p>旧名称</p><ul>' +
        nameHistory
          .map((h) => `<li>${escapeHtml(h.name)}${h.valid_to ? `（〜${escapeHtml(h.valid_to)}）` : ''}</li>`)
          .join('') +
        '</ul>'
      : ''
    lifecycleSection = `<section><dl>${lifecycleDl}</dl>${predecessorList}${nameHistoryList}</section>`
  }

  // #root の中身はアプリ mount 時に置き換わる（クローラー向けの初期 HTML）。
  const staticContent =
    `<main><h1>${escapeHtml(school.name)}</h1>` +
    (school.name_kana ? `<p>${escapeHtml(school.name_kana)}</p>` : '') +
    `<dl>${dl}</dl>${officialLink}${lifecycleSection}` +
    `<p>Manabi Map（まなびマップ）は、住所を入れると通える${typeLabel}が地図に表示される無料の学校選びサービスです。` +
    `お気に入り保存・見学メモ・家族での共有ができます。</p>` +
    `<p><a href="/">地図で通える学校をさがす</a></p></main>`

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': school.type === 'kosen' ? 'EducationalOrganization' : 'HighSchool',
    name: school.name,
    url,
    address: {
      '@type': 'PostalAddress',
      addressRegion: school.prefecture,
      ...(school.city ? { addressLocality: school.city } : {}),
      ...(school.address
        ? { streetAddress: dedupePrefInAddress(school.address, school.prefecture) }
        : {}),
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
    ...(school.official_url ? { sameAs: school.official_url } : {}),
  }

  const withHead = renderHead(template, { title, description, url })
  return withRootContent(withJsonLd(withHead, jsonLd), staticContent)
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

/** サイト共通フッター（プリレンダー用）。/guide/ は公開まで枠のみ（リンクにしない）。 */
const FOOTER_HTML =
  '<footer><nav aria-label="サイト情報">' +
  '<a href="/press/">プレスキット</a> ' +
  '<a href="/legal/terms/">利用規約</a> ' +
  '<a href="/legal/privacy/">プライバシーポリシー</a> ' +
  '<a href="/legal/deviation-methodology/">偏差値の方法と限界</a> ' +
  '<a href="/legal/third-party/">サードパーティライセンス</a> ' +
  '<span>ガイド（準備中）</span>' +
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

const LEGAL_DOCS = [
  { doc: 'terms', title: '利用規約' },
  { doc: 'privacy', title: 'プライバシーポリシー' },
  { doc: 'third-party', title: 'サードパーティライセンス' },
  { doc: 'deviation-methodology', title: '偏差値の方法と限界' },
]

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
    '<h2>取材・お問い合わせ</h2>' +
    '<ul>' +
    '<li>一般のお問い合わせ・取材依頼: <a href="mailto:hello@manabi-map.app">hello@manabi-map.app</a></li>' +
    '<li>掲載情報の削除・訂正要請: <a href="mailto:takedown@manabi-map.app">takedown@manabi-map.app</a>' +
    '（24 時間以内に受信確認 ／ 7 日以内に対応）</li>' +
    '</ul>' +
    '<h2>掲載データについて</h2>' +
    '<p>収録データは公的資料を根拠に編集しています。商用サイトからの数値転載は行いません。' +
    '数値の考え方と限界は <a href="/legal/deviation-methodology/">偏差値の方法と限界</a> で公開しています。' +
    'コードは <a href="https://github.com/ishizakahiroshi/manabi-map" rel="noopener">GitHub</a> で公開中です。</p>' +
    '</main>'
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
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
  const withHead = renderHead(template, { title, description, url })
  return withRootContent(withJsonLd(withHead, jsonLd), main + FOOTER_HTML)
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
await writeFile(join(distDir, 'index.html'), withRootContent(template, renderTopContent()))

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

for (const { doc, title } of LEGAL_DOCS) {
  const url = `${SITE_ORIGIN}/legal/${doc}/`
  const description = `Manabi Map（まなびマップ）の${title}。運営方針・データの扱い・お問い合わせ窓口を公開しています。`
  const body = await renderLegalHtml(doc)
  const withHead = renderHead(template, { title: `${title} | Manabi Map`, description, url })
  const outDir = join(distDir, 'legal', doc)
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
  { path: '/press/' },
  ...LEGAL_DOCS.map(({ doc }) => ({ path: `/legal/${doc}/` })),
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

console.log(
  `wrote ${targets.length} school pages, ${prefPages.length} pref hubs, ` +
  `${LEGAL_DOCS.length} legal pages, press, 404 and sitemap.xml (${urls.length} urls) to ${distDir}`,
)
