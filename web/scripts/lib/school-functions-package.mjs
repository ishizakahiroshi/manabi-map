// Inactive packaging of already compiled output. This never builds or reads env.
import { createHash } from 'node:crypto'
import { canonicalSchoolSourceJSON } from './school-source.mjs'

export const schoolDigest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const encode = (v) => Buffer.from(`${canonicalSchoolSourceJSON(v)}\n`)
const check = (ok) => { if (!ok) throw new Error('School package: invalid or unpinned distribution') }
const controls = new Set(['_routes.json', '_headers', '_redirects'])
const redirects = new Set([301, 302, 307, 308])
export function schoolPublicPath(path) {
  const encoded = '/' + path.split('/').map(encodeURIComponent).join('/')
  return encoded.endsWith('/index.html') ? encoded.slice(0, -10) : encoded.replace(/\.html$/, '')
}
function publicPath(path) {
  check(typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && path.length <= 2048)
  const url = new URL(path, 'https://observation.example.invalid')
  check(url.origin === 'https://observation.example.invalid' && url.pathname === path && !url.search && !url.hash)
  const decoded = decodeURIComponent(path)
  check(!decoded.includes('\\') && !decoded.includes('//') &&
    !decoded.includes('%') && decoded.split('/').map(encodeURIComponent).join('/') === path &&
    !decoded.split('/').some((part) => part === '.' || part === '..') &&
    ![...decoded].some((char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127))
}
function observationContract(files, overrides, redirectOrigins) {
  check(overrides instanceof Map && Array.isArray(redirectOrigins) && new Set(redirectOrigins).size === redirectOrigins.length)
  for (const origin of redirectOrigins) {
    const url = new URL(origin)
    check(url.protocol === 'https:' && origin === url.origin)
  }
  check([...overrides.keys()].every((path) => files.has(path) && !controls.has(path)))
  const observations = Object.create(null), urls = new Set()
  for (const path of files.keys()) {
    if (controls.has(path)) continue
    const value = overrides.get(path) ?? { path: schoolPublicPath(path), status: 200 }
    check(value && typeof value === 'object' && !Array.isArray(value))
    const redirect = redirects.has(value.status)
    check(Object.keys(value).sort().join(',') === (redirect ? 'location,path,status' : 'path,status'))
    check(redirect || [200, 404, 410].includes(value.status))
    publicPath(value.path)
    check(!urls.has(value.path)); urls.add(value.path)
    // The core runner's data contract is immutable, including public URL/status.
    if (schoolDataPath(path)) check(value.path === schoolPublicPath(path) && value.status === 200)
    let location = null
    if (redirect) {
      check(typeof value.location === 'string' && value.location.length <= 4096)
      const target = new URL(value.location)
      check(target.protocol === 'https:' && !target.username && !target.password &&
        target.href === value.location && redirectOrigins.includes(target.origin) && !target.search &&
        (!target.hash || target.hash === '#'))
      publicPath(target.pathname)
      location = value.location
    }
    observations[path] = { path: value.path, status: value.status, location, body: redirect ? 'redirect' : 'artifact' }
  }
  return observations
}
export const schoolDataPath = (path) => /^(?:schools-manifest\.json|(?:schools(?:-map)?|city-index|school-name-index)-[a-f0-9]+\.json(?:\.gz)?|school-data\/[a-z0-9-]+\.json|api\/v1\/(?:schools|dataset|openapi)\.json|api\/v1\/schools\/[a-z0-9-]+\.json)$/.test(path)
export function publicDistributionPath(path) {
  if (typeof path !== 'string' || path.includes('\\') || !/^[\p{L}\p{N}_./-]+$/u.test(path) ||
      path.split('/').some((p) => !p || p.startsWith('.'))) return false
  if (/^(?:functions|scripts|src|supabase|node_modules)(?:\/|$)/i.test(path)) return false
  return schoolDataPath(path) || ['_headers', '_redirects', '_routes.json', 'manifest.webmanifest', 'school-route-inventory.json'].includes(path) ||
    /\.(?:html|js|css|svg|png|ico|jpg|jpeg|webp|woff2?|txt|xml|pdf|md|zip)$/.test(path)
}
export function copySchoolFiles(files) {
  check(files instanceof Map && files.size > 0 && files.size <= 20000)
  let total = 0
  return new Map([...files].map(([path, bytes]) => {
    check(publicDistributionPath(path) && Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length < 25 * 1024 * 1024)
    total += bytes.length; check(total <= 64 * 1024 * 1024)
    return [path, Buffer.from(bytes)]
  }))
}
export function schoolInventory(files) {
  return [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: schoolDigest(bytes) })).sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

/** A complete immutable snapshot, exposed only through copies. The caller retains
 * an independent pin. bindings are identifiers/hashes, never secret values; actual
 * environment configuration must be compared by the deployment adapter.
 * Caller supplies a reviewed, already compiled single-module worker. This packs
 * opaque bytes and pins their identity; it does not parse JavaScript, prove that
 * imports were bundled, or prove that the bytes were built from sourceRevision.
 * Functions source paths cannot enter the static asset inventory.
 * observations overrides pin the public request path/status of a physical file.
 * 200/404/410 require its exact bytes; redirects pin Location and do not attest
 * the redirect response body. No redirect is followed during verification.
 */
export function createSchoolFunctionsPackage({ files, worker, bindingsSha256, sourceRevision,
  observations = new Map(), redirectOrigins = [] }) {
  files = copySchoolFiles(files)
  check(!files.has('_worker.js') && files.has('index.html') && files.has('_routes.json') && files.has('_headers'))
  check(Buffer.isBuffer(worker) && worker.length > 0 && worker.length < 25 * 1024 * 1024)
  check(/^[a-f0-9]{64}$/.test(bindingsSha256) && /^[a-f0-9]{40}$/.test(sourceRevision))
  const routes = JSON.parse(files.get('_routes.json').toString('utf8'))
  check(routes.version === 1 && Array.isArray(routes.include) && Array.isArray(routes.exclude) &&
    routes.include.length > 0 && [...routes.include, ...routes.exclude].every((p) => typeof p === 'string' && p.startsWith('/')))
  worker = Buffer.from(worker)
  observations = observationContract(files, observations, redirectOrigins)
  redirectOrigins = [...redirectOrigins].sort()
  const raw = encode({ format: 'school-full-distribution', version: 2, sourceRevision, bindingsSha256,
    observations, redirectOrigins,
    artifacts: schoolInventory(files), worker: { path: '_worker.js', size: worker.length, sha256: schoolDigest(worker) } })
  const pin = schoolDigest(raw)
  return Object.freeze({ pin, snapshot(expectedPin) {
    check(expectedPin === pin)
    return { raw: Buffer.from(raw), files: copySchoolFiles(files), worker: Buffer.from(worker), bindingsSha256, sourceRevision,
      observations: structuredClone(observations), redirectOrigins: [...redirectOrigins] }
  } })
}
