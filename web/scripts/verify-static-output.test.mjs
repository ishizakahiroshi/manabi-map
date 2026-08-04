import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import { verifyStaticOutput } from './verify-static-output.mjs'

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

// 合成データは実在校ではなく架空校（fixture は合成データで書く）。
// prefecture は prefectures.json との突き合わせを検査するため実在県名を使う。
const SCHOOLS = [
  { id: 'synthetic-a', name: '合成第一高等学校', prefecture: '群馬県', latitude: 36.4, longitude: 139.1 },
  { id: 'synthetic-b', name: '合成第二高等学校', prefecture: '群馬県', latitude: 36.5, longitude: 139.2 },
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
    main: '<h1>メディア関係者・教育関係者の方へ</h1>',
    jsonLd: { '@context': 'https://schema.org', '@type': 'Organization', name: 'Manabi Map' },
  }))
  for (const doc of ['terms', 'privacy', 'third-party', 'deviation-methodology']) {
    await mkdir(join(dir, 'legal', doc), { recursive: true })
    await writeFile(join(dir, 'legal', doc, 'index.html'), page({
      title: `${doc} | Manabi Map`,
      canonical: `${ORIGIN}/legal/${doc}/`,
      main: `<h1>${doc}</h1>`,
    }))
  }
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
        { '@context': 'https://schema.org', '@type': 'HighSchool', name: school.name },
        breadcrumbLd(school.name),
      ],
    }))
  }
  await writeFile(join(dir, 'sitemap.xml'), [
    `<loc>${ORIGIN}/</loc>`,
    `<loc>${ORIGIN}/schools/</loc>`,
    `<loc>${ORIGIN}/pref/gunma/</loc>`,
    `<loc>${ORIGIN}/press/</loc>`,
    `<loc>${ORIGIN}/legal/terms/</loc>`,
    `<loc>${ORIGIN}/legal/privacy/</loc>`,
    `<loc>${ORIGIN}/legal/third-party/</loc>`,
    `<loc>${ORIGIN}/legal/deviation-methodology/</loc>`,
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
  assert.equal(result.sitemapUrlCount, 10)
  assert.equal(result.sitemapUniqueUrlCount, 10)
  assert.equal(result.schoolDataCount, 2)
  assert.equal(result.prefDataCount, 1)
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
      { '@context': 'https://schema.org', '@type': 'HighSchool', name: '合成第二高等学校' },
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
    jsonLd: { '@context': 'https://schema.org', '@type': 'HighSchool', name: '合成第二高等学校' },
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
      { '@context': 'https://schema.org', '@type': 'HighSchool', name: '合成第二高等学校' },
      breadcrumbLd('合成第二高等学校'),
    ],
  }))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /admission table without 出典/,
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
