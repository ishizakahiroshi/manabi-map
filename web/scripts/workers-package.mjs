// Workers static assets package for an already verified school candidate.
// Local files only: no network, credentials or deployment. The output is a new isolated directory with
// the candidate's public files, the compiled Worker and its env.json (Worker targets only), the generated
// Wrangler config and a receipt.
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// Workers static assets limits (free plan): 20,000 files per version, 25 MiB per file.
const MAX_FILES = 20000
const MAX_FILE_BYTES = 25 * 1024 * 1024
const ROUTES = '_routes.json'
const PAGES_WORKER = '_worker.js'
const ENV_FILE = 'env.json'
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/
export const TARGETS = {
  'high-school': { candidate: 'high-school-candidate', worker: true },
  school: { candidate: 'school-portal-package', worker: false },
}

export class WorkersPackageError extends Error {}
const need = (condition, reason) => { if (!condition) throw new WorkersPackageError(reason) }
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`

/**
 * workers/<target>/env.json of a Worker target: the secrets the Worker must have as bindings, and the env names
 * left unset on purpose (each with a reason). `bindings` are Wrangler template bindings (ASSETS), which are not
 * env names. The package carries this file, and deploy refuses a version whose bindings differ from it.
 */
export function validateEnvContract(contract, { bindings = [] } = {}) {
  need(contract && typeof contract === 'object' && !Array.isArray(contract) &&
    canonical(Object.keys(contract).sort()) === canonical(['format', 'secrets', 'unset', 'version']),
  'env.json keys must be exactly format, secrets, unset and version')
  need(contract.format === 'school-workers-env-contract' && contract.version === 1, 'env.json format or version rejected')
  const { secrets, unset } = contract
  need(Array.isArray(secrets) && secrets.every((name) => typeof name === 'string' && ENV_NAME.test(name)), 'env.json secrets must be env names')
  need(canonical(secrets) === canonical([...new Set(secrets)].sort()), 'env.json secrets must be unique and sorted')
  need(unset && typeof unset === 'object' && !Array.isArray(unset), 'env.json unset must be an object')
  for (const [name, reason] of Object.entries(unset)) {
    need(ENV_NAME.test(name) && typeof reason === 'string' && reason.trim().length > 0, `env.json unset ${name} needs a reason`)
    need(!secrets.includes(name), `env.json ${name} is both a secret and unset`)
  }
  for (const name of [...secrets, ...Object.keys(unset)]) need(!bindings.includes(name), `env.json ${name} is a Wrangler binding, not an env name`)
  return contract
}
const hex = (value, length = 64) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value)
const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0
const beneath = (parent, child) => {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

/** JSON with // and block comments (Wrangler's JSONC). Trailing commas are rejected (fail closed). */
export function parseJsonc(text) {
  let out = '', inString = false, escaped = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true; out += char
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      need(end >= 0, 'unterminated comment in JSONC')
      i = end + 1
    } else out += char
  }
  return JSON.parse(out)
}

/** Pages `_routes.json` → Workers `assets.run_worker_first` (include as-is, exclude as negative rules). */
export function runWorkerFirstFromRoutes(routes) {
  need(routes && typeof routes === 'object' && Object.keys(routes).sort().join(',') === 'exclude,include,version' &&
    routes.version === 1 && Array.isArray(routes.include) && routes.include.length > 0 && Array.isArray(routes.exclude) &&
    [...routes.include, ...routes.exclude].every((rule) => typeof rule === 'string' && rule.startsWith('/')),
  'unsupported _routes.json')
  return [...routes.include, ...routes.exclude.map((rule) => `!${rule}`)]
}

async function plainDirectory(path) {
  const stat = await fs.lstat(path)
  need(stat.isDirectory() && !stat.isSymbolicLink(), 'expected a plain directory')
  need(relative(resolve(path), await fs.realpath(path)) === '', 'directory resolves elsewhere')
  return resolve(path)
}

async function readPlain(path, maximum = MAX_FILE_BYTES) {
  const stat = await fs.lstat(path)
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum, 'expected a plain bounded file')
  const bytes = await fs.readFile(path)
  need(bytes.length === stat.size, 'file changed while reading')
  return bytes
}

/** Every regular file below root as posix paths. Links, junctions and special files are rejected. */
export async function listFiles(root) {
  const result = []
  async function visit(directory, prefix) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(directory, entry.name)
      const stat = await fs.lstat(full)
      need(!stat.isSymbolicLink(), 'link inside package input')
      if (stat.isDirectory()) await visit(full, path)
      else {
        need(stat.isFile(), 'special file inside package input')
        result.push(path)
      }
    }
  }
  await visit(root, '')
  return result.sort()
}

export async function readTarget(target, repoRoot = defaultRepoRoot) {
  const spec = TARGETS[target]
  need(spec, 'unknown Workers target')
  const templatePath = `workers/${target}/wrangler.jsonc`
  const contractPath = `workers/${target}/observe.json`
  const templateBytes = await readPlain(join(repoRoot, templatePath), 1024 * 1024)
  const contractBytes = await readPlain(join(repoRoot, contractPath), 1024 * 1024)
  const template = parseJsonc(templateBytes.toString('utf8'))
  const contract = JSON.parse(contractBytes)
  need(typeof template.name === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(template.name) &&
    /^\d{4}-\d{2}-\d{2}$/.test(template.compatibility_date ?? '') && template.workers_dev === true &&
    !('main' in template) && template.assets && typeof template.assets === 'object' && !('directory' in template.assets) &&
    !('vars' in template) && !('routes' in template) && !('route' in template),
  'Workers template shape rejected')
  if (spec.worker) {
    need(template.no_bundle === true && template.assets.binding === 'ASSETS' && Array.isArray(template.assets.run_worker_first),
      'Workers template for a Worker target must pin no_bundle, ASSETS and run_worker_first')
  } else {
    need(!('binding' in template.assets) && !('run_worker_first' in template.assets), 'assets-only template must not bind a Worker')
  }
  const envPath = `workers/${target}/${ENV_FILE}`
  let envBytes = null, env = null
  if (spec.worker) {
    try { envBytes = await readPlain(join(repoRoot, envPath), 1024 * 1024) } catch (error) {
      if (error?.code === 'ENOENT') need(false, `${envPath} is required for a Worker target`)
      throw error
    }
    env = validateEnvContract(JSON.parse(envBytes), { bindings: [template.assets.binding] })
  } else {
    let declared = true
    try { await fs.lstat(join(repoRoot, envPath)) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      declared = false
    }
    need(!declared, `assets-only target must not declare ${envPath}`)
  }
  need(contract.format === 'school-workers-observe-contract' && contract.version === 1 &&
    Array.isArray(contract.shellRoutes) && Array.isArray(contract.noindexRoutes) &&
    (contract.shellPath === null || contract.shellPath === '/') &&
    (contract.shellPath !== null || (contract.shellRoutes.length === 0 && contract.noindexRoutes.length === 0)),
  'observe contract rejected')
  return { spec, template, templatePath, templateSha256: sha(templateBytes), contractBytes, contractPath, contractSha256: sha(contractBytes),
    env, envBytes, envPath, envSha256: envBytes ? sha(envBytes) : null }
}

async function readCandidate(target, candidateRoot) {
  const root = await plainDirectory(candidateRoot)
  if (target === 'high-school') {
    const candidateRaw = await readPlain(join(root, 'candidate.json'), 8 * 1024 * 1024)
    const candidate = JSON.parse(candidateRaw)
    const buildPath = join(root, 'build/observed-build.json')
    const buildRaw = await readPlain(buildPath, 64 * 1024 * 1024)
    need(candidate.build_receipt?.sha256 === sha(buildRaw) && resolve(candidate.build_receipt.path) === buildPath,
      'candidate build receipt pin differs')
    const built = JSON.parse(buildRaw)
    need(built.format === 'observed-school-build' && built.deploymentPerformed === false && hex(built.candidateRevision, 40) &&
      typeof built.origin === 'string' && Array.isArray(built.publicArtifacts) &&
      built.publicArtifacts.length === candidate.artifact_count, 'observed build receipt rejected')
    const worker = await readPlain(join(root, 'build/functions-candidate/compiled/index.js'))
    need(hex(candidate.worker_sha256) && sha(worker) === candidate.worker_sha256, 'compiled Worker differs from candidate pin')
    return {
      kind: 'high-school-candidate', root, dist: join(root, 'build/dist'), artifacts: built.publicArtifacts,
      extra: new Map([[PAGES_WORKER, sha(worker)]]), worker,
      source: { revision: built.candidateRevision, sourceSha256: null, origin: built.origin },
      receipt: { path: join(root, 'candidate.json'), sha256: sha(candidateRaw) },
    }
  }
  const receiptPath = join(root, 'school-portal-package.json')
  const receiptRaw = await readPlain(receiptPath, 8 * 1024 * 1024)
  const receipt = JSON.parse(receiptRaw)
  need(receipt.format === 'school-portal-package' && receipt.version === 1 && receipt.deploymentPerformed === false &&
    receipt.target?.outputDirectory === 'dist-school-portal' && hex(receipt.sourceSha256) && Array.isArray(receipt.artifacts),
  'school portal package receipt rejected')
  return {
    kind: 'school-portal-package', root, dist: join(root, receipt.target.outputDirectory), artifacts: receipt.artifacts,
    extra: new Map(), worker: null,
    source: { revision: null, sourceSha256: receipt.sourceSha256, origin: receipt.target.origin },
    receipt: { path: receiptPath, sha256: sha(receiptRaw) },
  }
}

export async function buildWorkersPackage({ target, candidateRoot, outputRoot, repoRoot = defaultRepoRoot, now = () => new Date() }) {
  const { spec, template, templatePath, templateSha256, contractBytes, contractPath, contractSha256, envBytes, envPath, envSha256 } =
    await readTarget(target, repoRoot)
  const input = await readCandidate(target, candidateRoot)
  need(input.kind === spec.candidate, 'candidate kind does not match the target')
  const output = resolve(outputRoot)
  need(!beneath(input.root, output) && !beneath(output, input.root) && !beneath(resolve(repoRoot), output) &&
    !beneath(output, resolve(repoRoot)), 'package output must be isolated from the candidate and the repository')
  await plainDirectory(dirname(output))
  try { await fs.lstat(output); need(false, 'package output already exists; create a new directory') } catch (error) {
    if (!(error instanceof WorkersPackageError) && error.code !== 'ENOENT') throw error
    if (error instanceof WorkersPackageError) throw error
  }

  const expected = new Map()
  for (const entry of input.artifacts) {
    need(typeof entry?.path === 'string' && Number.isInteger(entry.size) && entry.size > 0 && entry.size <= MAX_FILE_BYTES &&
      hex(entry.sha256) && !expected.has(entry.path) && !entry.path.split('/').some((part) => !part || part === '.' || part === '..'),
    'candidate artifact entry rejected')
    expected.set(entry.path, entry)
  }
  const dist = await plainDirectory(input.dist)
  const actual = await listFiles(dist)
  need(canonical(actual) === canonical([...expected.keys(), ...input.extra.keys()].sort()), 'candidate files differ from its receipt')
  if (spec.worker) {
    need(sha(await readPlain(join(dist, PAGES_WORKER))) === input.extra.get(PAGES_WORKER), 'Pages _worker.js differs from compiled Worker')
    need(expected.has(ROUTES), 'Worker target requires _routes.json')
    const derived = runWorkerFirstFromRoutes(JSON.parse(await readPlain(join(dist, ROUTES))))
    need(canonical(derived) === canonical(template.assets.run_worker_first),
      'workers template run_worker_first differs from candidate _routes.json')
  } else {
    need(!expected.has(ROUTES), 'assets-only target must not carry _routes.json')
  }
  const assets = [...expected.values()].filter((entry) => entry.path !== ROUTES).sort(byPath)
  need(assets.length > 0 && assets.length <= MAX_FILES, 'asset count exceeds Workers limits')

  await fs.mkdir(output)
  const assetsRoot = join(output, 'assets')
  await fs.mkdir(assetsRoot)
  let bytes = 0
  for (const entry of assets) {
    // Read once, verify the pin, then write the same bytes: no gap between verification and copy.
    const raw = await readPlain(join(dist, entry.path))
    need(raw.length === entry.size && sha(raw) === entry.sha256, `candidate bytes differ from receipt: ${entry.path}`)
    const destination = join(assetsRoot, entry.path)
    await fs.mkdir(dirname(destination), { recursive: true })
    await fs.writeFile(destination, raw, { flag: 'wx' })
    bytes += raw.length
  }
  let worker = null
  const config = { ...template, assets: { ...template.assets, directory: 'assets' } }
  if (spec.worker) {
    await fs.mkdir(join(output, 'worker'))
    await fs.writeFile(join(output, 'worker/index.js'), input.worker, { flag: 'wx' })
    worker = { path: 'worker/index.js', size: input.worker.length, sha256: sha(input.worker) }
    config.main = 'worker/index.js'
  }
  const configBytes = Buffer.from(canonical(config))
  await fs.writeFile(join(output, 'wrangler.jsonc'), configBytes, { flag: 'wx' })
  await fs.writeFile(join(output, 'observe.json'), contractBytes, { flag: 'wx' })
  // The validated bytes read by readTarget, so the package declares exactly the secrets that were checked.
  if (spec.worker) await fs.writeFile(join(output, ENV_FILE), envBytes, { flag: 'wx' })
  const files = assets.map(({ path, size, sha256 }) => ({ path, size, sha256 }))
  const receipt = {
    format: 'school-workers-package', version: 1, target, workerName: template.name,
    source: input.source,
    candidate: { kind: input.kind, root: input.root, receipt: input.receipt },
    template: { path: templatePath, sha256: templateSha256 },
    contract: { path: contractPath, sha256: contractSha256 },
    env: spec.worker ? { path: envPath, sha256: envSha256 } : null,
    config: { path: 'wrangler.jsonc', sha256: sha(configBytes) },
    worker,
    runWorkerFirst: spec.worker ? template.assets.run_worker_first : null,
    assets: { directory: 'assets', count: files.length, bytes, inventorySha256: sha(canonical(files)), files },
    createdAt: now().toISOString(),
    deploymentPerformed: false,
  }
  const receiptBytes = Buffer.from(canonical(receipt))
  await fs.writeFile(join(output, 'workers-package.json'), receiptBytes, { flag: 'wx' })
  await verifyWorkersPackage({ packageRoot: output, expectedReceiptSha256: sha(receiptBytes) })
  return { target, workerName: template.name, packageRoot: output, receiptSha256: sha(receiptBytes), assetCount: files.length, assetBytes: bytes, workerSha256: worker?.sha256 ?? null }
}

/** Re-read every packaged byte against the receipt. Used again right before any upload. */
export async function verifyWorkersPackage({ packageRoot, expectedReceiptSha256 }) {
  need(hex(expectedReceiptSha256), 'package receipt pin required')
  const root = await plainDirectory(packageRoot)
  const raw = await readPlain(join(root, 'workers-package.json'), 64 * 1024 * 1024)
  need(sha(raw) === expectedReceiptSha256, 'package receipt differs from pin')
  const receipt = JSON.parse(raw)
  need(raw.equals(Buffer.from(canonical(receipt))) && receipt.format === 'school-workers-package' && receipt.version === 1 &&
    receipt.deploymentPerformed === false && TARGETS[receipt.target], 'package receipt rejected')
  const spec = TARGETS[receipt.target]
  need(Boolean(receipt.worker) === spec.worker, 'package Worker presence differs from its target')
  if (spec.worker) {
    need(receipt.env && receipt.env.path === `workers/${receipt.target}/${ENV_FILE}` && hex(receipt.env.sha256),
      'package has no env contract (built before env.json was packaged); rebuild it from the candidate')
  } else {
    need(receipt.env == null, 'assets-only package must not carry an env contract')
  }
  // Wrangler may leave its own `.wrangler` cache next to the config it reads; it is never uploaded.
  const top = (await fs.readdir(root)).filter((name) => name !== '.wrangler').sort()
  const expectedTop = ['assets', 'observe.json', 'workers-package.json', 'wrangler.jsonc', ...(receipt.worker ? ['worker'] : []),
    ...(receipt.env ? [ENV_FILE] : [])].sort()
  need(canonical(top) === canonical(expectedTop), 'package directory has unexpected entries')
  const config = parseJsonc((await readPlain(join(root, 'wrangler.jsonc'), 1024 * 1024)).toString('utf8'))
  need(sha(await readPlain(join(root, 'wrangler.jsonc'), 1024 * 1024)) === receipt.config.sha256 &&
    config.name === receipt.workerName && config.assets?.directory === 'assets' &&
    canonical(config.assets.run_worker_first ?? null) === canonical(receipt.runWorkerFirst), 'package config differs')
  need(sha(await readPlain(join(root, 'observe.json'), 1024 * 1024)) === receipt.contract.sha256, 'observe contract differs')
  let envContract = null
  if (receipt.env) {
    const envBytes = await readPlain(join(root, ENV_FILE), 1024 * 1024)
    need(sha(envBytes) === receipt.env.sha256, 'package env contract differs')
    envContract = validateEnvContract(JSON.parse(envBytes), { bindings: [config.assets.binding] })
  }
  if (receipt.worker) {
    need(config.main === receipt.worker.path && config.no_bundle === true, 'package Worker entry differs')
    const worker = await readPlain(join(root, receipt.worker.path))
    need(worker.length === receipt.worker.size && sha(worker) === receipt.worker.sha256, 'package Worker bytes differ')
    need(canonical(await listFiles(join(root, 'worker'))) === canonical(['index.js']), 'package Worker directory differs')
  } else {
    need(!('main' in config), 'assets-only package must not have a Worker entry')
  }
  const files = receipt.assets.files
  need(Array.isArray(files) && files.length === receipt.assets.count && sha(canonical(files)) === receipt.assets.inventorySha256,
    'package asset inventory differs')
  need(canonical(await listFiles(join(root, 'assets'))) === canonical(files.map((entry) => entry.path)), 'package asset files differ')
  let bytes = 0
  for (const entry of files) {
    const assetBytes = await readPlain(join(root, 'assets', entry.path))
    need(assetBytes.length === entry.size && sha(assetBytes) === entry.sha256, `package asset bytes differ: ${entry.path}`)
    bytes += assetBytes.length
  }
  need(bytes === receipt.assets.bytes, 'package asset byte total differs')
  return { receipt, packageRoot: root, receiptSha256: expectedReceiptSha256, envContract }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [action, ...args] = process.argv.slice(2)
  try {
    let result = null
    if (action === 'build' && args.length === 3) {
      result = await buildWorkersPackage({ target: args[0], candidateRoot: args[1], outputRoot: args[2] })
    } else if (action === 'verify' && args.length === 2) {
      const { receipt } = await verifyWorkersPackage({ packageRoot: args[0], expectedReceiptSha256: args[1] })
      result = { target: receipt.target, workerName: receipt.workerName, assetCount: receipt.assets.count, receiptSha256: args[1] }
    }
    need(result, 'usage: workers-package.mjs build <target> <candidate-root> <output-root> | verify <package-root> <receipt-sha256>')
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(`Workers package rejected: ${error instanceof WorkersPackageError ? error.message : error?.code ?? 'unexpected error'}`)
    process.exitCode = 1
  }
}
