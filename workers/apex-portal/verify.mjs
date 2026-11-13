import { strict as assert } from 'node:assert'
import { pathToFileURL } from 'node:url'

const worker = (await import(pathToFileURL(process.argv[2]).href)).default
const get = (path, method = 'GET') => worker.fetch(new Request(`https://manabi-map.app${path}`, { method }))
const response = await get('/')
const html = await response.text()
assert.equal(response.status, 200)
// 学校の種類は、学校入口を経由せず、それぞれの行き先へ直接つなぐ
for (const [name, url] of [['小学校', 'https://school.manabi-map.app/primary/'], ['中学校', 'https://school.manabi-map.app/middle/'],
  ['高校・高専', 'https://high-school.manabi-map.app/'], ['大学・短大', 'https://school.manabi-map.app/university/'],
  ['専修学校（専門学校を含む）', 'https://school.manabi-map.app/vocational/']]) {
  assert.ok(html.includes(`<a class="primary" href="${url}">${name} →</a>`), `学校の種類の行き先が無い: ${name}`)
}
assert.match(html, /https:\/\/home\.manabi-map\.app\//)
assert.ok(html.includes('<p class="service-brand chifact">chifact<span>.</span><small>｜地ファクト</small></p>'), '地ファクトのロゴの文字が無い')
assert.match(html, /href="https:\/\/kanji\.manabi-map\.app\/">たねもじを開く/)
assert.match(html, /href="https:\/\/english\.manabi-map\.app\/">たねワードを開く/)
// 教科の色（案 A）: カードに教科を当て、色の値は subject-themes.json から CSS 変数で入る。教科は名前と絵でも分かる
assert.match(html, /<article data-subject="kokugo"><span class="badge"[^>]*><svg><use href="#pin-kanji"\/><\/svg><\/span><h2>たねもじ<\/h2>/)
assert.match(html, /<article data-subject="english"><span class="badge"[^>]*><svg><use href="#pin-english"\/><\/svg><\/span><h2>たねワード<\/h2>/)
assert.ok(html.includes('.cards article[data-subject="kokugo"]{--s-accent:#ff5c6c;--s-soft:#fff0f1;--s-text:#c2182b;--s-on-accent:#241f1a}'), '国語の色が無い')
assert.ok(html.includes('.cards article[data-subject="english"]{--s-accent:#a57bff;--s-soft:#f5f0ff;--s-text:#6534d6;--s-on-accent:#241f1a}'), '英語の色が無い')
// たねちず・たねさんすう・たねデジ（2026-11-14 公開）
for (const [subject, name, host] of [['shakai', 'たねちず', 'shakai'], ['math', 'たねさんすう', 'math'], ['joho', 'たねデジ', 'joho']]) {
  assert.match(html, new RegExp(`<article data-subject="${subject}"><span class="badge"[^>]*><svg><use href="#pin-${subject}"/></svg></span><h2>${name}</h2>`))
  assert.ok(html.includes(`href="https://${host}.manabi-map.app/">${name}を開く →</a>`), `${name} の行き先が無い`)
  assert.ok(html.includes(`.cards article[data-subject="${subject}"]{--s-accent:`), `${name} の色が無い`)
}
assert.equal((html.match(/<article data-subject=/g) || []).length, 5, '公開していない教科のカードが入っている')
assert.match(html, /rel="canonical" href="https:\/\/manabi-map\.app\//)
assert.doesNotMatch(html, /noindex|旧URL|移行候補|\{\{/)
// フッターから総合入口のプライバシーポリシーへつなぐ。訪問を数えていることを利用者が確かめられるようにする（2026-11-13 に高校版のページから切り替え）
assert.match(html, /<footer>[\s\S]*<a href="\/legal\/privacy\/">プライバシーポリシー・利用規約<\/a>[\s\S]*<\/footer>/)
// 運営者とソース、安心材料、お知らせ（2026-11-14）。準備中のかるたは最初の案内に書かない
assert.match(html, /<footer>[\s\S]*<a href="https:\/\/ishizakahiroshi\.com\/">運営者<\/a>[\s\S]*<a href="https:\/\/github\.com\/ishizakahiroshi\/manabi-map">/)
assert.match(html, /<ul class="promises"[^>]*><li>どれも無料<\/li>/)
assert.match(html, /<section id="news"[\s\S]*<time datetime="2026-11-13">/)
assert.doesNotMatch(html, /<p class="lead">[^<]*かるた/)
assert.doesNotMatch(html, /high-school\.manabi-map\.app\/legal\/privacy/)
{
  const res = await get('/legal/privacy/')
  const body = await res.text()
  assert.equal(res.status, 200)
  assert.match(body, /<h1>まなびマップ プライバシーポリシー<\/h1>/)
  assert.match(body, /Cloudflare Web Analytics/)
  assert.match(body, /rel="canonical" href="https:\/\/manabi-map\.app\/legal\/privacy\/"/)
  assert.ok(body.includes('href="https://high-school.manabi-map.app/legal/privacy/"'), '高校版のポリシーへつなぐ')
  assert.ok(body.includes('<a href="https://ishizakahiroshi.com/">ishizakahiroshi</a>'), '運営者の個人ページへつなぐ')
  assert.doesNotMatch(body, /<script|<img\b|<link\b[^>]*stylesheet|\{\{/i)
  const redirect = await get('/legal/privacy')
  assert.equal(redirect.status, 301); assert.equal(redirect.headers.get('location'), '/legal/privacy/')
  assert.match(await (await get('/sitemap.xml')).text(), /https:\/\/manabi-map\.app\/legal\/privacy\//)
}
// 絵とロゴは HTML の中の SVG だけで描く（CSP は default-src 'none'）。<use> の参照先がすべて同じ HTML にあること
assert.match(html, /<symbol id="brand-mark" viewBox="[\d\s.-]+">/)
const used = [...html.matchAll(/<use\b[^>]*\shref="([^"]*)"/g)].map((m) => m[1])
assert.ok(used.length > 0)
for (const ref of used) assert.ok(/^#[\w-]+$/.test(ref) && html.includes(` id="${ref.slice(1)}"`), `<use> の参照先が無い: ${ref}`)
assert.doesNotMatch(html, /<script|<img\b|<link\b[^>]*stylesheet|url\(\s*["']?(?:https?:|\/\/|data:)/i)
// タブのアイコンは HTML に埋め込み、CSP は埋め込んだ画像（data:）だけを許す。通信で取りに行く画像は止めたまま
// スクリプトと通信は、Cloudflare Web Analytics の読み込み元と送信先だけを許す。HTML 自身にはスクリプトを書かない（上の検査）
const csp = response.headers.get('content-security-policy')
assert.equal(csp, "default-src 'none'; script-src https://static.cloudflareinsights.com; connect-src https://manabi-map.app/cdn-cgi/rum https://cloudflareinsights.com; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'")
const directive = (name) => csp.split('; ').find((part) => part.startsWith(`${name} `)) ?? ''
for (const name of ['script-src', 'connect-src']) assert.doesNotMatch(directive(name), /'self'|'unsafe-inline'|'unsafe-eval'|\*|data:|blob:/, `${name} を広げない`)
assert.match(html, /<link rel="icon" type="image\/png" sizes="32x32" href="data:image\/png;base64,[A-Za-z0-9+/]+=*">/)
assert.match(html, /<link rel="icon" type="image\/svg\+xml" sizes="any" href="data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*">/)
assert.doesNotMatch(html, /<link rel="[^"]*icon[^"]*"[^>]*href="(?!data:)/)
for (const path of ['/robots.txt', '/sitemap.xml', '/llms.txt']) assert.equal((await get(path)).status, 200)
const robots = await (await get('/robots.txt')).text()
assert.match(robots, /User-agent: GPTBot/)
assert.match(robots, /Allow: \/api\/v1\/[\s\S]*Disallow: \//)
assert.equal((await get('/')).headers.get('x-robots-tag'), null)
assert.equal((await get('/', 'HEAD')).status, 200)
assert.equal((await get('/', 'POST')).status, 405)
assert.equal((await get('/unknown')).status, 404)

// /api/v1/* は高校版の同じファイルを中継する。外へ出ないよう fetch を差し替えて確かめる
const calls = []
let upstreamReply = () => new Response('{"api_version":"v1"}\n', {
  status: 200,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600', ETag: '"abc"', 'Set-Cookie': 'x=1', 'X-Frame-Options': 'DENY' },
})
globalThis.fetch = async (input, init = {}) => {
  calls.push({ url: String(input), method: init.method, headers: new Headers(init.headers), redirect: init.redirect })
  return upstreamReply()
}
const api = (path, init = {}) => worker.fetch(new Request(`https://manabi-map.app${path}`, init))

for (const path of ['/api/v1/schools.json', '/api/v1/dataset.json', '/api/v1/openapi.json', '/api/v1/schools/gunma.json']) {
  calls.length = 0
  const res = await api(`${path}?utm_source=x`, { headers: { Cookie: 'session=secret', Authorization: 'Bearer t', 'If-None-Match': '"old"' } })
  assert.equal(res.status, 200, path)
  assert.equal(await res.text(), '{"api_version":"v1"}\n')
  assert.equal(res.headers.get('content-type'), 'application/json')
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  assert.equal(res.headers.get('cache-control'), 'public, max-age=3600')
  assert.equal(res.headers.get('etag'), '"abc"')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('set-cookie'), null, '高校版の Cookie を返さない')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `https://high-school.manabi-map.app${path}`, '問い合わせ文字列を落として高校版の同じパスへ')
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].redirect, 'manual')
  assert.equal(calls[0].headers.get('cookie'), null, 'Cookie を高校版へ渡さない')
  assert.equal(calls[0].headers.get('authorization'), null)
  assert.equal(calls[0].headers.get('if-none-match'), '"old"')
}

// HEAD は本文なし。304 はそのまま返す
const head = await api('/api/v1/schools.json', { method: 'HEAD' })
assert.equal(head.status, 200)
assert.equal(calls.at(-1).method, 'HEAD')
assert.equal(await head.text(), '')
upstreamReply = () => new Response(null, { status: 304, headers: { ETag: '"abc"' } })
const notModified = await api('/api/v1/schools.json', { headers: { 'If-None-Match': '"abc"' } })
assert.equal(notModified.status, 304)
assert.equal(notModified.headers.get('access-control-allow-origin'), '*')

// 公開データのファイル名に合わない道は、高校版へ問い合わせずに 404
for (const path of ['/api/v1/secrets', '/api/v1/env', '/api/v1/schools/', '/api/v1/schools/Gunma.json', '/api/v1/schools/gunma/x.json',
  '/api/v1/schools/..%2fdataset.json', '/api/v1/schools.json/', '/api/v1/', '/api/v2/schools.json', '/api/admin/me']) {
  calls.length = 0
  assert.equal((await api(path)).status, 404, path)
  assert.equal(calls.length, 0, `${path} は中継しない`)
}
assert.equal((await api('/api/v1/schools.json', { method: 'POST' })).status, 405)
assert.equal((await api('/api/v1/schools.json', { method: 'OPTIONS' })).status, 405)

// 高校版の異常は 502 にして、別の中身を 200 で返さない
const failures = [
  ['404', () => new Response('nf', { status: 404 }), 404],
  ['500', () => new Response('err', { status: 500 }), 502],
  ['301', () => new Response(null, { status: 301, headers: { Location: 'https://example.com/' } }), 502],
  ['HTML', () => new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } }), 502],
  ['JSON に似た型', () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/jsonx' } }), 502],
  ['通信失敗', () => { throw new TypeError('network') }, 502],
]
for (const [label, reply, status] of failures) {
  upstreamReply = reply
  const res = await api('/api/v1/schools.json')
  assert.equal(res.status, status, label)
  assert.equal(res.headers.get('access-control-allow-origin'), null, `${label} に CORS を付けない`)
}
// /data/ は全種類の案内。/data は /data/ へ。トップのフッターからつながる
const dataRes = await get('/data/')
const dataHtml = await dataRes.text()
assert.equal(dataRes.status, 200)
assert.match(dataHtml, /href="\/api\/catalog\.json"/)
for (const kind of ['primary', 'middle', 'university', 'vocational']) assert.ok(dataHtml.includes(`https://school.manabi-map.app/api/v1/${kind}/dataset.json`), kind)
assert.ok(dataHtml.includes('https://high-school.manabi-map.app/data/'))
assert.doesNotMatch(dataHtml, /<script|<img\b|<link\b[^>]*stylesheet/i)
const toData = await get('/data')
assert.equal(toData.status, 301); assert.equal(toData.headers.get('location'), '/data/')
assert.match(html, /<footer>[\s\S]*<a href="\/data\/">公開データ・API<\/a>/)
assert.match(await (await get('/robots.txt')).text(), /Allow: \/api\/catalog\.json/)
assert.match(await (await get('/sitemap.xml')).text(), /https:\/\/manabi-map\.app\/data\//)

// /api/catalog.json は高校版と学校入口の dataset.json を読んでまとめる
const datasets = {
  'https://high-school.manabi-map.app/api/v1/dataset.json': { school_count: 5088, license: 'CC BY-SA 4.0', generated_at: '2026-11-13T00:00:00Z' },
  'https://school.manabi-map.app/api/v1/dataset.json': { kinds: [{ id: 'primary', label: '小学校', school_count: 100, license: 'CC BY 4.0' }, { id: 'Bad/Id', label: 'x', school_count: 1 }] },
}
calls.length = 0
globalThis.fetch = async (input, init = {}) => {
  calls.push({ url: String(input), method: init.method })
  const body = datasets[String(input)]
  return body ? new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }) : new Response('nf', { status: 404 })
}
const cat = await api('/api/catalog.json?x=1')
assert.equal(cat.status, 200)
assert.equal(cat.headers.get('access-control-allow-origin'), '*')
const catBody = await cat.json()
assert.deepEqual(catBody.datasets.map((d) => [d.id, d.school_count]), [['high_school', 5088], ['primary', 100]])
assert.equal(catBody.total_school_count, 5188)
assert.equal(catBody.datasets[1].dataset_url, 'https://school.manabi-map.app/api/v1/primary/dataset.json')
assert.deepEqual(calls.map((c) => c.url).sort(), Object.keys(datasets).sort())
datasets['https://school.manabi-map.app/api/v1/dataset.json'] = undefined
assert.equal((await api('/api/catalog.json')).status, 502, '片方が読めなければ 502')
assert.equal((await api('/api/catalog.json', { method: 'POST' })).status, 405)
console.log('経路と検索情報、公開データの中継の確認に成功')
