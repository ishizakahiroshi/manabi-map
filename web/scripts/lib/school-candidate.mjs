// Isolated school JSON candidates. No credentials, network, build or publication.
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { canonicalSchoolSourceJSON } from './school-source.mjs'

export const CANDIDATE_MANIFEST = 'candidate-manifest.json'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const canonical = (value) => `${canonicalSchoolSourceJSON(value)}\n`
const requireValue = (ok, message) => { if (!ok) throw new Error(`Invalid school candidate: ${message}`) }
const beneath = (parent, child) => { const path = relative(parent, child); return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)) }

export async function checkedPath(value, { missing = false } = {}) {
  requireValue(typeof value === 'string' && value.length > 0 && !value.split(/[\\/]/).includes('..'), 'explicit path without parent traversal required')
  requireValue(!/^(?:\\\\|\/\/|[a-zA-Z]:(?![\\/]))/.test(value), 'network, device and drive-relative paths are not supported')
  const path = resolve(value)
  let current = path
  const chain = []
  while (true) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const component of chain.reverse()) {
    let info
    try { info = await fs.lstat(component) } catch (err) {
      if (err.code === 'ENOENT' && component === path && missing) continue
      throw err
    }
    requireValue(!info.isSymbolicLink(), 'linked/junction paths are not supported')
    requireValue(component === path || info.isDirectory(), 'ancestor is not a directory')
    if (info.isFile()) requireValue(info.nlink === 1, 'hard-linked files are not supported')
    // Also detects path aliases/reparse resolution not reported as a symlink.
    requireValue(relative(component, await fs.realpath(component)) === '', 'aliased path is not supported')
  }
  return path
}

export async function checkedFile(path) {
  path = await checkedPath(path)
  requireValue((await fs.lstat(path)).isFile(), 'regular input file required')
  return path
}

export async function checkedOutput(outputRoot, inputPaths, protectedRoot) {
  const output = await checkedPath(outputRoot, { missing: true })
  try { await fs.lstat(output); throw new Error('Invalid school candidate: output already exists') } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  for (const root of [resolve(protectedRoot), ...inputPaths.map(dirname)]) {
    requireValue(!beneath(root, output) && !beneath(output, root), 'output overlaps source or protected web root')
  }
  return output
}

async function artifactFiles(root, prefix = '') {
  const result = []
  for (const item of await fs.readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name
    requireValue(/^[a-zA-Z0-9._/-]+$/.test(path), 'unsupported artifact path')
    const full = await checkedPath(join(root, path))
    if (item.isDirectory()) result.push(...await artifactFiles(root, path))
    else {
      requireValue(item.isFile(), 'non-file artifact')
      if (path !== CANDIDATE_MANIFEST) {
        const bytes = await fs.readFile(full)
        result.push({ path, sha256: hash(bytes), size: bytes.length })
      }
    }
  }
  return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

export async function verifySchoolCandidate(outputRoot) {
  const root = await checkedPath(outputRoot)
  requireValue((await fs.lstat(root)).isDirectory(), 'candidate directory required')
  const raw = await fs.readFile(await checkedFile(join(root, CANDIDATE_MANIFEST)), 'utf8')
  const receipt = JSON.parse(raw)
  requireValue(receipt && typeof receipt === 'object' && !Array.isArray(receipt), 'receipt object required')
  requireValue(raw === canonical(receipt), 'noncanonical or duplicate receipt fields')
  requireValue(Object.keys(receipt).sort().join(',') === ['format', 'formatVersion', 'synthetic', 'datasetVersion', 'sourceVersion', 'generatedAt', 'source', 'generator', 'artifacts', 'artifactsSha256', 'scope'].sort().join(','), 'receipt fields differ')
  requireValue(receipt.format === 'school-source-candidate' && receipt.formatVersion === 1 && receipt.synthetic === true && receipt.scope === 'school-json-only', 'unsupported receipt scope')
  requireValue(['datasetVersion', 'sourceVersion', 'generatedAt'].every((key) => typeof receipt[key] === 'string' && receipt[key].trim()), 'receipt metadata missing')
  requireValue(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(receipt.generatedAt) && Number.isFinite(Date.parse(receipt.generatedAt)), 'invalid generatedAt')
  requireValue(receipt.source && Object.keys(receipt.source).sort().join(',') === 'contentSha256,manifestSha256,snapshotSha256', 'source identity fields')
  requireValue(Object.values(receipt.source).every((value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)), 'source identity hash')
  requireValue(receipt.generator && Object.keys(receipt.generator).sort().join(',') === 'files,sha256' && Array.isArray(receipt.generator.files) && receipt.generator.files.length > 0, 'generator identity fields')
  const codePaths = receipt.generator.files.map((entry) => {
    requireValue(entry && Object.keys(entry).sort().join(',') === 'path,sha256' && typeof entry.path === 'string' && /^(?:web\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*)$/.test(entry.path) && !entry.path.split('/').includes('..') && /^[0-9a-f]{64}$/.test(entry.sha256), 'generator file identity')
    return entry.path
  })
  requireValue(new Set(codePaths).size === codePaths.length && JSON.stringify(codePaths) === JSON.stringify([...codePaths].sort()), 'generator paths must be sorted unique')
  requireValue(receipt.generator.sha256 === hash(canonicalSchoolSourceJSON(receipt.generator.files)), 'generator hash mismatch')
  const artifacts = await artifactFiles(root)
  requireValue(artifacts.some((item) => item.path === 'schools-manifest.json'), 'school manifest missing')
  requireValue(canonical(receipt.artifacts) === canonical(artifacts) && receipt.artifactsSha256 === hash(canonicalSchoolSourceJSON(artifacts)), 'artifact bytes or file set differ')
  const manifest = JSON.parse(await fs.readFile(join(root, 'schools-manifest.json'), 'utf8'))
  requireValue(manifest.generatedAt === receipt.generatedAt, 'generation timestamp differs')
  return receipt
}

async function writeSynced(path, bytes) {
  const file = await fs.open(path, 'wx')
  try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
}

const sameIdentity = (left, right) => left && right && !left.isSymbolicLink() && left.dev === right.dev && left.ino === right.ino
async function isOwned(path, identity) {
  try { await checkedPath(path); return sameIdentity(await fs.lstat(path), identity) } catch { return false }
}

/** `build` writes only into the private stage. Output becomes complete at receipt-last.
 * Identity checks guard ordinary competing writers; this is not an OS sandbox.
 */
export async function stageSchoolCandidate({ outputRoot, inputPaths, protectedRoot, metadata, generator, build }) {
  const output = await checkedOutput(outputRoot, inputPaths, protectedRoot)
  const stage = await fs.mkdtemp(join(dirname(output), '.school-candidate-'))
  const stageIdentity = await fs.lstat(stage)
  let identity
  const owned = []
  const directories = new Map()
  async function confirmOutput() {
    requireValue(await isOwned(output, identity), 'output directory identity changed')
    for (const [dir, info] of directories) requireValue(await isOwned(dir, info), 'output subdirectory identity changed')
  }
  async function createParents(path) {
    const parts = relative(output, dirname(path)).split(sep).filter(Boolean)
    let parent = output
    for (const part of parts) {
      parent = join(parent, part)
      if (directories.has(parent)) continue
      await confirmOutput()
      await fs.mkdir(parent) // Existing competing directories are never adopted.
      directories.set(parent, await fs.lstat(parent))
    }
    await confirmOutput()
  }
  try {
    await build(stage)
    requireValue(await isOwned(stage, stageIdentity), 'stage directory identity changed')
    const artifacts = await artifactFiles(stage)
    const receipt = { format: 'school-source-candidate', formatVersion: 1, synthetic: true,
      ...metadata, generator, artifacts, artifactsSha256: hash(canonicalSchoolSourceJSON(artifacts)), scope: 'school-json-only' }
    await writeSynced(join(stage, CANDIDATE_MANIFEST), canonical(receipt))
    await verifySchoolCandidate(stage)
    await checkedOutput(output, inputPaths, protectedRoot)
    await fs.mkdir(output) // Exclusive; even an existing empty directory is an error.
    identity = await fs.lstat(output)
    // Existing public manifest stays last among generator outputs; receipt is the final marker.
    const paths = [...artifacts.map((entry) => entry.path).filter((path) => path !== 'schools-manifest.json'), 'schools-manifest.json', CANDIDATE_MANIFEST]
    for (const path of paths) {
      await confirmOutput()
      const target = join(output, path)
      await createParents(target)
      // Reserve with wx before copying so cleanup only knows files we own.
      const dest = await fs.open(target, 'wx')
      try {
        owned.push({ target, info: await dest.stat() })
        await dest.writeFile(await fs.readFile(join(stage, path)))
        await dest.sync()
      } finally { await dest.close() }
    }
    await confirmOutput()
    return await verifySchoolCandidate(output)
  } catch (err) {
    if (await isOwned(output, identity)) {
      for (const file of owned.reverse()) {
        if (await isOwned(file.target, file.info)) await fs.unlink(file.target).catch(() => {})
      }
      // Only our unchanged, empty directories can be recovered; competitors survive.
      for (const [dir, info] of [...directories].reverse()) {
        if (await isOwned(dir, info)) await fs.rmdir(dir).catch(() => {})
      }
      await fs.rmdir(output).catch(() => {})
    }
    throw err
  } finally {
    if (await isOwned(stage, stageIdentity)) await fs.rm(stage, { recursive: true, force: true })
  }
}
