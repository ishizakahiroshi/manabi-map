import { lstat, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const DEFAULT_MAX_FILE_MIB = 25
const SITE_ORIGIN = 'https://manabi-map.app'

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

async function collectFiles(dir, root = dir) {
  const files = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`static output must not contain symbolic links: ${path}`)
    }
    if (entry.isDirectory()) files.push(...await collectFiles(path, root))
    else if (entry.isFile()) {
      const stat = await lstat(path)
      files.push({ path, relativePath: path.slice(root.length + 1).replaceAll('\\', '/'), bytes: stat.size })
    }
  }
  return files
}

function decodeSchoolsPayload(buffer) {
  const isGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
  const text = (isGzip ? gunzipSync(buffer) : buffer).toString('utf8')
  const payload = JSON.parse(text)
  const schools = Array.isArray(payload) ? payload : payload?.schools
  if (!Array.isArray(schools)) throw new Error('schools payload has an unsupported format')
  return { payload, schools, isGzip }
}

function sitemapLocations(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])
}

export async function verifyStaticOutput({
  distDir,
  maxFileBytes = DEFAULT_MAX_FILE_MIB * 1024 * 1024,
} = {}) {
  if (!distDir) throw new Error('distDir is required')
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new Error('maxFileBytes must be a positive safe integer')
  }

  const absoluteDist = resolve(distDir)
  const files = await collectFiles(absoluteDist)
  if (files.length === 0) throw new Error(`static output is empty: ${absoluteDist}`)
  const largest = files.reduce((current, file) => file.bytes > current.bytes ? file : current)
  const oversized = files.filter((file) => file.bytes >= maxFileBytes)
  if (oversized.length > 0) {
    throw new Error(
      `static file must be smaller than ${maxFileBytes} bytes: ` +
      oversized.map((file) => `${file.relativePath}=${file.bytes}`).join(', '),
    )
  }

  const manifest = JSON.parse(await readFile(join(absoluteDist, 'schools-manifest.json'), 'utf8'))
  if (!Number.isInteger(manifest.count) || manifest.count < 0) {
    throw new Error('schools-manifest.json count is invalid')
  }
  if (typeof manifest.url !== 'string' || !/^\/schools(?:-[0-9a-f]+)?\.json(?:\.gz)?$/i.test(manifest.url)) {
    throw new Error('schools-manifest.json url is invalid')
  }
  const schoolsPath = join(absoluteDist, manifest.url.slice(1))
  const { schools, isGzip } = decodeSchoolsPayload(await readFile(schoolsPath))
  if (schools.length !== manifest.count) {
    throw new Error(`manifest count mismatch: manifest=${manifest.count} payload=${schools.length}`)
  }
  if (manifest.compression === 'gzip' && !isGzip) {
    throw new Error('manifest declares gzip but payload does not have gzip magic bytes')
  }

  const targets = schools.filter((school) => school?.latitude != null && school?.longitude != null)
  const expectedLocations = new Set([
    `${SITE_ORIGIN}/`,
    `${SITE_ORIGIN}/search`,
    ...targets.map((school) => `${SITE_ORIGIN}/school/${school.id}`),
  ])
  const locations = sitemapLocations(await readFile(join(absoluteDist, 'sitemap.xml'), 'utf8'))
  const actualLocations = new Set(locations)
  if (actualLocations.size !== locations.length) {
    throw new Error(`sitemap contains duplicate URLs: entries=${locations.length} unique=${actualLocations.size}`)
  }
  if (
    actualLocations.size !== expectedLocations.size ||
    [...actualLocations].some((url) => !expectedLocations.has(url)) ||
    [...expectedLocations].some((url) => !actualLocations.has(url))
  ) {
    throw new Error(`sitemap mismatch: expected=${expectedLocations.size} actual=${actualLocations.size}`)
  }

  const schoolRoot = join(absoluteDist, 'school')
  const generatedIds = new Set(await readdir(schoolRoot))
  if (generatedIds.size !== targets.length || targets.some((school) => !generatedIds.has(String(school.id)))) {
    throw new Error(`SEO school page count mismatch: expected=${targets.length} actual=${generatedIds.size}`)
  }

  const targetPages = new Map()
  for (const target of targets) {
    const indexPath = join(schoolRoot, String(target.id), 'index.html')
    let stat
    try {
      stat = await lstat(indexPath)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`SEO school index.html is missing: ${target.id}`)
      }
      throw error
    }
    if (!stat.isFile()) throw new Error(`SEO school index.html is not a regular file: ${target.id}`)
    targetPages.set(String(target.id), await readFile(indexPath, 'utf8'))
  }

  const representative = targets[0]
  if (representative) {
    const html = targetPages.get(String(representative.id))
    if (!html.includes(`<h1>${escapeHtml(representative.name)}</h1>`)) {
      throw new Error(`representative View Source is missing school heading: ${representative.id}`)
    }
    if (!html.includes(`href="${SITE_ORIGIN}/school/${representative.id}"`)) {
      throw new Error(`representative View Source is missing canonical URL: ${representative.id}`)
    }
  }

  return {
    fileCount: files.length,
    largestFile: largest.relativePath,
    largestFileBytes: largest.bytes,
    schoolCount: schools.length,
    seoSchoolCount: targets.length,
    sitemapUrlCount: locations.length,
    sitemapUniqueUrlCount: actualLocations.size,
    schoolsPayloadGzip: isGzip,
  }
}

function parseArgs(argv) {
  const here = dirname(fileURLToPath(import.meta.url))
  const args = { distDir: join(here, '..', 'dist'), maxFileBytes: DEFAULT_MAX_FILE_MIB * 1024 * 1024 }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dist') args.distDir = argv[++i]
    else if (argv[i] === '--max-file-mib') {
      const mib = Number(argv[++i])
      if (!Number.isFinite(mib) || mib <= 0) throw new Error('--max-file-mib must be positive')
      args.maxFileBytes = Math.floor(mib * 1024 * 1024)
    } else throw new Error(`unknown argument: ${argv[i]}`)
  }
  return args
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = await verifyStaticOutput(parseArgs(process.argv.slice(2)))
  console.log(
    `static output verified: files=${result.fileCount} schools=${result.schoolCount} ` +
    `seo=${result.seoSchoolCount} sitemap=${result.sitemapUrlCount} ` +
    `largest=${result.largestFile} (${result.largestFileBytes} bytes) gzip=${result.schoolsPayloadGzip}`,
  )
}
