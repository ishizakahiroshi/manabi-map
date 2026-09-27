import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assessInventory, validateTargets, verifyDeploymentCapacity, ASSET_BYTE_LIMIT } from './verify-deployment-capacity.mjs'

const directory = { origin: 'https://schools.example.invalid', pagesProject: 'synthetic-directory', outputDirectory: 'dist-directory', kind: 'school-directory' }
const school = { origin: 'https://high.example.invalid', pagesProject: 'synthetic-high', outputDirectory: 'dist-high', kind: 'high-school-app' }
const config = () => ({ formatVersion: 1, targets: { school: { ...directory }, 'high-school': { ...school } } })
const entry = (path, bytes = 10) => ({ path, bytes })
const schoolFiles = (count) => [entry('index.html'), entry('schools-manifest.json'), ...Array.from({ length: count - 2 }, (_, i) => entry(`school/${i}/index.html`))]

test('file count is per output: exact budget accepted and one extra rejected', () => {
  assert.equal(assessInventory(schoolFiles(20_000), school).valid, true)
  const rejected = assessInventory(schoolFiles(20_001), school)
  assert.equal(rejected.valid, false)
  assert.equal(rejected.remainingFiles, -1)
})

test('another 5000 schools with HTML and JSON exceed the current 11718-file scenario', () => {
  const files = schoolFiles(11_718)
  for (let i = 0; i < 5000; i++) files.push(entry(`elementary-school/${i}/index.html`), entry(`elementary-data/${i}.json`))
  const report = assessInventory(files, school)
  assert.equal(report.fileCount, 21_718)
  assert.equal(report.valid, false)
})

test('below asset limit passes while exact limit and one byte over fail closed', () => {
  const files = schoolFiles(2)
  assert.equal(assessInventory([...files, entry('api/v1/schools.json', ASSET_BYTE_LIMIT - 1)], school).valid, true)
  for (const size of [ASSET_BYTE_LIMIT, ASSET_BYTE_LIMIT + 1]) {
    assert.equal(assessInventory([...files, entry('api/v1/schools.json', size)], school).valid, false)
  }
})

test('portal allows its UI assets but refuses school payloads and Functions', () => {
  const files = [entry('index.html'), entry('assets/entry-a1.js'), entry('assets/entry-a1.css'), entry('favicon.ico')]
  assert.equal(assessInventory(files, directory).valid, true)
  for (const path of ['school/abc/index.html', 'school-data/abc.json', 'schools-manifest.json', 'api/v1/schools.json', 'assets/schools.json', '_worker.js', 'functions/_middleware.ts']) {
    assert.equal(assessInventory([...files, entry(path)], directory).valid, false, path)
  }
})

test('source secrets and other app directories cannot become high-school assets', () => {
  for (const path of ['.env.local', '.git/config', '.git-credentials', '.npmrc', '.netrc', '.pypirc', 'private.sql', 'assets/private.key', 'source.sqlite', 'node_modules/module/index.js', 'kanji/index.html', 'school-portal/index.html', 'Kanji/index.html', 'SCHOOL-PORTAL/index.html']) {
    assert.equal(assessInventory([...schoolFiles(2), entry(path)], school).valid, false, path)
  }
})

test('empty/incomplete outputs and case-colliding paths are rejected', () => {
  assert.equal(assessInventory([], directory).valid, false)
  assert.equal(assessInventory([entry('index.html')], school).valid, false)
  assert.equal(assessInventory([entry('index.html'), entry('INDEX.HTML')], directory).valid, false)
})

test('budgets and inventory are validated before reporting', () => {
  for (const maxFiles of [NaN, 0, -1, 1.5]) assert.throws(() => assessInventory([], directory, { maxFiles }))
  for (const path of ['../index.html', '/index.html', 'assets\\index.js', 'assets//file.js']) assert.throws(() => assessInventory([entry(path)], directory))
  assert.throws(() => assessInventory([entry('index.html', -1)], directory))
  assert.throws(() => assessInventory([], { kind: 'unknown' }))
})

test('distinct hostnames alone do not permit a shared Pages project/output', () => {
  for (const key of ['origin', 'pagesProject', 'outputDirectory']) {
    const shared = config()
    shared.targets.school[key] = shared.targets['high-school'][key]
    assert.throws(() => validateTargets(shared), /distinct/)
  }
  assert.deepEqual(validateTargets(config())['high-school'], school)
})

test('target origins require HTTPS without path and output names cannot escape', () => {
  for (const origin of ['https://schools.example.invalid/high-school/', 'http://schools.example.invalid', 'https://schools.example.invalid/']) {
    const invalid = config(); invalid.targets.school.origin = origin
    assert.throws(() => validateTargets(invalid))
  }
  const invalid = config(); invalid.targets.school.outputDirectory = '../dist'
  assert.throws(() => validateTargets(invalid))
})

test('80 percent warning does not replace the hard budget', () => {
  const report = assessInventory(schoolFiles(8), school, { maxFiles: 10 })
  assert.equal(report.valid, true)
  assert.equal(report.warnings.length, 1)
  assert.equal(report.remainingFiles, 2)
})

test('real output is read without modification; CLI fails on contamination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'synthetic-pages-capacity-'))
  try {
    const output = join(root, 'output'); await mkdir(output)
    await writeFile(join(output, 'index.html'), '<h1>Synthetic directory</h1>')
    const path = join(root, 'targets.json'); await writeFile(path, JSON.stringify(config()))
    const report = await verifyDeploymentCapacity({ distDir: output, targetId: 'school', config: config() })
    assert.equal(report.valid, true)
    assert.equal(report.fileCount, 1)
    assert.equal(await readFile(join(output, 'index.html'), 'utf8'), '<h1>Synthetic directory</h1>')
    await writeFile(join(output, 'schools-manifest.json'), '{}')
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./verify-deployment-capacity.mjs', import.meta.url)), '--config', path, '--dist', output, '--target', 'school'], { encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 1)
    assert.equal(JSON.parse(result.stdout).valid, false)
    await assert.rejects(verifyDeploymentCapacity({ distDir: output, targetId: 'missing', config: config() }))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('directory junctions/symlinks cannot hide files from inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'synthetic-pages-links-'))
  try {
    const output = join(root, 'output'); const data = join(root, 'data')
    await mkdir(output); await mkdir(data)
    await writeFile(join(output, 'index.html'), 'synthetic')
    await writeFile(join(data, 'record.json'), '{}')
    await symlink(data, join(output, 'assets'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(verifyDeploymentCapacity({ distDir: output, targetId: 'school', config: config() }), /Linked/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
