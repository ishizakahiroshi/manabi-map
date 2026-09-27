import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkBeacon, hasBeaconScript } from './smoke-beacon.mjs'

const script = '<script defer src="https://static.cloudflareinsights.com/beacon.min.js/v123abc" data-cf-beacon=\'{"token":"synthetic"}\'></script>'

test('recognizes injected script with attribute order and quote variants', () => {
  assert.equal(hasBeaconScript(script), true)
  assert.equal(hasBeaconScript("<SCRIPT SRC='https://static.cloudflareinsights.com/beacon.min.js' defer></SCRIPT>"), true)
  assert.equal(hasBeaconScript('<script src=https://static.cloudflareinsights.com/beacon.min.js></script>'), true)
})

test('words in prose, attributes and comments do not establish injection', () => {
  for (const html of ['cloudflareinsights beacon.min.js', `<a title='${script}'>link</a>`, `<!-- ${script} -->`, `<!-- ${script}`]) {
    assert.equal(hasBeaconScript(html), false, html)
  }
})

test('inert containers and raw text cannot masquerade as executable scripts', () => {
  for (const tag of ['template', 'noscript', 'textarea', 'title', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext', 'svg', 'math']) {
    assert.equal(hasBeaconScript(`<${tag}>${script}</${tag}>`), false, tag)
  }
  assert.equal(hasBeaconScript(`<script>const example = '${script}'</script>`), false)
  assert.equal(hasBeaconScript(`<template>${script}</template>${script}`), true)
  assert.equal(hasBeaconScript(`<template></noscript>${script}</template>`), false)
  assert.equal(hasBeaconScript(`<svg/>${script}`), true)
  assert.equal(hasBeaconScript(`<math/>${script}`), true)
  assert.equal(hasBeaconScript(`<svg><svg/>${script}</svg>`), false)
  assert.equal(hasBeaconScript(`<math><math/>${script}</math>`), false)
})

test('rejects lookalike hosts, paths and non-executable script types', () => {
  const userinfo = new URL('https://static.cloudflareinsights.com/beacon.min.js')
  userinfo.username = 'synthetic'
  for (const src of [
    'https://example.com/beacon.min.js', 'https://static.cloudflareinsights.com.example.com/beacon.min.js',
    'https://static.cloudflareinsights.com/other.js', 'http://static.cloudflareinsights.com/beacon.min.js',
    userinfo.href,
  ]) assert.equal(hasBeaconScript(`<script src="${src}"></script>`), false, src)
  assert.equal(hasBeaconScript(script.replace('<script ', '<script type="application/ld+json" ')), false)
  assert.equal(hasBeaconScript(script.replace('<script ', '<script nomodule ')), false)
  assert.equal(hasBeaconScript(script.replace('<script ', '<script language="vbscript" ')), false)
  assert.equal(hasBeaconScript(script.replace('<script ', '<script src="https://example.com/other.js" ')), false)
})

test('requests browser HTML and validates successful responses containing script', async () => {
  const size = await checkBeacon('https://example.test/', async (url, init) => {
    assert.equal(url, 'https://example.test/')
    assert.match(init.headers['user-agent'], /Chrome/)
    assert.match(init.headers.accept, /text\/html/)
    assert.equal(init.redirect, 'follow')
    return new Response(script, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  })
  assert.equal(size, script.length)
  await assert.rejects(checkBeacon('https://example.test/', async () => new Response(script, { status: 404 })), /HTTP 404/)
  await assert.rejects(checkBeacon('https://example.test/', async () => new Response('cloudflareinsights', { headers: { 'content-type': 'text/html' } })), /not found/)
  for (const mime of ['application/json', 'text/plain', '']) {
    await assert.rejects(checkBeacon('https://example.test/', async () => new Response(script, { headers: { 'content-type': mime } })), /not HTML/)
  }
  await assert.rejects(checkBeacon('https://example.test/', async () => { throw new Error('synthetic network failure') }), /synthetic network failure/)
})

test('CLI reports failure for marker-only HTML and success for actual script without network', () => {
  const executable = fileURLToPath(new URL('./smoke-beacon.mjs', import.meta.url))
  for (const [html, expected] of [['cloudflareinsights documentation only', 1], [script, 0]]) {
    const result = spawnSync(process.execPath, [executable, '--url', `data:text/html,${encodeURIComponent(html)}`], { encoding: 'utf8' })
    assert.equal(result.status, expected, result.stderr)
  }
})
