import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildWorkersPackage, canonical, parseJsonc, readTarget, runWorkerFirstFromRoutes, sha, validateEnvContract, verifyWorkersPackage,
  WorkersPackageError } from './workers-package.mjs'
import { ENV_CONTRACT, ENV_SECRETS, fakeHighSchoolCandidate, fakeSchoolDirectory, fakeRepo, tempRoot, WORKER } from './workers-fixture.test-helper.mjs'

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
  const { receipt, envContract } = await verifyWorkersPackage({ packageRoot: output, expectedReceiptSha256: result.receiptSha256 })
  assert.equal(receipt.source.revision, 'a'.repeat(40))
  assert.deepEqual(receipt.runWorkerFirst, ['/*', '!/assets/*', '!/robots.txt'])
  const envBytes = await fs.readFile(join(repo, 'workers/high-school/env.json'))
  assert.deepEqual(await fs.readFile(join(output, 'env.json')), envBytes)
  assert.deepEqual(receipt.env, { path: 'workers/high-school/env.json', sha256: sha(envBytes) })
  assert.deepEqual(envContract.secrets, ENV_SECRETS)
})

test('env contract validation: exact keys, sorted unique secret names, reasons for unset names, no binding names', () => {
  assert.equal(validateEnvContract(ENV_CONTRACT, { bindings: ['ASSETS'] }), ENV_CONTRACT)
  const rejected = [
    [{ ...ENV_CONTRACT, extra: 1 }, /keys must be exactly/],
    [{ ...ENV_CONTRACT, version: 2 }, /format or version/],
    [{ ...ENV_CONTRACT, secrets: ['EXAMPLE_URL', 'EXAMPLE_KEY'] }, /unique and sorted/],
    [{ ...ENV_CONTRACT, secrets: ['EXAMPLE_KEY', 'EXAMPLE_KEY'] }, /unique and sorted/],
    [{ ...ENV_CONTRACT, secrets: ['example_key'] }, /must be env names/],
    [{ ...ENV_CONTRACT, unset: [] }, /unset must be an object/],
    [{ ...ENV_CONTRACT, unset: { EXAMPLE_FLAG: ' ' } }, /needs a reason/],
    [{ ...ENV_CONTRACT, unset: { EXAMPLE_KEY: 'synthetic' } }, /both a secret and unset/],
    [{ ...ENV_CONTRACT, secrets: ['ASSETS'] }, /Wrangler binding/],
  ]
  for (const [contract, pattern] of rejected) {
    assert.throws(() => validateEnvContract(contract, { bindings: ['ASSETS'] }), (error) => error instanceof WorkersPackageError && pattern.test(error.message))
  }
})

test('package refuses a Worker target without a valid env.json and an assets-only target that declares one', async (t) => {
  const root = await tempRoot(t)
  const cases = [
    ['missing', 'high-school', { highSchoolEnv: null }, /workers\/high-school\/env\.json is required/],
    ['unsorted', 'high-school', { highSchoolEnv: { ...ENV_CONTRACT, secrets: ['EXAMPLE_URL', 'EXAMPLE_KEY'] } }, /unique and sorted/],
    ['school', 'school', { schoolEnv: ENV_CONTRACT }, /assets-only target must not declare workers\/school\/env\.json/],
  ]
  for (const [name, target, options, pattern] of cases) {
    const repo = await fakeRepo(join(root, name), options)
    const candidate = target === 'school' ? await fakeSchoolDirectory(join(root, name)) : await fakeHighSchoolCandidate(join(root, name))
    await assert.rejects(buildWorkersPackage({ target, candidateRoot: candidate, outputRoot: join(root, `out-${name}`), repoRoot: repo }),
      (error) => error instanceof WorkersPackageError && pattern.test(error.message))
    await assert.rejects(fs.lstat(join(root, `out-${name}`)), { code: 'ENOENT' })
  }
})

test('verification detects a changed env.json and refuses a Worker package without one', async (t) => {
  const root = await tempRoot(t)
  const repo = await fakeRepo(root)
  const candidate = await fakeHighSchoolCandidate(root)
  const output = join(root, 'package')
  const { receiptSha256 } = await buildWorkersPackage({ target: 'high-school', candidateRoot: candidate, outputRoot: output, repoRoot: repo })
  // Still a valid contract, but it no longer declares one of the secrets the package was built with.
  await fs.writeFile(join(output, 'env.json'), `${JSON.stringify({ ...ENV_CONTRACT, secrets: ['EXAMPLE_URL'] }, null, 2)}\n`)
  await assert.rejects(verifyWorkersPackage({ packageRoot: output, expectedReceiptSha256: receiptSha256 }), /package env contract differs/)
  // A package built before env.json was packaged: no env entry in the receipt, no env.json file.
  const receipt = JSON.parse(await fs.readFile(join(output, 'workers-package.json'), 'utf8'))
  delete receipt.env
  await fs.rm(join(output, 'env.json'))
  await fs.writeFile(join(output, 'workers-package.json'), canonical(receipt))
  await assert.rejects(verifyWorkersPackage({ packageRoot: output, expectedReceiptSha256: sha(Buffer.from(canonical(receipt))) }),
    /package has no env contract/)
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
  await assert.rejects(fs.lstat(join(output, 'env.json')), { code: 'ENOENT' })
  const { receipt, envContract } = await verifyWorkersPackage({ packageRoot: output, expectedReceiptSha256: result.receiptSha256 })
  assert.equal(receipt.env, null)
  assert.equal(envContract, null)
})
