import test from 'node:test'
import assert from 'node:assert/strict'
import { createSchoolFunctionsPackage } from './school-functions-package.mjs'

function input() { return { files: new Map([
  ['index.html', Buffer.from('<!doctype html><title>Synthetic</title>')],
  ['_headers', Buffer.from('/*\n  X-Content-Type-Options: nosniff')],
  ['_routes.json', Buffer.from(JSON.stringify({ version: 1, include: ['/*'], exclude: ['/api/v1/*'] }))],
]), worker: Buffer.from('export default {fetch(){return new Response("synthetic")}}'),
bindingsSha256: 'a'.repeat(64), sourceRevision: 'b'.repeat(40) } }

test('full distribution snapshots bind Functions, routing and bindings and expose only copies', () => {
  const value = input(), pkg = createSchoolFunctionsPackage(value), pin = pkg.pin
  value.worker.fill(0); value.files.get('index.html').fill(0)
  const first = pkg.snapshot(pin)
  assert.match(first.worker.toString(), /export default/)
  assert.match(first.files.get('index.html').toString(), /Synthetic/)
  first.files.get('index.html').fill(0); first.worker.fill(0)
  assert.match(pkg.snapshot(pin).worker.toString(), /export default/)
  assert.throws(() => pkg.snapshot('c'.repeat(64)), /unpinned/)
})

test('private files, links as paths, Functions source, maps and invalid routes cannot enter upload inventory', () => {
  for (const path of ['.env', '../secret.txt', 'source.sqlite', 'assets/main.js.map', 'functions/index.ts', 'functions/index.js', 'functions/index.mjs', 'scripts/server.js', 'src/server.js', 'backup.json', 'x\\a.js', '_worker.js']) {
    const value = input(); value.files.set(path, Buffer.from('synthetic'))
    assert.throws(() => createSchoolFunctionsPackage(value), /distribution/)
  }
  const value = input(); value.files.set('_routes.json', Buffer.from('{"version":1,"include":[],"exclude":[]}'))
  assert.throws(() => createSchoolFunctionsPackage(value), /distribution/)
})

test('HTTP observation status, path, redirect origins and expected Location are independently pinned', () => {
  const value = input()
  value.files.set('legacy.html', Buffer.from('synthetic legacy bytes'))
  value.observations = new Map([
    ['index.html', { path: '/retired', status: 410 }],
    ['legacy.html', { path: '/legacy', status: 301, location: 'https://school.example.invalid/new/#' }],
  ])
  value.redirectOrigins = ['https://school.example.invalid']
  const pkg = createSchoolFunctionsPackage(value), frozen = pkg.snapshot(pkg.pin)
  assert.equal(JSON.parse(frozen.raw).version, 2)
  assert.equal(frozen.observations['index.html'].body, 'artifact')
  assert.equal(frozen.observations['legacy.html'].body, 'redirect')
  value.observations.get('index.html').status = 404
  frozen.observations['legacy.html'].location = 'https://other.example.invalid/'
  assert.equal(pkg.snapshot(pkg.pin).observations['index.html'].status, 410)
  assert.notEqual(createSchoolFunctionsPackage(value).pin, pkg.pin)
})

test('HTTP observation rejects unknown paths, duplicate URLs, unsafe redirects and school-data contract changes', () => {
  const authenticatedURL = new URL('https://school.example.invalid/')
  authenticatedURL.username = 'synthetic-user'
  authenticatedURL.password = 'synthetic-password'
  for (const overrides of [
    new Map([['missing.html', { path: '/missing', status: 404 }]]),
    new Map([['_routes.json', { path: '/routes', status: 200 }]]),
    new Map([['index.html', { path: '//outside.example.invalid/', status: 410 }]]),
    new Map([['index.html', { path: '/%2Foutside', status: 410 }]]),
    new Map([['index.html', { path: '/', status: 301, location: 'https://outside.example.invalid/' }]]),
    new Map([['index.html', { path: '/', status: 301, location: authenticatedURL.href }]]),
    new Map([['index.html', { path: '/', status: 301, location: 'https://school.example.invalid/?token=synthetic' }]]),
    new Map([['schools-manifest.json', { path: '/other', status: 200 }]]),
    new Map([['schools-manifest.json', { path: '/schools-manifest.json', status: 410 }]]),
    new Map([['other.html', { path: '/', status: 200 }]]),
  ]) {
    const value = input(); value.files.set('schools-manifest.json', Buffer.from('{}')); value.files.set('other.html', Buffer.from('synthetic'))
    value.observations = overrides; value.redirectOrigins = ['https://school.example.invalid']
    assert.throws(() => createSchoolFunctionsPackage(value), /distribution/)
  }
})
