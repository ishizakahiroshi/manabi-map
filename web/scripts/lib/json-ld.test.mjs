import test from 'node:test'
import assert from 'node:assert/strict'
import { jsonLdScript } from './json-ld.mjs'

test('JSON-LD cannot enter escaped script states or terminate its data block', () => {
  const value = { name: '<!--<script>', description: '</ScRiPt><h1>synthetic</h1>', nested: ['<', '&', '引用"', '\u2028\u2029'] }
  const script = jsonLdScript(value)
  const data = script.slice('<script type="application/ld+json">'.length, -'</script>'.length)
  assert.equal(data.includes('<'), false)
  assert.deepEqual(JSON.parse(data), value)
  assert.equal((script.match(/<\/script>/g) ?? []).length, 1)
})

test('normal structured data retains all values', () => {
  const value = { '@context': 'https://schema.org', '@type': 'School', name: '合成学校', address: { addressLocality: '合成市' }, numberOfEmployees: 0 }
  const data = jsonLdScript(value).match(/^<script type="application\/ld\+json">(.*)<\/script>$/s)[1]
  assert.deepEqual(JSON.parse(data), value)
})
