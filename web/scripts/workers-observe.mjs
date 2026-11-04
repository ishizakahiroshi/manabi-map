// HTTP acceptance for a Workers static assets package: every packaged file by bytes and `_headers`
// headers, plus the not-found page, `_redirects` rules and the SPA shell routes of the observe contract.
// Read-only GETs to one base URL. Failures are recorded per path (no bodies) instead of stopping at the first.
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonical, sha, verifyWorkersPackage } from './workers-package.mjs'

const MAX_BODY_BYTES = 25 * 1024 * 1024
const MAX_RECORDED_FAILURES = 200
const RETRY_STATUSES = new Set([502, 503, 504])

export class WorkersObserveError extends Error {}
const need = (condition, reason) => { if (!condition) throw new WorkersObserveError(reason) }

/** Cloudflare `_headers`: an unindented URL pattern followed by indented `Name: value` lines. */
export function parseHeadersFile(text) {
  const blocks = []
  let current = null
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    if (!/^\s/.test(line)) {
      need(line.startsWith('/') && !line.includes(':') && !line.includes('?'), 'unsupported _headers pattern')
      current = { pattern: line.trim(), headers: [] }
      blocks.push(current)
    } else {
      const text = line.trim()
      // `! Name` removes a header; not used by the candidates and not modelled here, so fail closed.
      need(current && !text.startsWith('!') && text.includes(':'), 'unsupported _headers line')
      const index = text.indexOf(':')
      const name = text.slice(0, index).trim().toLowerCase()
      const value = text.slice(index + 1).trim()
      need(/^[a-z0-9-]+$/.test(name) && value, 'unsupported _headers entry')
      current.headers.push([name, value])
    }
  }
  return blocks
}

/** `*` is a splat over any characters (including `/`), `:name` is one path segment. */
export function patternRegExp(pattern) {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*') source += '.*'
    else if (char === ':' && /[A-Za-z]/.test(pattern[i + 1] ?? '')) {
      while (/\w/.test(pattern[i + 1] ?? '')) i++
      source += '[^/]+'
    } else source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/** Headers applied to a path: every matching rule; a name set by several rules is joined with ", ". */
export function expectedHeaders(blocks, pathname) {
  const result = {}
  for (const block of blocks) {
    if (!patternRegExp(block.pattern).test(pathname)) continue
    for (const [name, value] of block.headers) result[name] = name in result ? `${result[name]}, ${value}` : value
  }
  return result
}

export function workerFirst(rules, pathname) {
  if (!rules) return false
  const negative = rules.filter((rule) => rule.startsWith('!')).map((rule) => patternRegExp(rule.slice(1)))
  const positive = rules.filter((rule) => !rule.startsWith('!')).map((rule) => patternRegExp(rule))
  return !negative.some((pattern) => pattern.test(pathname)) && positive.some((pattern) => pattern.test(pathname))
}

/** Same URL mapping as the Pages observer: `a/index.html` → `/a/`, `a.html` → `/a`. */
export function publicUrl(path) {
  need(typeof path === 'string' && path && !path.startsWith('/') && !path.includes('\\') &&
    path.split('/').every((part) => part && part !== '.' && part !== '..'), 'unsupported artifact path')
  const url = `/${path.split('/').map(encodeURIComponent).join('/')}`
  if (url.endsWith('/index.html')) return url.slice(0, -'index.html'.length)
  return url.endsWith('.html') ? url.slice(0, -'.html'.length) : url
}

export function planObservation({ receipt, headersText, redirectsText, contract }) {
  const blocks = headersText === null ? [] : parseHeadersFile(headersText)
  const files = new Map(receipt.assets.files.map((entry) => [entry.path, entry]))
  const expected = []
  for (const entry of receipt.assets.files) {
    if (entry.path === '_headers' || entry.path === '_redirects') continue
    if (entry.path === '404.html') {
      expected.push({ kind: 'not-found', path: `/__workers_observe_missing_${receipt.assets.inventorySha256.slice(0, 16)}`,
        status: 404, bodySha256: entry.sha256, headers: {} })
      continue
    }
    const path = publicUrl(entry.path)
    expected.push({ kind: 'asset', path, status: 200, bodySha256: entry.sha256, headers: expectedHeaders(blocks, path) })
  }
  if (redirectsText !== null) {
    for (const line of redirectsText.split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue
      const parts = line.trim().split(/\s+/)
      need(parts.length === 3 && ['301', '302', '307', '308'].includes(parts[2]) && parts[0].startsWith('/') &&
        !/[*:]/.test(parts[0]), 'unsupported _redirects rule')
      expected.push({ kind: 'redirect', path: parts[0], status: Number(parts[2]), location: parts[1], headers: {} })
    }
  }
  if (contract.shellPath !== null) {
    const shell = files.get('index.html')
    need(shell, 'shell routes require index.html')
    const shellHeaders = { ...expectedHeaders(blocks, contract.shellPath), 'content-type': 'text/html; charset=utf-8' }
    for (const path of contract.shellRoutes) {
      expected.push({ kind: 'shell', path, status: 200, bodySha256: shell.sha256, headers: shellHeaders })
    }
    for (const path of contract.noindexRoutes) {
      expected.push({ kind: 'shell-noindex', path, status: 200, bodySha256: shell.sha256, headers: { ...shellHeaders, 'x-robots-tag': 'noindex' } })
    }
  }
  const seen = new Set()
  for (const item of expected) {
    need(!seen.has(item.path) && item.path.startsWith('/') && !item.path.startsWith('//'), 'duplicate or unsafe observation path')
    seen.add(item.path)
  }
  return expected
}

function baseOrigin(baseUrl) {
  const url = new URL(baseUrl)
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
  need((url.protocol === 'https:' || local) && !url.username && !url.password && (url.pathname === '/' || url.pathname === '') &&
    !url.search && !url.hash, 'base URL must be an https origin')
  return url.origin
}

export function httpGet(url, { agent, timeoutMs = 60000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(url)
    const client = target.protocol === 'https:' ? https : http
    const request = client.request(target, {
      method: 'GET', agent, timeout: timeoutMs,
      headers: { 'accept-encoding': 'identity', 'cache-control': 'no-cache', 'user-agent': 'school-workers-observer/1' },
    }, (response) => {
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) response.destroy(new Error('body limit exceeded'))
        else chunks.push(chunk)
      })
      response.on('end', () => resolvePromise({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }))
      response.on('error', reject)
    })
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', reject)
    request.end()
  })
}

// On a zone hostname (custom domain), Cloudflare Web Analytics' automatic setup inserts its beacon into
// HTML right before `</body>`. workers.dev has no zone features, so the same version is compared there
// byte for byte. For a custom domain, `allowEdgeBeacon` accepts exactly one such tag at that position and
// nothing else: removing it must restore the packaged bytes exactly.
const EDGE_BEACON = /<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/v[0-9a-f]+" integrity="sha512-[A-Za-z0-9+/=]+" data-cf-beacon='\{[^'<>]*\}' crossorigin="anonymous"><\/script>\n?/g

export function withoutEdgeBeacon(body) {
  const text = body.toString('latin1')
  const matches = [...text.matchAll(EDGE_BEACON)]
  if (matches.length !== 1) return null
  const [match] = matches
  const end = match.index + match[0].length
  if (!text.startsWith('</body>', end) || end !== text.lastIndexOf('</body>')) return null
  return Buffer.from(text.slice(0, match.index) + text.slice(end), 'latin1')
}

function compare(item, response, { allowEdgeBeacon = false } = {}) {
  const problems = []
  let beacon = false
  if (response.status !== item.status) problems.push({ reason: 'status', status: response.status })
  const encoding = response.headers['content-encoding']
  if (encoding !== undefined && encoding !== 'identity') problems.push({ reason: 'encoding', actual: encoding })
  if (item.bodySha256 && response.status === item.status && sha(response.body) !== item.bodySha256) {
    const stripped = allowEdgeBeacon && /^text\/html\b/.test(response.headers['content-type'] ?? '') ? withoutEdgeBeacon(response.body) : null
    if (stripped && sha(stripped) === item.bodySha256) beacon = true
    else problems.push({ reason: 'body' })
  }
  if (item.location !== undefined && response.headers.location !== item.location) {
    problems.push({ reason: 'location', expected: item.location, actual: response.headers.location ?? null })
  }
  for (const [name, value] of Object.entries(item.headers)) {
    if (response.headers[name] !== value) problems.push({ reason: 'header', header: name, expected: value, actual: response.headers[name] ?? null })
  }
  return { problems, beacon }
}

export async function observeWorkersPackage({
  packageRoot, expectedReceiptSha256, baseUrl, outputPath, versionId = null, concurrency = 16, allowEdgeBeacon = false,
  get = httpGet, attempts = 3, retryDelayMs = 500, onProgress = () => {}, now = () => new Date(),
}) {
  need(!allowEdgeBeacon || !new URL(baseUrl).hostname.endsWith('.workers.dev'), 'edge beacon allowance is only for zone hostnames')
  const origin = baseOrigin(baseUrl)
  need(Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 64, 'concurrency out of range')
  const output = resolve(outputPath)
  try { await fs.lstat(output); need(false, 'observation output already exists') } catch (error) {
    if (error instanceof WorkersObserveError) throw error
    if (error.code !== 'ENOENT') throw error
  }
  const { receipt, packageRoot: root } = await verifyWorkersPackage({ packageRoot, expectedReceiptSha256 })
  const read = async (path) => receipt.assets.files.some((entry) => entry.path === path)
    ? (await fs.readFile(join(root, 'assets', path))).toString('utf8') : null
  const contract = JSON.parse(await fs.readFile(join(root, 'observe.json')))
  const expected = planObservation({ receipt, headersText: await read('_headers'), redirectsText: await read('_redirects'), contract })
  const agent = new (origin.startsWith('https:') ? https : http).Agent({ keepAlive: true, maxSockets: concurrency })
  const startedAt = now().toISOString()
  const failures = []
  const failuresByReason = {}
  let passed = 0, failed = 0, retries = 0, done = 0, next = 0, edgeBeacon = 0
  async function one(item) {
    let response = null
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        response = await get(origin + item.path, { agent })
        if (!RETRY_STATUSES.has(response.status) || attempt === attempts) break
      } catch {
        response = null
        if (attempt === attempts) break
      }
      retries++
      await new Promise((wake) => setTimeout(wake, retryDelayMs * attempt))
    }
    const { problems, beacon } = response ? compare(item, response, { allowEdgeBeacon }) : { problems: [{ reason: 'transport' }], beacon: false }
    if (beacon) edgeBeacon++
    if (problems.length === 0) passed++
    else {
      failed++
      for (const problem of problems) failuresByReason[problem.reason] = (failuresByReason[problem.reason] ?? 0) + 1
      if (failures.length < MAX_RECORDED_FAILURES) {
        failures.push({ path: item.path, kind: item.kind, expectedStatus: item.status, problems })
      }
    }
    done++
    if (done % 1000 === 0 || done === expected.length) onProgress({ done, total: expected.length, failed })
  }
  async function lane() {
    while (next < expected.length) await one(expected[next++])
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, expected.length) }, lane))
  } finally {
    agent.destroy()
  }
  failures.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const result = {
    format: 'school-workers-http-observation', version: 1,
    status: failed === 0 ? 'passed' : 'failed',
    target: receipt.target, workerName: receipt.workerName, versionId, baseUrl: origin,
    packageReceiptSha256: expectedReceiptSha256, assetInventorySha256: receipt.assets.inventorySha256,
    startedAt, finishedAt: now().toISOString(),
    expected: expected.length, passed, failed, retries, allowEdgeBeacon, edgeBeaconNormalized: edgeBeacon,
    byKind: expected.reduce((counts, item) => ({ ...counts, [item.kind]: (counts[item.kind] ?? 0) + 1 }), {}),
    workerFirstRequests: expected.filter((item) => workerFirst(receipt.runWorkerFirst, new URL(item.path, origin).pathname)).length,
    failuresByReason, failures,
  }
  await fs.writeFile(output, canonical(result), { flag: 'wx' })
  return { ...result, outputPath: output, failures: undefined }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2)
  const allowEdgeBeacon = args.includes('--allow-edge-beacon')
  const [packageRoot, receiptSha256, baseUrl, outputPath, versionId] = args.filter((arg) => arg !== '--allow-edge-beacon')
  try {
    need(packageRoot && receiptSha256 && baseUrl && outputPath,
      'usage: workers-observe.mjs <package-root> <package-receipt-sha256> <base-url> <output-json> [version-id] [--allow-edge-beacon]')
    const result = await observeWorkersPackage({
      packageRoot, expectedReceiptSha256: receiptSha256, baseUrl, outputPath, versionId: versionId ?? null, allowEdgeBeacon,
      onProgress: ({ done, total, failed }) => console.error(`progress ${done}/${total} failed=${failed}`),
    })
    console.log(JSON.stringify(result))
    if (result.status !== 'passed') process.exitCode = 2
  } catch (error) {
    console.error(`Workers observation rejected: ${error instanceof WorkersObserveError || error?.constructor?.name === 'WorkersPackageError' ? error.message : error?.code ?? 'unexpected error'}`)
    process.exitCode = 1
  }
}
