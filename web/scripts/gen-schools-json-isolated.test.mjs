import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import test from 'node:test'
import { generateSchoolCandidate, main } from './gen-schools-json.mjs'
import { checkedPath, stageSchoolCandidate, verifySchoolCandidate } from './lib/school-candidate.mjs'
import { SNAPSHOT_COLUMNS, SOURCE_TABLES, REQUIRED_CODE_FILES, canonicalSchoolSourceJSON, snapshotToGeneratorRows, buildSchoolPayload } from './lib/school-source.mjs'
import { buildMapPayload } from '../src/lib/mapPayload.ts'
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'), repoRoot = dirname(webRoot)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fixedDate = '2026-09-27T00:00:00+00:00'
async function fixture(root, change = () => {}) {
  const source = JSON.parse(await fs.readFile(join(repoRoot, 'scripts/local-data/example.school.synthetic.json'), 'utf8'))
  const tables = Object.fromEntries(Object.entries(SNAPSHOT_COLUMNS).map(([table, columns]) => [table, source.tables[table].map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null])))]))
  for (const school of tables.schools) {
    school.prefecture = '東京都'; school.city = '千代田区'; school.address = '東京都千代田区 合成住所'
    for (const field of ['latitude', 'longitude']) if (school[field] !== null) school[field] = Number(school[field])
  }
  const snapshot = { format: 'school-source-snapshot', format_version: 1, schema_version: 3, synthetic: true, dataset_version: source.dataset_version, source_version: source.source_version, tables }
  change(snapshot)
  const bytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`)
  const files = REQUIRED_CODE_FILES.map((path) => ({ path, sha256: hash('explicitly synthetic exporter identity') }))
  const manifest = { format: 'school-source-manifest', format_version: 1, schema_version: 3, synthetic: true,
    dataset_version: snapshot.dataset_version, source_version: snapshot.source_version, created_at: fixedDate,
    table_counts: Object.fromEntries(SOURCE_TABLES.map((table) => [table, snapshot.tables[table]?.length ?? source.tables[table]?.length ?? 0])),
    content_sha256: hash(canonicalSchoolSourceJSON(snapshot)), snapshot_sha256: hash(bytes), code: { identity: 'sha256', files, sha256: hash(canonicalSchoolSourceJSON(files)) } }
  const input = join(root, 'input'); await fs.mkdir(input)
  const snapshotPath = join(input, 'snapshot.json'), manifestPath = join(input, 'manifest.json')
  await fs.writeFile(snapshotPath, bytes); await fs.writeFile(manifestPath, JSON.stringify(manifest))
  return { snapshotPath, manifestPath, snapshot }
}
async function temporary(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'synthetic-school-candidate-'))
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root
}
async function missing(path) { await assert.rejects(fs.lstat(path), { code: 'ENOENT' }) }
const cli = (...args) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/gen-schools-json.mjs', ...args], { cwd: webRoot, encoding: 'utf8' })

test('import is inert despite invalid CLI arguments and disabled fetch', () => {
  const code = `globalThis.fetch = () => { throw new Error('network forbidden') }; process.argv.push('--invalid'); await import('./scripts/gen-schools-json.mjs'); console.log('imported')`
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: webRoot, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'imported')
})
test('isolated fixture preserves full/map/detail/partition/API and deterministic receipt', async (t) => {
  const root = await temporary(t), input = await fixture(root), output = join(root, 'candidate')
  const publicInfo = await fs.stat(join(webRoot, 'public')), publicNames = await fs.readdir(join(webRoot, 'public'))
  t.mock.method(globalThis, 'fetch', () => { throw new Error('network forbidden') })
  const receipt = await generateSchoolCandidate({ ...input, outputRoot: output })
  assert.equal(receipt.scope, 'school-json-only'); assert.equal(receipt.synthetic, true); assert.equal(receipt.generatedAt, fixedDate)
  assert.deepEqual(await verifySchoolCandidate(output), receipt)
  assert.deepEqual(await generateSchoolCandidate({ ...input, outputRoot: join(root, 'again') }), receipt)
  const manifest = JSON.parse(await fs.readFile(join(output, 'schools-manifest.json')))
  const rows = snapshotToGeneratorRows(input.snapshot), payload = buildSchoolPayload(rows)
  const readGz = async (url) => JSON.parse(gunzipSync(await fs.readFile(join(output, url.replace(/^\//, '')))))
  assert.deepEqual(await readGz(manifest.url), payload)
  assert.deepEqual(await readGz(manifest.mapUrl), buildMapPayload(payload.schools))
  assert.equal(manifest.count, rows.length); assert.equal(manifest.schoolDataCount, rows.length)
  for (const row of rows) assert.equal(JSON.parse(await fs.readFile(join(output, 'school-data', `${row.id}.json`))).schools[0].id, row.id)
  assert.ok(Object.keys(manifest.prefDataUrls).length > 0); assert.ok(Object.keys(manifest.prefIndexUrls).length > 0)
  for (const entry of receipt.artifacts) assert.equal(hash(await fs.readFile(join(output, entry.path))), entry.sha256)
  const api = JSON.parse(await fs.readFile(join(output, 'api/v1/schools.json')))
  assert.equal(api.count, rows.filter((row) => row.official_url).length); assert.equal(api.generated_at, fixedDate)
  assert.ok(api.schools.every((row) => !('school_deviation_values' in row) && !('status_note' in row)))
  assert.deepEqual(await fs.readdir(join(webRoot, 'public')), publicNames); assert.equal((await fs.stat(join(webRoot, 'public'))).mtimeMs, publicInfo.mtimeMs)
})
test('existing output, repo destinations and input containment are refused', async (t) => {
  const root = await temporary(t), input = await fixture(root), empty = join(root, 'empty'), file = join(root, 'file')
  await fs.mkdir(empty); await fs.writeFile(file, 'competitor')
  for (const outputRoot of [empty, file, join(webRoot, 'public', 'candidate'), join(repoRoot, 'scripts', 'candidate'), join(dirname(input.snapshotPath), 'candidate'), root]) await assert.rejects(generateSchoolCandidate({ ...input, outputRoot }))
  assert.equal(await fs.readFile(file, 'utf8'), 'competitor'); assert.deepEqual(await fs.readdir(empty), [])
})
test('links, network paths and drive-relative paths are rejected', async (t) => {
  const root = await temporary(t), input = await fixture(root), target = join(root, 'target'), link = join(root, 'linked')
  await fs.mkdir(target); await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(generateSchoolCandidate({ ...input, outputRoot: join(link, 'candidate') }))
  const hard = join(root, 'hard.json'); await fs.link(input.snapshotPath, hard)
  await assert.rejects(generateSchoolCandidate({ ...input, snapshotPath: hard, outputRoot: join(root, 'candidate') }))
  for (const path of ['C:relative', '\\\\synthetic-host\\share\\candidate', '//synthetic-host/share/candidate', '\\\\?\\C:\\candidate']) await assert.rejects(checkedPath(path, { missing: true }))
})
test('corrupt pairs, unknown prefectures and unsafe IDs leave no candidate', async (t) => {
  for (const change of [(s) => { s.synthetic = false }, (s) => { s.tables.schools[0].prefecture = '合成県' }, (s) => { s.tables.schools[0].id = '../../escape' }]) {
    const root = await temporary(t), input = await fixture(root, change), output = join(root, 'candidate')
    await assert.rejects(generateSchoolCandidate({ ...input, outputRoot: output })); await missing(output)
    assert.deepEqual((await fs.readdir(root)).filter((name) => name.startsWith('.school-candidate-')), [])
  }
})
test('verification rejects missing, extra, altered artifacts and malformed receipts', async (t) => {
  const root = await temporary(t), input = await fixture(root), output = join(root, 'candidate')
  const receipt = await generateSchoolCandidate({ ...input, outputRoot: output })
  const artifact = join(output, receipt.artifacts[0].path), original = await fs.readFile(artifact)
  await fs.writeFile(artifact, Buffer.concat([original, Buffer.from(' ')])); await assert.rejects(verifySchoolCandidate(output))
  await fs.writeFile(artifact, original); await fs.unlink(artifact); await assert.rejects(verifySchoolCandidate(output)); await fs.writeFile(artifact, original)
  const extra = join(output, 'unexpected.json'); await fs.writeFile(extra, '{}'); await assert.rejects(verifySchoolCandidate(output)); await fs.unlink(extra)
  const manifest = join(output, 'candidate-manifest.json'), before = await fs.readFile(manifest)
  await fs.writeFile(manifest, before.toString().replace('"synthetic":true', '"synthetic":true,"synthetic":true')); await assert.rejects(verifySchoolCandidate(output))
  await fs.writeFile(manifest, before); await fs.unlink(manifest); await assert.rejects(verifySchoolCandidate(output))
})
function stageOptions(root, build) {
  const files = [{ path: 'web/synthetic.mjs', sha256: hash('synthetic') }]
  return { outputRoot: join(root, 'candidate'), inputPaths: [join(root, 'input', 'snapshot.json')], protectedRoot: repoRoot,
    metadata: { datasetVersion: 'synthetic-v1', sourceVersion: 'synthetic-v1', generatedAt: fixedDate, source: { snapshotSha256: hash('snapshot'), manifestSha256: hash('manifest'), contentSha256: hash('content') } },
    generator: { files, sha256: hash(canonicalSchoolSourceJSON(files)) }, build }
}
async function simpleBuild(stage) {
  await fs.mkdir(join(stage, 'api')); await fs.writeFile(join(stage, 'api/data.json'), '{}')
  await fs.writeFile(join(stage, 'schools-manifest.json'), JSON.stringify({ generatedAt: fixedDate }))
}
test('build failure recovers private stage without complete output', async (t) => {
  const root = await temporary(t)
  await assert.rejects(stageSchoolCandidate(stageOptions(root, async (stage) => { await simpleBuild(stage); throw new Error('injected build failure') })), /injected build failure/)
  await missing(join(root, 'candidate')); assert.deepEqual(await fs.readdir(root), [])
})
test('publish failure preserves a competing file', async (t) => {
  const root = await temporary(t), options = stageOptions(root, simpleBuild), originalOpen = fs.open
  t.mock.method(fs, 'open', async (path, ...args) => {
    if (path === join(options.outputRoot, 'api/data.json')) await fs.writeFile(path, 'competitor')
    return originalOpen(path, ...args)
  })
  await assert.rejects(stageSchoolCandidate(options), { code: 'EEXIST' })
  assert.equal(await fs.readFile(join(options.outputRoot, 'api/data.json'), 'utf8'), 'competitor'); await missing(join(options.outputRoot, 'candidate-manifest.json'))
})
test('competing directory is never adopted or removed', async (t) => {
  const root = await temporary(t), options = stageOptions(root, simpleBuild), originalMkdir = fs.mkdir
  t.mock.method(fs, 'mkdir', async (path, ...args) => { if (path === join(options.outputRoot, 'api')) await originalMkdir(path); return originalMkdir(path, ...args) })
  await assert.rejects(stageSchoolCandidate(options), { code: 'EEXIST' })
  assert.deepEqual(await fs.readdir(join(options.outputRoot, 'api')), []); await missing(join(options.outputRoot, 'candidate-manifest.json'))
})
test('replaced output identity is refused and replacement remains untouched', async (t) => {
  const root = await temporary(t), options = stageOptions(root, simpleBuild), originalMkdir = fs.mkdir
  t.mock.method(fs, 'mkdir', async (path, ...args) => {
    const result = await originalMkdir(path, ...args)
    if (path === join(options.outputRoot, 'api')) { await fs.rename(options.outputRoot, join(root, 'moved-owned')); await originalMkdir(options.outputRoot); await fs.writeFile(join(options.outputRoot, 'competitor.txt'), 'keep') }
    return result
  })
  await assert.rejects(stageSchoolCandidate(options)); assert.equal(await fs.readFile(join(options.outputRoot, 'competitor.txt'), 'utf8'), 'keep')
  assert.deepEqual(await fs.readdir(options.outputRoot), ['competitor.txt'])
})
test('identity capture failure preserves original error and unclaimed directory', async (t) => {
  const root = await temporary(t), options = stageOptions(root, simpleBuild), originalLstat = fs.lstat
  let fail = true
  t.mock.method(fs, 'lstat', async (path, ...args) => { const info = await originalLstat(path, ...args); if (path === options.outputRoot && fail) { fail = false; throw new Error('injected identity failure') } return info })
  await assert.rejects(stageSchoolCandidate(options), /injected identity failure/); assert.deepEqual(await fs.readdir(options.outputRoot), [])
})
test('replaced private stage is not recursively removed', async (t) => {
  const root = await temporary(t); let replaced
  await assert.rejects(stageSchoolCandidate(stageOptions(root, async (stage) => {
    replaced = stage; await fs.rename(stage, join(root, 'moved-stage')); await fs.mkdir(stage); await fs.writeFile(join(stage, 'competitor.txt'), 'keep'); throw new Error('stage replaced')
  })), /stage replaced/)
  assert.equal(await fs.readFile(join(replaced, 'competitor.txt'), 'utf8'), 'keep')
})
test('CLI requires isolation and reports completion only after offline verification', async (t) => {
  const root = await temporary(t), input = await fixture(root), output = join(root, 'candidate')
  const args = ['--school-source=snapshot', `--snapshot=${input.snapshotPath}`, `--snapshot-manifest=${input.manifestPath}`]
  const noOutput = cli(...args); assert.equal(noOutput.status, 1); assert.equal(noOutput.stdout, ''); assert.ok(!noOutput.stderr.includes(root))
  const good = cli(...args, `--output-root=${output}`); assert.equal(good.status, 0, good.stderr); assert.equal(JSON.parse(good.stdout).status, 'generated'); await verifySchoolCandidate(output)
  await assert.rejects(main(['--school-source=supabase', `--output-root=${join(root, 'forbidden')}`]))
  await assert.rejects(main([...args, `--output-root=${output}`, `--output-root=${output}`]))
})


test('case-variant UUIDs and uppercase inactive predecessors are rejected before writes', async (t) => {
  for (const inactive of [false, true]) {
    const root = await temporary(t)
    const input = await fixture(root, (snapshot) => {
      const clone = structuredClone(snapshot.tables.schools[0])
      clone.id = 'ABCDEF00-0000-4000-8000-000000000099'
      clone.is_active = !inactive
      snapshot.tables.schools.push(clone)
      if (!inactive) snapshot.tables.schools.push({ ...clone, id: clone.id.toLowerCase() })
    })
    await assert.rejects(generateSchoolCandidate({ ...input, outputRoot: join(root, 'candidate') }), /canonical lowercase UUID/)
    await missing(join(root, 'candidate'))
  }
})
