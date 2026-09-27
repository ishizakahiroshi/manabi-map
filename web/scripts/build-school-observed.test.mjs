// Entirely fabricated files and public config. No Vite build or live sources.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import syncFS from 'node:fs'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { canonicalSchoolSourceJSON, SNAPSHOT_COLUMNS, SOURCE_TABLES, LIVE_CODE_FILES } from './lib/school-source.mjs'
import { schoolResourceBudget } from './lib/school-resource-budget.mjs'
import { parseObservedBuildArgs, observedBuildEnvironment, observedBuildCommands, verifyObservedBuildInput, buildSchoolObserved, observedBuildFailure } from './build-school-observed.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const canonical = (value) => `${canonicalSchoolSourceJSON(value)}\n`
const publicConfig = { VITE_SUPABASE_URL: 'https://invented-project.supabase.invalid', VITE_SUPABASE_ANON_KEY: 'sb_publishable_invented_only_0000000000' }
async function temporary(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'invented-observed-build-'))
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root
}
async function inventedGeneration(t) {
  const root = await temporary(t), publicRoot = join(root, 'public-data'), privateRoot = join(root, 'private-source')
  await fs.mkdir(join(publicRoot, 'api/v1'), { recursive: true }); await fs.mkdir(privateRoot)
  const payload = Buffer.from(JSON.stringify({ formatVersion: 2, schools: [], sourceCatalog: [] }))
  const fullPath = `schools-${hash(payload).slice(0, 10)}.json.gz`
  const generatedAt = '2030-01-01T00:00:00Z'
  const files = new Map([
    [fullPath, gzipSync(payload)],
    ['schools-manifest.json', Buffer.from(JSON.stringify({ generatedAt, url: `/${fullPath}` }))],
    ['api/v1/schools.json', Buffer.from(JSON.stringify({ api_version: 'v1', generated_at: generatedAt, count: 0, schools: [] }))],
  ])
  for (const [path, bytes] of files) await fs.writeFile(join(publicRoot, path), bytes)
  const rows = Buffer.from('[]\n')
  await fs.writeFile(join(privateRoot, 'rows.json'), rows)
  await fs.writeFile(join(privateRoot, 'generator-payload.json'), payload)
  const artifacts = [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: hash(bytes) })).sort((a, b) => a.path.localeCompare(b.path, 'en'))
  const code = [{ path: 'web/scripts/invented.mjs', sha256: hash('invented code') }]
  const pins = { snapshotSha256: hash('invented snapshot'), manifestSha256: hash('invented manifest'), candidateRevision: 'a'.repeat(40), generatedAt, resourceBudget: schoolResourceBudget() }
  const receipt = { format: 'observed-school-json', version: 1, evidence: 'observed', scope: 'school-json-only',
    generatedAt, candidateRevision: pins.candidateRevision,
    source: { type: 'sqlite-snapshot', snapshotSha256: pins.snapshotSha256, manifestSha256: pins.manifestSha256, rowsSha256: hash(rows), rowCount: 0 },
    generator: { files: code, sha256: hash(canonicalSchoolSourceJSON(code)) }, generatorSnapshotSha256: hash(payload),
    resourceBudget: pins.resourceBudget, artifacts, artifactsSha256: hash(canonicalSchoolSourceJSON(artifacts)), projection: { generatedAt, publicRecords: 0 } }
  await fs.writeFile(join(root, 'observed-generation.json'), canonical(receipt))
  return { root, pins, receipt, files, publicRoot, privateRoot }
}

test('observed CLI requires explicit pinned source, external output and public-only config', () => {
  const required = ['--snapshot=a', '--manifest=b', '--output-root=c', '--public-config=d', '--generation-time=2030-01-01T00:00:00Z', `--candidate-revision=${'a'.repeat(40)}`]
  assert.equal(parseObservedBuildArgs([...required, '--max-decoded-bytes=268435456'])['max-decoded-bytes'], '268435456')
  for (const args of [[], required.slice(1), [...required, '--snapshot=duplicate'], [...required, '--env-file=secret'], [...required, '--school-source=supabase']]) assert.throws(() => parseObservedBuildArgs(args))
})

test('build environment permits explicit public anon config but cannot inherit secrets or source selection', () => {
  const env = observedBuildEnvironment(publicConfig, '1.0.0', {
    Path: 'invented-runtime', NODE_OPTIONS: '--require=secret', MANABI_MAP_ENV_DIR: 'secret-folder',
    VITE_SUPABASE_URL: 'ambient', VITE_SUPABASE_ANON_KEY: 'ambient-secret', VITE_SCHOOLS_SOURCE: 'supabase', SUPABASE_SERVICE_ROLE_KEY: 'private',
  })
  assert.equal(env.Path, 'invented-runtime'); assert.equal(env.VITE_SUPABASE_URL, publicConfig.VITE_SUPABASE_URL)
  assert.equal(env.VITE_SUPABASE_ANON_KEY, publicConfig.VITE_SUPABASE_ANON_KEY)
  assert.equal(env.VITE_SCHOOLS_SOURCE, 'static')
  for (const key of ['NODE_OPTIONS', 'MANABI_MAP_ENV_DIR', 'SUPABASE_SERVICE_ROLE_KEY']) assert.equal(env[key], undefined)
  const jwt = (role) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.inventedsignature`
  assert.equal(observedBuildEnvironment({ ...publicConfig, VITE_SUPABASE_ANON_KEY: jwt('anon') }, '1.0.0').VITE_SUPABASE_ANON_KEY, jwt('anon'))
  for (const config of [{ ...publicConfig, VITE_SUPABASE_ANON_KEY: jwt('service_role') }, { ...publicConfig, VITE_SUPABASE_ANON_KEY: 'sb_secret_invented_0000000000000' },
    { ...publicConfig, VITE_SUPABASE_URL: 'https://user:pass@example.com' }, { ...publicConfig, VITE_OTHER_KEY: 'private' }]) assert.throws(() => observedBuildEnvironment(config, '1.0.0'))
})

test('command plan uses the current Vite origin and normal SEO guard without DB/fetch/install chains', () => {
  const commands = observedBuildCommands({ generation: '/invented/generation', snapshot: '/invented/snapshot.json', manifest: '/invented/manifest.json',
    output: '/invented/dist', revision: 'a'.repeat(40), generatedAt: '2030-01-01T00:00:00Z', maximum: 1073741824, decoded: 268435456 })
  assert.deepEqual(commands.map((c) => c.phase), ['generation', 'client', 'ssr', 'seo', 'static'])
  assert.ok(commands[0].args.includes('--school-source=sqlite-snapshot'))
  assert.ok(commands[0].args.includes('--max-decoded-bytes=268435456'))
  assert.deepEqual(commands[1].args.slice(0, 3), ['build', '--config', 'vite.config.ts'])
  assert.ok(!JSON.stringify(commands).includes('synthetic-candidate'))
  assert.ok(!JSON.stringify(commands).includes('supabase'))
  assert.ok(!JSON.stringify(commands).includes('pnpm'))
})

test('only exact public receipt artifacts are selected; private evidence is never returned as a public file', async (t) => {
  const fixture = await inventedGeneration(t)
  const result = await verifyObservedBuildInput(fixture.root, fixture.pins)
  assert.deepEqual([...result.files.keys()].sort(), [...fixture.files.keys()].sort())
  assert.ok([...result.files.keys()].every((path) => !path.includes('private-source')))
  await fs.writeFile(join(fixture.publicRoot, 'snapshot.json'), 'invented private data')
  await assert.rejects(verifyObservedBuildInput(fixture.root, fixture.pins))
})

test('generation verification refuses changed bytes, pins, private capture or cross-scope receipt', async (t) => {
  for (const kind of ['public', 'private', 'pin', 'scope', 'budget', 'duplicate']) {
    const fixture = await inventedGeneration(t), pins = { ...fixture.pins }
    if (kind === 'public') await fs.appendFile(join(fixture.publicRoot, 'api/v1/schools.json'), ' ')
    if (kind === 'private') await fs.appendFile(join(fixture.privateRoot, 'rows.json'), ' ')
    if (kind === 'pin') pins.snapshotSha256 = '0'.repeat(64)
    if (kind === 'scope') { fixture.receipt.source.type = 'supabase'; await fs.writeFile(join(fixture.root, 'observed-generation.json'), canonical(fixture.receipt)) }
    if (kind === 'budget') pins.resourceBudget = schoolResourceBudget({ maxDecodedBytes: 128 * 1024 * 1024 })
    if (kind === 'duplicate') await fs.writeFile(join(fixture.root, 'observed-generation.json'), canonical(fixture.receipt).replace('"version":1', '"version":1,"version":1'))
    await assert.rejects(verifyObservedBuildInput(fixture.root, pins), kind)
  }
})

test('missing observed input fails before build or output creation and CLI diagnostics stay generic', async (t) => {
  const root = await temporary(t), output = join(root, 'output')
  await assert.rejects(buildSchoolObserved({ snapshot: join(root, 'missing'), manifest: join(root, 'manifest'), 'public-config': join(root, 'config'), 'output-root': output }))
  await assert.rejects(fs.stat(output), { code: 'ENOENT' })
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./build-school-observed.mjs', import.meta.url)), '--unknown=invented-private-value'], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 1); assert.equal(result.stdout, '')
  assert.ok(!result.stderr.includes('invented-private-value'))
  assert.deepEqual(JSON.parse(result.stderr.trim().split('\n').at(-1)), { status: 'failed', code: 'OBSERVED_BUILD_ARGUMENTS', phase: 'arguments', complete: false })
  assert.deepEqual(observedBuildFailure(Object.assign(new Error('invented secret'), { phase: 'private path', code: 'credential' })),
    { status: 'failed', code: 'OBSERVED_BUILD_FAILED', phase: 'unknown', complete: false })
})

test('mocked build executes isolated phases in order and copies only public generation files', async (t) => {
  // Subprocesses are mocked. This verifies orchestration, not real Vite/SEO acceptance.
  const fixture = await inventedGeneration(t), root = await temporary(t), input = join(root, 'input')
  let output = join(root, 'output'), fault = null
  await fs.mkdir(input)
  const snapshot = { format: 'school-source-snapshot', format_version: 1, schema_version: 3, synthetic: false,
    dataset_version: 'invented', source_version: 'invented', tables: Object.fromEntries(Object.keys(SNAPSHOT_COLUMNS).map((key) => [key, []])) }
  const snapshotRaw = Buffer.from(canonical(snapshot))
  const code = LIVE_CODE_FILES.map((path) => ({ path, sha256: hash('invented') }))
  const manifest = { format: 'school-source-manifest', format_version: 1, schema_version: 3, synthetic: false,
    dataset_version: 'invented', source_version: 'invented', created_at: fixture.pins.generatedAt,
    table_counts: Object.fromEntries(SOURCE_TABLES.map((key) => [key, 0])), snapshot_sha256: hash(snapshotRaw),
    content_sha256: hash(canonicalSchoolSourceJSON(snapshot)), code: { identity: 'sha256', files: code, sha256: hash(canonicalSchoolSourceJSON(code)) } }
  const manifestRaw = Buffer.from(canonical(manifest))
  await fs.writeFile(join(input, 'snapshot.json'), snapshotRaw)
  await fs.writeFile(join(input, 'manifest.json'), manifestRaw)
  await fs.writeFile(join(input, 'public.json'), JSON.stringify(publicConfig))
  fixture.receipt.source.snapshotSha256 = hash(snapshotRaw); fixture.receipt.source.manifestSha256 = hash(manifestRaw)
  await fs.writeFile(join(fixture.root, 'observed-generation.json'), canonical(fixture.receipt))
  const phases = []
  t.mock.method(childProcess, 'execFileSync', (executable, args, options) => {
    if (executable === 'git') return 'web/package.json\0web/vite.config.ts\0web/data/site.json\0'
    assert.ok(args[0].startsWith('--max-old-space-size='))
    assert.equal(options.env.VITE_SCHOOLS_SOURCE, 'static')
    assert.equal(options.env.NODE_OPTIONS, undefined)
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe'])
    assert.ok(options.timeout > 0)
    const phase = args.includes('scripts/gen-schools-json.mjs') ? 'generation' : args.includes('--ssr') ? 'ssr' :
      basename(args[1]) === 'vite.js' ? 'client' : args.includes('scripts/gen-seo-pages.mjs') ? 'seo' : 'static'
    if (fault === phase) throw Object.assign(new Error('invented private child message'), {
      stdout: Buffer.from('invented private stdout'), stderr: Buffer.from('invented private stderr'), path: 'invented private path',
    })
    if (args.includes('scripts/gen-schools-json.mjs')) {
      phases.push('generation')
      const generation = args.find((arg) => arg.startsWith('--output-root=')).slice('--output-root='.length)
      syncFS.cpSync(fixture.root, generation, { recursive: true })
      if (fault === 'junction') {
        const parent = join(output, 'source/web/public'), victim = join(root, 'victim')
        syncFS.mkdirSync(victim)
        syncFS.renameSync(parent, join(output, 'retained-public'))
        syncFS.symlinkSync(victim, parent, process.platform === 'win32' ? 'junction' : 'dir')
      }
    } else if (basename(args[1]) === 'vite.js' && !args.includes('--ssr')) {
      phases.push('client')
      syncFS.cpSync(join(output, 'generation/public-data'), join(output, 'dist'), { recursive: true })
      syncFS.writeFileSync(join(output, 'dist/index.html'), '<!doctype html><title>Invented fixture</title>')
    } else if (args.includes('--ssr')) phases.push('ssr')
    else if (args.includes('scripts/gen-seo-pages.mjs')) phases.push('seo')
    else if (basename(args[1]) === 'verify-static-output.mjs') phases.push('static')
    else assert.fail('unexpected command')
    return Buffer.from('invented subprocess output must not be printed')
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const receipt = await buildSchoolObserved({ snapshot: join(input, 'snapshot.json'), manifest: join(input, 'manifest.json'),
    'public-config': join(input, 'public.json'), 'output-root': output,
    'generation-time': fixture.pins.generatedAt, 'candidate-revision': fixture.pins.candidateRevision })
  assert.deepEqual(phases, ['generation', 'client', 'ssr', 'seo', 'static'])
  assert.equal(receipt.deploymentPerformed, false)
  assert.ok(receipt.publicArtifacts.every((entry) => !/private|snapshot|source\//.test(entry.path)))
  assert.equal(receipt.publicArtifacts.length, fixture.files.size + 1)
  await assert.rejects(fs.stat(join(output, 'source/web/public/private-source')), { code: 'ENOENT' })
  assert.equal(JSON.parse(await fs.readFile(join(output, 'observed-build.json'))).generationReceiptSha256, hash(canonical(fixture.receipt)))
  for (const phase of ['generation', 'client', 'ssr', 'seo', 'static']) {
    await t.test(`fixed ${phase} failure excludes all child diagnostics`, async () => {
      fault = phase; output = join(root, `failed-${phase}`)
      await assert.rejects(buildSchoolObserved({ snapshot: join(input, 'snapshot.json'), manifest: join(input, 'manifest.json'),
        'public-config': join(input, 'public.json'), 'output-root': output,
        'generation-time': fixture.pins.generatedAt, 'candidate-revision': fixture.pins.candidateRevision }), error => {
        assert.deepEqual(observedBuildFailure(error), { status: 'failed', code: 'OBSERVED_BUILD_CHILD_FAILED', phase, complete: false })
        assert.doesNotMatch(error.message, /private/)
        assert.equal(error.cause, undefined)
        return true
      })
      await assert.rejects(fs.stat(join(output, 'observed-build.json')), { code: 'ENOENT' })
    })
  }
  await t.test('ancestor junction replacement is rejected before copying public artifacts', async () => {
    fault = 'junction'; output = join(root, 'junction')
    await assert.rejects(buildSchoolObserved({ snapshot: join(input, 'snapshot.json'), manifest: join(input, 'manifest.json'),
      'public-config': join(input, 'public.json'), 'output-root': output,
      'generation-time': fixture.pins.generatedAt, 'candidate-revision': fixture.pins.candidateRevision }), error => {
      assert.equal(observedBuildFailure(error).phase, 'public-copy'); return true
    })
    assert.deepEqual(await fs.readdir(join(root, 'victim')), [])
    await assert.rejects(fs.stat(join(output, 'observed-build.json')), { code: 'ENOENT' })
  })
})
