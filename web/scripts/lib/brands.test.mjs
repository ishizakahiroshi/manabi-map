import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { brands, validateBrands, renderBrandHtml, brandManifest, escapeBrandHtml } from './brands.mjs'
import { portalWithBrands, renderEntryPage } from '../../apex-portal/portal.mjs'
import { datasetAttribution } from './public-api.mjs'

test('independent brands escape text and JSON without rewriting origins or identifiers', () => {
  const config = structuredClone(brands)
  const name = 'Synthetic long school <script> & "quoted" </script><!--\\'
  config['high-school'].name = name
  config['high-school'].displayName.ja = name
  config['high-school'].shareImage = '/icon-512.png'
  config.apex.displayName.ja = 'Synthetic independent apex & entrance'
  const source = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const html = renderBrandHtml(source, 'high-school', config)
  assert.ok(html.includes(`<title>${escapeBrandHtml(name)}｜`))
  assert.ok(html.includes('og:image" content="__SITE_ORIGIN__/icon-512.png"'))
  assert.ok(!html.includes('<script> &'))
  const script = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]
  assert.equal(JSON.parse(script).name, name)
  assert.equal(JSON.parse(script).url, '__SITE_ORIGIN__/')
  const manifest = { start_url: '/', scope: '/', icons: [{ src: '/icon.svg' }] }
  assert.deepEqual(brandManifest(manifest, config), { ...manifest, name, short_name: brands['high-school'].shortName })
  const entrance = renderBrandHtml('__BRAND_NAME__', 'school', config)
  assert.equal(entrance, brands.school.name)
  const apex = renderEntryPage('{{brand}} {{schoolBrand}} {{learningCards}}', portalWithBrands(config))
  assert.ok(apex.includes('Synthetic independent apex &amp; entrance'))
  assert.ok(apex.includes(escapeBrandHtml(name)))
  assert.ok(apex.includes('たねもじ'))
  assert.equal(brands['high-school'].name, 'Manabi Map')
})

test('brand assets and text fail closed before HTML generation', () => {
  for (const asset of ['https://example.test/a.svg', '//example.test/a.svg', '/a/../b.svg', '/a.svg?x', '/a".svg']) {
    const config = structuredClone(brands); config.school.logo = asset
    assert.throws(() => validateBrands(config), /brand asset/)
  }
  for (const text of ['', ' ', null, 'bad\ntext']) {
    const config = structuredClone(brands); config.apex.name = text
    assert.throws(() => validateBrands(config), /brand text/)
  }
})

test('dataset credit preserves replacement metacharacters and token-like brand text', () => {
  const name = 'Synthetic $& $` $\' {origin} {brand} <school>'
  const attribution = datasetAttribution({ displayName: { ja: name } }, 'https://school.example')
  assert.equal(attribution, `出典: ${name} https://school.example （CC BY-SA 4.0）`)
})

test('HTML and origin placeholders inside a brand remain literal text', () => {
  const config = structuredClone(brands)
  const name = '__BRAND_WEBSITE_JSON_LD__ __SITE_ORIGIN__ __HIGH_SCHOOL_ORIGIN__'
  config['high-school'].name = name
  config['high-school'].displayName.ja = name
  const source = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const html = renderBrandHtml(source, 'high-school', config, { SITE_ORIGIN: 'https://school.example' })
  assert.ok(html.includes(`<title>${name}｜`))
  assert.ok(html.includes('href="https://school.example/"'))
  assert.equal([...html.matchAll(/<script type="application\/ld\+json">/g)].length, 1)
  const website = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])
  assert.equal(website.name, name)
  assert.equal(website.url, 'https://school.example/')
  config.school.displayName.ja = name
  const entrance = renderBrandHtml('__BRAND_DISPLAY_NAME__ __SCHOOL_ORIGIN__ __HIGH_SCHOOL_ORIGIN__', 'school', config,
    { SCHOOL_ORIGIN: 'https://entry.example', HIGH_SCHOOL_ORIGIN: 'https://school.example' })
  assert.equal(entrance, `${name} https://entry.example https://school.example`)
})

test('initial template has one coverage token, only in the OGP description', () => {
  const source = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  assert.equal([...source.matchAll(/__COVERAGE__/g)].length, 1)
  assert.match(source, /<meta property="og:description" content="[^"]*__COVERAGE__[^"]*"/)
})
