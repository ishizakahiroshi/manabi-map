// Joins an already completed observed build, producer gate and compiled worker
// into one immutable, inactive release candidate. This file never builds or deploys.
import fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkedFile, checkedPath } from './lib/school-candidate.mjs'
import { canonicalSchoolSourceJSON } from './lib/school-source.mjs'
import { produceSchoolRelease } from './lib/school-release-producer.mjs'
import { validateSchoolRelease } from './lib/school-release.mjs'
import { createSchoolFunctionsPackage, schoolDigest, schoolInventory } from './lib/school-functions-package.mjs'
import { schoolResourceBudget, sameSchoolBudget } from './lib/school-resource-budget.mjs'

const hash = schoolDigest
const canonical = (value) => Buffer.from(`${canonicalSchoolSourceJSON(value)}\n`)
const reject = () => { throw new Error('School release finalizer: candidate refused') }
const same = (left, right) => canonicalSchoolSourceJSON(left) === canonicalSchoolSourceJSON(right)
const sourcePins = (entries) => entries.map(({ path, sha256 }) => ({ path, sha256 }))

function validateFunctionsCandidate({ raw, sourceInventory, buildReceipt, worker, bindingsSha256 }) {
  if (!Buffer.isBuffer(raw) || !Buffer.isBuffer(worker) || !Array.isArray(sourceInventory) ||
      !Array.isArray(buildReceipt.sourceFiles)) reject()
  let candidate
  try { candidate = JSON.parse(raw.toString('utf8')) } catch { reject() }
  const keys = ['bindingsSha256', 'buildMetadataSha256', 'compiler', 'compilerVersion', 'format', 'invocationSha256',
    'sourceInventory', 'sourceInventorySha256', 'sourceRevision', 'status', 'version', 'workerSha256']
  if (!raw.equals(canonical(candidate)) || !same(Object.keys(candidate).sort(), keys) ||
      candidate.format !== 'school-functions-compile-candidate' || candidate.version !== 1 ||
      candidate.status !== 'success' || candidate.compiler !== 'wrangler-pages' ||
      !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(candidate.compilerVersion) ||
      !/^[a-f0-9]{64}$/.test(candidate.invocationSha256) ||
      !/^[a-f0-9]{64}$/.test(candidate.buildMetadataSha256) ||
      candidate.sourceRevision !== buildReceipt.candidateRevision ||
      candidate.bindingsSha256 !== bindingsSha256 || !/^[a-f0-9]{64}$/.test(bindingsSha256) ||
      !/^[a-f0-9]{64}$/.test(candidate.workerSha256) || hash(worker) !== candidate.workerSha256 ||
      !same(candidate.sourceInventory, sourceInventory) ||
      candidate.sourceInventorySha256 !== hash(canonical(candidate.sourceInventory)) ||
      !same(sourcePins(candidate.sourceInventory), buildReceipt.sourceFiles.filter((entry) => entry.path.startsWith('functions/'))
        .sort((a, b) => a.path.localeCompare(b.path, 'en')))) reject()
  return candidate
}

function validateInputs({ buildReceipt, generationReceiptRaw, generatorSnapshot, functionsCandidateRaw,
  functionsSourceInventory, worker, bindingsSha256, resourceBudget }) {
  if (!buildReceipt || buildReceipt.format !== 'observed-school-build' || buildReceipt.version !== 1 ||
      buildReceipt.evidence !== 'observed' || buildReceipt.deploymentPerformed !== false ||
      buildReceipt.functions?.deployed !== false || buildReceipt.functions?.source !== 'source/functions' ||
      !Array.isArray(buildReceipt.publicArtifacts) || !Buffer.isBuffer(generationReceiptRaw) ||
      !Buffer.isBuffer(generatorSnapshot) || !Buffer.isBuffer(worker)) reject()
  const generationReceipt = JSON.parse(generationReceiptRaw.toString('utf8'))
  if (!generationReceiptRaw.equals(canonical(generationReceipt)) || generationReceipt.format !== 'observed-school-json' ||
      generationReceipt.version !== 1 || generationReceipt.evidence !== 'observed' ||
      generationReceipt.scope !== 'school-json-only' || generationReceipt.source?.type !== 'sqlite-snapshot' ||
      !/^[a-f0-9]{64}$/.test(generationReceipt.generatorSnapshotSha256) ||
      hash(generatorSnapshot) !== generationReceipt.generatorSnapshotSha256 ||
      buildReceipt.generationReceiptSha256 !== hash(generationReceiptRaw) ||
      buildReceipt.candidateRevision !== generationReceipt.candidateRevision ||
      buildReceipt.generatedAt !== generationReceipt.generatedAt ||
      !same(buildReceipt.source, generationReceipt.source)) reject()
  if (worker.length === 0) reject()
  const functionsCandidate = validateFunctionsCandidate({ raw: functionsCandidateRaw,
    sourceInventory: functionsSourceInventory, buildReceipt, worker, bindingsSha256 })
  const budget = schoolResourceBudget(resourceBudget ?? buildReceipt.resourceBudget)
  if (!sameSchoolBudget(budget, buildReceipt.resourceBudget) ||
      !sameSchoolBudget(budget, generationReceipt.resourceBudget)) reject()
  return { generationReceipt, budget, functionsCandidate }
}

/**
 * Accept only the producer's validated result plus matching build/generation
 * receipts and an immutable compiler-output record. The record is checked
 * against actual source files, worker bytes, bindings and revision. This code
 * does not run Wrangler or independently authenticate who wrote that record.
 */
export function createSchoolReleaseCompletion({ buildReceipt, generationReceiptRaw, generatorSnapshot, release,
  functionsCandidateRaw, functionsSourceInventory, worker, bindingsSha256, observations = new Map(),
  redirectOrigins = [], resourceBudget }) {
  const { generationReceipt, budget, functionsCandidate } = validateInputs({ buildReceipt, generationReceiptRaw, generatorSnapshot,
    functionsCandidateRaw, functionsSourceInventory, worker, bindingsSha256, resourceBudget })
  if (!release || !Buffer.isBuffer(release.raw) || !release.pin || !(release.artifacts instanceof Map) ||
      !(release.files instanceof Map) || !Buffer.isBuffer(release.gate) ||
      release.candidateRevision !== undefined && release.candidateRevision !== buildReceipt.candidateRevision) reject()
  let receipt
  try { receipt = validateSchoolRelease(release.raw, release.pin, release.artifacts) } catch { reject() }
  if (receipt.evidence !== 'observed' || receipt.candidateRevision !== buildReceipt.candidateRevision ||
      receipt.sourceSnapshotSha256 !== hash(generatorSnapshot) || !same(release.resourceBudget, budget) ||
      !same(schoolInventory(release.artifacts), generationReceipt.artifacts)) reject()
  const inventory = schoolInventory(release.files)
  if (!same(inventory, buildReceipt.publicArtifacts) ||
      hash(canonicalSchoolSourceJSON(inventory)) !== buildReceipt.publicArtifactsSha256 ||
      !sameSchoolBudget(budget, release.resourceBudget)) reject()
  for (const [path, bytes] of release.artifacts) {
    if (!release.files.has(path) || !release.files.get(path).equals(bytes)) reject()
  }
  const functionsPackage = createSchoolFunctionsPackage({ files: release.files, worker,
    bindingsSha256, sourceRevision: buildReceipt.candidateRevision, observations, redirectOrigins, resourceBudget: budget })
  const packageSnapshot = functionsPackage.snapshot(functionsPackage.pin)
  const completion = {
    format: 'school-release-completion', version: 1, evidence: 'observed', deploymentPerformed: false,
    generation: receipt.generation, generatedAt: generationReceipt.generatedAt,
    candidateRevision: buildReceipt.candidateRevision,
    generationReceiptSha256: buildReceipt.generationReceiptSha256,
    observedBuildSha256: hash(canonical(buildReceipt)),
    producerReceiptSha256: release.pin.receiptSha256,
    projectionGateSha256: release.pin.projectionGateSha256,
    functions: { compileRecordStatus: 'success', sourceRevision: functionsCandidate.sourceRevision,
      compileRecordSha256: hash(functionsCandidateRaw), compiler: functionsCandidate.compiler,
      compilerVersion: functionsCandidate.compilerVersion, invocationSha256: functionsCandidate.invocationSha256,
      buildMetadataSha256: functionsCandidate.buildMetadataSha256,
      sourceInventorySha256: functionsCandidate.sourceInventorySha256, workerSha256: hash(worker), bindingsSha256 },
    packagePin: functionsPackage.pin,
    packageMetadataSha256: hash(packageSnapshot.raw),
    resourceBudget: budget,
    artifacts: schoolInventory(packageSnapshot.files),
  }
  const raw = canonical(completion)
  return Object.freeze({ raw, receipt: completion, pin: hash(raw), functionsPackage })
}

async function inventoryFunctionsSources(functionsRoot) {
  const root = await checkedPath(functionsRoot)
  const inventory = []
  async function walk(directory, prefix = '') {
    for (const entry of await fs.readdir(await checkedPath(directory), { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(path, relativePath)
      else {
        if (!entry.isFile()) reject()
        const bytes = await fs.readFile(await checkedFile(path))
        inventory.push({ path: `functions/${relativePath}`, size: bytes.length, sha256: hash(bytes) })
      }
    }
  }
  await walk(root)
  inventory.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  if (!inventory.length) reject()
  return inventory
}

function commandEnvironment() {
  const names = ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']
  return Object.fromEntries(names.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []))
}

/** Run the local Wrangler compiler and issue a create-only receipt from its
 * exit, generated metadata, output bytes and unchanged source inventory. This
 * verifies execution consistency; the receipt itself is not a signature from
 * Cloudflare and cannot attest the behavior of a tampered Wrangler executable.
 */
export async function compileSchoolFunctionsCandidate({ buildRoot, wranglerPath, wranglerVersion, bindingsSha256,
  sourceRevision, expectedSourceInventory, maxWorkerBytes = 25 * 1024 * 1024, timeoutMs = 20 * 60 * 1000 }) {
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(wranglerVersion) ||
      !/^[a-f0-9]{40}$/.test(sourceRevision) ||
      !/^[a-f0-9]{64}$/.test(bindingsSha256) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3600000) reject()
  const root = await checkedPath(buildRoot)
  const wrangler = await checkedFile(wranglerPath)
  const sourceRoot = await checkedPath(join(root, 'source', 'functions'))
  const distRoot = await checkedPath(join(root, 'dist'))
  const candidateRoot = join(root, 'functions-candidate')
  await fs.mkdir(await checkedPath(candidateRoot, { missing: true }))
  const workerPath = join(distRoot, '_worker.js')
  const compiledRoot = join(candidateRoot, 'compiled')
  const compiledWorkerPath = join(compiledRoot, 'index.js')
  const metadataPath = join(candidateRoot, 'wrangler-build-metadata.json')
  const receiptPath = join(candidateRoot, 'school-functions-compile-receipt.json')
  const before = await inventoryFunctionsSources(sourceRoot)
  if (!same(sourcePins(before), expectedSourceInventory) ||
      await fs.lstat(await checkedPath(workerPath, { missing: true })).then(() => true, (err) => err.code !== 'ENOENT') ||
      await fs.lstat(await checkedPath(compiledRoot, { missing: true })).then(() => true, (err) => err.code !== 'ENOENT')) reject()
  const normalizedInvocation = ['wrangler', 'pages', 'functions', 'build', 'source/functions',
    '--outdir', 'functions-candidate/compiled', '--metafile', 'functions-candidate/wrangler-build-metadata.json']
  const invocationSha256 = hash(canonical(normalizedInvocation))
  const env = commandEnvironment()
  let actualVersion
  try {
    actualVersion = execFileSync(process.execPath, [wrangler, '--version'], { cwd: sourceRoot, env,
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: Math.min(timeoutMs, 30000), maxBuffer: 64 * 1024 })
      .toString('utf8').trim()
    if (actualVersion !== wranglerVersion) reject()
    execFileSync(process.execPath, [wrangler, 'pages', 'functions', 'build', sourceRoot,
      '--outdir', compiledRoot, '--metafile', metadataPath], { cwd: sourceRoot, env,
      windowsHide: true, stdio: 'ignore', timeout: timeoutMs, maxBuffer: 1024 * 1024 })
  } catch { reject() }
  const compiledEntries = await fs.readdir(await checkedPath(compiledRoot), { withFileTypes: true })
  // A Pages advanced-mode _worker.js must contain the entire Worker. Refuse
  // split or auxiliary output until that module layout has an explicit package contract.
  if (compiledEntries.length !== 1 || compiledEntries[0].name !== 'index.js' ||
      !compiledEntries[0].isFile()) reject()
  const [after, workerBytes, metadataRaw] = await Promise.all([
    inventoryFunctionsSources(sourceRoot), fs.readFile(await checkedFile(compiledWorkerPath)),
    fs.readFile(await checkedFile(metadataPath)),
  ])
  if (!same(before, after) || workerBytes.length === 0 || workerBytes.length > maxWorkerBytes ||
      metadataRaw.length === 0 || metadataRaw.length > 4 * 1024 * 1024) reject()
  try {
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: workerBytes, cwd: sourceRoot, env,
      windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], timeout: Math.min(timeoutMs, 30000), maxBuffer: 1024 * 1024 })
  } catch { reject() }
  let metadata
  try { metadata = JSON.parse(metadataRaw.toString('utf8')) } catch { reject() }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
      !metadata.inputs || typeof metadata.inputs !== 'object' || Array.isArray(metadata.inputs) ||
      !metadata.outputs || typeof metadata.outputs !== 'object' || Array.isArray(metadata.outputs)) reject()
  const receipt = { format: 'school-functions-compile-candidate', version: 1, status: 'success', compiler: 'wrangler-pages',
    compilerVersion: actualVersion, invocationSha256, sourceRevision, sourceInventory: before,
    sourceInventorySha256: hash(canonical(before)), workerSha256: hash(workerBytes),
    buildMetadataSha256: hash(metadataRaw), bindingsSha256 }
  const raw = canonical(receipt)
  const workerHandle = await fs.open(await checkedPath(workerPath, { missing: true }), 'wx')
  try { await workerHandle.writeFile(workerBytes); await workerHandle.sync() } finally { await workerHandle.close() }
  const handle = await fs.open(await checkedPath(receiptPath, { missing: true }), 'wx')
  try { await handle.writeFile(raw); await handle.sync() } finally { await handle.close() }
  return { raw, receipt, workerPath, metadataPath, receiptPath }
}

export async function finalizeObservedSchoolBuild({ buildRoot, wranglerPath, wranglerVersion, bindingsSha256,
  generation, observations = new Map(), redirectOrigins = [], outputPath, timeoutMs }) {
  const root = await checkedPath(buildRoot)
  const buildRaw = await fs.readFile(await checkedFile(join(root, 'observed-build.json')))
  const buildReceipt = JSON.parse(buildRaw.toString('utf8'))
  if (!buildRaw.equals(canonical(buildReceipt))) reject()
  const generationRoot = await checkedPath(join(root, 'generation'))
  const generationReceiptRaw = await fs.readFile(await checkedFile(join(generationRoot, 'observed-generation.json')))
  const generatorSnapshot = await fs.readFile(await checkedFile(join(generationRoot, 'private-source', 'generator-payload.json')))
  const functionsSourceInventory = await inventoryFunctionsSources(join(root, 'source', 'functions'))
  const release = await produceSchoolRelease({ distDir: await checkedPath(join(root, 'dist')), generatorSnapshot,
    generation, candidateRevision: buildReceipt.candidateRevision, evidence: 'observed', resourceBudget: buildReceipt.resourceBudget })
  const compiled = await compileSchoolFunctionsCandidate({ buildRoot: root, wranglerPath, wranglerVersion,
    bindingsSha256, sourceRevision: buildReceipt.candidateRevision,
    expectedSourceInventory: buildReceipt.sourceFiles.filter((entry) => entry.path.startsWith('functions/'))
      .sort((a, b) => a.path.localeCompare(b.path, 'en')),
    maxWorkerBytes: buildReceipt.resourceBudget.maxFileBytes, timeoutMs })
  const workerBytes = await fs.readFile(await checkedFile(compiled.workerPath))
  const result = createSchoolReleaseCompletion({ buildReceipt, generationReceiptRaw, generatorSnapshot, release,
    functionsCandidateRaw: compiled.raw, functionsSourceInventory, worker: workerBytes, bindingsSha256, observations,
    redirectOrigins, resourceBudget: buildReceipt.resourceBudget })
  const requestedOutput = resolve(outputPath ?? join(root, 'school-release-completion.json'))
  const outputRelative = relative(root, requestedOutput)
  if (!outputRelative || outputRelative === '..' || outputRelative.startsWith(`..${sep}`)) reject()
  const destination = await checkedPath(requestedOutput, { missing: true })
  await checkedPath(dirname(destination))
  const handle = await fs.open(destination, 'wx')
  try { await handle.writeFile(result.raw); await handle.sync() } finally { await handle.close() }
  return result.receipt
}

export function parseFinalizeSchoolReleaseArgs(args) {
  const options = {}
  for (const arg of args) {
    const match = /^--(build-root|wrangler-path|wrangler-version|bindings-sha256|generation|timeout-ms|output)=(.+)$/.exec(arg)
    if (!match || Object.hasOwn(options, match[1])) reject()
    options[match[1]] = match[2]
  }
  if (!['build-root', 'wrangler-path', 'wrangler-version', 'bindings-sha256', 'generation'].every((key) => options[key]) ||
      !/^[a-f0-9]{64}$/.test(options['bindings-sha256']) ||
      !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(options['wrangler-version']) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(options.generation)) reject()
  const timeoutMs = options['timeout-ms'] === undefined ? undefined : Number(options['timeout-ms'])
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3600000)) reject()
  return { buildRoot: options['build-root'], wranglerPath: options['wrangler-path'], wranglerVersion: options['wrangler-version'],
    bindingsSha256: options['bindings-sha256'], generation: options.generation, ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(options.output ? { outputPath: options.output } : {}) }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  Promise.resolve().then(() => finalizeObservedSchoolBuild(parseFinalizeSchoolReleaseArgs(process.argv.slice(2))))
    .then((receipt) => console.log(JSON.stringify({ status: 'packaged', deploymentPerformed: false,
      generation: receipt.generation, packagePin: receipt.packagePin })))
    .catch(() => { console.error('School release finalizer: candidate refused'); process.exitCode = 1 })
}
