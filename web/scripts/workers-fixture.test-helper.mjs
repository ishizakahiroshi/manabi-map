// Synthetic candidates for the Workers package / observe / publish tests. No real school data.
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import { dirname, join } from 'node:path'

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')

export const ROUTES = { version: 1, include: ['/*'], exclude: ['/assets/*', '/robots.txt'] }
export const HEADERS = '# synthetic\n/*\n  X-Frame-Options: DENY\n  X-Content-Type-Options: nosniff\n\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n'
export const WORKER = 'export default { async fetch(request, env) { return env.ASSETS.fetch(request) } }\n'

export async function tempRoot(t) {
  const root = await fs.mkdtemp(join(os.tmpdir(), 'workers-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

async function write(path, bytes) {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, bytes)
}

export async function fakeRepo(root, { runWorkerFirst = ['/*', '!/assets/*', '!/robots.txt'] } = {}) {
  const repo = join(root, 'repo')
  await write(join(repo, 'workers/high-school/wrangler.jsonc'), `// synthetic\n{\n  "name": "example-high-school",\n  "compatibility_date": "2026-01-01",\n  "no_bundle": true,\n  "workers_dev": true,\n  "preview_urls": true,\n  "assets": { "binding": "ASSETS", "html_handling": "auto-trailing-slash", "not_found_handling": "404-page",\n    "run_worker_first": ${JSON.stringify(runWorkerFirst)} }\n}\n`)
  await write(join(repo, 'workers/high-school/observe.json'), JSON.stringify({ format: 'school-workers-observe-contract', version: 1,
    shellPath: '/', shellRoutes: ['/auth/callback'], noindexRoutes: ['/map?lat=1&lng=2'] }))
  await write(join(repo, 'workers/school/wrangler.jsonc'), '{ "name": "example-school", "compatibility_date": "2026-01-01", "workers_dev": true,\n  "assets": { "html_handling": "auto-trailing-slash", "not_found_handling": "404-page" } }\n')
  await write(join(repo, 'workers/school/observe.json'), JSON.stringify({ format: 'school-workers-observe-contract', version: 1,
    shellPath: null, shellRoutes: [], noindexRoutes: [] }))
  return repo
}

export const HIGH_SCHOOL_FILES = {
  'index.html': '<!doctype html><title>shell</title>',
  '404.html': '<!doctype html><title>missing</title>',
  'school/example-1/index.html': '<!doctype html><title>school 1</title>',
  'guide.html': '<!doctype html><title>guide</title><body><p>guide</p></body>\n',
  'assets/app-0001.js': 'console.log(1)\n',
  'robots.txt': 'User-agent: *\n',
  _headers: HEADERS,
  _redirects: '# none\n',
  '_routes.json': JSON.stringify(ROUTES),
}

export async function fakeHighSchoolCandidate(root, { files = HIGH_SCHOOL_FILES, extraDist = {} } = {}) {
  const candidate = join(root, 'candidate-high-school')
  const dist = join(candidate, 'build/dist')
  const artifacts = []
  for (const [path, text] of Object.entries(files)) {
    const bytes = Buffer.from(text)
    await write(join(dist, path), bytes)
    artifacts.push({ path, sha256: sha(bytes), size: bytes.length })
  }
  for (const [path, text] of Object.entries(extraDist)) await write(join(dist, path), text)
  await write(join(dist, '_worker.js'), WORKER)
  await write(join(candidate, 'build/functions-candidate/compiled/index.js'), WORKER)
  const built = Buffer.from(JSON.stringify({ format: 'observed-school-build', deploymentPerformed: false,
    candidateRevision: 'a'.repeat(40), origin: 'https://high-school.example.test', publicArtifacts: artifacts }))
  await write(join(candidate, 'build/observed-build.json'), built)
  await write(join(candidate, 'candidate.json'), JSON.stringify({ artifact_count: artifacts.length, worker_sha256: sha(Buffer.from(WORKER)),
    build_receipt: { path: join(candidate, 'build/observed-build.json'), sha256: sha(built) } }))
  return candidate
}

export async function fakeSchoolDirectory(root) {
  const portal = join(root, 'portal')
  const files = { 'index.html': '<!doctype html><title>portal</title>', '404.html': '<!doctype html><title>nf</title>',
    _headers: '/*\n  X-Content-Type-Options: nosniff\n' }
  const artifacts = []
  for (const [path, text] of Object.entries(files)) {
    await write(join(portal, 'dist-school-portal', path), text)
    artifacts.push({ path, size: Buffer.byteLength(text), sha256: sha(Buffer.from(text)) })
  }
  await write(join(portal, 'school-portal-package.json'), JSON.stringify({ format: 'school-portal-package', version: 1,
    target: { origin: 'https://school.example.test', outputDirectory: 'dist-school-portal' }, sourceSha256: 'b'.repeat(64),
    artifacts, deploymentPerformed: false }))
  return portal
}
