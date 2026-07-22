import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import { verifyStaticOutput } from './verify-static-output.mjs'

async function syntheticDist() {
  const dir = await mkdtemp(join(tmpdir(), 'manabi-map-static-'))
  const schools = [
    { id: 'synthetic-a', name: '合成第一高等学校', latitude: 35, longitude: 139 },
    { id: 'synthetic-b', name: '合成第二高等学校', latitude: 36, longitude: 140 },
  ]
  const body = Buffer.from(JSON.stringify({ formatVersion: 2, sourceCatalog: [], schools }))
  // 拡張子ではなくmagic byteを見ることを検証するため、gzipを.json名で保存する。
  await writeFile(join(dir, 'schools-a1b2c3d4e5.json'), gzipSync(body))
  await writeFile(join(dir, 'schools-manifest.json'), JSON.stringify({
    url: '/schools-a1b2c3d4e5.json', count: schools.length, compression: 'gzip',
  }))
  await writeFile(join(dir, 'index.html'), '<div id="root"></div>')
  await writeFile(join(dir, 'sitemap.xml'), [
    '<loc>https://manabi-map.app/</loc>',
    '<loc>https://manabi-map.app/search</loc>',
    '<loc>https://manabi-map.app/school/synthetic-a</loc>',
    '<loc>https://manabi-map.app/school/synthetic-b</loc>',
  ].join('\n'))
  for (const school of schools) {
    const schoolDir = join(dir, 'school', school.id)
    await mkdir(schoolDir, { recursive: true })
    await writeFile(
      join(schoolDir, 'index.html'),
      `<link rel="canonical" href="https://manabi-map.app/school/${school.id}"><h1>${school.name}</h1>`,
    )
  }
  return dir
}

test('gzip magic, manifest, sitemap, SEO page and size gate pass together', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const result = await verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 })
  assert.equal(result.schoolsPayloadGzip, true)
  assert.equal(result.schoolCount, 2)
  assert.equal(result.seoSchoolCount, 2)
  assert.equal(result.sitemapUrlCount, 4)
  assert.equal(result.sitemapUniqueUrlCount, 4)
})

test('a file exactly at the limit is rejected because the contract is strictly under 25 MiB', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'at-limit.bin'), Buffer.alloc(64))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 64 }),
    /must be smaller than 64 bytes/,
  )
})

test('sitemap count drift is rejected', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'sitemap.xml'), '<loc>https://manabi-map.app/</loc>')
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /sitemap mismatch/,
  )
})

test('a duplicate allowed sitemap URL cannot replace a required school URL', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'sitemap.xml'), [
    '<loc>https://manabi-map.app/</loc>',
    '<loc>https://manabi-map.app/search</loc>',
    '<loc>https://manabi-map.app/school/synthetic-a</loc>',
    '<loc>https://manabi-map.app/school/synthetic-a</loc>',
  ].join('\n'))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /sitemap contains duplicate URLs/,
  )
})

test('a non-representative school directory without index.html is rejected', async (t) => {
  const dir = await syntheticDist()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await rm(join(dir, 'school', 'synthetic-b', 'index.html'))
  await assert.rejects(
    verifyStaticOutput({ distDir: dir, maxFileBytes: 1024 * 1024 }),
    /SEO school index\.html is missing: synthetic-b/,
  )
})
