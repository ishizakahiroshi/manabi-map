import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkedFile, verifySchoolCandidate } from './school-candidate.mjs'

// A small source is allowed only by explicit opt-in to a verified synthetic receipt.
// The built dist must still contain every exact JSON/API artifact from that receipt.
export async function createSeoDataReader(args, distDir) {
  const flags = args.filter((arg) => arg.startsWith('--synthetic-candidate'))
  if (!flags.length) return { minimumExpected: 1000, readData: (path, encoding) => readFile(join(distDir, path), encoding) }
  if (flags.length !== 1 || !flags[0].startsWith('--synthetic-candidate=')) throw new Error('One explicit --synthetic-candidate=<directory> is required')
  const candidate = flags[0].slice('--synthetic-candidate='.length)
  const receipt = await verifySchoolCandidate(candidate)
  const artifacts = new Map(receipt.artifacts.map((artifact) => [artifact.path, artifact]))
  async function readData(path, encoding) {
    const artifact = artifacts.get(path)
    if (!artifact) throw new Error('Synthetic SEO consumed data is missing from the receipt')
    const bytes = await readFile(await checkedFile(join(distDir, path)))
    if (bytes.length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
      throw new Error('Synthetic SEO candidate differs from built public artifacts')
    }
    return encoding ? bytes.toString(encoding) : bytes
  }
  for (const artifact of receipt.artifacts) await readData(artifact.path)
  const manifest = JSON.parse(await readData('schools-manifest.json', 'utf8'))
  if (typeof manifest.url !== 'string' || !/^\/schools-[0-9a-f]{10}\.json\.gz$/.test(manifest.url) || !artifacts.has(manifest.url.slice(1))) {
    throw new Error('Synthetic SEO requires a receipt-bound canonical schools URL; legacy fallback is forbidden')
  }
  return { minimumExpected: 1, readData }
}
