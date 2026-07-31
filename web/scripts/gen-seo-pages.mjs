// ビルド後に実行する SEO ページ生成スクリプト。
//
//   node scripts/gen-seo-pages.mjs [--dist <dir>]
//
// dist/index.html をテンプレートに、dist/schools.json の全校分
// dist/school/<id>/index.html（固有 title / description / OGP / canonical /
// JSON-LD / 静的コンテンツ）と dist/sitemap.xml を生成する。
// Cloudflare Pages は静的ファイルを _redirects の SPA fallback より優先して
// 配信するため、既存の `/* /index.html 200` と共存できる。
//
// 注意: §7.7 表示規約により、偏差値はプリレンダー内容に一切含めない。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

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

/** テンプレートの head 部を学校固有の値に置き換える。 */
function renderHead(html, { title, description, url }) {
  const t = escapeHtml(title)
  const d = escapeHtml(description)
  const u = escapeHtml(url)
  return html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${t}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${d}$2`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${u}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${t}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${d}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${u}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${t}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${d}$2`)
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

function renderSchoolPage(school) {
  const url = `${SITE_ORIGIN}/school/${school.id}`
  const place = placeLabel(school.prefecture, school.city)
  const typeLabel = school.type === 'kosen' ? '高等専門学校' : '高校'
  const title = `${school.name}（${place}）の地図・アクセス・学科 | Manabi Map`
  const description =
    `${school.name}（${place}）の場所・学科情報。住所を入れると通える${typeLabel}が地図に表示され、` +
    '通学時間の目安の確認や見学メモの家族共有ができる無料の学校選びサービスです。'

  const rows = []
  // address は既に prefecture + city を含む完全表記が入っている想定。
  // 未設定のときだけ prefecture + city を組み立てて代替する。
  const addressText = school.address ?? placeLabel(school.prefecture, school.city)
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

  // #root の中身はアプリ mount 時に置き換わる（クローラー向けの初期 HTML）。
  const staticContent =
    `<main><h1>${escapeHtml(school.name)}</h1>` +
    (school.name_kana ? `<p>${escapeHtml(school.name_kana)}</p>` : '') +
    `<dl>${dl}</dl>${officialLink}` +
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
      ...(school.address ? { streetAddress: school.address } : {}),
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
  // JSON 内の "</script" で script 要素が閉じないようエスケープする。
  const jsonLdScript = `<script type="application/ld+json">${JSON.stringify(jsonLd).replaceAll('</', '<\\/')}</script>`

  return renderHead(template, { title, description, url })
    .replace('</head>', `    ${jsonLdScript}\n  </head>`)
    .replace('<div id="root"></div>', `<div id="root">${staticContent}</div>`)
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

// トップの index.html も収録範囲を差し替えた版で上書きする。
// （template は学校ページの雛形として使うだけで dist には書き戻らないため、
//   これをやらないとトップだけプレースホルダのまま残る）
await writeFile(join(distDir, 'index.html'), template)

for (const school of targets) {
  const outDir = join(distDir, 'school', school.id)
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'index.html'), renderSchoolPage(school))
}

const today = new Date().toISOString().slice(0, 10)
const urls = ['/', '/search', ...targets.map((s) => `/school/${s.id}`)]
const sitemap =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  urls
    .map((p) => `  <url><loc>${SITE_ORIGIN}${escapeHtml(p)}</loc><lastmod>${today}</lastmod></url>`)
    .join('\n') +
  '\n</urlset>\n'
await writeFile(join(distDir, 'sitemap.xml'), sitemap)

console.log(`wrote ${targets.length} school pages and sitemap.xml (${urls.length} urls) to ${distDir}`)
