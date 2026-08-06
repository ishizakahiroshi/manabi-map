import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import { verifyStaticOutput } from './verify-static-output.mjs'
import {
  DATASET_ATTRIBUTION,
  DATASET_CLAIM,
  DATASET_LICENSE_URL,
  formatDatasetCoverage,
  toPublicSchoolRecord,
} from './lib/public-api.mjs'

const ORIGIN = 'https://manabi-map.app'

/** 検証対象の骨格（canonical / og:url / title / main）を持つ最小ページを合成する。
 * jsonLd は単体 object でも配列でもよい（配列は本番同様に script タグを分けて出す）。 */
function page({ title, canonical, main, jsonLd, noindex = false }) {
  const canonicalTag = canonical ? `<link rel="canonical" href="${canonical}">` : ''
  const ogUrl = canonical ? `<meta property="og:url" content="${canonical}">` : ''
  const robots = noindex ? '<meta name="robots" content="noindex" />' : ''
  const jsonLdTag = (Array.isArray(jsonLd) ? jsonLd : jsonLd ? [jsonLd] : [])
    .map((block) => `<script type="application/ld+json">${JSON.stringify(block)}</script>`)
    .join('')
  return `<!doctype html><html><head><title>${title}</title>${robots}${canonicalTag}${ogUrl}${jsonLdTag}</head>` +
    `<body><div id="root"><main>${main}</main></div></body></html>`
}

/** 学校ページの BreadcrumbList JSON-LD（本番: ホーム › 県 › 市区町村 › 校名）。 */
function breadcrumbLd(schoolName) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'ホーム', item: `${ORIGIN}/` },
      { '@type': 'ListItem', position: 2, name: '群馬県', item: `${ORIGIN}/pref/gunma/` },
      { '@type': 'ListItem', position: 3, name: '前橋市' },
      { '@type': 'ListItem', position: 4, name: schoolName },
    ],
  }
}

function schoolLd(schoolName) {
  return {
    '@context': 'https://schema.org',
    '@type': 'HighSchool',
    name: schoolName,
    license: DATASET_LICENSE_URL,
    creditText: DATASET_ATTRIBUTION,
  }
}

// 合成データは実在校ではなく架空校（fixture は合成データで書く）。
// prefecture は prefectures.json との突き合わせを検査するため実在県名を使う。
const SCHOOLS = [
  { id: 'synthetic-a', name: '合成第一高等学校', prefecture: '群馬県', city: '前橋市', latitude: 36.4, longitude: 139.1, official_url: 'https://synthetic-a.ed.jp/', is_active: true },
  { id: 'synthetic-b', name: '合成第二高等学校', prefecture: '群馬県', city: '前橋市', latitude: 36.5, longitude: 139.2, official_url: 'https://synthetic-b.ed.jp/', is_active: true },
]

async function syntheticDist() {
  const dir = await mkdtemp(join(tmpdir(), 'manabi-map-static-'))
  const body = Buffer.from(JSON.stringify({ formatVersion: 2, sourceCatalog: [], schools: SCHOOLS }))
  // 拡張子ではなくmagic byteを見ることを検証するため、gzipを.json名で保存する。
  await writeFile(join(dir, 'schools-a1b2c3d4e5.json'), gzipSync(body))
  await writeFile(join(dir, 'city-index-0123456789.json'), JSON.stringify([
    { pref: '群馬県', prefSlug: 'gunma', city: '前橋市', kana: 'まえばしし', count: 2 },
  ]))
  await writeFile(join(dir, 'school-name-index-0123456789.json'), JSON.stringify(
    SCHOOLS.map((s) => ({ i: s.id, n: s.name, k: null, p: s.prefecture, c: '前橋市', lat: s.latitude, lng: s.longitude })),
  ))
  await writeFile(join(dir, 'schools-manifest.json'), JSON.stringify({
    url: '/schools-a1b2c3d4e5.json', count: SCHOOLS.length, compression: 'gzip',
    cityIndexUrl: '/city-index-0123456789.json', nameIndexUrl: '/school-name-index-0123456789.json',
    schoolDataVersion: 'a1b2c3d4e5', schoolDataCount: SCHOOLS.length,
    prefDataUrls: { gunma: '/school-data/pref-gunma.json' },
  }))

  // 学校単体 JSON / 県別分割 JSON（c7 C1）
  await mkdir(join(dir, 'school-data'), { recursive: true })
  for (const school of SCHOOLS) {
    const neighbor = SCHOOLS.find((s) => s.id !== school.id)
    await writeFile(join(dir, 'school-data', `${school.id}.json`), JSON.stringify({
      formatVersion: 2,
      sourceCatalog: [],
      schools: [school],
      neighbors: [{ id: neighbor.id, name: neighbor.name, prefecture: neighbor.prefecture, city: '前橋市', distanceKm: 1.0 }],
      successors: [],
      linkableSchoolIds: [],
    }))
  }
  await writeFile(join(dir, 'school-data', 'pref-gunma.json'), JSON.stringify({
    formatVersion: 2, sourceCatalog: [], schools: SCHOOLS,
  }))

  const publicSchools = SCHOOLS.map((school) => ({
    id: school.id,
    name: school.name,
    prefecture: school.prefecture,
    official_url: school.official_url,
    provenance: { official_url: school.official_url, last_built_at: '2026-08-06T00:00:00.000Z', field_sources: [] },
  }))
  await mkdir(join(dir, 'api', 'v1', 'schools'), { recursive: true })
  await writeFile(join(dir, 'api', 'v1', 'schools.json'), JSON.stringify({
    api_version: 'v1', generated_at: '2026-08-06T00:00:00.000Z',
    count: publicSchools.length, schools: publicSchools,
  }))
  await writeFile(join(dir, 'api', 'v1', 'schools', 'gunma.json'), JSON.stringify({
    api_version: 'v1', generated_at: '2026-08-06T00:00:00.000Z',
    prefecture: '群馬県', count: publicSchools.length, schools: publicSchools,
  }))
  await writeFile(join(dir, 'api', 'v1', 'dataset.json'), JSON.stringify({
    api_version: 'v1',
    generated_at: '2026-08-06T00:00:00.000Z',
    school_count: publicSchools.length,
    prefecture_count: 1,
    prefectures: { gunma: publicSchools.length },
    provenance_policy: DATASET_CLAIM,
    license_url: DATASET_LICENSE_URL,
  }))

  await writeFile(join(dir, 'index.html'), page({
    title: 'Manabi Map',
    canonical: `${ORIGIN}/`,
    main: '<h1>親子で使う、学校選びの地図ノート。</h1><nav><a href="/pref/gunma/">群馬県</a></nav>',
    jsonLd: [
      { '@context': 'https://schema.org', '@type': 'WebSite', '@id': `${ORIGIN}/#website`, name: 'Manabi Map' },
      { '@context': 'https://schema.org', '@type': 'Organization', '@id': `${ORIGIN}/#organization`, name: 'Manabi Map' },
    ],
  }))
  await mkdir(join(dir, 'schools'), { recursive: true })
  await writeFile(join(dir, 'schools', 'index.html'), page({
    title: '高校一覧 | Manabi Map',
    canonical: `${ORIGIN}/schools/`,
    main: '<h1>高校一覧</h1><ul><li><a href="/pref/gunma/">群馬県の高校一覧（2 校）</a></li></ul>',
  }))
  await mkdir(join(dir, 'pref', 'gunma'), { recursive: true })
  await writeFile(join(dir, 'pref', 'gunma', 'index.html'), page({
    title: '群馬県の高校一覧（2 校） | Manabi Map',
    canonical: `${ORIGIN}/pref/gunma/`,
    main: '<h1>群馬県の高校一覧（2 校）</h1>' +
      '<nav><a href="#%E5%89%8D%E6%A9%8B%E5%B8%82">前橋市（2）</a></nav>' +
      '<section id="前橋市"><h2>前橋市（2 校）</h2><ul>' +
      SCHOOLS.map((s) => `<li><a href="/school/${s.id}/">${s.name}</a></li>`).join('') +
      '</ul></section>',
  }))
  await mkdir(join(dir, 'press'), { recursive: true })
  await writeFile(join(dir, 'press', 'index.html'), page({
    title: '配布素材・プレスキット | Manabi Map',
    canonical: `${ORIGIN}/press/`,
    main: `<h1>メディア関係者・教育関係者の方へ</h1><p>${DATASET_CLAIM}</p>`,
    jsonLd: { '@context': 'https://schema.org', '@type': 'Organization', name: 'Manabi Map' },
  }))
  await mkdir(join(dir, 'data'), { recursive: true })
  await writeFile(join(dir, 'data', 'index.html'), page({
    title: '学校基本情報データセット・公開 API | Manabi Map',
    canonical: `${ORIGIN}/data/`,
    main: `<h1>学校基本情報データセット・公開 API</h1>` +
      `<p>1 都道府県・${publicSchools.length} 校の学校基本情報を公開しています。</p>` +
      `<p>${DATASET_CLAIM}</p>` +
      '<a href="/api/v1/schools.json">API</a>',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Dataset',
      license: DATASET_LICENSE_URL,
      distribution: [{ '@type': 'DataDownload', contentUrl: `${ORIGIN}/api/v1/schools.json` }],
    },
  }))
  for (const doc of ['terms', 'privacy', 'third-party', 'deviation-methodology']) {
    await mkdir(join(dir, 'legal', doc), { recursive: true })
    await writeFile(join(dir, 'legal', doc, 'index.html'), page({
      title: `${doc} | Manabi Map`,
      canonical: `${ORIGIN}/legal/${doc}/`,
      main: `<h1>${doc}</h1>`,
    }))
  }
  for (const slug of ['commute-time', 'school-visit', 'deviation-with-care']) {
    await mkdir(join(dir, 'guide', slug), { recursive: true })
    await writeFile(join(dir, 'guide', slug, 'index.html'), page({
      title: `${slug} | Manabi Map`,
      canonical: `${ORIGIN}/guide/${slug}/`,
      main: `<h1>${slug}</h1><p>学校選びのためのガイドです。</p>`,
    }))
  }
  await writeFile(join(dir, 'llms.txt'), [
    '# Manabi Map',
    '',
    'CC BY-SA 4.0',
    DATASET_CLAIM,
    `${ORIGIN}/data/`,
    `${ORIGIN}/api/v1/schools.json`,
    '',
  ].join('\n'))
  await writeFile(join(dir, '404.html'), page({
    title: 'ページが見つかりません | Manabi Map',
    canonical: null,
    noindex: true,
    main: '<h1>ページが見つかりません</h1>',
  }))
  for (const school of SCHOOLS) {
    const schoolDir = join(dir, 'school', school.id)
    await mkdir(schoolDir, { recursive: true })
    const neighbor = SCHOOLS.find((s) => s.id !== school.id)
    await writeFile(join(schoolDir, 'index.html'), page({
      title: `${school.name}（${school.prefecture}前橋市）の地図・アクセス・学科 | Manabi Map`,
      canonical: `${ORIGIN}/school/${school.id}/`,
      main: `<h1>${school.name}</h1>` +
        `<section><h2>${school.name}の近くにある高校</h2>` +
        '<p>直線距離の近い順に 1 校。実際の通学経路・所要時間は交通手段により異なります。</p>' +
        `<ul><li><a href="/school/${neighbor.id}/">${neighbor.name}</a>（前橋市・約 1.0 km）</li></ul></section>`,
      jsonLd: [
        schoolLd(school.name),
        breadcrumbLd(school.name),
      ],
    }))
  }
  await writeFile(join(dir, 'sitemap.xml'), [
    `<loc>${ORIGIN}/</loc>`,
    `<loc>${ORIGIN}/schools/</loc>`,
    `<loc>${ORIGIN}/pref/gunma/</loc>`,
    `<loc>${ORIGIN}/data/</loc>`,
    `<loc>${ORIGIN}/press/</loc>`,
    `<loc>${ORIGIN}/legal/terms/</loc>`,
    `<loc>${ORIGIN}/legal/privacy/</loc>`,
    `<loc>${ORIGIN}/legal/third-party/</loc>`,
    `<loc>${ORIGIN}/legal/deviation-methodology/</loc>`,
    '<loc>https://manabi-map.app/guide/commute-time/</loc>',
    '<loc>https://manabi-map.app/guide/school-visit/</loc>',
    '<loc>https://manabi-map.app/guide/deviation-with-care/</loc>',
    ...SCHOOLS.map((s) => `<loc>${ORIGIN}/school/${s.id}/</loc>`),
  ].join('\n'))
  return dir
}

test('gzip magic, manifest, sitemap, all pages and size gate pass together', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const result = await verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 })
  assert.equal(result.schoolsPayloadGzip, true)
  assert.equal(result.schoolCount, 2)
  assert.equal(result.seoSchoolCount, 2)
  assert.equal(result.prefPageCount, 1)
  assert.equal(result.sitemapUrlCount, 14)
  assert.equal(result.sitemapUniqueUrlCount, 14)
  assert.equal(result.schoolDataCount, 2)
  assert.equal(result.prefDataCount, 1)
  assert.equal(result.publicApiSchoolCount, 2)
  assert.equal(result.publicApiPrefCount, 1)
})

test('a file exactly at the limit is rejected because the contract is strictly under 25 MiB', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'at-limit.bin'), Buffer.alloc(64))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 64 }),
    /must be smaller than 64 bytes/,
  )
})

test('sitemap count drift is rejected', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'sitemap.xml'), `<loc>${ORIGIN}/</loc>`)
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /sitemap mismatch/,
  )
})

test('a duplicate allowed sitemap URL cannot replace a required school URL', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'sitemap.xml'), [
    `<loc>${ORIGIN}/</loc>`,
    `<loc>${ORIGIN}/school/synthetic-a/</loc>`,
    `<loc>${ORIGIN}/school/synthetic-a/</loc>`,
  ].join('\n'))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /sitemap contains duplicate URLs/,
  )
})

test('a non-representative school directory without index.html is rejected', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await rm(join(dir, 'school', 'synthetic-b', 'index.html'))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /SEO school page count mismatch|prerendered page is missing/,
  )
})

test('a wrong canonical on any single school page is rejected', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'school', 'synthetic-b', 'index.html'), page({
    title: '合成第二高等学校 | Manabi Map',
    canonical: `${ORIGIN}/`,
    main: '<h1>合成第二高等学校</h1>',
    jsonLd: { name: '合成第二高等学校' },
  }))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /canonical mismatch on \/school\/synthetic-b\//,
  )
})

test('a dangerous href scheme on any school page is rejected', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'school', 'synthetic-b', 'index.html'), page({
    title: '合成第二高等学校 | Manabi Map',
    canonical: `${ORIGIN}/school/synthetic-b/`,
    main: '<h1>合成第二高等学校</h1>' +
      '<a href="javascript:alert(1)">危険な合成リンク</a>' +
      '<section><h2>合成第二高等学校の近くにある高校</h2>' +
      '<p>直線距離の近い順に 1 校。</p>' +
      '<ul><li><a href="/school/synthetic-a/">合成第一高等学校</a>（前橋市・約 1.0 km）</li></ul></section>',
    jsonLd: [
      schoolLd('合成第二高等学校'),
      breadcrumbLd('合成第二高等学校'),
    ],
  }))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /unsafe href scheme on \/school\/synthetic-b\//,
  )
})

test('a forbidden ranking word in a pref hub is rejected', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'pref', 'gunma', 'index.html'), page({
    title: '群馬県の高校一覧（2 校） | Manabi Map',
    canonical: `${ORIGIN}/pref/gunma/`,
    main: '<h1>群馬県の高校一覧（2 校）</h1><p>偏差値ランキング</p>' +
      SCHOOLS.map((s) => `<a href="/school/${s.id}/">${s.name}</a>`).join(''),
  }))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /forbidden word/,
  )
})

test('a school page without the neighbor section is rejected', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'school', 'synthetic-b', 'index.html'), page({
    title: '合成第二高等学校（群馬県前橋市）の地図・アクセス・学科 | Manabi Map',
    canonical: `${ORIGIN}/school/synthetic-b/`,
    main: '<h1>合成第二高等学校</h1>',
    jsonLd: [
      schoolLd('合成第二高等学校'),
      breadcrumbLd('合成第二高等学校'),
    ],
  }))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /missing neighbor section heading/,
  )
})

test('a school page without BreadcrumbList JSON-LD is rejected', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'school', 'synthetic-b', 'index.html'), page({
    title: '合成第二高等学校（群馬県前橋市）の地図・アクセス・学科 | Manabi Map',
    canonical: `${ORIGIN}/school/synthetic-b/`,
    main: '<h1>合成第二高等学校</h1>' +
      '<section><h2>合成第二高等学校の近くにある高校</h2>' +
      '<p>直線距離の近い順に 1 校。</p>' +
      '<ul><li><a href="/school/synthetic-a/">合成第一高等学校</a>（前橋市・約 1.0 km）</li></ul></section>',
    jsonLd: schoolLd('合成第二高等学校'),
  }))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /BreadcrumbList JSON-LD is missing or too short/,
  )
})

test('a missing per-school JSON is rejected', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await rm(join(dir, 'school-data', 'synthetic-b.json'))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /school-data count mismatch|school-data JSON is missing/,
  )
})

test('an admission year table without 出典 is rejected', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'school', 'synthetic-b', 'index.html'), page({
    title: '合成第二高等学校（群馬県前橋市）の地図・アクセス・学科 | Manabi Map',
    canonical: `${ORIGIN}/school/synthetic-b/`,
    main: '<h1>合成第二高等学校</h1>' +
      '<section><h2>合成第二高等学校の年度別志願状況（一次募集）</h2><table></table></section>' +
      '<section><h2>合成第二高等学校の近くにある高校</h2>' +
      '<p>直線距離の近い順に 1 校。</p>' +
      '<ul><li><a href="/school/synthetic-a/">合成第一高等学校</a>（前橋市・約 1.0 km）</li></ul></section>',
    jsonLd: [
      schoolLd('合成第二高等学校'),
      breadcrumbLd('合成第二高等学校'),
    ],
  }))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /admission table without 出典/,
  )
})

test('an admission year table with only a source label is rejected', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'school', 'synthetic-b', 'index.html'), page({
    title: '合成第二高等学校（群馬県前橋市）の地図・アクセス・学科 | Manabi Map',
    canonical: `${ORIGIN}/school/synthetic-b/`,
    main: '<h1>合成第二高等学校</h1>' +
      '<section><h2>合成第二高等学校の年度別志願状況（一次募集）</h2><table></table>' +
      '<p>出典: 合成資料</p></section>' +
      '<section><h2>合成第二高等学校の近くにある高校</h2>' +
      '<p>直線距離の近い順に 1 校。</p>' +
      '<ul><li><a href="/school/synthetic-a/">合成第一高等学校</a>（前橋市・約 1.0 km）</li></ul></section>',
    jsonLd: [
      schoolLd('合成第二高等学校'),
      breadcrumbLd('合成第二高等学校'),
    ],
  }))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /admission table without 出典 URL/,
  )
})

test('a 404 page that declares canonical is rejected', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, '404.html'), page({
    title: 'ページが見つかりません | Manabi Map',
    canonical: `${ORIGIN}/`,
    noindex: true,
    main: '<h1>ページが見つかりません</h1>',
  }))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /404\.html must not declare a canonical URL/,
  )
})

test('a deviation field anywhere under /api/v1/ is rejected', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'api', 'v1', 'schools.json')
  const payload = JSON.parse(await readFile(path, 'utf8'))
  payload.schools[1].school_deviation_values = [{ value: 99 }]
  await writeFile(path, JSON.stringify(payload))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /deviation data found/,
  )
})

test('a public API record without official_url is rejected', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'api', 'v1', 'schools.json')
  const payload = JSON.parse(await readFile(path, 'utf8'))
  payload.schools[1].official_url = null
  await writeFile(path, JSON.stringify(payload))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /missing official_url or provenance/,
  )
})

test('an eligible school omitted from both public API payloads is rejected', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))

  for (const path of [
    join(dir, 'api', 'v1', 'schools.json'),
    join(dir, 'api', 'v1', 'schools', 'gunma.json'),
  ]) {
    const payload = JSON.parse(await readFile(path, 'utf8'))
    payload.schools = payload.schools.slice(0, 1)
    payload.count = payload.schools.length
    await writeFile(path, JSON.stringify(payload))
  }
  const metadataPath = join(dir, 'api', 'v1', 'dataset.json')
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
  metadata.school_count = 1
  metadata.prefectures.gunma = 1
  await writeFile(metadataPath, JSON.stringify(metadata))

  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /public API inclusion gate mismatch/,
  )
})

test('a missing prefecture API file reports the missing source prefecture slug', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await rm(join(dir, 'api', 'v1', 'schools', 'gunma.json'))

  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /missing source prefectures: gunma/,
  )
})

test('an admission metric without its matching source is rejected', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'api', 'v1', 'schools.json')
  const payload = JSON.parse(await readFile(path, 'utf8'))
  payload.schools[0].admission_recruitment_units = [{
    statistics: [{
      capacity: 100,
      sources: [{ fact_kind_code: 'applicants', official_url: 'https://synthetic-a.ed.jp/data.pdf' }],
    }],
  }]
  await writeFile(path, JSON.stringify(payload))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /public admission metric is missing its source/,
  )
})

test('a Wikipedia field source in the public API is rejected', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'api', 'v1', 'schools.json')
  const payload = JSON.parse(await readFile(path, 'utf8'))
  payload.schools[0].provenance.field_sources.push({
    field_name: 'school_departments.name',
    official_url: 'https://ja.wikipedia.org/wiki/合成高等学校',
  })
  await writeFile(path, JSON.stringify(payload))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /forbidden source domain/,
  )
})

test('a reviewed private-school association source host is accepted', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const path of [
    join(dir, 'api', 'v1', 'schools.json'),
    join(dir, 'api', 'v1', 'schools', 'gunma.json'),
  ]) {
    const payload = JSON.parse(await readFile(path, 'utf8'))
    payload.schools[0].provenance.field_sources.push({
      field_name: 'school_departments.name',
      official_url: 'https://www.aichi-shigaku.gr.jp/official-catalog.pdf',
    })
    await writeFile(path, JSON.stringify(payload))
  }
  await verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 })
})

test('an unreviewed gr.jp source host is rejected', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'api', 'v1', 'schools.json')
  const payload = JSON.parse(await readFile(path, 'utf8'))
  payload.schools[0].provenance.field_sources.push({
    field_name: 'school_departments.name',
    official_url: 'https://unreviewed-example.gr.jp/catalog.pdf',
  })
  await writeFile(path, JSON.stringify(payload))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /unregistered source domain/,
  )
})

test('/data/ without Dataset JSON-LD is rejected', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'data', 'index.html'), page({
    title: '学校基本情報データセット・公開 API | Manabi Map',
    canonical: `${ORIGIN}/data/`,
    main: `<h1>学校基本情報データセット・公開 API</h1>` +
      `<p>1 都道府県・${SCHOOLS.length} 校</p><p>${DATASET_CLAIM}</p>`,
  }))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /missing required Dataset JSON-LD/,
  )
})

test('/data/ cannot claim nationwide coverage for a partial-prefecture dataset', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'data', 'index.html')
  const html = await readFile(path, 'utf8')
  await writeFile(path, html.replace('1 都道府県・2 校', '全国 1 都道府県・2 校'))

  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /must not claim nationwide coverage/,
  )
})

test('dataset coverage uses nationwide only when every canonical prefecture is present', () => {
  assert.equal(formatDatasetCoverage(36, 3415, 47), '36 都道府県・3,415 校')
  assert.equal(formatDatasetCoverage(47, 4931, 47), '全国 47 都道府県・4,931 校')
})

test('a school JSON-LD without license is rejected', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'school', 'synthetic-b', 'index.html'), page({
    title: '合成第二高等学校（群馬県前橋市）の地図・アクセス・学科 | Manabi Map',
    canonical: `${ORIGIN}/school/synthetic-b/`,
    main: '<h1>合成第二高等学校</h1>' +
      '<section><h2>合成第二高等学校の近くにある高校</h2>' +
      '<p>直線距離の近い順に 1 校。</p>' +
      '<ul><li><a href="/school/synthetic-a/">合成第一高等学校</a>（前橋市・約 1.0 km）</li></ul></section>',
    jsonLd: [
      { '@context': 'https://schema.org', '@type': 'HighSchool', name: '合成第二高等学校' },
      breadcrumbLd('合成第二高等学校'),
    ],
  }))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /missing license or creditText/,
  )
})

test('the public API allowlist omits deviation data and unsourced optional fields', () => {
  const builtAt = '2026-08-06T00:00:00.000Z'
  const row = {
    id: 'synthetic-public',
    record_key: 'synthetic-public',
    name: '合成公開高等学校',
    name_kana: 'ごうせいこうかいこうとうがっこう',
    type: 'high_school',
    ownership: 'private',
    gender_type: 'coed',
    prefecture: '群馬県',
    city: '前橋市',
    address: '群馬県前橋市合成町1-1',
    postal_code: '000-0000',
    latitude: 36.4,
    longitude: 139.1,
    official_url: 'https://synthetic-public.ed.jp/',
    course_times: ['fulltime'],
    campus_type: 'main',
    is_active: true,
    total_students: 300,
    enrollment_year: 2026,
    male_ratio: 55,
    created_at: '2026-01-01T00:00:00Z',
    school_deviation_values: [{ value: 99 }],
    school_field_sources: [
      { field_name: 'schools.total_students', official_url: 'https://synthetic-public.ed.jp/data.pdf', is_official_source: true },
      { field_name: 'schools.enrollment_year', official_url: 'https://ja.wikipedia.org/wiki/example', is_official_source: false },
      { field_name: 'schools.latitude', official_url: 'https://ja.wikipedia.org/wiki/example', is_official_source: false },
    ],
    admission_recruitment_units: [],
  }
  const result = toPublicSchoolRecord(row, [], builtAt)
  assert.equal(result.total_students, 300)
  assert.equal('enrollment_year' in result, false)
  assert.equal('male_ratio' in result, false)
  assert.equal('latitude' in result, false)
  assert.equal(result.longitude, 139.1)
  assert.equal('school_deviation_values' in result, false)
  assert.equal('created_at' in result, false)
  assert.equal(result.provenance.field_sources.length, 1)
  assert.equal(result.provenance.last_built_at, builtAt)
})
