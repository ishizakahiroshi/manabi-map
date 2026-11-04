import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSchoolDirectoryPackage, inspectSchoolDirectorySource, verifySchoolDirectoryPackage } from './school-portal-package.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'synthetic-school-portal-'))
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), root)
    assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`))
    await fs.rm(root, { recursive: true, force: true })
  })
  const sourceRoot = join(root, 'source')
  await fs.mkdir(sourceRoot)
  const source = await inspectSchoolDirectorySource()
  for (const file of source.sourceFiles) {
    const destination = join(sourceRoot, file.path)
    await fs.mkdir(dirname(destination), { recursive: true })
    await fs.copyFile(join(repoRoot, file.path), destination)
  }
  return { root, sourceRoot, outputRoot: join(root, 'package'), source }
}

test('dedicated portal package contains only indexable directory assets and verifies source and receipt pins', async (t) => {
  const { sourceRoot, outputRoot, source } = await fixture(t)
  assert.ok(source.sourceFiles.some((file) => file.path === 'web/scripts/verify-deployment-capacity.mjs'))
  const built = await buildSchoolDirectoryPackage({ sourceRoot, outputRoot, expectedSourceSha256: source.sourceSha256 })
  const verified = await verifySchoolDirectoryPackage({ sourceRoot, outputRoot,
    expectedSourceSha256: source.sourceSha256, expectedReceiptSha256: built.receiptSha256 })
  assert.equal(verified.fileCount, 8)
  assert.equal(verified.target.pagesProject, 'manabi-map-school')
  const files = await fs.readdir(verified.outputDirectory)
  assert.deepEqual(files.sort(), ['404.html', '_headers', 'assets', 'favicon.ico', 'index.html', 'llms.txt', 'robots.txt', 'sitemap.xml'])
  const html = await fs.readFile(join(verified.outputDirectory, 'index.html'), 'utf8')
  assert.match(html, /https:\/\/high-school\.manabi-map\.app\/search/)
  assert.match(html, /<link rel="icon" href="\/favicon\.ico"/)
  assert.deepEqual(await fs.readFile(join(verified.outputDirectory, 'favicon.ico')),
    await fs.readFile(join(sourceRoot, 'web/public/favicon.ico')))
  assert.doesNotMatch(html, /noindex|__BRAND_|synthetic/i)
  assert.match(await fs.readFile(join(verified.outputDirectory, 'robots.txt'), 'utf8'), /Allow: \/\n/)
  assert.doesNotMatch(await fs.readFile(join(verified.outputDirectory, '_headers'), 'utf8'), /X-Robots-Tag/)
  await assert.rejects(buildSchoolDirectoryPackage({ sourceRoot, outputRoot, expectedSourceSha256: source.sourceSha256 }))
})

test('wrong source pin and non-adopted target reject before creating a package', async (t) => {
  const { sourceRoot, outputRoot, source } = await fixture(t)
  await assert.rejects(buildSchoolDirectoryPackage({ sourceRoot, outputRoot, expectedSourceSha256: '0'.repeat(64) }))
  await assert.rejects(fs.lstat(outputRoot), { code: 'ENOENT' })
  const targetPath = join(sourceRoot, 'web/data/deployment-targets.json')
  const config = JSON.parse(await fs.readFile(targetPath, 'utf8'))
  config.targets.school.pagesProject = 'wrong-project'
  await fs.writeFile(targetPath, JSON.stringify(config))
  const changed = await inspectSchoolDirectorySource({ sourceRoot }).catch(() => null)
  assert.equal(changed, null)
  await assert.rejects(buildSchoolDirectoryPackage({ sourceRoot, outputRoot, expectedSourceSha256: source.sourceSha256 }))
  await assert.rejects(fs.lstat(outputRoot), { code: 'ENOENT' })
})

test('receipt verifier rejects tampered output, extra data and source drift', async (t) => {
  const { sourceRoot, outputRoot, source } = await fixture(t)
  const built = await buildSchoolDirectoryPackage({ sourceRoot, outputRoot, expectedSourceSha256: source.sourceSha256 })
  const args = { sourceRoot, outputRoot, expectedSourceSha256: source.sourceSha256, expectedReceiptSha256: built.receiptSha256 }
  const dist = built.outputDirectory
  const original = await fs.readFile(join(dist, 'index.html'))
  await fs.writeFile(join(dist, 'index.html'), '<h1>replaced</h1>')
  await assert.rejects(verifySchoolDirectoryPackage(args))
  await fs.writeFile(join(dist, 'index.html'), original)
  await fs.writeFile(join(dist, 'schools-manifest.json'), '{}')
  await assert.rejects(verifySchoolDirectoryPackage(args))
  await fs.rm(join(dist, 'schools-manifest.json'))
  await fs.appendFile(join(sourceRoot, 'web/school-portal/style.css'), '\n/* changed */\n')
  await assert.rejects(verifySchoolDirectoryPackage(args))
  await assert.rejects(verifySchoolDirectoryPackage({ ...args, expectedReceiptSha256: '0'.repeat(64) }))
})

test('receipt changes and linked output entries are rejected', async (t) => {
  const { root, sourceRoot, outputRoot, source } = await fixture(t)
  const built = await buildSchoolDirectoryPackage({ sourceRoot, outputRoot, expectedSourceSha256: source.sourceSha256 })
  const args = { sourceRoot, outputRoot, expectedSourceSha256: source.sourceSha256, expectedReceiptSha256: built.receiptSha256 }
  const receipt = join(outputRoot, 'school-portal-package.json')
  const original = await fs.readFile(receipt)
  await fs.appendFile(receipt, '\n')
  await assert.rejects(verifySchoolDirectoryPackage(args))
  await fs.writeFile(receipt, original)
  const robots = join(built.outputDirectory, 'robots.txt')
  await fs.rename(robots, join(root, 'robots-original.txt'))
  await fs.symlink(join(root, 'robots-original.txt'), robots)
  await assert.rejects(verifySchoolDirectoryPackage(args))
})
