import fs from 'node:fs/promises'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { checkedFile, checkedPath, verifySchoolCandidate } from './school-candidate.mjs'
import { portal, renderEntryPage, renderRecoveryEnded } from '../../apex-portal/portal.mjs'
import { entrySupportFiles } from './entry-metadata.mjs'
import { normalizedMigrationPath, validateMigrationInventory } from '../../../functions/_school-migration.ts'
import deploymentTargets from '../../data/deployment-targets.json' with { type: 'json' }

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** A completed school projection is the sole data input for both origins. */
export async function verifyCompatibilityGeneration(candidate, outputs) {
  const receipt = await verifySchoolCandidate(candidate)
  if (outputs.length !== 2) throw new Error('Both legacy and high-school outputs are required')
  const roots = await Promise.all([candidate, ...outputs].map((root) => checkedPath(root)))
  for (let a = 0; a < roots.length; a++) for (let b = 0; b < roots.length; b++) {
    if (a === b) continue
    const rel = relative(roots[a], roots[b])
    if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Separate non-overlapping generation and output directories required')
  }
  for (const root of outputs) {
    for (const artifact of receipt.artifacts) {
      const bytes = await fs.readFile(join(root, artifact.path))
      if (bytes.length !== artifact.size || sha256(bytes) !== artifact.sha256) throw new Error('Compatibility generation differs; restore both outputs from the completed candidate')
    }
  }
  return { artifactsSha256: receipt.artifactsSha256, artifacts: receipt.artifacts.length, origins: outputs.length }
}

/** Explicit synthetic historical inventory; collisions must match byte-for-byte. */
export async function retainLegacyAssets(source, destination) {
  await checkedPath(source); await checkedPath(destination)
  const manifest = JSON.parse(await fs.readFile(await checkedFile(join(source, 'legacy-assets.json')), 'utf8'))
  if (manifest.format !== 'synthetic-legacy-assets' || manifest.synthetic !== true || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length) throw new Error('Explicit synthetic legacy asset inventory required')
  const seen = new Set()
  for (const item of manifest.artifacts) {
    if (typeof item.path !== 'string' || !/^(?:assets\/[a-zA-Z0-9_./-]+\.(?:js|css|svg|png|woff2?)|(?:schools|city-index|school-name-index)-[a-z0-9-]+\.json(?:\.gz)?)$/.test(item.path) || item.path.split('/').some((part) => !part || part === '.' || part === '..') || seen.has(item.path.toLowerCase()) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size)) throw new Error('Invalid legacy asset entry')
    seen.add(item.path.toLowerCase())
    const bytes = await fs.readFile(await checkedFile(join(source, item.path)))
    if (bytes.length !== item.size || sha256(bytes) !== item.sha256) throw new Error('Legacy asset inventory differs')
    const target = join(destination, item.path)
    try {
      const existing = await fs.readFile(await checkedFile(target))
      if (!existing.equals(bytes)) throw new Error('Legacy asset path collision')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await fs.mkdir(dirname(target), { recursive: true })
      await fs.writeFile(target, bytes, { flag: 'wx' })
    }
  }
  // The published route inventory must include assets retained after construction.
  const inventoryPath = join(destination, 'school-migration-candidate.json')
  let inventory
  try { inventory = JSON.parse(await fs.readFile(await checkedFile(inventoryPath), 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (inventory) {
    validateMigrationInventory(inventory, inventory.phase)
    inventory.assets = [...new Set([...inventory.assets, ...manifest.artifacts.map((item) => normalizedMigrationPath('/' + item.path))])].sort()
    validateMigrationInventory(inventory, inventory.phase)
    await fs.writeFile(inventoryPath, JSON.stringify(inventory) + '\n')
  }
  return { synthetic: true, retained: seen.size }
}

/** No old SEO HTML is duplicated. Retain current candidate chunks/data for the legacy shell. */
export async function createApexCandidate({ highSchoolOutput, apexOutput, portalRoot, schoolShell, portalConfig = portal, phase = 'candidate-rescue' }) {
  if (!['candidate-rescue', 'candidate-retired'].includes(phase)) throw new Error('Explicit candidate phase required')
  await fs.mkdir(apexOutput)
  const inventory = { format: 'synthetic-school-routes', phase, routes: [], assets: [] }
  let existingHeaders = ''
  async function copyTree(path = '') {
    for (const item of await fs.readdir(join(highSchoolOutput, path), { withFileTypes: true })) {
      const relative = path ? `${path}/${item.name}` : item.name
      if (item.isSymbolicLink()) throw new Error('Linked compatibility assets are not supported')
      if (item.isDirectory()) await copyTree(relative)
      else if (item.isFile() && relative.endsWith('/index.html')) {
        inventory.routes.push(normalizedMigrationPath('/' + relative.slice(0, -'/index.html'.length)))
      } else if (item.isFile() && relative === '_headers') {
        existingHeaders = await fs.readFile(join(highSchoolOutput, relative), 'utf8')
      } else if (item.isFile() && (!relative.endsWith('.html') || relative === 'maintenance.html') &&
        !['robots.txt', 'sitemap.xml', 'llms.txt', '_redirects'].includes(relative)) {
        await fs.mkdir(dirname(join(apexOutput, relative)), { recursive: true })
        await fs.copyFile(join(highSchoolOutput, relative), join(apexOutput, relative), fs.constants.COPYFILE_EXCL)
        if (!relative.startsWith('_') && !relative.endsWith('.html') && !relative.startsWith('api/')) inventory.assets.push(normalizedMigrationPath('/' + relative))
      }
    }
  }
  await copyTree()
  const shell = schoolShell ?? await fs.readFile(join(highSchoolOutput, 'index.html'), 'utf8')
  await fs.mkdir(join(apexOutput, 'legacy-school'))
  await fs.writeFile(join(apexOutput, 'legacy-school/index.html'), shell.replace('<head>', '<head><meta name="legacy-school-shell" content="1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">'), { flag: 'wx' })
  await fs.writeFile(join(apexOutput, 'index.html'), renderEntryPage(await fs.readFile(join(portalRoot, 'index.html'), 'utf8'), { ...portalConfig, migrationPhase: phase }), { flag: 'wx' })
  await fs.copyFile(join(portalRoot, 'portal.css'), join(apexOutput, 'portal.css'), fs.constants.COPYFILE_EXCL)
  const support = entrySupportFiles({ origin: deploymentTargets.targets.apex.origin, brand: portalConfig.brand, description: '親子が学ぶことと通う場所を見つける総合入口。', stylesheet: '/portal.css' })
  support['_headers'] = existingHeaders + '\n' + support['_headers']
  for (const [name, content] of Object.entries(support)) await fs.writeFile(join(apexOutput, name), content, { flag: 'wx' })
  await fs.writeFile(join(apexOutput, 'school-recovery-ended.html'), renderRecoveryEnded(portalConfig), { flag: 'wx' })
  inventory.assets.push('/portal.css', '/robots.txt', '/sitemap.xml', '/llms.txt')
  inventory.routes.sort(); inventory.assets.sort()
  validateMigrationInventory(inventory, phase)
  await fs.writeFile(join(apexOutput, 'school-migration-candidate.json'), JSON.stringify(inventory) + '\n', { flag: 'wx' })
  // The callback shell and all dependent routes are handled by separately deployed Functions.
  await fs.writeFile(join(apexOutput, '_redirects'), '', { flag: 'wx' })
  return inventory
}
