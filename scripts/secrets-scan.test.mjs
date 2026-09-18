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

// 検出パターンを後から足しても、それ以前に削除されたファイルには当たらない——という
// 取りこぼしを塞ぐための履歴モード。削除済みの blob が拾えることを固定する。
test('history mode scans blobs of files deleted in earlier commits', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'manabi-map-secrets-scan-'))
  const kb = await mkdtemp(join(tmpdir(), 'manabi-map-secrets-kb-'))
  t.after(async () => {
    await rm(repo, { recursive: true, force: true })
    await rm(kb, { recursive: true, force: true })
  })

  await writeFile(join(kb, 'people.csv'), 'id,name\n1,synthetic-deleted-history-token\n')
  const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git(['init', '-q'])
  git(['config', 'user.email', 'synthetic@example.com'])
  git(['config', 'user.name', 'Synthetic Test'])
  await writeFile(join(repo, 'leaked.txt'), 'synthetic-deleted-history-token\n')
  git(['add', 'leaked.txt'])
  git(['commit', '-qm', 'synthetic leak'])
  git(['rm', '-q', 'leaked.txt'])
  git(['commit', '-qm', 'synthetic delete'])

  const run = (mode) => spawnSync(
    process.execPath,
    [scannerPath, mode, '--block', '--format=json'],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, KB_ROOT: kb, FAMILY_ROOT: '' } },
  )

  const tracked = run('--all-tracked')
  assert.equal(tracked.status, 0)
  assert.deepEqual(JSON.parse(tracked.stdout).hits, [])

  const history = run('--history')
  assert.equal(history.status, 1)
  const report = JSON.parse(history.stdout)
  assert.equal(report.mode, 'history')
  assert.deepEqual(report.hits.map((hit) => hit.file), ['leaked.txt'])
  assert.deepEqual(report.hits.map((hit) => hit.matched), ['synthetic-deleted-history-token'])
  assert.match(report.hits[0].blob, /^[0-9a-f]{40}$/)
  assert.deepEqual(report.unscanned, [])
})

// 走査できなかったものを黙って「走査済み」にしない。
test('oversized files are reported as unscanned instead of passing silently', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'manabi-map-secrets-scan-'))
  t.after(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git(['init', '-q'])
  git(['config', 'user.email', 'synthetic@example.com'])
  git(['config', 'user.name', 'Synthetic Test'])
  // MAX_FILE_SIZE（1 MiB）超。拡張子でも SKIP_FILENAMES でも除外されない形にする。
  await writeFile(join(repo, 'huge.txt'), 'a'.repeat(1024 * 1024 + 1))
  git(['add', 'huge.txt'])
  git(['commit', '-qm', 'synthetic oversized'])

  const result = spawnSync(
    process.execPath,
    [scannerPath, '--all-tracked', '--block', '--format=json'],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, KB_ROOT: '', FAMILY_ROOT: '' } },
  )
  assert.equal(result.status, 1)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.hits, [])
  assert.equal(report.scanned, 0)
  assert.deepEqual(report.unscanned.map((item) => [item.file, item.reason]), [['huge.txt', 'size-limit']])
})

// git は既定で非 ASCII を含むパスを C エスケープで包んで返す。包まれたパスは
// 拡張子判定も読み取りも通らず、以前は黙って未走査になっていた（2026-09-18 検知）。
test('paths with non-ASCII characters are scanned, not silently skipped', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'manabi-map-secrets-scan-'))
  const kb = await mkdtemp(join(tmpdir(), 'manabi-map-secrets-kb-'))
  t.after(async () => {
    await rm(repo, { recursive: true, force: true })
    await rm(kb, { recursive: true, force: true })
  })

  await writeFile(join(kb, 'people.csv'), 'id,name\n1,synthetic-non-ascii-path-token\n')
  const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git(['init', '-q'])
  git(['config', 'user.email', 'synthetic@example.com'])
  git(['config', 'user.name', 'Synthetic Test'])
  await writeFile(join(repo, '資料メモ.txt'), 'synthetic-non-ascii-path-token\n')
  git(['add', '.'])
  git(['commit', '-qm', 'synthetic non-ascii path'])

  const result = spawnSync(
    process.execPath,
    [scannerPath, '--all-tracked', '--block', '--format=json'],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, KB_ROOT: kb, FAMILY_ROOT: '' } },
  )
  assert.equal(result.status, 1)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.unscanned, [])
  assert.deepEqual(report.hits.map((hit) => hit.matched), ['synthetic-non-ascii-path-token'])
})

// 2 文字の名前は日本語の散文の中で何にでも当たる。境界規則（前後が英数字でない）は
// 非 ASCII では常に成立するため救いにならず、実運用で誤検知を出していた（2026-09-18）。
// 短い needle を読み込まないこと、そして落とした件数を黙らずに出すことを固定する。
test('watchlist needles shorter than the minimum length are excluded and reported', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'manabi-map-secrets-scan-'))
  const kb = await mkdtemp(join(tmpdir(), 'manabi-map-secrets-kb-'))
  t.after(async () => {
    await rm(repo, { recursive: true, force: true })
    await rm(kb, { recursive: true, force: true })
  })

  // 2 文字の合成名。長い needle を混ぜず、短い needle 単独で 0 件になることを見る。
  await writeFile(join(kb, 'people.csv'), 'id,name\n1,合成\n')
  const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git(['init', '-q'])
  git(['config', 'user.email', 'synthetic@example.com'])
  git(['config', 'user.name', 'Synthetic Test'])
  // 前後とも日本語なので、境界規則だけでは素の部分一致に退化して当たってしまう行。
  await writeFile(join(repo, 'note.txt'), '// これは合成データの説明行\n')
  git(['add', '.'])
  git(['commit', '-qm', 'synthetic short needle'])

  const result = spawnSync(
    process.execPath,
    [scannerPath, '--all-tracked', '--block', '--format=json'],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, KB_ROOT: kb, FAMILY_ROOT: '' } },
  )
  assert.equal(result.status, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.min_needle_len, 3)
  assert.deepEqual(report.hits, [])
  assert.deepEqual(report.unscanned, [])
  assert.equal(report.kb_needles, 0)
  // 落とした分を黙って捨てない。件数だけを出し、値そのものは出さない。
  assert.equal(report.short_needles_excluded, 1)
  assert.match(result.stderr, /1 watchlist needle\(s\) under 3 chars excluded/)
  assert.doesNotMatch(result.stdout, /合成/)
})

// 下限は「3 文字以上は残す」側の境界でもある。ちょうど下限の長さの needle が
// 従来どおり検知されることを固定する（下限を上げ過ぎた退行を落とす）。
test('watchlist needles at the minimum length are still detected', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'manabi-map-secrets-scan-'))
  const kb = await mkdtemp(join(tmpdir(), 'manabi-map-secrets-kb-'))
  t.after(async () => {
    await rm(repo, { recursive: true, force: true })
    await rm(kb, { recursive: true, force: true })
  })

  await writeFile(join(kb, 'people.csv'), 'id,name\n1,合成名\n')
  const git = (args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git(['init', '-q'])
  git(['config', 'user.email', 'synthetic@example.com'])
  git(['config', 'user.name', 'Synthetic Test'])
  await writeFile(join(repo, 'note.txt'), '// これは合成名を含む説明行\n')
  git(['add', '.'])
  git(['commit', '-qm', 'synthetic minimum length needle'])

  const result = spawnSync(
    process.execPath,
    [scannerPath, '--all-tracked', '--block', '--format=json'],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, KB_ROOT: kb, FAMILY_ROOT: '' } },
  )
  assert.equal(result.status, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.kb_needles, 1)
  assert.equal(report.short_needles_excluded, 0)
  assert.deepEqual(report.hits.map((hit) => [hit.file, hit.lineNumber, hit.matched]), [['note.txt', 1, '合成名']])
})
