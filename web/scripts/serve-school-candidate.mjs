// Loopback-only inspection adapter, not a Cloudflare emulator or deployment tool.
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, resolve, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { onRequest } from '../../functions/_middleware.ts'
import { checkedFile, checkedPath } from './lib/school-candidate.mjs'

const mime = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.gz': 'application/gzip' }
export function candidateHandler(root, legacy = false) {
  root = resolve(root)
  const assets = async (input) => {
    const request = input instanceof Request ? input : new Request(input)
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
    const url = new URL(request.url)
    let pathname
    try { pathname = decodeURIComponent(url.pathname) } catch { return new Response(null, { status: 400 }) }
    const full = resolve(root, `.${pathname}`)
    const rel = relative(root, full)
    if (rel.startsWith('..') || isAbsolute(rel) || pathname.includes('\\')) return new Response(null, { status: 404 })
    let path = full
    try {
      await checkedPath(path)
      const stat = await fs.lstat(path)
      if (stat.isSymbolicLink()) return new Response(null, { status: 404 })
      if (stat.isDirectory()) path = join(path, 'index.html')
      await checkedFile(path)
      const bytes = await fs.readFile(path)
      const headers = new Headers({ 'content-type': mime[extname(path)] ?? 'application/octet-stream' })
      if (pathname.startsWith('/api/v1/')) headers.set('access-control-allow-origin', '*')
      return new Response(request.method === 'HEAD' ? null : bytes, { headers })
    } catch { return new Response(null, { status: 404 }) }
  }
  return (request) => onRequest({ request, env: { LEGACY_SCHOOL_SHELL: legacy ? '1' : undefined, ASSETS: { fetch: assets } }, next: () => assets(request) })
}
export function serveCandidate(root, { legacy = false, port = 0 } = {}) {
  const handler = candidateHandler(root, legacy)
  const server = createServer(async (req, res) => {
    try {
      const response = await handler(new Request(new URL(req.url, 'http://127.0.0.1'), { method: req.method }))
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()))
    } catch { res.writeHead(500); res.end('Candidate inspection failed') }
  })
  return new Promise((accept) => server.listen(port, '127.0.0.1', () => accept(server)))
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [root, role, rawPort] = process.argv.slice(2)
  if (!root || !['apex', 'high-school'].includes(role) || !/^\d+$/.test(rawPort ?? '')) throw new Error('Explicit candidate root, apex|high-school and port required')
  const server = await serveCandidate(root, { legacy: role === 'apex', port: Number(rawPort) })
  console.log(`Candidate inspection server listening on http://127.0.0.1:${server.address().port}`)
}
