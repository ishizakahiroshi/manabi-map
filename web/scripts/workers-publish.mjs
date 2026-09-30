// Two-stage Workers publication for a verified package:
//   bootstrap (only for a Worker that does not exist yet: a 503 placeholder, because `versions upload`
//   cannot create a Worker) → upload (`wrangler versions upload`, Preview URL) → secrets when the version
//   lacks the secrets declared in the package env.json (`wrangler versions secret bulk`, a new Preview
//   version of the same code) → HTTP acceptance (workers-observe.mjs) of the version to deploy → deploy
//   (`wrangler versions deploy` of that same version at 100%). For a Worker target, deploy first reads the
//   version's bindings and refuses unless they are exactly ASSETS plus each env.json secret.
// Wrangler runs with the caller's existing login. This script never reads, prints or stores credentials;
// the caller provides CLOUDFLARE_ACCOUNT_ID in the environment. Each step writes create-only receipts and
// Wrangler logs into an evidence directory outside the repository.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonical, readTarget, sha, verifyWorkersPackage } from './workers-package.mjs'

export const WRANGLER_VERSION = '4.131.1'
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class WorkersPublishError extends Error {}
const need = (condition, reason) => { if (!condition) throw new WorkersPublishError(reason) }

export function versionLabels(receipt, receiptSha256) {
  const source = receipt.source.revision ?? receipt.source.sourceSha256
  const tag = `c8-${source.slice(0, 7)}-${receiptSha256.slice(0, 8)}`
  const message = `${receipt.source.revision ? `rev=${receipt.source.revision}` : `src=${receipt.source.sourceSha256.slice(0, 40)}`}` +
    ` cand=${receipt.candidate.receipt.sha256.slice(0, 12)} pkg=${receiptSha256.slice(0, 12)}`
  return { tag, message }
}

export function parseUploadOutput(stdout) {
  const id = /Worker Version ID:\s*([0-9a-f-]{36})/.exec(stdout)?.[1] ?? null
  const preview = /Version Preview URL:\s*(https:\/\/[^\s]+)/.exec(stdout)?.[1] ?? null
  return { versionId: id && VERSION_ID.test(id) ? id : null, previewUrl: preview }
}

/** `https://<prefix>-<name>.<subdomain>.workers.dev` → `https://<name>.<subdomain>.workers.dev` */
export function workersDevOrigin(previewUrl, workerName) {
  const url = new URL(previewUrl)
  const match = /^[0-9a-z]+-(.+)$/.exec(url.hostname)
  need(url.protocol === 'https:' && url.hostname.endsWith('.workers.dev') && match && match[1].startsWith(`${workerName}.`),
    'unexpected Preview URL shape')
  return `https://${match[1]}`
}

const list = (values) => values.length > 0 ? values.join(',') : 'none'

/**
 * Compare a `versions view` readback with the bindings a Worker version must have: ASSETS plus each secret declared
 * in the package env.json as secret_text. Returns null when they match exactly, otherwise the missing and extra
 * bindings as `name:type` (never values).
 */
export function bindingDifference(view, secretNames) {
  const expected = ['ASSETS:assets', ...secretNames.map((name) => `${name}:secret_text`)].sort()
  const bindings = view?.resources?.bindings ?? []
  const actual = (Array.isArray(bindings) ? bindings : []).map((binding) => `${binding?.name}:${binding?.type}`).sort()
  if (canonical(actual) === canonical(expected)) return null
  const missing = expected.filter((entry) => !actual.includes(entry))
  const extra = actual.filter((entry, index) => !expected.includes(entry) || actual.indexOf(entry) !== index)
  return `missing: ${list(missing)}; extra: ${list(extra)}`
}

async function readOptionalJson(path) {
  try { return JSON.parse(await fs.readFile(path)) } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function createOnly(path, value) {
  await fs.writeFile(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value), { flag: 'wx' })
}

async function evidence(directory) {
  need(isAbsolute(directory), 'evidence directory must be absolute')
  await fs.mkdir(directory, { recursive: true })
  return resolve(directory)
}

/** Default runner: node <wrangler.js> …args, stdin closed (non-interactive), logs written create-only. */
export function wranglerRunner({ wranglerJs = process.env.WRANGLER_JS, node = process.execPath } = {}) {
  return async (args, { cwd, logDirectory, label }) => {
    need(wranglerJs && isAbsolute(wranglerJs), 'WRANGLER_JS must be an absolute path to wrangler/bin/wrangler.js')
    const packageJson = JSON.parse(await fs.readFile(resolve(wranglerJs, '../../package.json')))
    need(packageJson.name === 'wrangler' && packageJson.version === WRANGLER_VERSION, `Wrangler ${WRANGLER_VERSION} is required`)
    need(process.env.CLOUDFLARE_ACCOUNT_ID, 'CLOUDFLARE_ACCOUNT_ID must be provided by the caller')
    const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', FORCE_COLOR: '0' }
    return await new Promise((resolvePromise, reject) => {
      const child = spawn(node, [wranglerJs, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      const out = [], err = []
      child.stdout.on('data', (chunk) => out.push(chunk))
      child.stderr.on('data', (chunk) => err.push(chunk))
      child.on('error', reject)
      child.on('close', async (code) => {
        const stdout = Buffer.concat(out), stderr = Buffer.concat(err)
        try {
          await createOnly(join(logDirectory, `${label}.stdout.log`), stdout)
          await createOnly(join(logDirectory, `${label}.stderr.log`), stderr)
          resolvePromise({ code, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') })
        } catch (error) { reject(error) }
      })
    })
  }
}

async function deploymentStatus(run, name, directory, label) {
  const result = await run(['deployments', 'status', '--name', name, '--json'], { cwd: directory, logDirectory: directory, label })
  if (result.code !== 0) {
    const text = result.stdout + result.stderr
    need(/10007|does not exist|not found/i.test(text), 'deployment status read failed')
    return null
  }
  const status = JSON.parse(result.stdout)
  need(Array.isArray(status.versions), 'unexpected deployment status shape')
  return { id: status.id ?? null, createdOn: status.created_on ?? null, source: status.source ?? null,
    versions: status.versions.map((entry) => ({ versionId: entry.version_id, percentage: entry.percentage })) }
}

export async function bootstrapWorker({ target, evidenceDirectory, run = wranglerRunner(), repoRoot, now = () => new Date() }) {
  const { template } = await readTarget(target, repoRoot)
  const directory = await evidence(evidenceDirectory)
  const before = await deploymentStatus(run, template.name, directory, 'bootstrap-status-before')
  need(before === null, 'Worker already exists; bootstrap is only for a new Worker')
  const placeholder = join(directory, 'bootstrap-worker')
  await fs.mkdir(placeholder)
  const script = "export default { fetch() { return new Response('準備中です。', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } }) } }\n"
  await createOnly(join(placeholder, 'index.js'), script)
  await createOnly(join(placeholder, 'wrangler.jsonc'), { name: template.name, main: 'index.js', compatibility_date: template.compatibility_date,
    workers_dev: true, preview_urls: true, send_metrics: false })
  await createOnly(join(directory, 'bootstrap-intent.json'), { target, workerName: template.name, placeholderSha256: sha(script), createdAt: now().toISOString() })
  const deployed = await run(['deploy', '--config', join(placeholder, 'wrangler.jsonc')], { cwd: placeholder, logDirectory: directory, label: 'bootstrap-deploy' })
  need(deployed.code === 0, 'bootstrap deploy failed')
  const after = await deploymentStatus(run, template.name, directory, 'bootstrap-status-after')
  need(after && after.versions.length === 1 && after.versions[0].percentage === 100, 'bootstrap readback failed')
  const receipt = { format: 'school-workers-bootstrap', version: 1, target, workerName: template.name, placeholderSha256: sha(script),
    deployment: after, observedAt: now().toISOString() }
  await createOnly(join(directory, 'bootstrap-receipt.json'), receipt)
  return receipt
}

export async function uploadVersion({ packageRoot, expectedReceiptSha256, evidenceDirectory, run = wranglerRunner(), now = () => new Date() }) {
  const { receipt, packageRoot: root } = await verifyWorkersPackage({ packageRoot, expectedReceiptSha256 })
  const directory = await evidence(evidenceDirectory)
  const current = await deploymentStatus(run, receipt.workerName, directory, 'upload-status-before')
  need(current, 'Worker does not exist; run bootstrap first')
  const { tag, message } = versionLabels(receipt, expectedReceiptSha256)
  await createOnly(join(directory, 'upload-intent.json'), { workerName: receipt.workerName, packageReceiptSha256: expectedReceiptSha256,
    tag, message, activeDeployment: current, createdAt: now().toISOString() })
  const uploaded = await run(['versions', 'upload', '--config', join(root, 'wrangler.jsonc'), '--tag', tag, '--message', message],
    { cwd: root, logDirectory: directory, label: 'versions-upload' })
  need(uploaded.code === 0, 'versions upload failed; inspect the evidence logs, do not repeat blindly')
  const { versionId, previewUrl } = parseUploadOutput(uploaded.stdout)
  need(versionId && previewUrl, 'versions upload output lacks a version ID or Preview URL')
  const viewed = await run(['versions', 'view', versionId, '--name', receipt.workerName, '--json'], { cwd: directory, logDirectory: directory, label: 'versions-view' })
  need(viewed.code === 0, 'version readback failed')
  const view = JSON.parse(viewed.stdout)
  const annotations = view.annotations ?? view.metadata?.annotations ?? {}
  need(annotations['workers/tag'] === tag && annotations['workers/message'] === message, 'uploaded version annotations differ')
  const after = await deploymentStatus(run, receipt.workerName, directory, 'upload-status-after')
  need(canonical(after.versions) === canonical(current.versions), 'active deployment changed during a Preview upload')
  const result = { format: 'school-workers-upload', version: 1, target: receipt.target, workerName: receipt.workerName,
    packageReceiptSha256: expectedReceiptSha256, versionId, previewUrl: new URL(previewUrl).origin, tag, message,
    activeDeployment: after, uploadedAt: now().toISOString() }
  await createOnly(join(directory, 'upload-receipt.json'), result)
  return result
}

/**
 * The version `versions secret bulk` will patch (it always patches the latest uploaded version):
 *   (a) the version a base deploy receipt put at 100%, still active and the latest upload; or
 *   (b) before any deploy receipt exists in the base directory, the version of its upload receipt, which must be
 *       the latest upload but need not be active (a new Worker gets its secrets before its first real deploy).
 * Either way the base receipt must come from this package.
 */
async function secretsBase(baseEvidenceDirectory, receipt, expectedReceiptSha256) {
  const deployed = await readOptionalJson(join(baseEvidenceDirectory, 'deploy-receipt.json'))
  if (deployed) {
    need(deployed.format === 'school-workers-deploy' && deployed.workerName === receipt.workerName &&
      deployed.packageReceiptSha256 === expectedReceiptSha256 && VERSION_ID.test(deployed.versionId), 'base deploy receipt does not match the package')
    return { file: 'deploy-receipt.json', versionId: deployed.versionId, workersDevHost: new URL(deployed.workersDevUrl).hostname }
  }
  const uploaded = await readOptionalJson(join(baseEvidenceDirectory, 'upload-receipt.json'))
  need(uploaded, 'base evidence directory has neither a deploy receipt nor an upload receipt')
  need(uploaded.format === 'school-workers-upload' && uploaded.workerName === receipt.workerName &&
    uploaded.packageReceiptSha256 === expectedReceiptSha256 && VERSION_ID.test(uploaded.versionId), 'base upload receipt does not match the package')
  return { file: 'upload-receipt.json', versionId: uploaded.versionId,
    workersDevHost: new URL(workersDevOrigin(uploaded.previewUrl, receipt.workerName)).hostname }
}

/**
 * Add secrets to a version of this package without changing code or assets (`versions secret bulk` patches the
 * latest uploaded version); the base is chosen by `secretsBase`. The names must be exactly the secrets of the
 * package env.json. The result is a Preview-only version recorded like an upload, so the same observe → deploy
 * steps apply. Secret values come from the caller, go only into a temporary JSON file that is removed right after
 * Wrangler reads it, and never appear in receipts or logs (names only).
 */
export async function secretsVersion({ packageRoot, expectedReceiptSha256, evidenceDirectory, baseEvidenceDirectory, secrets, run = wranglerRunner(), now = () => new Date(), tmpDirectory = os.tmpdir() }) {
  const { receipt, envContract } = await verifyWorkersPackage({ packageRoot, expectedReceiptSha256 })
  need(receipt.worker && envContract, 'secrets require a Worker target')
  const baseVersion = await secretsBase(baseEvidenceDirectory, receipt, expectedReceiptSha256)
  const names = Object.keys(secrets ?? {}).sort()
  need(names.length > 0 && names.every((name) => /^[A-Z][A-Z0-9_]{0,63}$/.test(name) && typeof secrets[name] === 'string' &&
    secrets[name].length > 0 && secrets[name].length <= 8192), 'secret names or values rejected')
  // A version with only some of the declared secrets would always be refused at deploy, so refuse it before creating one.
  const missing = envContract.secrets.filter((name) => !names.includes(name))
  const extra = names.filter((name) => !envContract.secrets.includes(name))
  need(missing.length === 0 && extra.length === 0, `secret names differ from the package env.json (missing: ${list(missing)}; extra: ${list(extra)})`)
  const directory = await evidence(evidenceDirectory)
  // This step ends by writing upload-receipt.json and version logs here; in a used directory (such as the base)
  // that write would fail after Wrangler had already created the version, leaving it unrecorded.
  need((await fs.readdir(directory)).length === 0, 'secrets need a new, empty evidence directory (not the base one)')
  const active = await deploymentStatus(run, receipt.workerName, directory, 'secrets-status-before')
  need(active, 'Worker does not exist; run bootstrap and upload first')
  const base = baseVersion.versionId
  const fromDeploy = baseVersion.file === 'deploy-receipt.json'
  if (fromDeploy) {
    need(active.versions.length === 1 && active.versions[0].percentage === 100, 'secrets require one version at 100%')
    need(active.versions[0].versionId === base, 'the active version is not the one recorded by the base deploy receipt')
  }
  const listed = await run(['versions', 'list', '--name', receipt.workerName, '--json'], { cwd: directory, logDirectory: directory, label: 'versions-list' })
  need(listed.code === 0, 'versions list failed')
  const latest = JSON.parse(listed.stdout).reduce((top, entry) => (!top || entry.number > top.number ? entry : top), null)
  need(latest?.id === base, fromDeploy ? 'the latest uploaded version is not the deployed one; secrets would patch another version'
    : 'the latest uploaded version is not the base upload; secrets would patch another version')
  const viewBase = await run(['versions', 'view', base, '--name', receipt.workerName, '--json'], { cwd: directory, logDirectory: directory, label: 'versions-view-base' })
  need(viewBase.code === 0, 'base version readback failed')
  const baseView = JSON.parse(viewBase.stdout)
  const { tag } = versionLabels(receipt, expectedReceiptSha256)
  const secretTag = `${tag}-s`
  const message = `secrets ${names.join(',')} on ${base.slice(0, 8)} pkg=${expectedReceiptSha256.slice(0, 12)}`.slice(0, 100)
  await createOnly(join(directory, 'secrets-intent.json'), { workerName: receipt.workerName, packageReceiptSha256: expectedReceiptSha256,
    baseVersionId: base, baseReceipt: baseVersion.file, secretNames: names, tag: secretTag, message, createdAt: now().toISOString() })
  const file = join(tmpDirectory, `workers-secrets-${randomUUID()}.json`)
  let created
  try {
    await fs.writeFile(file, JSON.stringify(secrets), { flag: 'wx', mode: 0o600 })
    created = await run(['versions', 'secret', 'bulk', file, '--name', receipt.workerName, '--message', message, '--tag', secretTag],
      { cwd: directory, logDirectory: directory, label: 'versions-secret-bulk' })
  } finally {
    await fs.rm(file, { force: true })
  }
  need(created.code === 0, 'versions secret bulk failed; read the evidence logs before any retry')
  const versionId = /Created version ([0-9a-f-]{36}) with/.exec(created.stdout)?.[1]
  need(versionId && VERSION_ID.test(versionId), 'secret bulk output lacks the new version ID')
  const viewed = await run(['versions', 'view', versionId, '--name', receipt.workerName, '--json'], { cwd: directory, logDirectory: directory, label: 'versions-view' })
  need(viewed.code === 0, 'new version readback failed')
  const view = JSON.parse(viewed.stdout)
  const difference = bindingDifference(view, envContract.secrets)
  need(!difference, `new version bindings differ from the package env.json (${difference})`)
  const scriptTag = (value) => value.resources?.script?.etag ?? null
  need(scriptTag(view) && scriptTag(view) === scriptTag(baseView), 'new version code differs from the base version')
  const annotations = view.annotations ?? {}
  need(annotations['workers/tag'] === secretTag && annotations['workers/message'] === message, 'new version annotations differ')
  const after = await deploymentStatus(run, receipt.workerName, directory, 'secrets-status-after')
  need(after && canonical(after.versions) === canonical(active.versions), 'active deployment changed while creating a secret version')
  const result = { format: 'school-workers-upload', version: 1, target: receipt.target, workerName: receipt.workerName,
    packageReceiptSha256: expectedReceiptSha256, versionId, previewUrl: `https://${versionId.slice(0, 8)}-${baseVersion.workersDevHost}`,
    tag: secretTag, message, baseVersionId: base, baseReceipt: baseVersion.file, secretNames: names, activeDeployment: after,
    uploadedAt: now().toISOString() }
  await createOnly(join(directory, 'upload-receipt.json'), result)
  return result
}

export async function deployVersion({ packageRoot, expectedReceiptSha256, evidenceDirectory, observationPath, run = wranglerRunner(), now = () => new Date() }) {
  const { receipt, envContract } = await verifyWorkersPackage({ packageRoot, expectedReceiptSha256 })
  const directory = await evidence(evidenceDirectory)
  const upload = JSON.parse(await fs.readFile(join(directory, 'upload-receipt.json')))
  const observation = JSON.parse(await fs.readFile(observationPath))
  need(upload.format === 'school-workers-upload' && upload.packageReceiptSha256 === expectedReceiptSha256 &&
    upload.workerName === receipt.workerName && VERSION_ID.test(upload.versionId), 'upload receipt does not match the package')
  need(observation.format === 'school-workers-http-observation' && observation.status === 'passed' && observation.failed === 0 &&
    observation.packageReceiptSha256 === expectedReceiptSha256 && observation.versionId === upload.versionId &&
    observation.baseUrl === upload.previewUrl, 'the same version has no passed Preview observation')
  const before = await deploymentStatus(run, receipt.workerName, directory, 'deploy-status-before')
  need(before, 'Worker does not exist')
  if (envContract) {
    // 2026-09-29: a version without the Supabase secrets passed the byte-for-byte observation and went live, and
    // /api/admin/* returned 404. The observation cannot see bindings, so read them back before any deploy intent.
    const viewed = await run(['versions', 'view', upload.versionId, '--name', receipt.workerName, '--json'],
      { cwd: directory, logDirectory: directory, label: 'deploy-versions-view' })
    need(viewed.code === 0, 'version readback before deploy failed')
    const difference = bindingDifference(JSON.parse(viewed.stdout), envContract.secrets)
    need(!difference, `version ${upload.versionId} bindings differ from the package env.json (${difference}); ` +
      'create a secrets version of this package, observe it, then deploy that version')
  }
  const message = `accept ${upload.tag} obs=${sha(await fs.readFile(observationPath)).slice(0, 12)}`
  await createOnly(join(directory, 'deploy-intent.json'), { workerName: receipt.workerName, versionId: upload.versionId,
    rollback: before, message, createdAt: now().toISOString() })
  const deployed = await run(['versions', 'deploy', `${upload.versionId}@100%`, '--name', receipt.workerName, '--message', message, '--yes'],
    { cwd: directory, logDirectory: directory, label: 'versions-deploy' })
  need(deployed.code === 0, 'versions deploy failed; read deployment status before any retry')
  const after = await deploymentStatus(run, receipt.workerName, directory, 'deploy-status-after')
  need(after && after.versions.length === 1 && after.versions[0].versionId === upload.versionId && after.versions[0].percentage === 100,
    'deployment readback does not show the accepted version at 100%')
  const result = { format: 'school-workers-deploy', version: 1, target: receipt.target, workerName: receipt.workerName,
    packageReceiptSha256: expectedReceiptSha256, versionId: upload.versionId, workersDevUrl: workersDevOrigin(upload.previewUrl, receipt.workerName),
    rollback: before, deployment: after, message, deployedAt: now().toISOString() }
  await createOnly(join(directory, 'deploy-receipt.json'), result)
  return result
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [action, ...args] = process.argv.slice(2)
  try {
    let result = null
    if (action === 'bootstrap' && args.length === 2) result = await bootstrapWorker({ target: args[0], evidenceDirectory: args[1] })
    else if (action === 'upload' && args.length === 3) result = await uploadVersion({ packageRoot: args[0], expectedReceiptSha256: args[1], evidenceDirectory: args[2] })
    else if (action === 'secrets' && args.length === 5) {
      // Values are read from WORKERS_SECRET_<NAME> set by the caller; they are never printed.
      const secrets = Object.fromEntries(args[4].split(',').map((name) => [name, process.env[`WORKERS_SECRET_${name}`] ?? '']))
      result = await secretsVersion({ packageRoot: args[0], expectedReceiptSha256: args[1], evidenceDirectory: args[2],
        baseEvidenceDirectory: args[3], secrets })
    } else if (action === 'deploy' && args.length === 4) {
      result = await deployVersion({ packageRoot: args[0], expectedReceiptSha256: args[1], evidenceDirectory: args[2], observationPath: args[3] })
    }
    need(result, 'usage: workers-publish.mjs bootstrap <target> <evidence-dir> | upload <package-root> <receipt-sha256> <evidence-dir> | secrets <package-root> <receipt-sha256> <evidence-dir> <base-evidence-dir> <NAME,NAME> | deploy <package-root> <receipt-sha256> <evidence-dir> <observation-json>')
    console.log(JSON.stringify({ action, workerName: result.workerName, versionId: result.versionId ?? null, status: 'ok' }))
  } catch (error) {
    console.error(`Workers publish rejected: ${error instanceof WorkersPublishError || error?.constructor?.name === 'WorkersPackageError' ? error.message : error?.code ?? 'unexpected error'}`)
    process.exitCode = 1
  }
}
