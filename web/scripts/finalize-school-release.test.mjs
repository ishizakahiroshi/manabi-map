import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync, gunzipSync } from 'node:zlib'
import { canonicalSchoolSourceJSON } from './lib/school-source.mjs'
import { validateSchoolRelease } from './lib/school-release.mjs'
import { schoolInventory } from './lib/school-functions-package.mjs'
import { produceSchoolRelease } from './lib/school-release-producer.mjs'
import { verifyStaticOutput } from './verify-static-output.mjs'
import { compileSchoolFunctionsCandidate, createSchoolReleaseCompletion, finalizeObservedSchoolBuild,
  parseFinalizeSchoolReleaseArgs } from './finalize-school-release.mjs'
import { cityPageDescription } from './lib/city-breakdown.mjs'
import { DEPT_GROUP_CODES } from './lib/dept-groups-shared.mjs'
import { buildOpenApiDocument, DATASET_ATTRIBUTION, DATASET_CLAIM, DATASET_LICENSE_URL,
  toPublicSchoolRecord } from './lib/public-api.mjs'
import { SITE_ORIGIN } from './lib/site.mjs'

const ORIGIN = SITE_ORIGIN
const scriptsDir = dirname(fileURLToPath(import.meta.url))
const SITE_FOOTER_LINKS = JSON.parse(await fs.readFile(join(scriptsDir, '..', 'data/site-footer-links.json'), 'utf8'))
const ROUTES_JSON_TEXT = await fs.readFile(join(scriptsDir, '..', 'public/_routes.json'), 'utf8')
const DATASET_VERSION = '0.0.0-synthetic'
const MAEBASHI_PATH = `/pref/gunma/${encodeURIComponent('前橋市')}/`
const SCHOOL_TIMESTAMP = '2026-08-06T00:00:00.000Z'
const digest = (value) => createHash('sha256').update(value).digest('hex')
const canonical = (value) => Buffer.from(`${canonicalSchoolSourceJSON(value)}\n`)

function page({ title, canonical: canonicalUrl, main, jsonLd, noindex = false, footer = '', mainAttrs = '', initialData = null, description = null }) {
  const canonicalTag = canonicalUrl ? `<link rel="canonical" href="${canonicalUrl}">` : ''
  const descriptionTag = description ? `<meta name="description" content="${description}">` : ''
  const ogUrl = canonicalUrl ? `<meta property="og:url" content="${canonicalUrl}">` : ''
  const robots = noindex ? '<meta name="robots" content="noindex" />' : ''
  const jsonLdTag = (Array.isArray(jsonLd) ? jsonLd : jsonLd ? [jsonLd] : [])
    .map((block) => `<script type="application/ld+json">${JSON.stringify(block)}</script>`).join('')
  const mainOpen = mainAttrs ? `<main ${mainAttrs}>` : '<main>'
  const initial = initialData != null ? `<script type="application/json" id="__MM_INITIAL__">${JSON.stringify(initialData).replace(/</g, '\\u003c')}</script>` : ''
  return `<!doctype html><html><head><title>${title}</title>${robots}${descriptionTag}${canonicalTag}${ogUrl}${jsonLdTag}</head><body><div id="root">${mainOpen}${main}</main></div>${initial}${footer}</body></html>`
}
function syntheticFooterHtml() {
  return '<footer><nav aria-label="サイト情報">' + SITE_FOOTER_LINKS.links.map(({ path, ja }) => `<a href="${path}/">${ja}</a>`).join(' ') + '</nav></footer>'
}
function schoolLd(name) { return { '@context': 'https://schema.org', '@type': 'HighSchool', name, license: DATASET_LICENSE_URL, creditText: DATASET_ATTRIBUTION } }
function breadcrumbLd(name) { return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
  { '@type': 'ListItem', position: 1, name: 'ホーム', item: `${ORIGIN}/` },
  { '@type': 'ListItem', position: 2, name: '群馬県', item: `${ORIGIN}/pref/gunma/` },
  { '@type': 'ListItem', position: 3, name: '前橋市', item: `${ORIGIN}${MAEBASHI_PATH}` },
  { '@type': 'ListItem', position: 4, name },
] } }
const schools = [
  { id: 'synthetic-a', name: '合成第一高等学校', prefecture: '群馬県', city: '前橋市', latitude: 36.4, longitude: 139.1, official_url: 'https://synthetic-a.ed.jp/', is_active: true },
  { id: 'synthetic-b', name: '合成第二高等学校', prefecture: '群馬県', city: '前橋市', latitude: 36.5, longitude: 139.2, official_url: 'https://synthetic-b.ed.jp/', is_active: true },
]
const mapSchools = schools.map((school) => ({ ...school, type: 'high_school', ownership: 'prefectural', gender_type: 'coed',
  is_integrated: school.id === 'synthetic-a', address: `${school.prefecture}${school.city}1-1-1`, course_times: ['fulltime'],
  school_departments: [{ id: `${school.id}-dept`, school_id: school.id, name: '普通科', course_type: 'general', ui_group: 'general' }],
  school_deviation_values: [{ department_id: `${school.id}-dept`, value: 50, is_active: true }], latest_primary_admission: { year: 2025, ratio: 1.1 } }))
const citySchools = schools.map((school) => ({ i: school.id, n: school.name, k: null, c: school.city, o: 'prefectural',
  ls: 'active', rs: 'recruiting', ct: ['fulltime'], g: 'coed', dg: [DEPT_GROUP_CODES.general],
  ...(school.id === 'synthetic-a' ? { ig: true } : {}), lat: school.latitude, lng: school.longitude }))
function syntheticOpenApi() { return buildOpenApiDocument({ version: DATASET_VERSION, prefectureSlugs: ['gunma'], origin: ORIGIN }) }

async function syntheticDist() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'school-finalizer-synthetic-'))
  const body = Buffer.from(JSON.stringify({ formatVersion: 2, sourceCatalog: [], schools }))
  await fs.writeFile(join(dir, 'schools-a1b2c3d4e5.json'), gzipSync(body))
  await fs.writeFile(join(dir, 'schools-map-b2c3d4e5f6.json.gz'), gzipSync(Buffer.from(JSON.stringify({ formatVersion: 2, sourceCatalog: [], schools: mapSchools }))))
  await fs.writeFile(join(dir, 'city-index-0123456789.json'), JSON.stringify([{ pref: '群馬県', prefSlug: 'gunma', city: '前橋市', kana: 'まえばしし', count: 2 }]))
  await fs.writeFile(join(dir, 'school-name-index-0123456789.json'), JSON.stringify(schools.map((s) => ({ i: s.id, n: s.name, k: null, p: s.prefecture, c: s.city, lat: s.latitude, lng: s.longitude }))))
  const manifest = { url: '/schools-a1b2c3d4e5.json', count: 2, compression: 'gzip', mapUrl: '/schools-map-b2c3d4e5f6.json.gz',
    mapCount: 2, mapFormatVersion: 2, cityIndexUrl: '/city-index-0123456789.json', nameIndexUrl: '/school-name-index-0123456789.json',
    schoolDataVersion: 'a1b2c3d4e5', schoolDataCount: 2, prefDataUrls: { gunma: '/school-data/pref-gunma.json' },
    prefIndexUrls: { gunma: '/school-data/pref-index-gunma.json' }, generatedAt: SCHOOL_TIMESTAMP }
  await fs.writeFile(join(dir, 'schools-manifest.json'), JSON.stringify(manifest))
  await fs.mkdir(join(dir, 'school-data'), { recursive: true })
  for (const school of schools) {
    const neighbor = schools.find((row) => row.id !== school.id)
    await fs.writeFile(join(dir, 'school-data', `${school.id}.json`), JSON.stringify({ formatVersion: 2, sourceCatalog: [], schools: [school],
      neighbors: [{ id: neighbor.id, name: neighbor.name, prefecture: neighbor.prefecture, city: '前橋市', distanceKm: 1 }], successors: [], linkableSchoolIds: [] }))
  }
  await fs.writeFile(join(dir, 'school-data/pref-gunma.json'), JSON.stringify({ formatVersion: 2, sourceCatalog: [], schools }))
  await fs.writeFile(join(dir, 'school-data/pref-index-gunma.json'), JSON.stringify({ slug: 'gunma', cities: ['前橋市'], schools: citySchools }))
  const publicSchools = schools.map((s) => ({ id: s.id, record_key: `school-${s.id}`, name: s.name, prefecture: s.prefecture,
    official_url: s.official_url, is_integrated: Boolean(s.is_integrated), provenance: { official_url: s.official_url, last_built_at: SCHOOL_TIMESTAMP, field_sources: [] } }))
  await fs.mkdir(join(dir, 'api/v1/schools'), { recursive: true })
  await fs.writeFile(join(dir, 'api/v1/schools.json'), JSON.stringify({ api_version: 'v1', generated_at: SCHOOL_TIMESTAMP, count: 2, schools: publicSchools }))
  await fs.writeFile(join(dir, 'api/v1/schools/gunma.json'), JSON.stringify({ api_version: 'v1', generated_at: SCHOOL_TIMESTAMP, prefecture: '群馬県', count: 2, schools: publicSchools }))
  await fs.writeFile(join(dir, 'api/v1/dataset.json'), JSON.stringify({ api_version: 'v1', version: DATASET_VERSION, generated_at: SCHOOL_TIMESTAMP,
    school_count: 2, prefecture_count: 1, prefectures: { gunma: 2 }, provenance_policy: DATASET_CLAIM, license_url: DATASET_LICENSE_URL }))
  await fs.writeFile(join(dir, 'api/v1/openapi.json'), JSON.stringify(syntheticOpenApi()))
  await fs.writeFile(join(dir, '_headers'), '/*\n  X-Content-Type-Options: nosniff\n/api/v1/*\n  Cache-Control: public, max-age=3600\n  Access-Control-Allow-Origin: *\n')
  await fs.writeFile(join(dir, '_routes.json'), ROUTES_JSON_TEXT)
  await fs.writeFile(join(dir, 'index.html'), page({ title: 'Manabi Map', canonical: `${ORIGIN}/`, main: '<h1>親子で使う、学校選びの地図ノート。</h1><nav><a href="/pref/gunma/">群馬県</a></nav>',
    mainAttrs: 'id="main-content" class="content home-content"', jsonLd: [
      { '@context': 'https://schema.org', '@type': 'WebSite', '@id': `${ORIGIN}/#website`, name: 'Manabi Map' },
      { '@context': 'https://schema.org', '@type': 'Organization', '@id': `${ORIGIN}/#organization`, name: 'Manabi Map' }] }))
  await fs.writeFile(join(dir, 'app.js'), 'export const syntheticBuild = true;')
  await fs.mkdir(join(dir, 'schools'), { recursive: true })
  await fs.writeFile(join(dir, 'schools/index.html'), page({ title: '高校一覧 | Manabi Map', canonical: `${ORIGIN}/schools/`, main: '<h1>高校一覧</h1><a href="/pref/gunma/">群馬県の高校一覧（2 校）</a>' }))
  await fs.mkdir(join(dir, 'pref/gunma/前橋市'), { recursive: true })
  await fs.writeFile(join(dir, 'pref/gunma/index.html'), page({ title: '群馬県の高校一覧（2 校） | Manabi Map', canonical: `${ORIGIN}/pref/gunma/`,
    main: '<h1>群馬県の高校一覧（2 校）</h1><section id="前橋市"><h2><a href="' + MAEBASHI_PATH + '">前橋市（2 校）</a></h2><ul>' + schools.map((s) => `<li><a href="/school/${s.id}/">${s.name}</a></li>`).join('') + '</ul></section>',
    mainAttrs: 'id="main-content" class="content hub-content"', initialData: { slug: 'gunma', cities: ['前橋市'] } }))
  await fs.writeFile(join(dir, 'pref/gunma/前橋市/index.html'), page({ title: '前橋市の高校一覧（2 校） | Manabi Map', canonical: `${ORIGIN}${MAEBASHI_PATH}`,
    description: cityPageDescription('群馬県', '前橋市', citySchools), main: '<h1>前橋市の高校一覧（2 校）</h1><p>群馬県前橋市にある高校は 2 校です。</p><ul>' + schools.map((s) => `<li><a href="/school/${s.id}/">${s.name}</a></li>`).join('') + '</ul>',
    mainAttrs: 'id="main-content" class="content hub-content"', initialData: { slug: 'gunma', city: '前橋市', schools: [], cityCounts: [{ c: '前橋市', n: 2 }] },
    jsonLd: { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'ホーム', item: `${ORIGIN}/` }, { '@type': 'ListItem', position: 2, name: '群馬県', item: `${ORIGIN}/pref/gunma/` }, { '@type': 'ListItem', position: 3, name: '前橋市' }] } }))
  for (const [path, title, main] of [
    ['about', 'このサービスについて | Manabi Map', `<h1>Manabi Map（まなびマップ）について</h1><p>${DATASET_CLAIM}</p>`],
    ['press', '配布素材・プレスキット | Manabi Map', `<h1>メディア関係者・教育関係者の方へ</h1><p>${DATASET_CLAIM}</p>`],
    ['data', '学校基本情報データセット・公開 API | Manabi Map', `<h1>学校基本情報データセット・公開 API</h1><p>1 都道府県・2 校の学校基本情報を公開しています。</p><p>${DATASET_CLAIM}</p><a href="/api/v1/schools.json">API</a>`],
  ]) { await fs.mkdir(join(dir, path), { recursive: true }); await fs.writeFile(join(dir, path, 'index.html'), page({ title, canonical: `${ORIGIN}/${path}/`, main,
    footer: path === 'data' ? syntheticFooterHtml() : '', jsonLd: path === 'data' ? { '@context': 'https://schema.org', '@type': 'Dataset',
      license: DATASET_LICENSE_URL, distribution: [{ '@type': 'DataDownload', contentUrl: `${ORIGIN}/api/v1/schools.json` }] } :
      ['about', 'press'].includes(path) ? { '@context': 'https://schema.org', '@type': 'Organization', name: 'Manabi Map' } : undefined })) }
  for (const path of ['terms', 'privacy', 'third-party', 'deviation-methodology']) {
    await fs.mkdir(join(dir, `legal/${path}`), { recursive: true }); await fs.writeFile(join(dir, `legal/${path}/index.html`), page({ title: `${path} | Manabi Map`, canonical: `${ORIGIN}/legal/${path}/`, main: `<h1>${path}</h1>` }))
  }
  for (const slug of ['commute-time', 'school-visit', 'deviation-with-care']) {
    await fs.mkdir(join(dir, `guide/${slug}`), { recursive: true }); await fs.writeFile(join(dir, `guide/${slug}/index.html`), page({ title: `${slug} | Manabi Map`, canonical: `${ORIGIN}/guide/${slug}/`, main: `<h1>${slug}</h1><p>学校選びのためのガイドです。</p>` }))
  }
  await fs.writeFile(join(dir, 'llms.txt'), ['# Manabi Map', '', 'CC BY-SA 4.0', DATASET_CLAIM,
    `${ORIGIN}/data/`, `${ORIGIN}/api/v1/schools.json`, `${ORIGIN}/api/v1/openapi.json`, ''].join('\n'))
  await fs.writeFile(join(dir, '404.html'), page({ title: 'ページが見つかりません | Manabi Map', canonical: null, noindex: true, main: '<h1>ページが見つかりません</h1>' }))
  for (const school of schools) {
    const neighbor = schools.find((row) => row.id !== school.id)
    await fs.mkdir(join(dir, `school/${school.id}`), { recursive: true })
    await fs.writeFile(join(dir, `school/${school.id}/index.html`), page({ title: `${school.name}（${school.prefecture}前橋市）の地図・アクセス・学科 | Manabi Map`,
      canonical: `${ORIGIN}/school/${school.id}/`, main: `<h1 class="detail-title">${school.name}</h1><section><h2>${school.name}の近くにある高校</h2><p>直線距離の近い順に 1 校。</p><ul><li><a href="/school/${neighbor.id}/">${neighbor.name}</a>（前橋市・約 1.0 km）</li></ul></section>`,
      mainAttrs: 'id="main-content"', initialData: { schools: [school] }, jsonLd: [schoolLd(school.name), breadcrumbLd(school.name)] }))
  }
  const urls = ['/', '/schools/', '/pref/gunma/', MAEBASHI_PATH, '/data/', '/about/', '/press/', '/legal/terms/', '/legal/privacy/', '/legal/third-party/',
    '/legal/deviation-methodology/', '/guide/commute-time/', '/guide/school-visit/', '/guide/deviation-with-care/', ...schools.map((s) => `/school/${s.id}/`)]
  await fs.writeFile(join(dir, 'sitemap.xml'), urls.map((url) => `<loc>${ORIGIN}${url}</loc>`).join('\n'))
  return dir
}

async function releaseFixture(t) {
  const distDir = await syntheticDist()
  t.after(() => fs.rm(distDir, { recursive: true, force: true }))
  const manifestPath = join(distDir, 'schools-manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  manifest.generatedAt = SCHOOL_TIMESTAMP
  await fs.writeFile(manifestPath, JSON.stringify(manifest))
  const payload = JSON.parse(gunzipSync(await fs.readFile(join(distDir, manifest.url.slice(1)))))
  for (const row of payload.schools) { row.record_key = `school-${row.id}`; row.is_integrated = false }
  const generatorSnapshot = Buffer.from(JSON.stringify(payload))
  await fs.writeFile(join(distDir, manifest.url.slice(1)), gzipSync(generatorSnapshot))
  const publicRecords = payload.schools.map((row) => toPublicSchoolRecord(row, payload.sourceCatalog, manifest.generatedAt))
  for (const path of ['api/v1/schools.json', 'api/v1/schools/gunma.json']) {
    const apiPath = join(distDir, path), value = JSON.parse(await fs.readFile(apiPath, 'utf8'))
    value.schools = publicRecords
    await fs.writeFile(apiPath, JSON.stringify(value))
  }
  await verifyStaticOutput({ distDir })
  const release = await produceSchoolRelease({ distDir, generatorSnapshot, generation: 'synthetic-g1',
    candidateRevision: 'b'.repeat(40), evidence: 'observed' })
  return { release, generatorSnapshot }
}

function buildAndGenerationRecords({ release, generatorSnapshot, sourceFiles, sourceRevision }) {
  const generatedAt = SCHOOL_TIMESTAMP
  const source = { type: 'sqlite-snapshot', snapshotSha256: '1'.repeat(64), manifestSha256: '2'.repeat(64), contentSha256: '3'.repeat(64) }
  const generation = { format: 'observed-school-json', version: 1, evidence: 'observed', scope: 'school-json-only', source,
    generatedAt, candidateRevision: sourceRevision, generatorSnapshotSha256: digest(generatorSnapshot),
    artifacts: schoolInventory(release.artifacts), resourceBudget: release.resourceBudget }
  const generationRaw = canonical(generation)
  const inventory = schoolInventory(release.files)
  const build = { format: 'observed-school-build', version: 1, evidence: 'observed', deploymentPerformed: false,
    candidateRevision: sourceRevision, generatedAt, source, generationReceiptSha256: digest(generationRaw), publicArtifacts: inventory,
    publicArtifactsSha256: digest(canonicalSchoolSourceJSON(inventory)), sourceFiles, resourceBudget: release.resourceBudget,
    functions: { source: 'source/functions', compiled: false, deployed: false } }
  return { build, generationRaw }
}

async function syntheticBuildRoot(t, release, sourceRevision, bindingsSha256) {
  const root = await fs.mkdtemp(join(tmpdir(), 'school-finalizer-build-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(join(root, 'source/functions'), { recursive: true })
  await fs.mkdir(join(root, 'dist'), { recursive: true })
  const functionSource = Buffer.from('export default 1;')
  await fs.writeFile(join(root, 'source/functions/_middleware.ts'), functionSource)
  for (const [path, bytes] of release.files) {
    const target = join(root, 'dist', path)
    await fs.mkdir(dirname(target), { recursive: true })
    await fs.writeFile(target, bytes)
  }
  const sourceFiles = [
    { path: 'functions/_middleware.ts', sha256: digest(functionSource) },
    { path: 'web/src/entry-client.tsx', sha256: '6'.repeat(64) },
  ]
  const fakeWrangler = join(root, 'wrangler-synthetic.mjs')
  await fs.writeFile(fakeWrangler, `import fs from 'node:fs/promises';\nimport {join} from 'node:path';\nconst args=process.argv.slice(2);\nif(args[0]==='--version'){process.stdout.write('4.0.0\\n')}else{const at=(name)=>args[args.indexOf(name)+1];await fs.mkdir(at('--outdir'));await fs.writeFile(join(at('--outdir'),'index.js'),'export default {fetch(){return new Response("synthetic")}}');if(args.includes('--metafile'))await fs.writeFile(at('--metafile'),JSON.stringify({inputs:{'_middleware.ts':{}},outputs:{'index.js':{}}}))}\n`)
  return { root, fakeWrangler, sourceFiles, bindingsSha256, sourceRevision }
}

async function compiledCandidate(t, release, sourceRevision, bindingsSha256) {
  const buildRoot = await syntheticBuildRoot(t, release, sourceRevision, bindingsSha256)
  const compiled = await compileSchoolFunctionsCandidate({ buildRoot: buildRoot.root, wranglerPath: buildRoot.fakeWrangler,
    wranglerVersion: '4.0.0', sourceRevision, bindingsSha256,
    expectedSourceInventory: buildRoot.sourceFiles.filter((entry) => entry.path.startsWith('functions/')) })
  const worker = await fs.readFile(compiled.workerPath)
  return { ...buildRoot, compiled, worker }
}

test('finalizer runs the real synthetic producer gate and binds its distribution to a compiler record and package', async (t) => {
  const { release, generatorSnapshot } = await releaseFixture(t)
  const sourceRevision = 'b'.repeat(40)
  const bindingsSha256 = '4'.repeat(64)
  const buildRoot = await syntheticBuildRoot(t, release, sourceRevision, bindingsSha256)
  const sourceFiles = buildRoot.sourceFiles
  const { build, generationRaw } = buildAndGenerationRecords({ release, generatorSnapshot, sourceFiles, sourceRevision })
  await fs.writeFile(join(buildRoot.root, 'observed-build.json'), canonical(build))
  await fs.mkdir(join(buildRoot.root, 'generation/private-source'), { recursive: true })
  await fs.writeFile(join(buildRoot.root, 'generation/observed-generation.json'), generationRaw)
  await fs.writeFile(join(buildRoot.root, 'generation/private-source/generator-payload.json'), generatorSnapshot)
  const completion = await finalizeObservedSchoolBuild({ buildRoot: buildRoot.root, wranglerPath: buildRoot.fakeWrangler,
    wranglerVersion: '4.0.0', bindingsSha256, generation: 'synthetic-g1' })
  const resultRaw = await fs.readFile(join(buildRoot.root, 'school-release-completion.json'))
  const result = { receipt: JSON.parse(resultRaw.toString('utf8')) }
  const compileRecordRaw = await fs.readFile(join(buildRoot.root, 'functions-candidate/school-functions-compile-receipt.json'))
  const compileRecord = JSON.parse(compileRecordRaw.toString('utf8'))
  const worker = await fs.readFile(join(buildRoot.root, 'dist/_worker.js'))
  assert.equal(completion.packagePin, result.receipt.packagePin)
  assert.equal(result.receipt.functions.buildMetadataSha256, compileRecord.buildMetadataSha256)
  assert.equal(result.receipt.functions.compileRecordStatus, 'success')
  assert.equal(result.receipt.functions.sourceRevision, sourceRevision)
  assert.equal(result.receipt.functions.workerSha256, digest(worker))
  assert.equal(result.receipt.artifacts.length, release.files.size)
  assert.equal(worker.toString(), 'export default {fetch(){return new Response("synthetic")}}')
  assert.equal(compileRecord.sourceRevision, sourceRevision)
  assert.equal(compileRecord.bindingsSha256, bindingsSha256)
  assert.equal(compileRecord.sourceInventorySha256, digest(canonical(compileRecord.sourceInventory)))
  assert.equal(validateSchoolRelease(release.raw, release.pin, release.artifacts).evidence, 'observed')
})

test('finalizer rejects changed source, revision, worker bytes, binding hash and stale static inventory', async (t) => {
  const { release, generatorSnapshot } = await releaseFixture(t)
  const sourceRevision = 'b'.repeat(40), bindingsSha256 = '4'.repeat(64)
  const buildRoot = await compiledCandidate(t, release, sourceRevision, bindingsSha256)
  const { build, generationRaw } = buildAndGenerationRecords({ release, generatorSnapshot,
    sourceFiles: buildRoot.sourceFiles, sourceRevision })
  const input = { buildReceipt: build, generationReceiptRaw: generationRaw, generatorSnapshot, release,
    functionsCandidateRaw: buildRoot.compiled.raw, functionsSourceInventory: buildRoot.compiled.receipt.sourceInventory,
    worker: buildRoot.worker, bindingsSha256 }
  assert.doesNotThrow(() => createSchoolReleaseCompletion(input))
  const differentWorker = Buffer.from('different-worker-output')
  assert.throws(() => createSchoolReleaseCompletion({ ...input, worker: differentWorker }), /candidate refused/)
  const changedInventory = [{ ...buildRoot.compiled.receipt.sourceInventory[0], sha256: 'a'.repeat(64) }]
  assert.throws(() => createSchoolReleaseCompletion({ ...input, functionsSourceInventory: changedInventory }), /candidate refused/)
  const badCandidate = JSON.parse(buildRoot.compiled.raw)
  badCandidate.sourceRevision = 'c'.repeat(40)
  assert.throws(() => createSchoolReleaseCompletion({ ...input, functionsCandidateRaw: canonical(badCandidate) }), /candidate refused/)
  assert.throws(() => createSchoolReleaseCompletion({ ...input, bindingsSha256: 'd'.repeat(64) }), /candidate refused/)
  const changedBuild = structuredClone(build)
  changedBuild.publicArtifactsSha256 = 'e'.repeat(64)
  assert.throws(() => createSchoolReleaseCompletion({ ...input, buildReceipt: changedBuild }), /candidate refused/)
})

test('failed Wrangler candidate cannot leave a compiled worker or success receipt', async (t) => {
  const { release } = await releaseFixture(t)
  const sourceRevision = 'b'.repeat(40), bindingsSha256 = '4'.repeat(64)
  const buildRoot = await syntheticBuildRoot(t, release, sourceRevision, bindingsSha256)
  await fs.writeFile(buildRoot.fakeWrangler, `import fs from 'node:fs/promises';\nconst args=process.argv.slice(2);\nif(args[0]==='--version'){process.stdout.write('4.0.0\\n')}else{process.exitCode=1}\n`)
  await assert.rejects(compileSchoolFunctionsCandidate({ buildRoot: buildRoot.root, wranglerPath: buildRoot.fakeWrangler,
    wranglerVersion: '4.0.0', sourceRevision, bindingsSha256,
    expectedSourceInventory: buildRoot.sourceFiles.filter((entry) => entry.path.startsWith('functions/')) }), /candidate refused/)
  await assert.rejects(fs.lstat(join(buildRoot.root, 'dist/_worker.js')), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(join(buildRoot.root, 'functions-candidate/school-functions-compile-receipt.json')), { code: 'ENOENT' })
})

test('finalizer rejects multipart compiler output and split modules before publishing a worker', async (t) => {
  const { release } = await releaseFixture(t)
  const sourceRevision = 'b'.repeat(40), bindingsSha256 = '4'.repeat(64)
  for (const extraModule of [false, true]) {
    const buildRoot = await syntheticBuildRoot(t, release, sourceRevision, bindingsSha256)
    const body = extraModule ? 'export default {fetch(){return new Response("synthetic")}}' :
      '--synthetic-boundary\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{}\r\n--synthetic-boundary--\r\n'
    await fs.writeFile(buildRoot.fakeWrangler, `import fs from 'node:fs/promises';\nimport {join} from 'node:path';\nconst args=process.argv.slice(2);\nif(args[0]==='--version'){process.stdout.write('4.0.0\\n')}else{const at=(name)=>args[args.indexOf(name)+1];await fs.mkdir(at('--outdir'));await fs.writeFile(join(at('--outdir'),'index.js'),${JSON.stringify(body)});${extraModule ? "await fs.writeFile(join(at('--outdir'),'other.js'),'export default 1');" : ''}await fs.writeFile(at('--metafile'),JSON.stringify({inputs:{'_middleware.ts':{}},outputs:{'index.js':{}}}))}\n`)
    await assert.rejects(compileSchoolFunctionsCandidate({ buildRoot: buildRoot.root, wranglerPath: buildRoot.fakeWrangler,
      wranglerVersion: '4.0.0', sourceRevision, bindingsSha256,
      expectedSourceInventory: buildRoot.sourceFiles.filter((entry) => entry.path.startsWith('functions/')) }), /candidate refused/)
    await assert.rejects(fs.lstat(join(buildRoot.root, 'dist/_worker.js')), { code: 'ENOENT' })
    await assert.rejects(fs.lstat(join(buildRoot.root, 'functions-candidate/school-functions-compile-receipt.json')), { code: 'ENOENT' })
  }
})

test('CLI identifies an explicit compiler and version and rejects a self-asserted compile flag', () => {
  const args = ['--build-root=D:/synthetic/build', '--wrangler-path=D:/synthetic/wrangler.mjs', '--wrangler-version=4.0.0',
    `--bindings-sha256=${'9'.repeat(64)}`, '--generation=synthetic-g1']
  assert.equal(parseFinalizeSchoolReleaseArgs(args).wranglerVersion, '4.0.0')
  assert.throws(() => parseFinalizeSchoolReleaseArgs([...args, '--functions-compiled=true']), /candidate refused/)
})
