import { strict as assert } from 'node:assert'
import { pathToFileURL } from 'node:url'

const worker = (await import(pathToFileURL(process.argv[2]).href)).default
const get = (path, method = 'GET') => worker.fetch(new Request(`https://manabi-map.app${path}`, { method }))
const response = await get('/')
const html = await response.text()
assert.equal(response.status, 200)
assert.match(html, /https:\/\/high-school\.manabi-map\.app\//)
assert.match(html, /https:\/\/home\.manabi-map\.app\//)
assert.match(html, /rel="canonical" href="https:\/\/manabi-map\.app\//)
assert.doesNotMatch(html, /noindex|旧URL|移行候補|\{\{/)
for (const path of ['/robots.txt', '/sitemap.xml', '/llms.txt']) assert.equal((await get(path)).status, 200)
assert.equal((await get('/')).headers.get('x-robots-tag'), null)
assert.equal((await get('/', 'HEAD')).status, 200)
assert.equal((await get('/', 'POST')).status, 405)
assert.equal((await get('/unknown')).status, 404)
console.log('経路と検索情報の確認に成功')
