// Explicit synthetic-only local build. Never invokes the production build/fetch chain.
import fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkedFile, checkedOutput } from './lib/school-candidate.mjs'
import { parseSchoolSnapshot } from './lib/school-source.mjs'
import { verifyDeploymentCapacity } from './verify-deployment-capacity.mjs'
import { createApexCandidate, retainLegacyAssets, verifyCompatibilityGeneration } from './lib/apex-candidate.mjs'
import { validateBrands } from './lib/brands.mjs'
import { portalWithBrands } from '../apex-portal/portal.mjs'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = dirname(webRoot)
const staticFiles = [
  '_routes.json', '_redirects', '_headers', 'robots.txt', 'manifest.webmanifest', 'maintenance.html',
  'favicon.svg', 'favicon.ico', 'favicon-16.png', 'favicon-32.png', 'favicon-48.png',
  'apple-touch-icon.png', 'icon.svg', 'icon-192.png', 'icon-512.png', 'brand-mark.svg', 'og-hero.png',
  'logos/line-login-icon.png', 'logos/google-signin-icon.svg',
  'legal/third-party.md', 'legal/terms.md', 'legal/privacy.md', 'legal/deviation-methodology.md',
  'guide/school-visit.md', 'guide/deviation-with-care.md', 'guide/commute-time.md',
  'press/press-release.pdf', 'press/manabi-map-poster.pdf', 'press/manabi-map-poster-thumb.png',
  'press/manabi-map-handout.pdf', 'press/manabi-map-handout-thumb.png', 'press/logo-pack.zip', 'press/listing-checklist.html',
]
const topFiles = new Set(['web/package.json', 'web/index.html', 'web/vite.config.ts',
  'web/tsconfig.json', 'web/tsconfig.app.json', 'web/tsconfig.node.json', 'web/tsconfig.functions.json'])
const dataFiles = new Set(['site.json', 'brands.json', 'site-footer-links.json', 'prefectures.json', 'municipalities.json', 'dataset-claims.json', 'book-ads-source.json'])

export function allowedCandidateSource(path) {
  if (path.split('/').some((part) => part.startsWith('.')) || path.includes('\\')) return false
  if (topFiles.has(path)) return true
  if (path.startsWith('web/data/')) return dataFiles.has(path.slice('web/data/'.length))
  if (path.startsWith('web/src/')) return ['.ts', '.tsx', '.css', '.svg'].includes(extname(path))
  if (path.startsWith('web/scripts/')) return extname(path) === '.mjs'
  if (path.startsWith('functions/')) return extname(path) === '.ts'
  return false
}

export function candidateEnvironment(source = process.env) {
  const allowed = new Set(['path', 'systemroot', 'windir', 'temp', 'tmp', 'userprofile', 'home', 'localappdata', 'appdata', 'comspec', 'pathext'])
  const result = Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key.toLowerCase())))
  return { ...result, VERSION_OVERRIDE: 'school-candidate',
    VITE_SUPABASE_URL: 'https://synthetic-school.supabase.invalid', VITE_SUPABASE_ANON_KEY: 'synthetic-public-placeholder',
    VITE_BOOK_ADS_BASE_URL: '/synthetic-book-ads' }
}

export function parseCandidateArgs(args) {
  const result = {}
  for (const arg of args) {
    const match = /^--(snapshot|manifest|output-root|legacy-assets|brands)=(.+)$/.exec(arg)
    if (!match || result[match[1]]) throw new Error('Explicit unique snapshot, manifest and output-root arguments are required')
    result[match[1]] = match[2]
  }
  if (!['snapshot', 'manifest', 'output-root'].every((key) => result[key])) throw new Error('Explicit synthetic snapshot and manifest are required')
  return result
}

async function copy(source, destination) {
  await checkedFile(source)
  await fs.mkdir(dirname(destination), { recursive: true })
  await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL)
}

export async function buildSchoolCandidates(options) {
  const inputs = await Promise.all([options.snapshot, options.manifest, ...(options.brands ? [options.brands] : [])].map(checkedFile))
  if (inputs[0] === inputs[1]) throw new Error('Separate source files are required')
  parseSchoolSnapshot(await fs.readFile(inputs[0]), await fs.readFile(inputs[1]))
  const output = await checkedOutput(options['output-root'], inputs, repoRoot)
  const config = JSON.parse(await fs.readFile(join(webRoot, 'data/deployment-targets.json'), 'utf8'))
  const targets = config.targets
  if (targets.school.origin !== 'https://school.manabi-map.app' || targets['high-school'].origin !== 'https://high-school.manabi-map.app' ||
      targets.school.outputDirectory !== 'dist-school-portal' || targets['high-school'].outputDirectory !== 'dist-high-school') {
    throw new Error('Unexpected deployment target contract')
  }
  // Only allowlisted source files known to Git or pending addition; no ignored/private files.
  // New source styles must be included before commit as well as after it.
  const sources = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true }).split('\0').filter(allowedCandidateSource)
  await fs.mkdir(output)
  const workspace = join(output, 'source')
  const isolatedWeb = join(workspace, 'web')
  for (const path of sources) await copy(join(repoRoot, path), join(workspace, path))
  // A synthetic brand trial changes only the isolated source; the checkout stays unchanged.
  const brandConfig = validateBrands(JSON.parse(await fs.readFile(options.brands ? inputs[2] : join(isolatedWeb, 'data/brands.json'), 'utf8')))
  await fs.writeFile(join(isolatedWeb, 'data/brands.json'), JSON.stringify(brandConfig, null, 2) + '\n')
  for (const path of ['data/deployment-targets.json', 'vite.school-portal.config.ts', 'vite.high-school-candidate.config.ts', 'school-portal/index.html', 'school-portal/style.css']) {
    await copy(join(webRoot, path), join(isolatedWeb, path))
  }
  for (const path of staticFiles) await copy(join(webRoot, 'public', path), join(isolatedWeb, 'public', path))
  await fs.writeFile(join(isolatedWeb, 'data/site.json'), JSON.stringify({ origin: targets['high-school'].origin }) + '\n')
  // Use already installed dependencies. This link is never a publish output or a recursive copy source.
  await fs.symlink(await fs.realpath(join(webRoot, 'node_modules')), join(isolatedWeb, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  const environment = candidateEnvironment()
  const run = (script, args) => execFileSync(process.execPath, [script, ...args], {
    cwd: isolatedWeb, env: environment, stdio: 'inherit', windowsHide: true,
  })
  const tsx = join(isolatedWeb, 'node_modules/tsx/dist/cli.mjs')
  const vite = join(isolatedWeb, 'node_modules/vite/bin/vite.js')
  const dataCandidate = join(output, 'school-data-candidate')
  run(tsx, ['scripts/gen-schools-json.mjs', '--school-source=snapshot', `--snapshot=${inputs[0]}`, `--snapshot-manifest=${inputs[1]}`, `--output-root=${dataCandidate}`])
  // Only receipt-listed public projection files cross into the app public directory.
  const receipt = JSON.parse(await fs.readFile(join(dataCandidate, 'candidate-manifest.json'), 'utf8'))
  for (const artifact of receipt.artifacts) await copy(join(dataCandidate, artifact.path), join(isolatedWeb, 'public', artifact.path))
  const schoolOutput = join(output, targets.school.outputDirectory)
  const highSchoolOutput = join(output, targets['high-school'].outputDirectory)
  if (targets.apex?.origin !== 'https://manabi-map.app' || targets.apex.outputDirectory !== 'dist-apex-portal') throw new Error('Explicit independent apex target required')
  const apexOutput = join(output, targets.apex.outputDirectory)
  run(vite, ['build', '--config', 'vite.school-portal.config.ts', '--outDir', schoolOutput])
  run(vite, ['build', '--config', 'vite.high-school-candidate.config.ts', '--outDir', highSchoolOutput])
  // Keep the client shell before the SEO pass inserts homepage-only SSR state.
  const schoolShell = await fs.readFile(join(highSchoolOutput, 'index.html'), 'utf8')
  run(vite, ['build', '--config', 'vite.high-school-candidate.config.ts', '--ssr', 'src/entry-server.tsx', '--outDir', 'dist-ssr'])
  run(tsx, ['scripts/gen-seo-pages.mjs', '--dist', highSchoolOutput, `--synthetic-candidate=${dataCandidate}`])
  run(join(isolatedWeb, 'scripts/verify-static-output.mjs'), ['--dist', highSchoolOutput, '--max-file-mib', '25'])
  await createApexCandidate({ highSchoolOutput, apexOutput, portalRoot: join(webRoot, 'apex-portal'), schoolShell, portalConfig: portalWithBrands(brandConfig) })
  const legacyAssets = options['legacy-assets'] ? await retainLegacyAssets(options['legacy-assets'], apexOutput) : { synthetic: true, retained: 0 }
  const compatibility = await verifyCompatibilityGeneration(dataCandidate, [apexOutput, highSchoolOutput])
  const capacity = {}
  for (const [targetId, distDir] of [['school', schoolOutput], ['high-school', highSchoolOutput], ['apex', apexOutput]]) {
    const check = await verifyDeploymentCapacity({ distDir, targetId, config })
    if (!check.valid) throw new Error(`Candidate capacity gate failed: ${targetId}`)
    capacity[targetId] = { valid: check.valid, fileCount: check.fileCount, totalBytes: check.totalBytes,
      largest: check.largest, maxFiles: check.maxFiles, maxFileBytes: check.maxFileBytes,
      remainingFiles: check.remainingFiles, warnings: check.warnings }
  }
  const result = { formatVersion: 1, synthetic: true, deploymentPerformed: false,
    targets, capacity, compatibility, legacyAssets, inputArtifactsSha256: receipt.artifactsSha256,
    functions: { source: 'source/functions', attachedTo: ['high-school', 'apex'], deployed: false,
      candidateBindings: { apex: { LEGACY_SCHOOL_SHELL: '1' } } },
    limitations: ['Pages project names are local candidate labels; confirm actual resources before deployment.',
      'Functions and production bindings are not included in the static high-school directory.',
      'Synthetic auth values cannot verify real OAuth, persistence or Android. Callback mocks are separate evidence.',
      'Historical retention is synthetic-only; a verified inventory of actual deployed chunks is required before real cutover.',
      'The legacy notice remains disabled; existing production origin is unchanged.',
      'Historical PDFs and outbound references are retained; they are not migration acceptance evidence.'] }
  await fs.writeFile(join(output, 'candidate-build.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  return result
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  buildSchoolCandidates(parseCandidateArgs(process.argv.slice(2))).then(() => console.log('Independent synthetic school candidates built; no deployment performed.')).catch(() => {
    console.error('Candidate build failed; retained scratch output is incomplete. No production build or deployment was performed.')
    process.exitCode = 1
  })
}
