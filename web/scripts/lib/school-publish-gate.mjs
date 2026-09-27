// Synthetic, local publication rehearsal only. No transport, hook or deployment adapter.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { CANDIDATE_MANIFEST, checkedFile, verifySchoolCandidate } from './school-candidate.mjs'
import { canonicalSchoolSourceJSON } from './school-source.mjs'
import { buildPublicSchoolRecords } from './public-api.mjs'

export const SCHOOL_PUBLICATION_STUB_DESTINATION = 'stub://school-publication'
const scriptDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/local-data')
const execute = promisify(execFile)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const requireValue = (ok, message) => { if (!ok) throw new Error(`School publication refused: ${message}`) }
const same = (a, b) => canonicalSchoolSourceJSON(a) === canonicalSchoolSourceJSON(b)
const identityKeys = ['datasetVersion', 'sourceVersion', 'snapshotSha256', 'contentSha256', 'candidateManifestSha256', 'artifactsSha256']

function validateIdentity(identity) {
  requireValue(identity && typeof identity === 'object' && !Array.isArray(identity) &&
    same(Object.keys(identity).sort(), [...identityKeys].sort()), 'candidate identity fields')
  for (const key of identityKeys) requireValue(typeof identity[key] === 'string' &&
    (key.endsWith('Sha256') ? /^[0-9a-f]{64}$/.test(identity[key]) : identity[key].trim().length > 0), 'candidate identity value')
}

export async function schoolCandidateIdentity(candidateRoot) {
  const receipt = await verifySchoolCandidate(candidateRoot)
  const raw = await fs.readFile(await checkedFile(join(candidateRoot, CANDIDATE_MANIFEST)))
  requireValue(same(JSON.parse(raw), receipt), 'candidate changed during verification')
  return {
    datasetVersion: receipt.datasetVersion, sourceVersion: receipt.sourceVersion,
    snapshotSha256: receipt.source.snapshotSha256, contentSha256: receipt.source.contentSha256,
    candidateManifestSha256: hash(raw), artifactsSha256: receipt.artifactsSha256,
  }
}

// Reuse Python's strict index and registration validators rather than a second JS schema.
// The executable must be supplied explicitly; this bridge never reads credentials or a DB.
const verifyRegistrationCode = [
  'import json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'import school_id_index, school_registry, store, store_core',
  'index = school_id_index.verify_index(sys.argv[2])',
  'raw, _ = school_id_index._read(sys.argv[3])',
  'receipt = json.loads(raw, object_pairs_hook=store.reject_duplicate_keys, parse_constant=store_core.reject_constant)',
  'school_registry.validate_receipt(receipt, index)',
  'print(json.dumps({"index": index, "receipt": receipt}, allow_nan=False))',
].join('\n')

async function verifyArtifactIds(candidateRoot, receipt, index) {
  const schools = new Set(index.schools.map((row) => row.id))
  const departments = new Map(index.departments.map((row) => [row.id, row.school_id]))
  const artifacts = new Map()
  for (const entry of receipt.artifacts) {
    requireValue(/\.json(?:\.gz)?$/.test(entry.path), 'unsupported school artifact')
    const bytes = await fs.readFile(await checkedFile(join(candidateRoot, entry.path)))
    artifacts.set(entry.path, JSON.parse(entry.path.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8')))
  }
  const manifest = artifacts.get('schools-manifest.json')
  const consumed = new Set(['schools-manifest.json'])
  function at(url) {
    requireValue(typeof url === 'string' && /^\/[a-zA-Z0-9._/-]+$/.test(url) && !url.split('/').includes('..'), 'invalid artifact URL')
    const path = url.slice(1)
    requireValue(artifacts.has(path), 'manifest references missing artifact')
    consumed.add(path); return artifacts.get(path)
  }
  function rowsIds(rows, compact = false) {
    requireValue(Array.isArray(rows), 'school rows missing')
    const ids = rows.map((row) => compact ? row.i : row.id)
    requireValue(ids.every((id) => schools.has(id)), 'unregistered school ID')
    requireValue(new Set(ids).size === ids.length, 'duplicate school ID')
    return ids.sort()
  }
  function references(value, context) {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value) references(item, context); return }
    for (const [key, child] of Object.entries(value)) {
      if (['school_id', 'predecessor_school_id', 'successor_school_id'].includes(key) && child !== null) {
        requireValue(schools.has(child), 'unregistered referenced school ID')
        if (key === 'school_id' && context) requireValue(child === context, 'different school membership')
      }
      if (key === 'department_id' && child !== null) requireValue(departments.has(child) && departments.get(child) === context, 'unregistered department or different school')
      if (key === 'school_departments') {
        requireValue(Array.isArray(child), 'department rows missing')
        for (const row of child) requireValue(departments.has(row.id) && departments.get(row.id) === context, 'unregistered department or different school')
      }
      if (key === 'predecessor' && child && Object.hasOwn(child, 'id')) {
        requireValue(schools.has(child.id), 'unregistered predecessor ID'); references(child, child.id); continue
      }
      if (key === 'linkableSchoolIds') requireValue(Array.isArray(child) && child.every((id) => schools.has(id)), 'unregistered linkable school ID')
      if (['neighbors', 'successors'].includes(key)) rowsIds(child)
      references(child, context)
    }
  }
  function payloadIds(payload) {
    const ids = rowsIds(payload?.schools)
    for (const row of payload.schools) references(row, row.id)
    references(payload.neighbors, null)
    if (payload.neighbors) rowsIds(payload.neighbors)
    if (payload.successors) rowsIds(payload.successors)
    if (payload.linkableSchoolIds) requireValue(payload.linkableSchoolIds.every((id) => schools.has(id)), 'unregistered linkable school ID')
    return ids
  }
  const full = at(manifest.url), fullIds = payloadIds(full), mapIds = payloadIds(at(manifest.mapUrl))
  requireValue(same(fullIds, mapIds), 'full/map school IDs differ')
  requireValue(manifest.count === fullIds.length && manifest.mapCount === mapIds.length, 'manifest school count differs')
  const detailIds = full.schools.filter((row) => row.latitude != null && row.longitude != null).map((row) => row.id).sort()
  const detailPaths = [...artifacts.keys()].filter((path) => /^school-data\/[0-9a-f-]+\.json$/.test(path)).sort()
  requireValue(same(detailPaths, detailIds.map((id) => `school-data/${id}.json`)), 'detail/full school IDs differ')
  for (const id of detailIds) requireValue(same(payloadIds(at(`/school-data/${id}.json`)), [id]), 'detail school ID differs from filename')
  requireValue(manifest.schoolDataCount === detailIds.length, 'detail count differs')
  requireValue(same(rowsIds(at(manifest.nameIndexUrl), true), detailIds), 'name index/detail school IDs differ')
  at(manifest.cityIndexUrl) // This index contains places and counts, no school/department IDs.
  for (const [field, expected, compact] of [['prefDataUrls', fullIds, false], ['prefIndexUrls', detailIds, true]]) {
    requireValue(manifest[field] && typeof manifest[field] === 'object' && !Array.isArray(manifest[field]), 'prefecture manifest missing')
    const ids = Object.values(manifest[field]).flatMap((url) => compact ? rowsIds(at(url).schools, true) : payloadIds(at(url)))
    requireValue(same(ids.sort(), expected), 'prefecture school IDs differ')
  }
  const api = at('/api/v1/schools.json')
  const apiIds = payloadIds(api)
  const expectedApi = buildPublicSchoolRecords(full.schools, full.sourceCatalog ?? [], receipt.generatedAt).map((row) => row.id).sort()
  requireValue(same(apiIds, expectedApi) && api.generated_at === receipt.generatedAt && api.count === apiIds.length, 'public API school IDs or generation differ')
  const partitionIds = []
  for (const path of artifacts.keys()) if (/^api\/v1\/schools\/[a-z-]+\.json$/.test(path)) {
    const part = at(`/${path}`), ids = payloadIds(part)
    requireValue(part.generated_at === receipt.generatedAt && part.count === ids.length, 'API partition generation differs')
    partitionIds.push(...ids)
  }
  requireValue(same(partitionIds.sort(), apiIds), 'API partition school IDs differ')
  const dataset = at('/api/v1/dataset.json')
  requireValue(dataset.generated_at === receipt.generatedAt && dataset.school_count === apiIds.length, 'API dataset generation differs')
  at('/api/v1/openapi.json') // Schemas only; no school rows.
  requireValue(consumed.size === artifacts.size, 'unexpected or unreferenced artifact')
}

export async function dryRunSchoolPublication({ candidateRoot, indexPath, receiptPath, pythonExecutable, expectedCandidate, destination }) {
  requireValue(destination === SCHOOL_PUBLICATION_STUB_DESTINATION, 'destination is not permitted')
  requireValue(typeof pythonExecutable === 'string' && pythonExecutable.length > 0, 'explicit Python executable required')
  validateIdentity(expectedCandidate)
  const candidate = await schoolCandidateIdentity(candidateRoot)
  requireValue(same(candidate, expectedCandidate), 'candidate generation differs from request')
  const paths = await Promise.all([indexPath, receiptPath].map(checkedFile))
  let registration
  try {
    const { stdout } = await execute(pythonExecutable, ['-B', '-c', verifyRegistrationCode, scriptDirectory, ...paths],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 })
    registration = JSON.parse(stdout)
  } catch {
    // Do not forward subprocess tracebacks or receipt contents to callers.
    throw new Error('School publication refused: invalid synthetic registration receipt or ID index')
  }
  const { index, receipt } = registration
  requireValue(index.synthetic === true && receipt.synthetic === true && receipt.state === 'registered', 'synthetic registered receipt required')
  requireValue(index.source.dataset_version === candidate.datasetVersion && index.source.source_version === candidate.sourceVersion &&
    index.source.snapshot_sha256 === candidate.snapshotSha256 && index.source.snapshot_content_sha256 === candidate.contentSha256,
  'ID index generation differs from candidate')
  const candidateReceipt = await verifySchoolCandidate(candidateRoot)
  await verifyArtifactIds(candidateRoot, candidateReceipt, index)
  requireValue(same(await schoolCandidateIdentity(candidateRoot), candidate), 'candidate changed during gate')
  return { format: 'school-publication-dry-run', formatVersion: 1, synthetic: true, state: 'ready',
    destination, candidate, indexSha256: index.index_sha256, registrySha256: receipt.registry_sha256 }
}

/** Artifact-only in-memory stub for isolated generator/registry tests. This API
 * deliberately has no queue authority. Use createQueueBoundSchoolPublicationStub
 * for the source-application workflow and withdrawal checks.
 * Failure retains requests and the active version. A caller
 * must persist its own queue; this object is not a scheduler or durable database.
 * Registration additions and user data are never rolled back by publication recovery.
 */
export function createSchoolPublicationStub() {
  return createPublicationStub(null)
}

const permitQueueCode = [
  'import json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'import school_review_queue as queue, store',
  'request = json.loads(sys.argv[3], object_pairs_hook=store.reject_duplicate_keys)',
  'q = queue.Queue(sys.argv[2])',
  'actor = queue.Actor("synthetic-publication-stub", "worker")',
  'if request["operation"] == "issue":',
  '    result = q.issue_publication_permit(request["proposalId"], request["requestId"], request["candidate"], actor)',
  'else:',
  '    result = q.consume_publication_permit(request["proposalId"], request["requestId"], request["candidate"], request["permitId"], actor)',
  'print(json.dumps(result, allow_nan=False))',
].join('\n')

/** Source-workflow stub: issues and consumes a durable queue permit after the
 * artifact gate, including retries. Withdrawal and consumption are serialized
 * inside the queue DB. beforeConsume injects a synthetic interleaving.
 * Actor is synthetic; this is not real executor authentication or delivery.
 * Queue/source checks and JS state are not a distributed atomic transaction.
 * A withdrawal after consumption revokes queue state but cannot remove JS memory
 * or bytes at a real delivery target. This is not an external delivery adapter.
 */
export function createQueueBoundSchoolPublicationStub({ queuePath, pythonExecutable }) {
  requireValue(typeof queuePath === 'string' && queuePath.length > 0, 'explicit queue path required')
  requireValue(typeof pythonExecutable === 'string' && pythonExecutable.length > 0, 'explicit Python executable required')
  const permits = new Map()
  async function exchange(operation, { proposalId, requestId, candidate }, permitId) {
    requireValue(typeof proposalId === 'string' && proposalId.trim().length > 0, 'proposal ID required')
    try {
      const path = await checkedFile(queuePath)
      const { stdout } = await execute(pythonExecutable, ['-B', '-c', permitQueueCode, scriptDirectory, path,
        JSON.stringify({ operation, proposalId, requestId, candidate, permitId })], { windowsHide: true, maxBuffer: 64 * 1024, timeout: 30_000 })
      const result = JSON.parse(stdout)
      requireValue(result.synthetic === true && (operation === 'issue' ? ['issued', 'consumed'].includes(result.state) : result.state === 'consumed') &&
        typeof result.permit_id === 'string' && result.permit_id.length > 0 &&
        (operation === 'issue' || result.permit_id === permitId) && result.proposal_id === proposalId &&
        result.request_id === requestId && same(result.candidate, candidate), 'queue permit response mismatch')
      return result
    } catch {
      throw new Error('School publication refused: queue consent, source application, or request is not ready')
    }
  }
  return createPublicationStub(async (request, beforeConsume) => {
    const key = canonicalSchoolSourceJSON(request)
    let permit = permits.get(key)
    if (!permit) {
      permit = await exchange('issue', request)
      permits.set(key, permit)
    }
    if (beforeConsume) await beforeConsume(structuredClone(permit))
    return exchange('consume', request, permit.permit_id)
  })
}

function createPublicationStub(checkQueue) {
  let active = null, previous = null, running = false
  const requests = new Map()
  async function publish(request, { fail = false, beforeConsume } = {}) {
    requireValue(!running, 'another publication is running')
    requireValue(request && typeof request.requestId === 'string' && request.requestId.trim().length > 0, 'request ID required')
    requireValue(beforeConsume === undefined || typeof beforeConsume === 'function', 'invalid beforeConsume callback')
    requireValue(!beforeConsume || checkQueue, 'beforeConsume requires queue-bound publication')
    running = true
    try {
      const { requestId, proposalId, ...options } = structuredClone(request)
      const gate = await dryRunSchoolPublication(options)
      const existing = requests.get(requestId)
      requireValue(!existing || (same(existing.candidate, gate.candidate) && existing.proposalId === proposalId), 'request ID reused for different candidate or proposal')
      // Recheck even an already-confirmed retry: an old stub receipt cannot
      // bypass a withdrawal or an unreconciled source transaction.
      const permit = checkQueue ? await checkQueue({ proposalId, requestId, candidate: gate.candidate }, beforeConsume) : null
      if (existing?.state === 'publication_confirmed') return structuredClone(existing.result)
      const pending = { requestId, proposalId, candidate: gate.candidate, state: 'publication_requested', attempts: (existing?.attempts ?? 0) + 1 }
      requests.set(requestId, pending)
      if (fail) {
        pending.state = 'publication_failed'
        throw new Error('Synthetic publication failed; queued request and previous version retained')
      }
      const result = { format: 'school-publication-stub-result', formatVersion: 1, synthetic: true,
        state: 'publication_confirmed', requestId, destination: gate.destination, candidate: gate.candidate,
        ...(permit ? { permit_id: permit.permit_id } : {}) }
      if (!active || !same(active.result.candidate, gate.candidate)) {
        previous = active
        active = { options: proposalId === undefined ? options : { ...options, proposalId }, result }
      }
      pending.state = 'publication_confirmed'; pending.result = result
      return structuredClone(result)
    } finally { running = false }
  }
  return {
    publish,
    async restorePrevious({ requestId }, options) {
      requireValue(previous !== null, 'no previous verified version')
      requireValue(requests.get(requestId)?.state !== 'publication_confirmed', 'restore requires a new request ID')
      return publish({ requestId, ...structuredClone(previous.options) }, options)
    },
    inspect() {
      return structuredClone({ synthetic: true, active: active?.result ?? null, previous: previous?.result ?? null,
        requests: [...requests.values()] })
    },
  }
}
