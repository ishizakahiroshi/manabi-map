import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { buildWorkersPackage, canonical, sha } from './workers-package.mjs'
import { bootstrapWorker, deployVersion, parseUploadOutput, secretsVersion, uploadVersion, versionLabels, workersDevOrigin } from './workers-publish.mjs'
import { fakeHighSchoolCandidate, fakeRepo, tempRoot } from './workers-fixture.test-helper.mjs'

const VERSION = '11111111-2222-4333-8444-555555555555'
const PREVIEW = 'https://1a2b3c4d-example-high-school.example-sub.workers.dev'

/** Fake Wrangler: records calls and keeps a tiny deployment state. Never touches the network. */
function fakeWrangler({ exists = true, annotations = null } = {}) {
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
      return { code: 0, stdout: `Worker Version ID: ${VERSION}\nVersion Preview URL: ${PREVIEW}\n`, stderr: '' }
    }
    if (command === 'versions' && sub === 'view') {
      const value = annotations ?? { 'workers/tag': state.uploaded.tag, 'workers/message': state.uploaded.message }
      return { code: 0, stdout: JSON.stringify({ id: VERSION, annotations: value }), stderr: '' }
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
})

const DEPLOYED = '22222222-3333-4444-8555-666666666666'
const PATCHED = '33333333-4444-4555-8666-777777777777'

/** Fake Wrangler for `versions secret bulk`: records the secret file contents it saw, never the network. */
function fakeSecretWrangler({ latest = DEPLOYED, etagChanges = false } = {}) {
  const state = { calls: [], seenSecrets: null, seenFile: null, active: [{ version_id: DEPLOYED, percentage: 100 }], annotations: {} }
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
      return { code: 0, stdout: JSON.stringify({ id: args[2], annotations: patched ? state.annotations : {},
        resources: { script: { etag: patched && etagChanges ? 'other' : 'same-code' },
          bindings: [{ name: 'ASSETS', type: 'assets' }, ...(patched ? [{ name: 'EXAMPLE_KEY', type: 'secret_text' }, { name: 'EXAMPLE_URL', type: 'secret_text' }] : [])] } }), stderr: '' }
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
