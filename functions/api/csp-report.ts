interface Context {
  request: Request
}

/** CSP Report-Only の受け口。本文は上限を設け、実データを保存せず Pages ログへ短く出す。 */
export const onRequestPost = async ({ request }: Context): Promise<Response> => {
  const contentLength = Number(request.headers.get('content-length') ?? 0)
  if (contentLength > 32_768) return new Response(null, { status: 413 })
  const body = await request.text()
  if (body.length > 32_768) return new Response(null, { status: 413 })
  try {
    const report = JSON.parse(body) as unknown
    console.warn('csp-report', JSON.stringify(report).slice(0, 4000))
  } catch {
    console.warn('csp-report: invalid JSON')
  }
  return new Response(null, { status: 204 })
}

export const onRequest = async ({ request }: Context): Promise<Response> => {
  if (request.method === 'POST') return onRequestPost({ request })
  return new Response(null, { status: 405, headers: { allow: 'POST' } })
}
