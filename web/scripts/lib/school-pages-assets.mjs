// Explicit, inactive Pages Direct Upload transport. Does not create deployments.
// Protocol: https://developers.cloudflare.com/api/resources/pages/subresources/assets/
// Hash convention: cloudflare/workers-sdk packages/deploy-helpers/src/deploy/helpers/hash.ts
import { extname } from 'node:path'
import { blake3 } from '@noble/hashes/blake3.js'
import { schoolResourceBudget, sameSchoolBudget } from './school-resource-budget.mjs'

const API = 'https://api.cloudflare.com/client/v4'
const MiB = 1024 * 1024
const ensure = (ok) => { if (!ok) throw new Error('Pages asset upload rejected') }
const isPath = (path) => typeof path === 'string' && path.length <= 1024 &&
  /^[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)*$/u.test(path) &&
  path.split('/').every((part) => part !== '.' && part !== '..' && (!part.startsWith('.') || part === '.well-known')) &&
  !['_worker.js', '_routes.json', '_headers', '_redirects'].includes(path)
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript', '.mjs': 'application/javascript', '.json': 'application/json',
  '.gz': 'application/gzip', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf', '.md': 'text/markdown; charset=utf-8', '.zip': 'application/zip',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
}

export function pagesAssetHash(path, bytes) {
  ensure(isPath(path) && Buffer.isBuffer(bytes))
  // Match Wrangler, including extension case; these are cache keys, not trust pins.
  return Buffer.from(blake3(Buffer.from(bytes.toString('base64') + extname(path).slice(1)))).toString('hex').slice(0, 32)
}

/** Returns uploadAssets({ accountId, project, files, signal }) for the release adapter.
 * Credential and targets are supplied separately; never reads env or files.
 * API responses cannot redirect credentials. All response bodies and waits are bounded.
 * No retries, deployment changes, or claim of live publication occur here.
 */
export function createPagesAssetUploader({ apiToken, fetchImpl = fetch, timeoutMs = 60_000,
  resourceBudget, maxTotalBytes, maxFileBytes, maxResponseBytes = MiB } = {}) {
  const limits = schoolResourceBudget({ ...resourceBudget,
    ...(maxTotalBytes === undefined ? {} : { maxTotalBytes }), ...(maxFileBytes === undefined ? {} : { maxFileBytes }) })
  maxTotalBytes = limits.maxTotalBytes; maxFileBytes = limits.maxFileBytes
  ensure(typeof apiToken === 'string' && apiToken.length > 0 && !/[\s]/.test(apiToken) &&
    typeof fetchImpl === 'function')
  ensure([timeoutMs, maxTotalBytes, maxFileBytes, maxResponseBytes].every((n) => Number.isSafeInteger(n) && n > 0))
  ensure(timeoutMs <= 3_600_000 && maxResponseBytes <= 8 * MiB)
  return async function uploadAssets({ accountId, project, files, signal, resourceBudget: pinnedBudget } = {}) {
    ensure(pinnedBudget === undefined || sameSchoolBudget(limits, pinnedBudget))
    ensure(typeof accountId === 'string' && /^[a-f0-9]{32}$/.test(accountId) &&
      typeof project === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(project))
    ensure(files instanceof Map && files.size > 0 && files.size <= limits.maxFiles)
    const deadline = performance.now() + timeoutMs
    // Take ownership before the first await; the caller cannot replace uploaded bytes.
    let total = 0
    const entries = [], manifest = Object.create(null), byHash = new Map()
    for (const [path, original] of files) {
      ensure(performance.now() < deadline && !signal?.aborted)
      ensure(isPath(path) && Buffer.isBuffer(original) && original.length <= maxFileBytes)
      total += original.length
      ensure(total <= maxTotalBytes)
      const bytes = Buffer.from(original), key = pagesAssetHash(path, bytes)
      const contentType = types[extname(path).toLowerCase()] ?? 'application/octet-stream'
      const item = { key, bytes, contentType }
      if (byHash.has(key)) ensure(byHash.get(key).bytes.equals(bytes) && byHash.get(key).contentType === contentType)
      else { byHash.set(key, item); entries.push(item) }
      manifest['/' + path] = key
    }
    const controller = new AbortController()
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    ensure(performance.now() < deadline)
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - performance.now()))
    let abortListener
    const stopped = new Promise((_, reject) => {
      abortListener = () => reject(new Error('Pages asset upload stopped'))
      combined.addEventListener('abort', abortListener, { once: true })
    })
    const bounded = async (operation) => {
      ensure(!combined.aborted && performance.now() < deadline)
      const result = await Promise.race([Promise.resolve().then(operation), stopped])
      ensure(!combined.aborted && performance.now() < deadline)
      return result
    }
    async function request(path, token, payload) {
      const response = await bounded(() => fetchImpl(API + path, {
        method: payload === undefined ? 'GET' : 'POST', redirect: 'error', signal: combined,
        headers: { Authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      }))
      let reader
      try {
        ensure(response.ok && !response.redirected &&
          response.headers.get('content-type')?.split(';')[0].trim() === 'application/json')
        const length = response.headers.get('content-length')
        ensure(length === null || (/^\d+$/.test(length) && Number(length) <= maxResponseBytes))
        reader = response.body?.getReader()
        ensure(reader)
        let size = 0
        const parts = []
        while (true) {
          const { done, value } = await bounded(() => reader.read())
          if (done) break
          size += value.byteLength
          ensure(size <= maxResponseBytes)
          parts.push(Buffer.from(value))
        }
        const value = JSON.parse(Buffer.concat(parts).toString('utf8'))
        ensure(value?.success === true && Array.isArray(value.errors) && value.errors.length === 0)
        return value.result
      } finally {
        // Cancel without waiting on a hostile/failed stream; fetch is aborted on exit.
        if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock() }
        else if (response.body) void response.body.cancel().catch(() => {})
      }
    }
    try {
      ensure(!combined.aborted)
      const authorization = await request(`/accounts/${accountId}/pages/projects/${project}/upload-token`, apiToken)
      ensure(typeof authorization?.jwt === 'string' && authorization.jwt.length > 0 && !/\s/.test(authorization.jwt))
      const jwt = authorization.jwt, hashes = entries.map((item) => item.key)
      const missing = await request('/pages/assets/check-missing', jwt, { hashes })
      ensure(Array.isArray(missing) && new Set(missing).size === missing.length && missing.every((key) => byHash.has(key)))
      const needed = new Set(missing)
      for (const item of entries) if (!needed.has(item.key)) item.bytes = null
      // Small serial batches bound memory and API request size. No automatic retry.
      let batch = [], batchSize = 2
      async function flush() {
        if (batch.length) await request('/pages/assets/upload', jwt, batch)
        batch = []; batchSize = 2
      }
      for (const key of missing) {
        const item = byHash.get(key)
        const upload = { key, value: item.bytes.toString('base64'), metadata: { contentType: item.contentType }, base64: true }
        item.bytes = null
        const size = Buffer.byteLength(JSON.stringify(upload)) + 1
        if (batchSize + size > 40 * MiB || batch.length >= 1000) await flush()
        batch.push(upload); batchSize += size
      }
      await flush()
      await request('/pages/assets/upsert-hashes', jwt, { hashes })
      // API cache presence is not evidence of bytes at the live origin. Release runner
      // must still GET/HEAD every pinned artifact after the deployment settles.
      const remaining = await request('/pages/assets/check-missing', jwt, { hashes })
      ensure(Array.isArray(remaining) && remaining.length === 0 && !combined.aborted)
      return manifest
    } catch {
      throw new Error('Pages asset upload failed; deployment was not requested')
    } finally {
      clearTimeout(timer)
      combined.removeEventListener('abort', abortListener)
      controller.abort()
    }
  }
}
