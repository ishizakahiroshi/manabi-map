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
assert.match(html, /rel="canonical" href="https:\/\/manabi-map\.app\//)
assert.doesNotMatch(html, /noindex|旧URL|移行候補|\{\{/)
// 絵とロゴは HTML の中の SVG だけで描く（CSP は default-src 'none'）。<use> の参照先がすべて同じ HTML にあること
assert.match(html, /<symbol id="brand-mark" viewBox="[\d\s.-]+">/)
const used = [...html.matchAll(/<use\b[^>]*\shref="([^"]*)"/g)].map((m) => m[1])
assert.ok(used.length > 0)
for (const ref of used) assert.ok(/^#[\w-]+$/.test(ref) && html.includes(` id="${ref.slice(1)}"`), `<use> の参照先が無い: ${ref}`)
assert.doesNotMatch(html, /<script|<img\b|<link\b[^>]*stylesheet|url\(\s*["']?(?:https?:|\/\/|data:)/i)
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
console.log('経路と検索情報、公開データの中継の確認に成功')
