import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildWorkersPackage, parseJsonc, readTarget, runWorkerFirstFromRoutes, verifyWorkersPackage, WorkersPackageError } from './workers-package.mjs'
import { fakeHighSchoolCandidate, fakeSchoolDirectory, fakeRepo, tempRoot, WORKER } from './workers-fixture.test-helper.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('JSONC comments are stripped outside strings only', () => {
  assert.deepEqual(parseJsonc('// a\n{ "u": "https://x/*y*/", /* b */ "n": 1 }\n'), { u: 'https://x/*y*/', n: 1 })
  assert.throws(() => parseJsonc('{ "a": 1, }'))
})

test('repository templates: high-school run_worker_first equals the Pages _routes.json; school is assets-only', async () => {
  const highSchool = await readTarget('high-school', repoRoot)
  const routes = JSON.parse(await fs.readFile(join(repoRoot, 'web/public/_routes.json'), 'utf8'))
  assert.deepEqual(highSchool.template.assets.run_worker_first, runWorkerFirstFromRoutes(routes))
  assert.equal(highSchool.template.assets.not_found_handling, '404-page')
  const school = await readTarget('school', repoRoot)
  assert.equal(school.template.assets.binding, undefined)
  assert.equal(school.template.assets.run_worker_first, undefined)
})

test('high-school package copies verified assets, the raw Worker and a generated config', async (t) => {
  const root = await tempRoot(t)
  const repo = await fakeRepo(root)
  const candidate = await fakeHighSchoolCandidate(root)
  const output = join(root, 'package-001')
  const result = await buildWorkersPackage({ target: 'high-school', candidateRoot: candidate, outputRoot: output, repoRoot: repo })
  assert.equal(result.assetCount, 8)
  const config = JSON.parse(await fs.readFile(join(output, 'wrangler.jsonc'), 'utf8'))
  assert.equal(config.main, 'worker/index.js')
  assert.equal(config.assets.directory, 'assets')
  assert.equal(config.no_bundle, true)
  assert.equal(await fs.readFile(join(output, 'worker/index.js'), 'utf8'), WORKER)
  await assert.rejects(fs.lstat(join(output, 'assets/_routes.json')), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(join(output, 'assets/_worker.js')), { code: 'ENOENT' })
  const { receipt } = await verifyWorkersPackage({ packageRoot: output, expectedReceiptSha256: result.receiptSha256 })
  assert.equal(receipt.source.revision, 'a'.repeat(40))
  assert.deepEqual(receipt.runWorkerFirst, ['/*', '!/assets/*', '!/robots.txt'])
})

test('package refuses a template whose run_worker_first differs from the candidate routes', async (t) => {
  const root = await tempRoot(t)
  const repo = await fakeRepo(root, { runWorkerFirst: ['/*', '!/assets/*'] })
  const candidate = await fakeHighSchoolCandidate(root)
  await assert.rejects(buildWorkersPackage({ target: 'high-school', candidateRoot: candidate, outputRoot: join(root, 'out'), repoRoot: repo }),
    (error) => error instanceof WorkersPackageError && /run_worker_first/.test(error.message))
  await assert.rejects(fs.lstat(join(root, 'out')), { code: 'ENOENT' })
})

test('package refuses extra or altered candidate files and an existing output', async (t) => {
  const root = await tempRoot(t)
  const repo = await fakeRepo(root)
  const extra = await fakeHighSchoolCandidate(join(root, 'a'), { extraDist: { 'stray.txt': 'x' } })
  await assert.rejects(buildWorkersPackage({ target: 'high-school', candidateRoot: extra, outputRoot: join(root, 'out-a'), repoRoot: repo }),
    /candidate files differ/)
  const altered = await fakeHighSchoolCandidate(join(root, 'b'))
  await fs.writeFile(join(altered, 'build/dist/guide.html'), '<!doctype html><title>changed</title>')
  await assert.rejects(buildWorkersPackage({ target: 'high-school', candidateRoot: altered, outputRoot: join(root, 'out-b'), repoRoot: repo }),
    /candidate bytes differ/)
  const good = await fakeHighSchoolCandidate(join(root, 'c'))
  await fs.mkdir(join(root, 'out-c'))
  await assert.rejects(buildWorkersPackage({ target: 'high-school', candidateRoot: good, outputRoot: join(root, 'out-c'), repoRoot: repo }),
    /already exists/)
})

test('verification detects a packaged file changed after build', async (t) => {
  const root = await tempRoot(t)
  const repo = await fakeRepo(root)
  const candidate = await fakeHighSchoolCandidate(root)
  const output = join(root, 'package')
  const { receiptSha256 } = await buildWorkersPackage({ target: 'high-school', candidateRoot: candidate, outputRoot: output, repoRoot: repo })
  await fs.writeFile(join(output, 'assets/robots.txt'), 'User-agent: x\n')
  await assert.rejects(verifyWorkersPackage({ packageRoot: output, expectedReceiptSha256: receiptSha256 }), /package asset bytes differ/)
})

test('school portal becomes an assets-only package', async (t) => {
  const root = await tempRoot(t)
  const repo = await fakeRepo(root)
  const portal = await fakeSchoolDirectory(root)
  const output = join(root, 'portal-package')
  const result = await buildWorkersPackage({ target: 'school', candidateRoot: portal, outputRoot: output, repoRoot: repo })
  assert.equal(result.workerSha256, null)
  const config = JSON.parse(await fs.readFile(join(output, 'wrangler.jsonc'), 'utf8'))
  assert.equal(config.main, undefined)
  assert.equal(config.assets.directory, 'assets')
  await assert.rejects(fs.lstat(join(output, 'worker')), { code: 'ENOENT' })
})
