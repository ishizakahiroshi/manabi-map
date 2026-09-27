// Inactive Cloudflare Pages REST adapter. No default credentials or targets.
// HTTP timeout is not server cancellation: uncertain mutations permanently block
// this adapter's rollback and require independent operational reconciliation.
import { canonicalSchoolSourceJSON } from './school-source.mjs'
import { schoolDataPath, schoolDigest } from './school-functions-package.mjs'
export { schoolPublicPath } from './school-functions-package.mjs'

const check = (ok) => { if (!ok) throw new Error('School Pages adapter: operation refused') }
const id = (v) => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v)
const controls = new Set(['_routes.json', '_headers', '_redirects'])
export const schoolBindingsDigest = (config) => schoolDigest(Buffer.from(canonicalSchoolSourceJSON(config)))

/** projects: Map(project, {origin, branch, next:{package,pin},
 * previous:{deploymentId,package,pin}}).
 * uploadAssets({accountId,project,files,signal}) returns /path -> storage hash.
 * Only copies of pinned public inventory bytes cross that dependency boundary.
 * Uses canonical_deployment (not latest preview) and never changes bindings/DNS.
 * Caller must hold an external exclusive release lease across both targets.
 * Cloudflare offers no compare-and-swap deployment endpoint; rechecks detect
 * observed conflicts but cannot eliminate a race with an uncooperative writer.
 */
export function createSchoolPagesAdapter({ accountId, token, projects, fetchImpl, uploadAssets,
  requestTimeoutMs = 10000,
  settlementTimeoutMs = 120000, pollIntervalMs = 1000, operationTimeoutMs = 300000 }) {
  check(typeof accountId === 'string' && /^[a-f0-9]{32}$/.test(accountId) &&
    typeof token === 'string' && token.length > 0 && !/[\r\n]/.test(token))
  check(typeof fetchImpl === 'function' && typeof uploadAssets === 'function' && projects instanceof Map && projects.size === 2)
  const apiBase = 'https://api.cloudflare.com/client/v4'
  for (const n of [requestTimeoutMs, settlementTimeoutMs, pollIntervalMs, operationTimeoutMs]) check(Number.isSafeInteger(n) && n > 0 && n <= 3600000)
  const configs = new Map()
  for (const [project, config] of projects) {
    check(typeof project === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(project) && id(config.branch) && id(config.previous.deploymentId))
    const origin = new URL(config.origin)
    check(config.origin === origin.origin && origin.protocol === 'https:')
    configs.set(project, { origin: config.origin, branch: config.branch,
      next: config.next.package.snapshot(config.next.pin),
      previous: { ...config.previous.package.snapshot(config.previous.pin), deploymentId: config.previous.deploymentId } })
  }
  const targetOrigins = new Set([...configs.values()].map((c) => c.origin))
  check(targetOrigins.size === 2)
  for (const c of configs.values()) for (const distribution of [c.next, c.previous]) {
    check(distribution.redirectOrigins.every((origin) => targetOrigins.has(origin)))
  }
  const busy = new Set(), uncertain = new Set(), ownedDeployments = new Map(), deadlines = new Map()
  function budget(project, requested) {
    const remaining = (deadlines.get(project) ?? Infinity) - performance.now()
    if (remaining <= 0) { uncertain.add(project); throw new Error('operation deadline') }
    return Math.min(requested, remaining)
  }
  function targetConfig(target) {
    const c = configs.get(target.project)
    check(c && target.origin === c.origin)
    return c
  }
  async function bounded(work, milliseconds = requestTimeoutMs) {
    const controller = new AbortController()
    let timer
    try {
      return await Promise.race([Promise.resolve().then(() => work(controller.signal)), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')) }, milliseconds)
      })])
    } finally { clearTimeout(timer); controller.abort() }
  }
  const endpoint = (project) => `${apiBase}/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(project)}`
  async function responseBytes(response, limit, headerLimit = limit) {
    check(!response.redirected)
    const length = response.headers.get('content-length')
    check(length === null || (/^\d+$/.test(length) && Number(length) <= headerLimit))
    if (!response.body) return Buffer.alloc(0)
    const reader = response.body.getReader(), parts = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength; check(size <= limit)
        parts.push(Buffer.from(value))
      }
      return Buffer.concat(parts)
    } finally { void reader.cancel().catch(() => {}) }
  }
  async function api(project, suffix = '', method = 'GET', body, timeoutMs = requestTimeoutMs) {
    const result = await bounded(async (signal) => {
      const response = await fetchImpl(endpoint(project) + suffix, { method, body, signal,
        redirect: 'error', headers: { authorization: `Bearer ${token}` } })
      check(response.ok && response.headers.get('content-type')?.split(';')[0].trim() === 'application/json')
      const result = JSON.parse((await responseBytes(response, 1024 * 1024)).toString('utf8'))
      check(result.success === true && Array.isArray(result.errors) && result.errors.length === 0 && result.result)
      return result.result
    }, budget(project, timeoutMs))
    budget(project, requestTimeoutMs)
    return result
  }
  async function current(target, timeoutMs = requestTimeoutMs) {
    targetConfig(target)
    const project = await api(target.project, '', 'GET', undefined, timeoutMs)
    check(id(project.canonical_deployment?.id))
    return project.canonical_deployment.id
  }
  async function read(target, path, method) {
    const c = targetConfig(target)
    check((method === 'GET' || method === 'HEAD') && (c.next.files.has(path) || c.previous.files.has(path)) && !controls.has(path))
    const before = await current(target)
    const distribution = before === c.previous.deploymentId ? c.previous :
      before === ownedDeployments.get(target.project) ? c.next : null
    check(distribution && Object.hasOwn(distribution.observations, path))
    const observation = distribution.observations[path]
    const response = await bounded(async (signal) => {
      // Fetch only the configured origin. Location is checked, never followed.
      const result = await fetchImpl(`${target.origin}${observation.path}`, {
        method, signal, redirect: 'manual', headers: { 'cache-control': 'no-cache' } })
      const limit = observation.body === 'redirect' ? 16384 : distribution.files.get(path).length
      return { status: result.status, headers: result.headers, bytes: await responseBytes(result, method === 'HEAD' ? 0 : limit, limit) }
    }, budget(target.project, requestTimeoutMs))
    check(await current(target) === before)
    return { ...response, deploymentId: before }
  }
  async function configuration(target, distribution) {
    const c = targetConfig(target), project = await api(target.project)
    check(project.production_branch === c.branch && project.source == null &&
      schoolBindingsDigest(project.deployment_configs?.production) === distribution.bindingsSha256)
    return project
  }
  async function settle(target, deploymentId) {
    const deadline = performance.now() + settlementTimeoutMs
    while (performance.now() < deadline) {
      const deployment = await api(target.project, `/deployments/${encodeURIComponent(deploymentId)}`, 'GET', undefined,
        Math.max(1, Math.min(requestTimeoutMs, deadline - performance.now())))
      check(deployment.id === deploymentId && deployment.environment === 'production')
      const stage = deployment.latest_stage
      if (stage?.name === 'deploy' && stage.status === 'success' && stage.ended_on) {
        const remaining = deadline - performance.now()
        check(remaining > 0)
        const live = await current(target, Math.max(1, Math.min(requestTimeoutMs, remaining)))
        check(performance.now() < deadline)
        if (live === deploymentId) {
          uncertain.delete(target.project)
          return
        }
      }
      if (['failure', 'canceled'].includes(stage?.status) && stage.ended_on) {
        uncertain.delete(target.project)
        throw new Error('terminal failure')
      }
      await new Promise((resolve) => setTimeout(resolve,
        budget(target.project, Math.min(pollIntervalMs, Math.max(1, deadline - performance.now())))))
      budget(target.project, requestTimeoutMs)
    }
    throw new Error('settlement unavailable')
  }
  async function verifyDistribution(target, distribution, deploymentId) {
    await configuration(target, distribution)
    check(await current(target) === deploymentId)
    for (const [path, bytes] of distribution.files) {
      if (controls.has(path)) continue
      const observation = distribution.observations[path]
      for (const method of ['GET', 'HEAD']) {
        const result = await read(target, path, method)
        check(result.status === observation.status && result.deploymentId === deploymentId)
        if (observation.body === 'redirect') check(new Headers(result.headers).get('location') === observation.location)
        else check((method === 'HEAD' ? result.bytes.length === 0 : result.bytes.equals(bytes)) && !new Headers(result.headers).has('location'))
      }
    }
    check(await current(target) === deploymentId)
  }
  async function mutate(target, run) {
    targetConfig(target)
    check(!busy.has(target.project) && !uncertain.has(target.project))
    busy.add(target.project)
    deadlines.set(target.project, performance.now() + operationTimeoutMs)
    try {
      const result = await run()
      budget(target.project, requestTimeoutMs)
      return result
    } catch {
      if (performance.now() >= deadlines.get(target.project)) uncertain.add(target.project)
      throw new Error('School Pages adapter: mutation failed; inspect recovery state')
    } finally { busy.delete(target.project); deadlines.delete(target.project) }
  }
  return Object.freeze({
    async current(target) { try { return await current({ ...target }) } catch { throw new Error('School Pages adapter: current unavailable') } },
    async read(target, path, method) { try { return await read({ ...target }, path, method) } catch { throw new Error('School Pages adapter: read unavailable') } },
    async deploy(target, artifacts, receipt) {
      target = { ...target }
      return mutate(target, async () => {
        const c = targetConfig(target), distribution = c.next
        check(receipt.candidateRevision === distribution.sourceRevision && artifacts instanceof Map)
        const expected = receipt.artifacts
        check(Array.isArray(expected) && expected.length === artifacts.size &&
          expected.length === [...distribution.files.keys()].filter(schoolDataPath).length)
        for (const entry of expected) {
          const bytes = artifacts.get(entry.path)
          check(Buffer.isBuffer(bytes) && bytes.length === entry.size && schoolDigest(bytes) === entry.sha256 &&
            distribution.files.get(entry.path)?.equals(bytes))
        }
        await verifyDistribution(target, c.previous, c.previous.deploymentId)
        await configuration(target, distribution)
        const files = new Map([...distribution.files].filter(([path]) => !controls.has(path)).map(([path, bytes]) => [path, Buffer.from(bytes)]))
        const manifest = await bounded((signal) => uploadAssets({ accountId, project: target.project,
          files: new Map([...files].map(([path, bytes]) => [path, Buffer.from(bytes)])), signal }), budget(target.project, settlementTimeoutMs))
        budget(target.project, requestTimeoutMs)
        check(manifest && typeof manifest === 'object' && !Array.isArray(manifest) &&
          Object.keys(manifest).length === files.size && [...files.keys()].every((path) =>
            typeof manifest[`/${path}`] === 'string' && /^[a-f0-9]{32,64}$/.test(manifest[`/${path}`])))
        const body = new FormData()
        body.set('manifest', JSON.stringify(manifest)); body.set('branch', c.branch)
        body.set('commit_hash', distribution.sourceRevision); body.set('commit_dirty', 'true')
        body.set('_worker.js', new Blob([distribution.worker], { type: 'application/javascript' }), '_worker.js')
        for (const path of controls) if (distribution.files.has(path)) body.set(path, new Blob([distribution.files.get(path)]), path)
        check(await current(target) === c.previous.deploymentId)
        uncertain.add(target.project)
        const deployment = await api(target.project, '/deployments', 'POST', body)
        check(id(deployment.id))
        await settle(target, deployment.id)
        ownedDeployments.set(target.project, deployment.id)
        await verifyDistribution(target, distribution, deployment.id)
        return deployment.id
      })
    },
    async rollback(target, deploymentId) {
      target = { ...target }
      return mutate(target, async () => {
        const c = targetConfig(target)
        check(deploymentId === c.previous.deploymentId)
        await configuration(target, c.previous)
        const live = await current(target)
        if (live !== deploymentId) {
          check(live === ownedDeployments.get(target.project))
          uncertain.add(target.project)
          const deployment = await api(target.project, `/deployments/${encodeURIComponent(deploymentId)}/rollback`, 'POST')
          check(deployment.id === deploymentId)
          await settle(target, deploymentId)
        }
        await verifyDistribution(target, c.previous, deploymentId)
      })
    },
    recoveryState() { return { uncertainProjects: [...uncertain].sort(), runningProjects: [...busy].sort() } },
  })
}
