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
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
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

async function handleRequest(request, files, fetchImpl) {
  const url = new URL(request.url)
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
  }
  if (url.pathname.startsWith('/api/v1/')) return proxyPublicApi(request, url, fetchImpl)
  const file = files[url.pathname]
  if (!file) return notFound()
  const headers = { ...COMMON_HEADERS, 'Content-Type': file[0], 'Content-Security-Policy': PAGE_CSP, 'Cache-Control': 'public, max-age=300' }
  if (url.hostname !== 'manabi-map.app') headers['X-Robots-Tag'] = 'noindex'
  return new Response(request.method === 'HEAD' ? null : file[1], { headers })
}
