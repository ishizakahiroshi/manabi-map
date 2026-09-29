import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { buildWorkersPackage, canonical, sha } from './workers-package.mjs'
import { bootstrapWorker, deployVersion, parseUploadOutput, uploadVersion, versionLabels, workersDevOrigin } from './workers-publish.mjs'
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
