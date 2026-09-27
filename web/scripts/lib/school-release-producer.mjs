// Explicit, inactive bridge from frozen generator projection to release receipt.
// No source database, credentials, build, or network access.
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { verifyStaticOutput } from '../verify-static-output.mjs'
import { checkedFile, checkedPath } from './school-candidate.mjs'
import { canonicalSchoolSourceJSON } from './school-source.mjs'
import { buildPublicSchoolRecords } from './public-api.mjs'
import { createSchoolReleaseReceipt } from './school-release.mjs'
import { copySchoolFiles, schoolDataPath, schoolDigest, schoolInventory } from './school-functions-package.mjs'

const check = (ok) => { if (!ok) throw new Error('School producer: projection or generation mismatch') }
const codeURLs = [new URL('../verify-static-output.mjs', import.meta.url), new URL('./public-api.mjs', import.meta.url)]
const loadedCodePins = await Promise.all(codeURLs.map(async (url) => schoolDigest(await fs.readFile(url))))
async function checkLoadedCode() {
  const current = await Promise.all(codeURLs.map(async (url) => schoolDigest(await fs.readFile(url))))
  check(current.every((pin, index) => pin === loadedCodePins[index]))
}
const same = (a, b) => canonicalSchoolSourceJSON(a) === canonicalSchoolSourceJSON(b)
const json = (bytes) => {
  check(Buffer.isBuffer(bytes) && bytes.length <= 64 * 1024 * 1024)
  return JSON.parse((bytes[0] === 0x1f && bytes[1] === 0x8b ?
    gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }) : bytes).toString('utf8'))
}

/** Runs the existing public allowlist projection, then checks every API partition
 * against it. Extra fields (including nested fields), omitted rows and cross-
 * generation inputs fail exact structural comparisons.
 */
export function verifySchoolProjection({ generatorSnapshot, files }) {
  check(Buffer.isBuffer(generatorSnapshot))
  const payload = json(generatorSnapshot)
  check(payload && same(Object.keys(payload).sort(), ['formatVersion', 'schools', 'sourceCatalog']) &&
    payload.formatVersion === 2 && Array.isArray(payload.schools) && Array.isArray(payload.sourceCatalog))
  const manifest = json(files.get('schools-manifest.json'))
  check(typeof manifest.generatedAt === 'string' && Number.isFinite(Date.parse(manifest.generatedAt)))
  check(typeof manifest.url === 'string' && manifest.url.startsWith('/') && schoolDataPath(manifest.url.slice(1)))
  const full = files.get(manifest.url.slice(1))
  check(Buffer.isBuffer(full) && same(payload, json(full)))
  const records = buildPublicSchoolRecords(payload.schools, payload.sourceCatalog, manifest.generatedAt)
  const api = json(files.get('api/v1/schools.json'))
  check(same(api, { api_version: 'v1', generated_at: manifest.generatedAt, count: records.length, schools: records }))
  const partitions = [...files.keys()].filter((p) => /^api\/v1\/schools\/.+\.json$/.test(p))
  const seen = new Set()
  for (const path of partitions) {
    const part = json(files.get(path))
    check(typeof part.prefecture === 'string' && !seen.has(part.prefecture))
    const schools = records.filter((r) => r.prefecture === part.prefecture)
    check(schools.length > 0 && same(part, { api_version: 'v1', generated_at: manifest.generatedAt,
      prefecture: part.prefecture, count: schools.length, schools }))
    seen.add(part.prefecture)
  }
  check(same([...seen].sort(), [...new Set(records.map((r) => r.prefecture))].sort()))
  return { generatedAt: manifest.generatedAt, publicRecords: records.length }
}

async function readDistribution(root, prefix = '', budget = { bytes: 0, count: 0 }) {
  const files = new Map()
  for (const item of await fs.readdir(await checkedPath(join(root, prefix)), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name
    if (item.isDirectory()) {
      for (const entry of await readDistribution(root, path, budget)) files.set(...entry)
    } else {
      const input = await checkedFile(join(root, path)), info = await fs.stat(input)
      budget.bytes += info.size; budget.count += 1
      check(info.size > 0 && info.size < 25 * 1024 * 1024 && budget.bytes <= 64 * 1024 * 1024 && budget.count <= 20000)
      const file = await fs.open(input, 'r')
      try {
        const bytes = Buffer.alloc(info.size + 1)
        let offset = 0
        while (offset < bytes.length) {
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
          if (!bytesRead) break
          offset += bytesRead
        }
        check(offset === info.size)
        files.set(path, bytes.subarray(0, offset))
      } finally { await file.close() }
    }
  }
  return files
}

/** generatorSnapshot is the exact frozen full generator payload, not a raw DB
 * backup or a trusted-schema assertion. Caller chooses evidence explicitly.
 * All existing static/public-field gates run on a private byte-for-byte snapshot;
 * producer inputs cannot be swapped while those gates are running.
 * Execute in a reviewed, immutable checkout matching candidateRevision. Startup
 * pins detect later edits to these gate entrypoints; they are not a signature of
 * the entire transitive JavaScript dependency graph or a source-code sandbox.
 */
export async function produceSchoolRelease({ distDir, generatorSnapshot, generation, candidateRevision, evidence }) {
  let phase = 'inventory'
  try {
    check(Buffer.isBuffer(generatorSnapshot) && generatorSnapshot.length <= 64 * 1024 * 1024)
    await checkLoadedCode()
    generatorSnapshot = Buffer.from(generatorSnapshot)
    const files = copySchoolFiles(await readDistribution(distDir))
    phase = 'projection'
    const projection = verifySchoolProjection({ generatorSnapshot, files })
    phase = 'static-output'
    const stage = await fs.mkdtemp(join(tmpdir(), 'school-release-gate-'))
    try {
      for (const [path, bytes] of files) {
        await fs.mkdir(dirname(join(stage, path)), { recursive: true })
        await fs.writeFile(join(stage, path), bytes, { flag: 'wx' })
      }
      await verifyStaticOutput({ distDir: stage })
      await checkLoadedCode()
    } finally { await fs.rm(stage, { recursive: true, force: true }) }
    phase = 'receipt'
    const artifacts = new Map([...files].filter(([path]) => schoolDataPath(path)))
    const [gateCodeSha256, projectionCodeSha256] = loadedCodePins
    const gate = Buffer.from(`${canonicalSchoolSourceJSON({ format: 'school-release-field-gate', version: 1,
      sourceSnapshotSha256: schoolDigest(generatorSnapshot), gateCodeSha256, projectionCodeSha256,
      artifacts: schoolInventory(artifacts), ...projection })}\n`)
    const projectionGateSha256 = schoolDigest(gate)
    const raw = createSchoolReleaseReceipt({ generation, sourceSnapshotSha256: schoolDigest(generatorSnapshot),
      projectionGateSha256, candidateRevision, evidence }, artifacts)
    return { raw, pin: { generation, receiptSha256: schoolDigest(raw), projectionGateSha256 }, artifacts, gate, files }
  } catch { throw new Error(`School producer: release refused; generation or field gate failed (${phase})`) }
}
