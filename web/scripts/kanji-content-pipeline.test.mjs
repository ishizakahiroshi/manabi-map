import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { pipelineFixture } from '../src/kanji/data/pipeline.fixture.ts'
import { parseJson, prepareCandidate } from './kanji-content-pipeline.mjs'

const python = process.env.KANJI_TEST_PYTHON
const scratch = process.env.KANJI_TEST_SCRATCH
assert.ok(python && scratch, 'Set explicit KANJI_TEST_PYTHON and KANJI_TEST_SCRATCH (existing external scratch)')
const root = mkdtempSync(join(scratch, 'cli-tests-'))
const cli = fileURLToPath(new URL('./kanji-content-pipeline.mjs', import.meta.url))
const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))
const first = join(root, 'first.json'), second = join(root, 'second.json')
writeFileSync(first, JSON.stringify(pipelineFixture()))
writeFileSync(second, JSON.stringify(pipelineFixture(2)))
let sequence = 0
const output = () => join(root, 'candidate-' + sequence++)
function run(args, ok = true) {
  const result = spawnSync(process.execPath, [tsx, cli, ...args, '--python', python], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status === 0, ok, result.stderr)
  return result
}
function prepare(path, extra = [], ok = true) {
  return run(['prepare', '--input', second, '--previous', first, '--output', path, '--scratch-root', root,
    '--created-at', '2026-09-27T00:00:00Z', ...extra], ok)
}
function verify(path, ok = true) { return run(['verify', '--bundle', path], ok) }
const digest = (raw) => createHash('sha256').update(raw).digest('hex')

test('CLI roundtrip, independent common-validator readback and deterministic rerun', () => {
  const a = output(), b = output()
  prepare(a); prepare(b); verify(a)
  for (const name of readdirSync(a)) assert.deepEqual(readFileSync(join(a, name)), readFileSync(join(b, name)))
  const manifest = JSON.parse(readFileSync(join(a, 'manifest.json')))
  assert.equal(manifest.service, 'kanji')
  assert.equal(manifest.counts.characters, 3)
  const files = Object.fromEntries(manifest.artifacts.map((entry) => [entry.path, readFileSync(join(a, entry.path)).toString('base64')]))
  const program = 'import base64,json,sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); import source_manifest; r=json.load(sys.stdin); source_manifest.validate(r["manifest"],{k:base64.b64decode(v) for k,v in r["files"].items()},expected_service="kanji"); print("common validator readback passed")'
  const result = spawnSync(python, ['-B', '-c', program, fileURLToPath(new URL('../../scripts/local-data', import.meta.url))], { input: JSON.stringify({ manifest, files }), encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(readFileSync(join(a, 'dataset.json')))
  assert.equal(payload.dataset.characters.length, manifest.counts.characters)
  assert.equal(payload.datasetVersion, manifest.dataset_version)
  for (const entry of manifest.artifacts) assert.equal(digest(readFileSync(join(a, entry.path))), entry.sha256)
  const diff = JSON.parse(readFileSync(join(a, 'diff.json')))
  assert.deepEqual(diff.characters, { added: ['U+56DB'], changed: ['U+4E00'], excluded: ['U+4E8C'] })
  assert.equal(diff.stateChanges.length, 2)
  console.log('Synthetic CLI evidence: ' + root)
})

test('created_at changes manifest only; first generation has no previous artifact', () => {
  const a = output(), b = output()
  for (const [target, stamp] of [[a, '2026-09-27T00:00:00Z'], [b, '2026-09-28T00:00:00Z']]) {
    run(['prepare', '--input', first, '--output', target, '--scratch-root', root, '--created-at', stamp])
  }
  assert.deepEqual(readFileSync(join(a, 'dataset.json')), readFileSync(join(b, 'dataset.json')))
  assert.deepEqual(readFileSync(join(a, 'diff.json')), readFileSync(join(b, 'diff.json')))
  assert.notDeepEqual(readFileSync(join(a, 'manifest.json')), readFileSync(join(b, 'manifest.json')))
  assert.equal(existsSync(join(a, 'previous.json')), false)
})

for (const field of ['bytes', 'counts', 'version', 'service', 'code', 'diff-with-rehashed-artifact', 'content-with-rehashed-artifact']) test('rejects tampering: ' + field, () => {
  const target = output(); prepare(target)
  const path = join(target, 'manifest.json')
  const manifest = JSON.parse(readFileSync(path))
  if (field === 'bytes') writeFileSync(join(target, 'dataset.json'), '{}')
  else if (field === 'counts') manifest.counts.characters++
  else if (field === 'version') manifest.source_version = 'different'
  else if (field === 'service') manifest.service = 'school'
  else if (field === 'code') manifest.code.sha256 = '0'.repeat(64)
  else {
    const name = field.startsWith('diff') ? 'diff.json' : 'dataset.json'
    const value = JSON.parse(readFileSync(join(target, name)))
    if (name === 'diff.json') value.characters.excluded = []
    else value.dataset.profiles = []
    const bytes = JSON.stringify(value) + '\n'
    writeFileSync(join(target, name), bytes)
    manifest.artifacts.find((entry) => entry.path === name).sha256 = digest(bytes)
  }
  writeFileSync(path, JSON.stringify(manifest)); verify(target, false)
})

test('refuses existing populated and empty output without deleting or modifying it', () => {
  const target = output(); prepare(target)
  const before = readdirSync(target).map((name) => readFileSync(join(target, name)).toString('base64'))
  prepare(target, [], false)
  assert.deepEqual(readdirSync(target).map((name) => readFileSync(join(target, name)).toString('base64')), before)
  const empty = output(); mkdirSync(empty); prepare(empty, [], false)
  assert.deepEqual(readdirSync(empty), [])
})

test('rejects malformed JSON, duplicate keys, invalid UTF8 and missing/extra flags before output', () => {
  for (const raw of ['{', '{"dataset":{},"dataset":{}}', Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d])]) {
    const bad = join(root, 'bad.json'); writeFileSync(bad, raw)
    const target = output()
    run(['prepare', '--input', bad, '--output', target, '--scratch-root', root], false)
    assert.equal(existsSync(target), false)
  }
  assert.throws(() => parseJson(Buffer.from('{"a":1,"\\u0061":2}')), /Duplicate/)
  run(['prepare'], false)
  prepare(output(), ['--unknown', 'x'], false)
})

test('schema failures and invalid timestamps leave no output', () => {
  const bad = join(root, 'bad-schema.json')
  writeFileSync(bad, JSON.stringify({ ...pipelineFixture(), profiles: [] }))
  const target = output()
  run(['prepare', '--input', bad, '--output', target, '--scratch-root', root], false)
  assert.equal(existsSync(target), false)
  const badTime = output()
  run(['prepare', '--input', first, '--output', badTime, '--scratch-root', root, '--created-at', '2026-02-30T00:00:00Z'], false)
  assert.equal(existsSync(badTime), false)
})

test('forbids implicit or repository output and incomplete/extra-file candidates', () => {
  const webRoot = dirname(dirname(cli))
  run(['prepare', '--input', first, '--output', join(webRoot, 'never-created-candidate'), '--scratch-root', webRoot], false)
  const target = output(); prepare(target)
  writeFileSync(join(target, 'unexpected.txt'), 'synthetic')
  verify(target, false)
  const partial = output(); mkdirSync(partial)
  cpSync(join(target, 'dataset.json'), join(partial, 'dataset.json'))
  verify(partial, false)
})

test('concurrent prepares have one winner and preserve its complete candidate', async () => {
  const { spawn } = await import('node:child_process')
  const target = output()
  const launch = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [tsx, cli, 'prepare', '--input', first, '--output', target, '--scratch-root', root, '--python', python], { stdio: 'ignore', windowsHide: true })
    child.on('exit', resolve)
  })
  const codes = (await Promise.all([launch(), launch()])).sort()
  assert.deepEqual(codes, [0, 1]); verify(target)
})

test('bridge failure cannot leave a completed candidate', () => {
  const target = output()
  assert.throws(() => prepareCandidate({ input: first, output: target, scratchRoot: root, python: join(root, 'nonexistent-python') }))
  assert.equal(existsSync(target), false)
})

test('partial write failure removes only this execution files and never leaves a manifest', (context) => {
  const target = output()
  const original = fs.writeFileSync
  let writes = 0
  context.mock.method(fs, 'writeFileSync', (fd, value, ...args) => {
    if (typeof fd === 'number' && ++writes === 2) {
      original(fd, 'partial')
      throw new Error('Invented disk failure')
    }
    return original(fd, value, ...args)
  })
  syncBuiltinESMExports()
  try {
    assert.throws(() => prepareCandidate({ input: first, output: target, scratchRoot: root, python }), /Invented disk failure/)
    assert.equal(existsSync(target), false)
  } finally { context.mock.restoreAll(); syncBuiltinESMExports() }
})
