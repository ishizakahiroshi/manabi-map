// Inactive release orchestration. No environment, network, credentials or CLI.
// An adapter must settle a deployment before resolving/rejecting; hook acceptance
// is not settlement. The caller owns operation timeouts/cancellation and must not
// let a timed-out deployment race a rollback. Real adapters require live review.
import { createHash } from 'node:crypto'
import { canonicalSchoolSourceJSON } from './school-source.mjs'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const encode = (value) => Buffer.from(`${canonicalSchoolSourceJSON(value)}\n`)
const requireValue = (ok, message) => { if (!ok) throw new Error(`School release: ${message}`) }
const fields = (obj, names) => requireValue(obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).sort().join(',') === names.split(' ').sort().join(','), 'invalid fields')
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
const artifactPath = (value) => typeof value === 'string' && !value.split('/').some((x) => !x || x === '.' || x === '..') &&
  /^(?:schools-manifest\.json|(?:schools(?:-map)?|city-index|school-name-index)-[a-f0-9]+\.json(?:\.gz)?|school-data\/[a-z0-9-]+\.json|api\/v1\/(?:schools|dataset|openapi)\.json|api\/v1\/schools\/[a-z0-9-]+\.json)$/.test(value)

/** Only the public projection is accepted, never a source database or private JSON.
 * projectionGateSha256 must identify the separately reviewed public-field check;
 * creating a receipt does not itself rerun or certify that check.
 */
export function createSchoolReleaseReceipt(metadata, artifacts) {
  fields(metadata, 'generation sourceSnapshotSha256 projectionGateSha256 candidateRevision evidence')
  requireValue(artifacts instanceof Map, 'artifact map required')
  const entries = [...artifacts].map(([path, bytes]) => {
    requireValue(Buffer.isBuffer(bytes), 'artifact bytes required')
    return { path, size: bytes.length, sha256: digest(bytes) }
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const raw = encode({ format: 'school-release-generation', version: 1, ...metadata, artifacts: entries })
  // This self-check is not an independent trust decision. Callers must retain and
  // approve a pin independently before passing the receipt to the release runner.
  validateSchoolRelease(raw, { generation: metadata.generation, receiptSha256: digest(raw),
    projectionGateSha256: metadata.projectionGateSha256 }, artifacts)
  return raw
}

export function validateSchoolRelease(raw, pin, artifacts) {
  requireValue(Buffer.isBuffer(raw), 'receipt bytes required')
  fields(pin, 'generation receiptSha256 projectionGateSha256')
  requireValue(sha(pin.receiptSha256) && sha(pin.projectionGateSha256) && digest(raw) === pin.receiptSha256, 'trusted pin mismatch')
  let receipt
  try { receipt = JSON.parse(raw.toString('utf8')) } catch { throw new Error('School release: invalid receipt JSON') }
  requireValue(raw.equals(encode(receipt)), 'canonical receipt required')
  fields(receipt, 'format version generation sourceSnapshotSha256 projectionGateSha256 candidateRevision evidence artifacts')
  requireValue(receipt.format === 'school-release-generation' && receipt.version === 1, 'unsupported receipt')
  requireValue(identifier(receipt.generation) && receipt.generation === pin.generation, 'generation mismatch')
  requireValue(sha(receipt.sourceSnapshotSha256) && receipt.projectionGateSha256 === pin.projectionGateSha256 &&
    /^[a-f0-9]{40}$/.test(receipt.candidateRevision), 'source or revision missing')
  requireValue(['synthetic', 'observed'].includes(receipt.evidence), 'evidence kind required')
  requireValue(Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0, 'artifacts missing')
  const paths = []
  for (const entry of receipt.artifacts) {
    fields(entry, 'path size sha256')
    requireValue(artifactPath(entry.path) && Number.isSafeInteger(entry.size) && entry.size > 0 && sha(entry.sha256), 'invalid artifact')
    paths.push(entry.path)
  }
  requireValue(paths.includes('schools-manifest.json') && paths.includes('api/v1/schools.json'), 'public manifests missing')
  requireValue(new Set(paths).size === paths.length && JSON.stringify(paths) === JSON.stringify([...paths].sort()), 'paths must be sorted unique')
  if (artifacts !== undefined) {
    requireValue(artifacts instanceof Map && artifacts.size === paths.length && [...artifacts.keys()].every((p) => paths.includes(p)), 'artifact set mismatch')
    for (const entry of receipt.artifacts) {
      const bytes = artifacts.get(entry.path)
      requireValue(Buffer.isBuffer(bytes) && bytes.length === entry.size && digest(bytes) === entry.sha256, 'artifact bytes differ')
    }
  }
  return receipt
}

function validateTargets(targets, order) {
  fields(targets, 'apex high-school')
  requireValue(Array.isArray(order) && order.length === 2 && new Set(order).size === 2 &&
    order.every((key) => Object.hasOwn(targets, key)), 'explicit two-target order required')
  const origins = [], projects = []
  for (const target of Object.values(targets)) {
    fields(target, 'origin project')
    let url
    try { url = new URL(target.origin) } catch { throw new Error('School release: invalid origin') }
    requireValue(url.protocol === 'https:' && target.origin === url.origin && !url.username && !url.password && identifier(target.project), 'invalid target')
    origins.push(url.origin); projects.push(target.project)
  }
  requireValue(new Set(origins).size === 2 && new Set(projects).size === 2, 'separate targets required')
}

function copyArtifacts(artifacts) { return new Map([...artifacts].map(([path, bytes]) => [path, Buffer.from(bytes)])) }
function safeReceipt(receipt) { return JSON.parse(JSON.stringify(receipt)) }

/** read() observes the live origin, not a deployment preview, and returns decoded
 * response bytes (HTTP content-encoding removed, stored .gz files still gzip).
 * All N artifacts get GET+HEAD checks; no fixed synthetic artifact count.
 */
async function verifyLive(adapter, target, deploymentId, receipt) {
  requireValue(await adapter.current({ ...target }) === deploymentId, 'live deployment mismatch')
  for (const entry of receipt.artifacts) {
    for (const method of ['GET', 'HEAD']) {
      const response = await adapter.read({ ...target }, entry.path, method)
      requireValue(response && response.status === 200 && response.deploymentId === deploymentId, 'public response mismatch')
      const headers = new Headers(response.headers)
      const mime = headers.get('content-type')?.split(';')[0].trim()
      requireValue(mime === (entry.path.endsWith('.gz') ? 'application/gzip' : 'application/json'), 'public MIME mismatch')
      requireValue(Buffer.isBuffer(response.bytes), 'response bytes missing')
      requireValue(method === 'HEAD' ? response.bytes.length === 0 :
        response.bytes.length === entry.size && digest(response.bytes) === entry.sha256, 'public artifact mismatch')
      if (entry.path.startsWith('api/v1/')) {
        requireValue(headers.get('access-control-allow-origin') === '*' &&
          /(?:^|,)\s*public\s*(?:,|$)/i.test(headers.get('cache-control') ?? '') &&
          /(?:^|,)\s*max-age=3600\s*(?:,|$)/i.test(headers.get('cache-control') ?? ''), 'public API headers mismatch')
      }
      if (entry.path === 'schools-manifest.json') requireValue(headers.get('cache-control') === 'no-store', 'manifest cache mismatch')
    }
  }
  requireValue(await adapter.current({ ...target }) === deploymentId, 'deployment changed during verification')
}

/** Adapter methods: current/read/deploy/rollback; all settle before returning.
 * maxSkewMs is checked after every awaited operation group. It detects an overrun,
 * not a hard interruption guarantee. No real adapter is installed by this module.
 * A successful result covers generation publication only, not OAuth/old assets.
 */
export async function runSchoolRelease({ raw, pin, artifacts, previous, targets, order, maxSkewMs, adapter, clock }) {
  // Clone mutable caller inputs before the first await, including every byte buffer.
  const nextFiles = copyArtifacts(artifacts), priorFiles = copyArtifacts(previous.artifacts)
  const next = validateSchoolRelease(Buffer.from(raw), structuredClone(pin), nextFiles)
  const prior = validateSchoolRelease(Buffer.from(previous.raw), structuredClone(previous.pin), priorFiles)
  targets = structuredClone(targets); order = structuredClone(order)
  const priorDeployments = structuredClone(previous.deployments)
  validateTargets(targets, order); fields(priorDeployments, 'apex high-school')
  requireValue(next.generation !== prior.generation && next.evidence === prior.evidence, 'distinct generations with matching evidence required')
  requireValue(Object.values(priorDeployments).every(identifier), 'previous deployments missing')
  requireValue(Number.isSafeInteger(maxSkewMs) && maxSkewMs > 0 && typeof clock === 'function', 'explicit time budget and clock required')
  requireValue(adapter && ['current', 'read', 'deploy', 'rollback'].every((key) => typeof adapter[key] === 'function'), 'explicit adapter required')
  // Reject invalid rollback inputs before any mutation.
  try {
    for (const key of order) await verifyLive(adapter, targets[key], priorDeployments[key], prior)
  } catch { throw new Error('School release: rollback preflight failed') }
  let lastTime = clock()
  requireValue(Number.isFinite(lastTime), 'invalid clock')
  const start = lastTime
  const checkBudget = () => {
    const now = clock()
    requireValue(Number.isFinite(now) && now >= lastTime, 'nonmonotonic clock')
    lastTime = now
    requireValue(now - start <= maxSkewMs, 'generation skew time exceeded')
  }
  const deployments = {}
  try {
    for (const key of order) {
      checkBudget()
      // Deployment payload is a copy; adapters cannot corrupt internal rollback evidence.
      deployments[key] = await adapter.deploy({ ...targets[key] }, copyArtifacts(nextFiles), safeReceipt(next))
      requireValue(identifier(deployments[key]), 'settled deployment ID required')
      checkBudget()
      await verifyLive(adapter, targets[key], deployments[key], next)
      checkBudget()
    }
    // Recheck both after the second deployment to catch later changes on the first.
    for (const key of order) await verifyLive(adapter, targets[key], deployments[key], next)
    checkBudget()
    return { state: 'complete', evidence: next.evidence, generation: next.generation,
      deployments, artifacts: next.artifacts.length, elapsedMs: lastTime - start }
  } catch {
    // A rejection can occur after mutation. Restore and verify BOTH prior deployments.
    // No automatic retry of the new generation; opaque adapter errors may contain secrets.
    const failed = new Set()
    for (const key of [...order].reverse()) {
      try { await adapter.rollback({ ...targets[key] }, priorDeployments[key]) } catch { failed.add(key) }
    }
    for (const key of order) {
      try { await verifyLive(adapter, targets[key], priorDeployments[key], prior) } catch { failed.add(key) }
    }
    return { state: failed.size ? 'recovery-required' : 'rolled-back', evidence: next.evidence,
      failedGeneration: next.generation, restoredGeneration: failed.size ? null : prior.generation,
      failedTargets: [...failed].sort() }
  }
}
