import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { buildWorkersPackage, canonical, sha } from './workers-package.mjs'
import { bindingDifference, bootstrapWorker, deployVersion, parseUploadOutput, secretsVersion, uploadVersion, versionLabels, workersDevOrigin } from './workers-publish.mjs'
import { fakeHighSchoolCandidate, fakeRepo, fakeSchoolDirectory, tempRoot } from './workers-fixture.test-helper.mjs'

const VERSION = '11111111-2222-4333-8444-555555555555'
const PREVIEW = 'https://1a2b3c4d-example-high-school.example-sub.workers.dev'
/** ASSETS plus the two secrets of the synthetic env.json (workers-fixture.test-helper.mjs). */
const FULL_BINDINGS = [{ name: 'ASSETS', type: 'assets' }, { name: 'EXAMPLE_KEY', type: 'secret_text' }, { name: 'EXAMPLE_URL', type: 'secret_text' }]
const isCall = (command, sub) => (args) => args[0] === command && args[1] === sub
const deployCalls = (state) => state.calls.filter(isCall('versions', 'deploy')).length

/** Fake Wrangler: records calls and keeps a tiny deployment state. Never touches the network. */
function fakeWrangler({ exists = true, annotations = null, bindings = FULL_BINDINGS, preview = PREVIEW } = {}) {
  const state = { exists, active: [{ version_id: 'old-version', percentage: 100 }], uploaded: null, calls: [] }
  const run = async (args, { logDirectory, label }) => {
    state.calls.push(args)
    await fs.writeFile(join(logDirectory, `${label}.stdout.log`), '', { flag: 'wx' })
    const [command, sub] = args
    if (command === 'deployments' && sub === 'status') {
      return state.exists ? { code: 0, stdout: JSON.stringify({ id: 'd', versions: state.active }), stderr: '' }
        : { code: 1, stdout: '', stderr: 'This Worker does not exist on your account. [code: 10007]' }
    }
    if (command === 'deploy') { state.exists = true; state.active = [{ version_id: 'placeholder', percentage: 100 }]; return { code: 0, stdout: '', stderr: '' } }
    if (command === 'versions' && sub === 'upload') {
      state.uploaded = { tag: args[args.indexOf('--tag') + 1], message: args[args.indexOf('--message') + 1] }
      return { code: 0, stdout: `Worker Version ID: ${VERSION}\nVersion Preview URL: ${preview}\n`, stderr: '' }
    }
    if (command === 'versions' && sub === 'view') {
      const value = annotations ?? { 'workers/tag': state.uploaded.tag, 'workers/message': state.uploaded.message }
      return { code: 0, stdout: JSON.stringify({ id: VERSION, annotations: value, resources: { script: { etag: 'same-code' }, bindings } }), stderr: '' }
    }
    if (command === 'versions' && sub === 'deploy') {
      state.active = [{ version_id: args[2].split('@')[0], percentage: 100 }]
      return { code: 0, stdout: '', stderr: '' }
    }
    throw new Error(`unexpected wrangler call ${args.join(' ')}`)
  }
  return { run, state }
}

async function fixture(t) {
  const root = await tempRoot(t)
  const repo = await fakeRepo(root)
  const candidate = await fakeHighSchoolCandidate(root)
  const output = join(root, 'package')
  const built = await buildWorkersPackage({ target: 'high-school', candidateRoot: candidate, outputRoot: output, repoRoot: repo })
  return { root, repo, output, receiptSha256: built.receiptSha256 }
}

test('labels carry the source revision, candidate and package pins', async (t) => {
  const { output, receiptSha256 } = await fixture(t)
  const receipt = JSON.parse(await fs.readFile(join(output, 'workers-package.json'), 'utf8'))
  const { tag, message } = versionLabels(receipt, receiptSha256)
  assert.equal(tag, `c8-aaaaaaa-${receiptSha256.slice(0, 8)}`)
  assert.match(message, new RegExp(`^rev=a{40} cand=[0-9a-f]{12} pkg=${receiptSha256.slice(0, 12)}$`))
  assert.ok(message.length <= 100)
  assert.deepEqual(parseUploadOutput(`x\nWorker Version ID: ${VERSION}\nVersion Preview URL: ${PREVIEW}\n`), { versionId: VERSION, previewUrl: PREVIEW })
  assert.equal(workersDevOrigin(PREVIEW, 'example-high-school'), 'https://example-high-school.example-sub.workers.dev')
  assert.throws(() => workersDevOrigin('https://example.test', 'example-high-school'))
})

test('bootstrap creates a placeholder only for a Worker that does not exist', async (t) => {
  const { root, repo } = await fixture(t)
  const missing = fakeWrangler({ exists: false })
  const receipt = await bootstrapWorker({ target: 'high-school', evidenceDirectory: join(root, 'ev-a'), run: missing.run, repoRoot: repo })
  assert.equal(receipt.workerName, 'example-high-school')
  assert.equal(missing.state.calls.filter((args) => args[0] === 'deploy').length, 1)
  const existing = fakeWrangler({ exists: true })
  await assert.rejects(bootstrapWorker({ target: 'high-school', evidenceDirectory: join(root, 'ev-b'), run: existing.run, repoRoot: repo }), /already exists/)
  assert.equal(existing.state.calls.filter((args) => args[0] === 'deploy').length, 0)
})

test('upload records the version and Preview URL without changing the active deployment', async (t) => {
  const { root, output, receiptSha256 } = await fixture(t)
  const fake = fakeWrangler()
  const result = await uploadVersion({ packageRoot: output, expectedReceiptSha256: receiptSha256, evidenceDirectory: join(root, 'ev'), run: fake.run })
  assert.equal(result.versionId, VERSION)
  assert.equal(result.previewUrl, PREVIEW)
  assert.deepEqual(result.activeDeployment.versions, [{ versionId: 'old-version', percentage: 100 }])
  const bad = fakeWrangler({ annotations: { 'workers/tag': 'other' } })
  await assert.rejects(uploadVersion({ packageRoot: output, expectedReceiptSha256: receiptSha256, evidenceDirectory: join(root, 'ev-bad'), run: bad.run }),
    /annotations differ/)
})

test('deploy requires a passed observation of the same version, then reads back 100%', async (t) => {
  const { root, output, receiptSha256 } = await fixture(t)
  const fake = fakeWrangler()
  const evidence = join(root, 'ev')
  await uploadVersion({ packageRoot: output, expectedReceiptSha256: receiptSha256, evidenceDirectory: evidence, run: fake.run })
  const observation = { format: 'school-workers-http-observation', status: 'failed', failed: 1, packageReceiptSha256: receiptSha256,
    versionId: VERSION, baseUrl: PREVIEW }
  await fs.writeFile(join(root, 'failed.json'), canonical(observation))
  await assert.rejects(deployVersion({ packageRoot: output, expectedReceiptSha256: receiptSha256, evidenceDirectory: evidence,
    observationPath: join(root, 'failed.json'), run: fake.run }), /no passed Preview observation/)
  await fs.writeFile(join(root, 'other.json'), canonical({ ...observation, status: 'passed', failed: 0, versionId: '99999999-2222-4333-8444-555555555555' }))
  await assert.rejects(deployVersion({ packageRoot: output, expectedReceiptSha256: receiptSha256, evidenceDirectory: evidence,
    observationPath: join(root, 'other.json'), run: fake.run }), /no passed Preview observation/)
  assert.equal(fake.state.calls.filter((args) => args[0] === 'versions' && args[1] === 'deploy').length, 0)
  const passed = canonical({ ...observation, status: 'passed', failed: 0 })
  await fs.writeFile(join(root, 'passed.json'), passed)
  const result = await deployVersion({ packageRoot: output, expectedReceiptSha256: receiptSha256, evidenceDirectory: evidence,
    observationPath: join(root, 'passed.json'), run: fake.run })
  assert.equal(result.versionId, VERSION)
  assert.deepEqual(result.rollback.versions, [{ versionId: 'old-version', percentage: 100 }])
  assert.equal(result.workersDevUrl, 'https://example-high-school.example-sub.workers.dev')
  assert.equal(result.message, `accept ${result.message.split(' ')[1]} obs=${sha(Buffer.from(passed)).slice(0, 12)}`)
  // The bindings of the accepted version were read back (they equal ASSETS + env.json secrets) right before the deploy.
  const deployAt = fake.state.calls.findIndex(isCall('versions', 'deploy'))
  assert.deepEqual(fake.state.calls[deployAt - 1], ['versions', 'view', VERSION, '--name', 'example-high-school', '--json'])
})

const passedObservation = (receiptSha256, versionId = VERSION, baseUrl = PREVIEW) =>
  canonical({ format: 'school-workers-http-observation', status: 'passed', failed: 0, packageReceiptSha256: receiptSha256, versionId, baseUrl })

test('deploy stops before any intent when the version lacks the secrets in env.json (2026-09-29) or has other bindings', async (t) => {
  const { root, output, receiptSha256 } = await fixture(t)
  await fs.writeFile(join(root, 'passed.json'), passedObservation(receiptSha256))
  const cases = [
    // 2026-09-29: the uploaded version had only ASSETS, the observation of every file passed, and it went live.
    ['ev-a', [{ name: 'ASSETS', type: 'assets' }], /missing: EXAMPLE_KEY:secret_text,EXAMPLE_URL:secret_text; extra: none/],
    ['ev-b', [...FULL_BINDINGS.slice(0, 2), { name: 'EXAMPLE_URL', type: 'plain_text' }, { name: 'OTHER_KEY', type: 'secret_text' }],
      /missing: EXAMPLE_URL:secret_text; extra: EXAMPLE_URL:plain_text,OTHER_KEY:secret_text/],
  ]
  for (const [name, bindings, pattern] of cases) {
    const fake = fakeWrangler({ bindings })
    const evidence = join(root, name)
    await uploadVersion({ packageRoot: output, expectedReceiptSha256: receiptSha256, evidenceDirectory: evidence, run: fake.run })
    await assert.rejects(deployVersion({ packageRoot: output, expectedReceiptSha256: receiptSha256, evidenceDirectory: evidence,
      observationPath: join(root, 'passed.json'), run: fake.run }), (error) => pattern.test(error.message) && /env\.json/.test(error.message))
    await assert.rejects(fs.lstat(join(evidence, 'deploy-intent.json')), { code: 'ENOENT' })
    assert.equal(deployCalls(fake.state), 0)
    assert.deepEqual(fake.state.active, [{ version_id: 'old-version', percentage: 100 }])
  }
  assert.equal(bindingDifference({ resources: { bindings: [...FULL_BINDINGS, FULL_BINDINGS[0]] } }, ['EXAMPLE_KEY', 'EXAMPLE_URL']),
    'missing: none; extra: ASSETS:assets')
  assert.equal(bindingDifference({}, []), 'missing: ASSETS:assets; extra: none')
})

test('an assets-only deploy keeps its behaviour and does not read version bindings', async (t) => {
  const root = await tempRoot(t)
  const repo = await fakeRepo(root)
  const portal = await fakeSchoolDirectory(root)
  const output = join(root, 'portal-package')
  const { receiptSha256 } = await buildWorkersPackage({ target: 'school', candidateRoot: portal, outputRoot: output, repoRoot: repo })
  const preview = 'https://1a2b3c4d-example-school.example-sub.workers.dev'
  const fake = fakeWrangler({ bindings: [], preview })
  const evidence = join(root, 'ev')
  await uploadVersion({ packageRoot: output, expectedReceiptSha256: receiptSha256, evidenceDirectory: evidence, run: fake.run })
  const viewsAfterUpload = fake.state.calls.filter(isCall('versions', 'view')).length
  await fs.writeFile(join(root, 'passed.json'), passedObservation(receiptSha256, VERSION, preview))
  const result = await deployVersion({ packageRoot: output, expectedReceiptSha256: receiptSha256, evidenceDirectory: evidence,
    observationPath: join(root, 'passed.json'), run: fake.run })
  assert.equal(result.workersDevUrl, 'https://example-school.example-sub.workers.dev')
  assert.equal(fake.state.calls.filter(isCall('versions', 'view')).length, viewsAfterUpload)
  assert.equal(deployCalls(fake.state), 1)
})

const DEPLOYED = '22222222-3333-4444-8555-666666666666'
const PATCHED = '33333333-4444-4555-8666-777777777777'

/**
 * Fake Wrangler for `versions secret bulk`: records the secret file contents it saw, never the network. The patched
 * version gets ASSETS plus the secret names it was given (or `patchedBindings`); other versions have ASSETS only.
 */
function fakeSecretWrangler({ latest = DEPLOYED, etagChanges = false, active = DEPLOYED, patchedBindings = null } = {}) {
  const state = { calls: [], seenSecrets: null, seenFile: null, active: [{ version_id: active, percentage: 100 }], annotations: {} }
  const run = async (args, { logDirectory, label }) => {
    state.calls.push(args)
    await fs.writeFile(join(logDirectory, `${label}.stdout.log`), '', { flag: 'wx' })
    const [command, sub] = args
    if (command === 'deployments') return { code: 0, stdout: JSON.stringify({ id: 'd', versions: state.active }), stderr: '' }
    if (command === 'versions' && sub === 'list') {
      return { code: 0, stdout: JSON.stringify([{ id: 'placeholder', number: 1 }, { id: latest, number: 2 }]), stderr: '' }
    }
    if (command === 'versions' && sub === 'secret') {
      state.seenFile = args[3]
      state.seenSecrets = JSON.parse(await fs.readFile(args[3], 'utf8'))
      state.annotations = { 'workers/tag': args[args.indexOf('--tag') + 1], 'workers/message': args[args.indexOf('--message') + 1] }
      return { code: 0, stdout: `Success! Created version ${PATCHED} with 2 secrets.`, stderr: '' }
    }
    if (command === 'versions' && sub === 'view') {
      const patched = args[2] === PATCHED
      const secretBindings = Object.keys(state.seenSecrets ?? {}).map((name) => ({ name, type: 'secret_text' }))
      return { code: 0, stdout: JSON.stringify({ id: args[2], annotations: patched ? state.annotations : {},
        resources: { script: { etag: patched && etagChanges ? 'other' : 'same-code' },
          bindings: patched ? patchedBindings ?? [{ name: 'ASSETS', type: 'assets' }, ...secretBindings] : [{ name: 'ASSETS', type: 'assets' }] } }), stderr: '' }
    }
    if (command === 'versions' && sub === 'deploy') {
      state.active = [{ version_id: args[2].split('@')[0], percentage: 100 }]
      return { code: 0, stdout: '', stderr: '' }
    }
    throw new Error(`unexpected wrangler call ${args.join(' ')}`)
  }
  return { run, state }
}

async function secretFixture(t) {
  const base = await fixture(t)
  const baseEvidence = join(base.root, 'ev-base')
  await fs.mkdir(baseEvidence)
  await fs.writeFile(join(baseEvidence, 'deploy-receipt.json'), canonical({ format: 'school-workers-deploy', workerName: 'example-high-school',
    packageReceiptSha256: base.receiptSha256, versionId: DEPLOYED, workersDevUrl: 'https://example-high-school.example-sub.workers.dev' }))
  return { ...base, baseEvidence, tmp: await fs.mkdtemp(join(base.root, 'tmp-')) }
}

test('secrets create a Preview version of the same code with only the named secrets, and remove the value file', async (t) => {
  const { root, output, receiptSha256, baseEvidence, tmp } = await secretFixture(t)
  const fake = fakeSecretWrangler()
  const secrets = { EXAMPLE_URL: 'https://example.test', EXAMPLE_KEY: 'synthetic-value' }
  const result = await secretsVersion({ packageRoot: output, expectedReceiptSha256: receiptSha256, evidenceDirectory: join(root, 'ev-secrets'),
    baseEvidenceDirectory: baseEvidence, secrets, run: fake.run, tmpDirectory: tmp })
  assert.equal(result.versionId, PATCHED)
  assert.equal(result.previewUrl, 'https://33333333-example-high-school.example-sub.workers.dev')
  assert.deepEqual(result.secretNames, ['EXAMPLE_KEY', 'EXAMPLE_URL'])
  assert.equal(result.baseReceipt, 'deploy-receipt.json')
  assert.equal(result.baseVersionId, DEPLOYED)
  assert.deepEqual(fake.state.seenSecrets, secrets)
  assert.deepEqual(await fs.readdir(tmp), [])
  const saved = await fs.readFile(join(root, 'ev-secrets/upload-receipt.json'), 'utf8')
  assert.ok(!saved.includes('synthetic-value') && !(await fs.readFile(join(root, 'ev-secrets/secrets-intent.json'), 'utf8')).includes('synthetic-value'))
  assert.equal(fake.state.calls.filter((args) => args[0] === 'versions' && args[1] === 'deploy').length, 0)
})

test('secrets refuse to patch when the latest upload is not the deployed version or the code changes', async (t) => {
  const { root, output, receiptSha256, baseEvidence, tmp } = await secretFixture(t)
  const secrets = { EXAMPLE_URL: 'https://example.test', EXAMPLE_KEY: 'synthetic-value' }
  const stale = fakeSecretWrangler({ latest: PATCHED })
  await assert.rejects(secretsVersion({ packageRoot: output, expectedReceiptSha256: receiptSha256, evidenceDirectory: join(root, 'ev-a'),
    baseEvidenceDirectory: baseEvidence, secrets, run: stale.run, tmpDirectory: tmp }), /latest uploaded version is not the deployed one/)
  assert.equal(stale.state.seenSecrets, null)
  const changed = fakeSecretWrangler({ etagChanges: true })
  await assert.rejects(secretsVersion({ packageRoot: output, expectedReceiptSha256: receiptSha256, evidenceDirectory: join(root, 'ev-b'),
    baseEvidenceDirectory: baseEvidence, secrets, run: changed.run, tmpDirectory: tmp }), /code differs/)
  assert.deepEqual(await fs.readdir(tmp), [])
  await assert.rejects(secretsVersion({ packageRoot: output, expectedReceiptSha256: receiptSha256, evidenceDirectory: join(root, 'ev-c'),
    baseEvidenceDirectory: baseEvidence, secrets: { lower: 'x' }, run: fakeSecretWrangler().run, tmpDirectory: tmp }), /names or values/)
})

test('secrets refuse a name set that differs from the package env.json before calling Wrangler', async (t) => {
  const { root, output, receiptSha256, baseEvidence, tmp } = await secretFixture(t)
  const cases = [
    ['ev-subset', { EXAMPLE_URL: 'https://example.test' }, /secret names differ from the package env\.json \(missing: EXAMPLE_KEY; extra: none\)/],
    ['ev-superset', { EXAMPLE_URL: 'https://example.test', EXAMPLE_KEY: 'synthetic-value', OTHER_KEY: 'synthetic-other' },
      /\(missing: none; extra: OTHER_KEY\)/],
  ]
  for (const [name, secrets, pattern] of cases) {
    const fake = fakeSecretWrangler()
    await assert.rejects(secretsVersion({ packageRoot: output, expectedReceiptSha256: receiptSha256, evidenceDirectory: join(root, name),
      baseEvidenceDirectory: baseEvidence, secrets, run: fake.run, tmpDirectory: tmp }),
    (error) => pattern.test(error.message) && !error.message.includes('synthetic-'))
    assert.deepEqual(fake.state.calls, [])
  }
  assert.deepEqual(await fs.readdir(tmp), [])
})

const UPLOAD_EVIDENCE = 'ev-upload'
const SECRETS = { EXAMPLE_URL: 'https://example.test', EXAMPLE_KEY: 'synthetic-value' }

/** A real upload of the package (Preview only; the active deployment stays on 'old-version'), without a deploy receipt. */
async function uploadedFixture(t) {
  const base = await fixture(t)
  const baseEvidence = join(base.root, UPLOAD_EVIDENCE)
  await uploadVersion({ packageRoot: base.output, expectedReceiptSha256: base.receiptSha256, evidenceDirectory: baseEvidence,
    run: fakeWrangler({ bindings: [{ name: 'ASSETS', type: 'assets' }] }).run })
  return { ...base, baseEvidence, tmp: await fs.mkdtemp(join(base.root, 'tmp-')) }
}

test('before the first deploy, secrets patch the latest upload of the package, and that version can be observed and deployed', async (t) => {
  const { root, output, receiptSha256, baseEvidence, tmp } = await uploadedFixture(t)
  const fake = fakeSecretWrangler({ active: 'old-version', latest: VERSION })
  const evidence = join(root, 'ev-secrets')
  const result = await secretsVersion({ packageRoot: output, expectedReceiptSha256: receiptSha256, evidenceDirectory: evidence,
    baseEvidenceDirectory: baseEvidence, secrets: SECRETS, run: fake.run, tmpDirectory: tmp })
  assert.equal(result.versionId, PATCHED)
  assert.equal(result.baseVersionId, VERSION)
  assert.equal(result.baseReceipt, 'upload-receipt.json')
  assert.equal(result.previewUrl, 'https://33333333-example-high-school.example-sub.workers.dev')
  assert.deepEqual(result.activeDeployment.versions, [{ versionId: 'old-version', percentage: 100 }])
  assert.deepEqual(fake.state.seenSecrets, SECRETS)
  assert.deepEqual(await fs.readdir(tmp), [])
  assert.equal(deployCalls(fake.state), 0)
  await fs.writeFile(join(root, 'passed.json'), passedObservation(receiptSha256, PATCHED, result.previewUrl))
  const deployed = await deployVersion({ packageRoot: output, expectedReceiptSha256: receiptSha256, evidenceDirectory: evidence,
    observationPath: join(root, 'passed.json'), run: fake.run })
  assert.equal(deployed.versionId, PATCHED)
  assert.equal(deployed.workersDevUrl, 'https://example-high-school.example-sub.workers.dev')
  assert.deepEqual(fake.state.active, [{ version_id: PATCHED, percentage: 100 }])
})

test('secrets from an upload refuse another package, a stale base, a reused evidence directory and incomplete bindings', async (t) => {
  const { root, output, receiptSha256, baseEvidence, tmp } = await uploadedFixture(t)
  const attempt = (fake, evidenceDirectory, baseEvidenceDirectory = baseEvidence) => secretsVersion({ packageRoot: output, expectedReceiptSha256: receiptSha256,
    evidenceDirectory, baseEvidenceDirectory, secrets: SECRETS, run: fake.run, tmpDirectory: tmp })
  const stale = fakeSecretWrangler({ active: 'old-version', latest: PATCHED })
  await assert.rejects(attempt(stale, join(root, 'ev-a')), /latest uploaded version is not the base upload/)
  assert.equal(stale.state.seenSecrets, null)
  const reused = fakeSecretWrangler({ active: 'old-version', latest: VERSION })
  await assert.rejects(attempt(reused, baseEvidence), /new, empty evidence directory/)
  assert.deepEqual(reused.state.calls, [])
  const empty = join(root, 'ev-empty-base')
  await fs.mkdir(empty)
  await assert.rejects(attempt(fakeSecretWrangler(), join(root, 'ev-b'), empty), /neither a deploy receipt nor an upload receipt/)
  const other = join(root, 'ev-other-base')
  await fs.mkdir(other)
  const upload = JSON.parse(await fs.readFile(join(baseEvidence, 'upload-receipt.json'), 'utf8'))
  await fs.writeFile(join(other, 'upload-receipt.json'), canonical({ ...upload, packageReceiptSha256: 'f'.repeat(64) }))
  await assert.rejects(attempt(fakeSecretWrangler(), join(root, 'ev-c'), other), /base upload receipt does not match the package/)
  const partial = fakeSecretWrangler({ active: 'old-version', latest: VERSION, patchedBindings: FULL_BINDINGS.slice(0, 2) })
  await assert.rejects(attempt(partial, join(root, 'ev-d')), /new version bindings differ from the package env\.json \(missing: EXAMPLE_URL:secret_text; extra: none\)/)
  assert.deepEqual(await fs.readdir(tmp), [])
})
