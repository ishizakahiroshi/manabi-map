// Static school-directory package only. No school records, Functions, credentials or network.
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { renderBrandHtml, validateBrands } from './lib/brands.mjs'
import { verifyDeploymentCapacity } from './verify-deployment-capacity.mjs'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = dirname(webRoot)
const sourcePaths = [
  'web/data/brands.json',
  'web/data/deployment-targets.json',
  'web/public/favicon.ico',
  'web/school-portal/index.html',
  'web/school-portal/style.css',
  'web/scripts/lib/brands.mjs',
  'web/scripts/lib/json-ld.mjs',
  'web/scripts/school-portal-package.mjs',
  'web/scripts/verify-deployment-capacity.mjs',
]
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`
const hex = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const requireValue = (condition) => { if (!condition) throw new Error('School portal package rejected') }
const sortedArtifacts = (output) => [...output].map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha(bytes) }))
  .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
const beneath = (parent, child) => {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

async function unlinked(path, { missing = false } = {}) {
  path = resolve(path)
  const chain = []
  for (let current = path; ; current = dirname(current)) {
    chain.push(current)
    if (dirname(current) === current) break
  }
  for (const component of chain.reverse()) {
    let stat
    try { stat = await fs.lstat(component) } catch (error) {
      if (missing && error.code === 'ENOENT') continue
      throw error
    }
    requireValue(!stat.isSymbolicLink() && relative(component, await fs.realpath(component)) === '')
  }
  return path
}

async function readSource(root = repoRoot) {
  root = await unlinked(root)
  requireValue((await fs.lstat(root)).isDirectory())
  const files = [], bytesByPath = new Map()
  for (const path of sourcePaths) {
    const full = await unlinked(join(root, path))
    const stat = await fs.lstat(full)
    requireValue(stat.isFile() && stat.size <= 1024 * 1024 && stat.nlink === 1)
    const bytes = await fs.readFile(full)
    requireValue(bytes.length <= 1024 * 1024)
    files.push({ path, size: bytes.length, sha256: sha(bytes) })
    bytesByPath.set(path, bytes)
  }
  return { files, bytesByPath, sourceSha256: sha(canonical(files)) }
}

function targetFrom(source) {
  const config = JSON.parse(source.bytesByPath.get('web/data/deployment-targets.json'))
  const target = config?.targets?.school
  requireValue(config.formatVersion === 1 && target?.kind === 'school-directory' &&
    target.origin === 'https://school.manabi-map.app' && target.pagesProject === 'manabi-map-school' &&
    target.outputDirectory === 'dist-school-portal' &&
    config.targets?.['high-school']?.origin === 'https://high-school.manabi-map.app' &&
    config.targets?.['high-school']?.pagesProject === 'manabi-map-high-school')
  return { config, target }
}

function render(source) {
  const { config, target } = targetFrom(source)
  const brands = validateBrands(JSON.parse(source.bytesByPath.get('web/data/brands.json')))
  const highSchoolOrigin = config.targets['high-school'].origin
  const style = source.bytesByPath.get('web/school-portal/style.css')
  const stylePath = `assets/portal-${sha(style).slice(0, 16)}.css`
  const template = source.bytesByPath.get('web/school-portal/index.html').toString('utf8')
  requireValue(template.includes('href="./style.css"'))
  const html = renderBrandHtml(template, 'school', brands, {
    SCHOOL_ORIGIN: target.origin, HIGH_SCHOOL_ORIGIN: highSchoolOrigin,
  }).replace('href="./style.css"', `href="/${stylePath}"`)
    .replace('</head>', '    <link rel="icon" href="/favicon.ico" />\n  </head>')
  requireValue(!/__[A-Z][A-Z_]+__/.test(html) &&
    html.includes(`href="${target.origin}/"`) && html.includes(`action="${highSchoolOrigin}/search"`))
  const brand = brands.school.name.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
  const noIndex = '<meta name="robots" content="noindex">'
  const output = new Map([
    ['index.html', Buffer.from(html)],
    ['favicon.ico', source.bytesByPath.get('web/public/favicon.ico')],
    [stylePath, style],
    ['robots.txt', Buffer.from(`User-agent: *\nAllow: /\nSitemap: ${target.origin}/sitemap.xml\n`)],
    ['sitemap.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${target.origin}/</loc></url></urlset>\n`)],
    ['llms.txt', Buffer.from(`# ${brands.school.name}\n\n高校・高専を探す入口です。\n\n[学校を探す](${target.origin}/)\n`)],
    ['404.html', Buffer.from(`<!doctype html><html lang="ja"><head><meta charset="utf-8">${noIndex}<title>ページが見つかりません | ${brand}</title><link rel="stylesheet" href="/${stylePath}"></head><body><main><h1>ページが見つかりません</h1><p>入口から、もう一度お探しください。</p><a href="/">${brand}の入口へ</a></main></body></html>`) ],
    ['_headers', Buffer.from('/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  X-Frame-Options: DENY\n')],
  ])
  requireValue(!/noindex|Disallow:\s*\//i.test(html + output.get('robots.txt').toString() + output.get('_headers').toString()))
  return { target, output }
}

async function outputInventory(directory) {
  const result = new Map()
  async function visit(root, prefix = '') {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = await unlinked(join(root, entry.name))
      if (entry.isDirectory()) await visit(full, path)
      else {
        requireValue(entry.isFile() && (await fs.lstat(full)).nlink === 1)
        result.set(path, await fs.readFile(full))
      }
    }
  }
  await visit(directory)
  return result
}

export async function inspectSchoolDirectorySource({ sourceRoot = repoRoot } = {}) {
  const source = await readSource(sourceRoot)
  targetFrom(source)
  return { sourceFiles: source.files, sourceSha256: source.sourceSha256 }
}

export async function buildSchoolDirectoryPackage({ outputRoot, expectedSourceSha256, sourceRoot = repoRoot }) {
  requireValue(hex(expectedSourceSha256) && typeof outputRoot === 'string' && outputRoot.length > 0)
  const source = await readSource(sourceRoot)
  requireValue(source.sourceSha256 === expectedSourceSha256)
  const { target, output } = render(source)
  const root = await unlinked(outputRoot, { missing: true })
  const sourceLocation = resolve(sourceRoot)
  requireValue(!beneath(sourceLocation, root) && !beneath(root, sourceLocation))
  try { await fs.lstat(root); requireValue(false) } catch (error) { if (error.code !== 'ENOENT') throw error }
  await fs.mkdir(root)
  const dist = join(root, target.outputDirectory)
  await fs.mkdir(dist)
  for (const [path, bytes] of output) {
    const full = join(dist, path)
    await fs.mkdir(dirname(full), { recursive: true })
    await fs.writeFile(full, bytes, { flag: 'wx' })
  }
  const check = await verifyDeploymentCapacity({ distDir: dist, targetId: 'school', config: JSON.parse(source.bytesByPath.get('web/data/deployment-targets.json')) })
  requireValue(check.valid)
  const artifacts = sortedArtifacts(output)
  const receipt = { format: 'school-portal-package', version: 1, target, sourceFiles: source.files,
    sourceSha256: source.sourceSha256, artifacts, deploymentPerformed: false }
  const receiptBytes = Buffer.from(canonical(receipt))
  await fs.writeFile(join(root, 'school-portal-package.json'), receiptBytes, { flag: 'wx' })
  return { receiptSha256: sha(receiptBytes), sourceSha256: source.sourceSha256, fileCount: artifacts.length, outputDirectory: dist }
}

export async function verifySchoolDirectoryPackage({ outputRoot, expectedSourceSha256, expectedReceiptSha256, sourceRoot = repoRoot }) {
  requireValue(hex(expectedSourceSha256) && hex(expectedReceiptSha256))
  const root = await unlinked(outputRoot)
  const receiptPath = await unlinked(join(root, 'school-portal-package.json'))
  requireValue((await fs.lstat(receiptPath)).nlink === 1)
  const raw = await fs.readFile(receiptPath)
  requireValue(sha(raw) === expectedReceiptSha256)
  const receipt = JSON.parse(raw)
  requireValue(raw.equals(Buffer.from(canonical(receipt))) && receipt.format === 'school-portal-package' &&
    receipt.version === 1 && receipt.deploymentPerformed === false &&
    Object.keys(receipt).sort().join(',') === 'artifacts,deploymentPerformed,format,sourceFiles,sourceSha256,target,version')
  const source = await readSource(sourceRoot)
  const { target, output } = render(source)
  requireValue(source.sourceSha256 === expectedSourceSha256 && receipt.sourceSha256 === expectedSourceSha256 &&
    canonical(receipt.sourceFiles) === canonical(source.files) && canonical(receipt.target) === canonical(target))
  requireValue(canonical((await fs.readdir(root)).sort()) === canonical([target.outputDirectory, 'school-portal-package.json'].sort()))
  const dist = await unlinked(join(root, target.outputDirectory))
  const actual = await outputInventory(dist)
  requireValue(actual.size === output.size && [...actual.keys()].every((path) => output.has(path)))
  const artifacts = sortedArtifacts(actual)
  requireValue(canonical(artifacts) === canonical(receipt.artifacts) &&
    [...actual].every(([path, bytes]) => bytes.equals(output.get(path))))
  const check = await verifyDeploymentCapacity({ distDir: dist, targetId: 'school', config: JSON.parse(source.bytesByPath.get('web/data/deployment-targets.json')) })
  requireValue(check.valid)
  return { target, sourceSha256: expectedSourceSha256, receiptSha256: expectedReceiptSha256, fileCount: actual.size, outputDirectory: dist }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [action, outputRoot, sourcePin, receiptPin] = process.argv.slice(2)
  try {
    const result = action === 'inspect' && process.argv.length === 3 ? await inspectSchoolDirectorySource()
      : action === 'build' && outputRoot && sourcePin && !receiptPin ? await buildSchoolDirectoryPackage({ outputRoot, expectedSourceSha256: sourcePin })
        : action === 'verify' && outputRoot && sourcePin && receiptPin ? await verifySchoolDirectoryPackage({ outputRoot, expectedSourceSha256: sourcePin, expectedReceiptSha256: receiptPin })
          : null
    requireValue(result)
    console.log(JSON.stringify(result))
  } catch {
    console.error('School portal package rejected; no deployment performed.')
    process.exitCode = 1
  }
}
