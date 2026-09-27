// Read-only, per-Pages-site budgets. This is not a deployment or a billing-plan check.
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { resolve, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const FREE_FILE_LIMIT = 20_000
export const ASSET_BYTE_LIMIT = 25 * 1024 * 1024
const configPath = fileURLToPath(new URL('../data/deployment-targets.json', import.meta.url))
const kinds = new Set(['school-directory', 'high-school-app', 'apex-portal'])

export function validateTargets(config) {
  if (config?.formatVersion !== 1 || !config.targets || Array.isArray(config.targets)) throw new Error('Unknown deployment target format')
  const entries = Object.entries(config.targets)
  if (!entries.length) throw new Error('Deployment targets are empty')
  for (const field of ['origin', 'pagesProject', 'outputDirectory']) {
    const seen = new Set()
    for (const [id, target] of entries) {
      if (!/^[a-z][a-z0-9-]*$/.test(id) || !kinds.has(target?.kind)) throw new Error('Unknown deployment target kind')
      const value = target[field]
      if (typeof value !== 'string' || !value || seen.has(value.toLowerCase())) throw new Error(`Targets require distinct ${field} values`)
      seen.add(value.toLowerCase())
      if (field === 'origin') {
        const url = new URL(value)
        if (url.protocol !== 'https:' || url.origin !== value) throw new Error('Target origin must be a bare HTTPS origin')
      } else if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) throw new Error(`Invalid ${field}`)
    }
  }
  return config.targets
}

function forbiddenPath(path) {
  return /(^|\/)(?:\.git(?:-credentials)?|\.env(?:\.[^/]*)?|\.npmrc|\.netrc|\.pypirc|node_modules|__pycache__)(?:\/|$)/i.test(path)
    || /\.(?:sqlite(?:3)?|db|dump|sql|pem|key|pyc)$/i.test(path)
}

function directoryAsset(path) {
  return /^(?:index\.html|404\.html|robots\.txt|sitemap\.xml|_headers|_redirects|favicon\.ico|site\.webmanifest)$/.test(path)
    || /^(?:[a-z0-9-]+\.(?:png|svg|ico|webmanifest))$/i.test(path)
    || /^assets\/(?:[a-z0-9_.-]+\/)*[a-z0-9_.-]+\.(?:css|js|svg|png|webp|jpg|woff2?)$/i.test(path)
}

export function assessInventory(files, target, { maxFiles = FREE_FILE_LIMIT, maxFileBytes = ASSET_BYTE_LIMIT } = {}) {
  if (!kinds.has(target?.kind)) throw new Error('Unknown deployment target kind')
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) throw new Error('Positive integer budgets required')
  const errors = []
  const names = new Set()
  let totalBytes = 0
  let largest = null
  for (const file of files) {
    if (typeof file.path !== 'string' || !file.path || file.path.includes('\\') || file.path.startsWith('/')
      || file.path.split('/').some((part) => !part || part === '.' || part === '..')
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('Invalid file inventory')
    if (names.has(file.path.toLowerCase())) errors.push(`Duplicate/case-colliding output: ${file.path}`)
    names.add(file.path.toLowerCase())
    totalBytes += file.bytes
    if (!Number.isSafeInteger(totalBytes)) throw new Error('File size total is unsafe')
    if (!largest || file.bytes > largest.bytes) largest = file
    // Match the existing static verifier's conservative strictly-below policy.
    if (file.bytes >= maxFileBytes) errors.push(`Asset must be smaller than ${maxFileBytes} bytes: ${file.path}`)
    if (forbiddenPath(file.path)) errors.push(`Private/source asset in output: ${file.path}`)
    if (target.kind === 'school-directory' && !directoryAsset(file.path)) errors.push(`School directory contains a non-portal asset: ${file.path}`)
    if (target.kind === 'high-school-app' && /^(?:school-portal|kanji)(?:\/|$)/i.test(file.path)) errors.push(`Other application output in high school: ${file.path}`)
    if (target.kind === 'apex-portal' && /^(?:school|schools|pref|kanji|school-portal)\//i.test(file.path)) errors.push(`Other page output in apex: ${file.path}`)
  }
  if (!names.has('index.html')) errors.push('Output must contain index.html')
  if (target.kind === 'high-school-app' && !names.has('schools-manifest.json')) errors.push('High school output must contain schools-manifest.json')
  if (target.kind === 'apex-portal' && (!names.has('legacy-school/index.html') || !names.has('schools-manifest.json'))) errors.push('Apex compatibility shell and generation are required')
  if (files.length > maxFiles) errors.push(`File count exceeds ${maxFiles}: ${files.length}`)
  return {
    valid: errors.length === 0, fileCount: files.length, totalBytes, largest,
    maxFiles, maxFileBytes, remainingFiles: maxFiles - files.length,
    warnings: files.length >= maxFiles * 0.8 ? ['File count is at least 80% of this target budget'] : [],
    errors,
  }
}

async function inventory(distDir) {
  const root = resolve(distDir)
  const canonical = await realpath(root)
  const same = process.platform === 'win32' ? root.toLowerCase() === canonical.toLowerCase() : root === canonical
  if (!same || !(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new Error('Output must be an unlinked directory')
  const files = []
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) throw new Error('Linked output is not supported')
      if (stat.isDirectory()) await walk(path)
      else if (stat.isFile()) files.push({ path: relative(root, path).split(sep).join('/'), bytes: stat.size })
      else throw new Error('Output contains a non-regular file')
    }
  }
  await walk(root)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

export async function verifyDeploymentCapacity({ distDir, targetId, config, ...budgets }) {
  const targets = validateTargets(config)
  if (!Object.hasOwn(targets, targetId)) throw new Error('Explicit known target required')
  if (!distDir) throw new Error('Explicit output directory required')
  return { target: targetId, ...targets[targetId], inspectedDirectory: resolve(distDir), ...assessInventory(await inventory(distDir), targets[targetId], budgets) }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    dist: { type: 'string' }, target: { type: 'string' }, config: { type: 'string', default: configPath },
    'max-files': { type: 'string', default: String(FREE_FILE_LIMIT) },
    'max-file-mib': { type: 'string', default: '25' },
  } })
  const result = await verifyDeploymentCapacity({ distDir: values.dist, targetId: values.target,
    config: JSON.parse(await readFile(values.config, 'utf8')),
    maxFiles: Number(values['max-files']), maxFileBytes: Number(values['max-file-mib']) * 1024 * 1024 })
  console.log(JSON.stringify(result, null, 2))
  return result.valid ? 0 : 1
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    console.error(`Deployment capacity check failed: ${error.message}`)
    process.exitCode = 1
  })
}
