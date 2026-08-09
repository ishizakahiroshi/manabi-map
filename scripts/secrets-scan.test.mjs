import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const scannerPath = join(dirname(fileURLToPath(import.meta.url)), 'secrets-scan.mjs')

test('staged mode reads the index blob instead of the unstaged working tree', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'manabi-map-secrets-scan-'))
  const kb = await mkdtemp(join(tmpdir(), 'manabi-map-secrets-kb-'))
  t.after(async () => {
    await rm(repo, { recursive: true, force: true })
    await rm(kb, { recursive: true, force: true })
  })

  await mkdir(repo, { recursive: true })
  await writeFile(join(kb, 'people.csv'), 'id,name\n1,synthetic-index-only-scan-token\n')
  const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git(['init', '-q'])
  git(['config', 'user.email', 'synthetic@example.com'])
  git(['config', 'user.name', 'Synthetic Test'])
  await writeFile(join(repo, 'probe.txt'), 'synthetic-safe-content\n')
  git(['add', 'probe.txt'])
  git(['commit', '-qm', 'synthetic baseline'])

  await writeFile(join(repo, 'probe.txt'), 'synthetic-index-only-scan-token\n')
  git(['add', 'probe.txt'])
  await writeFile(join(repo, 'probe.txt'), 'synthetic-worktree-only-scan-token\n')

  const result = spawnSync(
    process.execPath,
    [scannerPath, '--staged', '--block', '--format=json'],
    {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, KB_ROOT: kb, FAMILY_ROOT: '' },
    },
  )
  assert.equal(result.status, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.mode, 'staged')
  assert.deepEqual(report.hits.map((hit) => hit.matched), ['synthetic-index-only-scan-token'])
  assert.doesNotMatch(result.stdout, /synthetic-worktree-only-scan-token/)
})
