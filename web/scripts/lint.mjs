import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const webRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repoRoot = resolve(webRoot, '..')
const functionsRoot = resolve(repoRoot, 'functions')
const oxlintEntry = resolve(webRoot, 'node_modules', 'oxlint', 'bin', 'oxlint')
const result = spawnSync(process.execPath, [oxlintEntry, webRoot, functionsRoot], { stdio: 'inherit' })

if (result.error) throw result.error
process.exitCode = result.status ?? 1
