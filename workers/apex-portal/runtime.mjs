// 総合入口（manabi-map.app）の Worker の本体。
// build.mjs がこのファイルの本文をそのまま worker.mjs の先頭へ写し、`files` と default export を後ろに足す。
// そのため、このファイルには import / export を書かない。
//
// /api/v1/* は、以前のアドレスを使い続ける利用者のための互換の入口。
// 高校版（high-school.manabi-map.app）の同じファイルを取ってきて、そのまま 200 と CORS で返す。
// データを配る先は高校版の 1 か所だけにして、ここではデータを持たない（2026-11-11 本人決定）。
// 中継するのは公開データのファイル名に合う GET / HEAD だけ。ほかの道へは使えないようにする。

const API_ORIGIN = 'https://high-school.manabi-map.app'
// 公開データのファイルは schools.json・dataset.json・openapi.json と、県別の schools/<県>.json だけ
// （web/scripts/gen-schools-json.mjs が書き出すもの）。これ以外は中継せず 404 を返す。
const API_PATH = /^\/api\/v1\/(?:(?:schools|dataset|openapi)\.json|schools\/[a-z]{2,20}\.json)$/
// 送る側から高校版へ渡すのは、キャッシュの確認に要る 2 つだけ（Cookie などは渡さない）
const API_FORWARD_REQUEST = ['if-none-match', 'if-modified-since']
const API_PASS_RESPONSE = ['content-type', 'cache-control', 'etag', 'last-modified']
const COMMON_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }
// 画像は HTML に埋め込んだもの（data:）だけを許す。タブのアイコンを出すためで、通信で取りに行く画像は今までどおり止める
// スクリプトは Cloudflare Web Analytics（Cookie を使わない計測。Cloudflare が配信のときに差し込む）だけを許す。
// 送信先は同じサイトの /cdn-cgi/rum の 1 本（2026-11-12 実測）と、Cloudflare の案内にある cloudflareinsights.com。
// これが無いと総合入口の訪問が数えられない。ほかのスクリプトと通信は今までどおり止める
const PAGE_CSP = "default-src 'none'; script-src https://static.cloudflareinsights.com; connect-src https://manabi-map.app/cdn-cgi/rum https://cloudflareinsights.com; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
const API_CSP = "default-src 'none'; frame-ancestors 'none'"

const notFound = () => new Response('Not Found', { status: 404 })
const badGateway = () => new Response('Bad Gateway', {
  status: 502,
  headers: { ...COMMON_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
})

async function proxyPublicApi(request, url, fetchImpl) {
  if (!API_PATH.test(url.pathname)) return notFound()
  const forward = new Headers()
  for (const name of API_FORWARD_REQUEST) {
    const value = request.headers.get(name)
    if (value) forward.set(name, value)
  }
  let upstream
  try {
    // 問い合わせ文字列は落とす（静的ファイルなので意味を持たない）。転送はたどらない
    upstream = await fetchImpl(API_ORIGIN + url.pathname, { method: request.method, headers: forward, redirect: 'manual' })
  } catch {
    return badGateway()
  }
  const isJson = /^application\/json(?:\s*;|$)/i.test(upstream.headers.get('content-type') ?? '')
  if (upstream.status === 404 || !((upstream.status === 200 && isJson) || upstream.status === 304)) {
    await upstream.body?.cancel()
    return upstream.status === 404 ? notFound() : badGateway()
  }
  const headers = new Headers({ ...COMMON_HEADERS, 'Access-Control-Allow-Origin': '*', 'Content-Security-Policy': API_CSP })
  for (const name of API_PASS_RESPONSE) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  const withBody = request.method !== 'HEAD' && upstream.status === 200
  if (!withBody) await upstream.body?.cancel()
  return new Response(withBody ? upstream.body : null, { status: upstream.status, headers })
}

// /api/catalog.json は、学びマップの全部の学校の種類の公開 API をまとめた一覧（2026-11-13 本人決定）。
// データはここに持たず、高校版と学校入口の dataset.json をその場で読んで、件数・ライセンス・URL だけを並べる。
// /api/v1/* は高校版の互換の入口のまま変えない（使っている人のプログラムを壊さないため）。
const SCHOOL_ORIGIN = 'https://school.manabi-map.app'
const KIND_ID = /^[a-z][a-z_]{0,30}$/

async function readDataset(fetchImpl, origin) {
  const res = await fetchImpl(`${origin}/api/v1/dataset.json`, { method: 'GET', redirect: 'manual' })
  if (res.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(res.headers.get('content-type') ?? '')) {
    await res.body?.cancel()
    throw new Error('upstream')
  }
  return res.json()
}

async function catalog(request, fetchImpl) {
  let hs, school
  try {
    ;[hs, school] = await Promise.all([readDataset(fetchImpl, API_ORIGIN), readDataset(fetchImpl, SCHOOL_ORIGIN)])
  } catch {
    return badGateway()
  }
  const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null)
  const text = (v) => (typeof v === 'string' && v.length <= 200 ? v : null)
  const kinds = Array.isArray(school?.kinds) ? school.kinds.filter((k) => KIND_ID.test(k?.id ?? '')) : []
  const datasets = [
    { id: 'high_school', label: '高校・高専', school_count: count(hs?.school_count), license: text(hs?.license), generated_at: text(hs?.generated_at),
      dataset_url: `${API_ORIGIN}/api/v1/dataset.json`, schools_url: `${API_ORIGIN}/api/v1/schools.json`, openapi_url: `${API_ORIGIN}/api/v1/openapi.json`, data_page: `${API_ORIGIN}/data/` },
    ...kinds.map((k) => ({ id: k.id, label: text(k.label), school_count: count(k.school_count), license: text(k.license), generated_at: null,
      dataset_url: `${SCHOOL_ORIGIN}/api/v1/${k.id}/dataset.json`, schools_url: `${SCHOOL_ORIGIN}/api/v1/${k.id}/schools.json`, openapi_url: `${SCHOOL_ORIGIN}/api/v1/openapi.json`, data_page: `${SCHOOL_ORIGIN}/data/` })),
  ]
  const body = JSON.stringify({
    name: 'まなびマップ 公開データの一覧', catalog_version: 1,
    description: '学びマップの学校の種類ごとの公開 API の入口です。データ本体・大きさ・SHA-256 は各 dataset_url にあります。認証は不要で、CORS はすべての origin に開いています。',
    total_school_count: datasets.every((d) => d.school_count !== null) ? datasets.reduce((s, d) => s + d.school_count, 0) : null,
    datasets,
    compatibility: 'https://manabi-map.app/api/v1/ は高校版の /api/v1/ と同じファイルを返す互換の入口です。',
    data_page: 'https://manabi-map.app/data/',
  }, null, 2) + '\n'
  const headers = { ...COMMON_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*', 'Content-Security-Policy': API_CSP }
  return new Response(request.method === 'HEAD' ? null : body, { headers })
}

async function handleRequest(request, files, fetchImpl) {
  const url = new URL(request.url)
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
  }
  if (url.pathname.startsWith('/api/v1/')) return proxyPublicApi(request, url, fetchImpl)
  if (url.pathname === '/api/catalog.json') return catalog(request, fetchImpl)
  if (url.pathname === '/data') return new Response(null, { status: 301, headers: { ...COMMON_HEADERS, Location: '/data/' } })
  const file = files[url.pathname]
  if (!file) return notFound()
  const headers = { ...COMMON_HEADERS, 'Content-Type': file[0], 'Content-Security-Policy': PAGE_CSP, 'Cache-Control': 'public, max-age=300' }
  if (url.hostname !== 'manabi-map.app') headers['X-Robots-Tag'] = 'noindex'
  return new Response(request.method === 'HEAD' ? null : file[1], { headers })
}
