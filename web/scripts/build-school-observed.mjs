// Explicit offline SQLite projection -> isolated build at the current origin.
// No install, Git fetch, deployment, source DB, or ambient credential discovery.
import fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { allowedCandidateSource } from './build-school-candidates.mjs'
import { checkedFile, checkedOutput, checkedPath } from './lib/school-candidate.mjs'
import { canonicalSchoolSourceJSON, parseObservedSchoolSnapshot } from './lib/school-source.mjs'
import { schoolResourceBudget } from './lib/school-resource-budget.mjs'
import { schoolDataPath, publicDistributionPath } from './lib/school-functions-package.mjs'
import { verifySchoolProjection } from './lib/school-release-producer.mjs'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'), repoRoot = dirname(webRoot)
const hash = (raw) => createHash('sha256').update(raw).digest('hex')
const canonical = (value) => `${canonicalSchoolSourceJSON(value)}\n`
const check = (ok) => { if (!ok) throw new Error('Observed school build contract refused') }
const failureDetails = new WeakMap()
function buildFailure(code, phase) {
  const error = new Error(`Observed school build failed: ${code} (${phase})`)
  failureDetails.set(error, Object.freeze({ status: 'failed', code, phase, complete: false }))
  return error
}
/** Only internally created fixed diagnostics can cross the CLI boundary. */
export function observedBuildFailure(error) {
  return failureDetails.get(error) ?? { status: 'failed', code: 'OBSERVED_BUILD_FAILED', phase: 'unknown', complete: false }
}
const staticFiles = new Set([
  '_routes.json', '_redirects', '_headers', 'robots.txt', 'manifest.webmanifest', 'maintenance.html',
  'favicon.svg', 'favicon.ico', 'favicon-16.png', 'favicon-32.png', 'favicon-48.png',
  'apple-touch-icon.png', 'icon.svg', 'icon-192.png', 'icon-512.png', 'brand-mark.svg', 'og-hero.png',
  'logos/line-login-icon.png', 'logos/google-signin-icon.svg',
  'legal/third-party.md', 'legal/terms.md', 'legal/privacy.md', 'legal/deviation-methodology.md',
  'guide/school-visit.md', 'guide/deviation-with-care.md', 'guide/commute-time.md',
  'press/press-release.pdf', 'press/manabi-map-poster.pdf', 'press/manabi-map-poster-thumb.png',
  'press/manabi-map-handout.pdf', 'press/manabi-map-handout-thumb.png', 'press/logo-pack.zip', 'press/listing-checklist.html',
])

export function parseObservedBuildArgs(args) {
  const options = {}
  for (const arg of args) {
    const match = /^--(snapshot|manifest|output-root|public-config|generation-time|candidate-revision|max-total-bytes|max-decoded-bytes|timeout-seconds|node-heap-mib|version)=(.+)$/.exec(arg)
    check(match && !Object.hasOwn(options, match[1])); options[match[1]] = match[2]
  }
  check(['snapshot', 'manifest', 'output-root', 'public-config', 'generation-time', 'candidate-revision'].every((key) => options[key]))
  return options
}

export function observedBuildEnvironment(config, version, runtime = process.env) {
  check(config && Object.keys(config).sort().join(',') === 'VITE_SUPABASE_ANON_KEY,VITE_SUPABASE_URL')
  const url = new URL(config.VITE_SUPABASE_URL)
  check(url.protocol === 'https:' && url.origin === config.VITE_SUPABASE_URL && !url.username && !url.password)
  const key = config.VITE_SUPABASE_ANON_KEY
  check(typeof key === 'string' && key.length >= 20 && key.length <= 4096)
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
    check(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key))
    // This checks the public role, not the provider's signature. The caller
    // supplies public project config; no service-role credential is accepted.
    let role
    try { role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role } catch { check(false) }
    check(role === 'anon')
  }
  check(typeof version === 'string' && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}$/.test(version))
  const allowed = new Set(['path', 'systemroot', 'windir', 'temp', 'tmp', 'userprofile', 'home', 'localappdata', 'appdata', 'comspec', 'pathext'])
  return { ...Object.fromEntries(Object.entries(runtime).filter(([name]) => allowed.has(name.toLowerCase()))),
    VERSION_OVERRIDE: version, VITE_SCHOOLS_SOURCE: 'static',
    VITE_SUPABASE_URL: config.VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY: key }
}

async function readBounded(path, maximum) {
  const file = await fs.open(await checkedFile(path), 'r')
  try {
    const before = await file.stat()
    check(before.size > 0 && before.size <= maximum)
    const bytes = Buffer.alloc(before.size + 1)
    let size = 0
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null)
      if (!bytesRead) break
      size += bytesRead
    }
    const after = await fs.stat(await checkedFile(path))
    check(size === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs &&
      after.ino === before.ino && after.dev === before.dev)
    return bytes.subarray(0, size)
  } finally { await file.close() }
}

async function inventory(root, limits, accept) {
  const entries = [], files = new Map()
  let total = 0
  async function walk(prefix = '') {
    for (const item of await fs.readdir(await checkedPath(join(root, prefix)), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${item.name}` : item.name
      if (item.isDirectory()) { await walk(path); continue }
      check(item.isFile() && accept(path) && entries.length < limits.maxFiles)
      const bytes = await readBounded(join(root, path), limits.maxFileBytes)
      check((total += bytes.length) <= limits.maxTotalBytes)
      entries.push({ path, size: bytes.length, sha256: hash(bytes) }); files.set(path, bytes)
    }
  }
  await walk()
  entries.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  return { entries, files, bytes: total }
}

/** Reads receipt-bound public bytes only; private evidence is verified separately. */
export async function verifyObservedBuildInput(root, pins) {
  const raw = await readBounded(join(root, 'observed-generation.json'), 4 * 1024 * 1024)
  const receipt = JSON.parse(raw)
  check(raw.toString() === canonical(receipt) && receipt.format === 'observed-school-json' && receipt.version === 1 &&
    receipt.evidence === 'observed' && receipt.scope === 'school-json-only' && receipt.source?.type === 'sqlite-snapshot')
  check(receipt.generator && Array.isArray(receipt.generator.files) && receipt.generator.files.length > 0 &&
    hash(canonicalSchoolSourceJSON(receipt.generator.files)) === receipt.generator.sha256)
  check(receipt.source.snapshotSha256 === pins.snapshotSha256 && receipt.source.manifestSha256 === pins.manifestSha256 &&
    receipt.candidateRevision === pins.candidateRevision && receipt.generatedAt === pins.generatedAt)
  const limits = schoolResourceBudget(receipt.resourceBudget)
  check(canonical(limits) === canonical(pins.resourceBudget))
  const { files, entries } = await inventory(join(root, 'public-data'), limits, schoolDataPath)
  check(canonical(entries) === canonical(receipt.artifacts) && hash(canonicalSchoolSourceJSON(entries)) === receipt.artifactsSha256)
  const rows = await readBounded(join(root, 'private-source/rows.json'), limits.maxDecodedBytes)
  const payload = await readBounded(join(root, 'private-source/generator-payload.json'), limits.maxDecodedBytes)
  check(hash(rows) === receipt.source.rowsSha256 && hash(payload) === receipt.generatorSnapshotSha256)
  check(canonical(verifySchoolProjection({ generatorSnapshot: payload, files, resourceBudget: limits })) === canonical(receipt.projection))
  return { receipt, files, receiptSha256: hash(raw) }
}

export function observedBuildCommands({ generation, snapshot, manifest, output, revision, generatedAt, maximum, decoded }) {
  return [
    { phase: 'generation', script: 'tsx', args: ['scripts/gen-schools-json.mjs', '--school-source=sqlite-snapshot',
      `--snapshot=${snapshot}`, `--snapshot-manifest=${manifest}`, `--output-root=${generation}`,
      `--generation-time=${generatedAt}`, `--candidate-revision=${revision}`, `--max-total-bytes=${maximum}`, `--max-decoded-bytes=${decoded}`] },
    { phase: 'client', script: 'vite', args: ['build', '--config', 'vite.config.ts', '--outDir', output] },
    { phase: 'ssr', script: 'vite', args: ['build', '--config', 'vite.config.ts', '--ssr', 'src/entry-server.tsx', '--outDir', 'dist-ssr'] },
    { phase: 'seo', script: 'tsx', args: ['scripts/gen-seo-pages.mjs', '--dist', output] },
    { phase: 'static', script: 'verify', args: ['--dist', output, '--max-file-mib', '25'] },
  ]
}

export async function buildSchoolObserved(options) {
  const state = { phase: 'input' }
  try { return await buildObserved(options, state) } catch (error) {
    if (failureDetails.has(error)) throw error
    throw buildFailure('OBSERVED_BUILD_FAILED', state.phase)
  }
}

async function buildObserved(options, state) {
  // Synchronous OS I/O cannot be forcibly interrupted. Child processes have an
  // explicit heap ceiling and a shared remaining deadline; late success fails.
  const timeout = Number(options['timeout-seconds'] ?? 900), heap = Number(options['node-heap-mib'] ?? 2048)
  check(Number.isInteger(timeout) && timeout > 0 && timeout <= 3600 && Number.isInteger(heap) && heap >= 256 && heap <= 4096)
  const deadline = performance.now() + timeout * 1000
  const remaining = () => { const value = Math.floor(deadline - performance.now()); check(value > 0); return value }
  const limits = schoolResourceBudget({
    ...(options['max-total-bytes'] === undefined ? {} : { maxTotalBytes: Number(options['max-total-bytes']) }),
    ...(options['max-decoded-bytes'] === undefined ? {} : { maxDecodedBytes: Number(options['max-decoded-bytes']) }),
  })
  const inputs = await Promise.all([options.snapshot, options.manifest, options['public-config']].map(checkedFile))
  check(new Set(inputs).size === 3 && /^[0-9a-f]{40}$/.test(options['candidate-revision']) &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(options['generation-time']) && Number.isFinite(Date.parse(options['generation-time'])))
  const output = await checkedOutput(options['output-root'], inputs, repoRoot)
  const [snapshot, manifest, publicConfig] = await Promise.all([
    readBounded(inputs[0], limits.maxDecodedBytes), readBounded(inputs[1], 65536), readBounded(inputs[2], 8192),
  ])
  parseObservedSchoolSnapshot(snapshot, manifest)
  const version = options.version ?? JSON.parse(await fs.readFile(join(webRoot, 'package.json'))).version
  const environment = observedBuildEnvironment(JSON.parse(publicConfig), version)
  const pins = { snapshotSha256: hash(snapshot), manifestSha256: hash(manifest),
    candidateRevision: options['candidate-revision'], generatedAt: options['generation-time'], resourceBudget: limits }
  state.phase = 'source-copy'
  const sourcePaths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: repoRoot, encoding: 'utf8', windowsHide: true, timeout: remaining(), maxBuffer: 4 * 1024 * 1024 })
    .split('\0').filter(allowedCandidateSource)
  check(new Set(sourcePaths).size === sourcePaths.length)
  await fs.mkdir(output)
  const rootIdentity = await fs.lstat(output), directories = new Map([[output, rootIdentity]])
  async function own(target) {
    remaining()
    // Per-file writes only inspect their ancestry. At phase boundaries, inspect
    // every owned directory. Avoid O(files * all directories * path depth) I/O.
    let selected = directories
    if (target !== undefined) {
      await checkedPath(target, { missing: true })
      selected = new Map()
      let path = target
      for (;;) {
        if (directories.has(path)) selected.set(path, directories.get(path))
        if (path === output) break
        const parent = dirname(path)
        check(parent !== path)
        path = parent
      }
    }
    for (const [path, expected] of selected) {
      const current = await fs.lstat(target === undefined ? await checkedPath(path) : path)
      check(current.isDirectory() && current.dev === expected.dev && current.ino === expected.ino)
    }
  }
  async function make(path) {
    if (directories.has(path)) return
    await make(dirname(path)); await own(dirname(path)); await fs.mkdir(path)
    directories.set(path, await fs.lstat(await checkedPath(path)))
  }
  async function write(path, bytes) {
    await make(dirname(path)); await own(path)
    const handle = await fs.open(await checkedPath(path, { missing: true }), 'wx')
    try { await own(path); await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  }
  const workspace = join(output, 'source'), isolatedWeb = join(workspace, 'web')
  const copiedSources = []
  for (const path of [...sourcePaths, ...[...staticFiles].map((name) => `web/public/${name}`)]) {
    const bytes = await readBounded(join(repoRoot, path), limits.maxFileBytes)
    await write(join(workspace, path), bytes); copiedSources.push({ path, sha256: hash(bytes) })
  }
  const site = JSON.parse(await fs.readFile(join(isolatedWeb, 'data/site.json')))
  check(new URL(site.origin).origin === site.origin && site.origin.startsWith('https://'))
  await own()
  await fs.symlink(await fs.realpath(join(webRoot, 'node_modules')), join(isolatedWeb, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const generation = join(output, 'generation'), dist = join(output, 'dist')
  const commands = observedBuildCommands({ generation, snapshot: inputs[0], manifest: inputs[1], output: dist,
    revision: pins.candidateRevision, generatedAt: pins.generatedAt, maximum: limits.maxTotalBytes, decoded: limits.maxDecodedBytes })
  function run(command, cwd) {
    state.phase = command.phase
    const script = command.script === 'tsx' ? join(cwd, 'node_modules/tsx/dist/cli.mjs') :
      command.script === 'vite' ? join(cwd, 'node_modules/vite/bin/vite.js') : join(cwd, 'scripts/verify-static-output.mjs')
    try {
      execFileSync(process.execPath, [`--max-old-space-size=${heap}`, script, ...command.args],
        { cwd, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: remaining(), maxBuffer: 16 * 1024 * 1024 })
      remaining()
    } catch { throw buildFailure('OBSERVED_BUILD_CHILD_FAILED', command.phase) }
  }
  run(commands[0], webRoot)
  state.phase = 'generation-verify'
  let verified = await verifyObservedBuildInput(generation, pins)
  const generationPin = verified.receiptSha256
  state.phase = 'public-copy'
  for (const [path, bytes] of verified.files) await write(join(isolatedWeb, 'public', path), bytes)
  verified = null // Release the full public byte inventory before Vite starts.
  async function verifyCopiedArtifacts() {
    const current = await verifyObservedBuildInput(generation, pins)
    check(current.receiptSha256 === generationPin)
    for (const [path, bytes] of current.files) check((await readBounded(join(dist, path), limits.maxFileBytes)).equals(bytes))
    return current.receipt
  }
  await own(); run(commands[1], isolatedWeb)
  state.phase = 'client-verify'
  await verifyCopiedArtifacts()
  await own(); run(commands[2], isolatedWeb)
  await own(); run(commands[3], isolatedWeb) // Normal >=1000-school SEO guard remains.
  state.phase = 'seo-verify'
  const receipt = await verifyCopiedArtifacts()
  await own(); run(commands[4], isolatedWeb)
  state.phase = 'distribution'
  const distribution = await inventory(dist, limits, (path) => publicDistributionPath(path) &&
    !/^(?:private-source|source|generation|bundle)(?:\/|$)/i.test(path))
  state.phase = 'source-recheck'
  for (const entry of copiedSources) {
    check(hash(await readBounded(join(repoRoot, entry.path), limits.maxFileBytes)) === entry.sha256)
    check(hash(await readBounded(join(workspace, entry.path), limits.maxFileBytes)) === entry.sha256)
  }
  check(hash(await readBounded(inputs[0], limits.maxDecodedBytes)) === pins.snapshotSha256 &&
    hash(await readBounded(inputs[1], 65536)) === pins.manifestSha256 && hash(await readBounded(inputs[2], 8192)) === hash(publicConfig))
  state.phase = 'completion'
  await own()
  const result = { format: 'observed-school-build', version: 1, evidence: 'observed', deploymentPerformed: false,
    origin: site.origin, appVersion: version, candidateRevision: pins.candidateRevision, generatedAt: pins.generatedAt,
    source: receipt.source, generationReceiptSha256: generationPin, sourceFiles: copiedSources,
    publicArtifacts: distribution.entries, publicArtifactsSha256: hash(canonicalSchoolSourceJSON(distribution.entries)),
    publicBytes: distribution.bytes, resourceBudget: limits, checks: ['projection', 'vite', 'ssr', 'seo', 'static-output', 'private-path-exclusion'],
    functions: { source: 'source/functions', compiled: false, deployed: false } }
  await write(join(output, 'observed-build.json'), canonical(result))
  return result
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  Promise.resolve().then(() => {
    let options
    try { options = parseObservedBuildArgs(process.argv.slice(2)) } catch { throw buildFailure('OBSERVED_BUILD_ARGUMENTS', 'arguments') }
    return buildSchoolObserved(options)
  }).then((receipt) => {
    console.log(JSON.stringify({ status: 'built', evidence: receipt.evidence, deploymentPerformed: false,
      files: receipt.publicArtifacts.length, bytes: receipt.publicBytes, artifactsSha256: receipt.publicArtifactsSha256 }))
  }).catch((error) => {
    console.error(JSON.stringify(observedBuildFailure(error)))
    process.exitCode = 1
  })
}
