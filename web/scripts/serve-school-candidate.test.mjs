import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveCandidate } from './serve-school-candidate.mjs'

test('candidate HTTP preserves API GET/HEAD/CORS/MIME, old chunks, unknown 404 and POST 405', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'synthetic-compat-http-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const dir of ['api/v1', 'assets', 'legacy-school']) await fs.mkdir(join(root, dir), { recursive: true })
  await fs.writeFile(join(root, 'index.html'), 'independent portal')
  await fs.writeFile(join(root, 'legacy-school/index.html'), 'dedicated school shell')
  await fs.writeFile(join(root, 'api/v1/schools.json'), '{"synthetic":true}')
  await fs.writeFile(join(root, 'assets/previous.js'), '/* synthetic old chunk */')
  const server = await serveCandidate(root, { legacy: true })
  t.after(() => new Promise((done) => server.close(done)))
  const base = `http://127.0.0.1:${server.address().port}`
  for (const method of ['GET', 'HEAD']) {
    const res = await fetch(`${base}/api/v1/schools.json`, { method })
    assert.equal(res.status, 200); assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.match(res.headers.get('content-type'), /^application\/json/)
    assert.equal(await res.text(), method === 'HEAD' ? '' : '{"synthetic":true}')
  }
  assert.equal(await (await fetch(base)).text(), 'independent portal')
  for (const path of ['/auth/callback?code=synthetic', '/family/join?token=synthetic', '/family/join', '/mypage']) assert.equal(await (await fetch(base + path)).text(), 'dedicated school shell')
  const oldChunk = await fetch(`${base}/assets/previous.js`)
  assert.equal(oldChunk.status, 200)
  assert.match(oldChunk.headers.get('content-type'), /^application\/javascript/)
  assert.equal((await fetch(`${base}/unknown`)).status, 404)
  assert.equal((await fetch(`${base}/api/v1/unknown.json`)).status, 404)
  for (const path of ['/auth/callback', '/api/v1/schools.json']) assert.equal((await fetch(base + path, { method: 'POST' })).status, 405)
  const outside = await fs.mkdtemp(join(tmpdir(), 'synthetic-http-outside-'))
  t.after(() => fs.rm(outside, { recursive: true, force: true }))
  await fs.writeFile(join(outside, 'outside.json'), 'synthetic outside root')
  await fs.symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await fetch(`${base}/linked/outside.json`)).status, 404)
})
