import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'

// The portal uses no personal data, analytics, account or third-party assets.
const root = resolve(import.meta.dirname, '../..')
const template = await readFile(resolve(root, 'web/apex-portal/index.html'), 'utf8')
const css = await readFile(resolve(root, 'web/apex-portal/portal.css'), 'utf8')
// たねもじは 2026-11-04 に kanji.manabi-map.app で公開した（本人の「自走してデプロイまでやっていい」）
const cards = '<article><h2>たねもじ</h2><p>漢字を学ぶ教材。</p><a class="primary" href="https://kanji.manabi-map.app/">たねもじを開く →</a></article><article><h2>郷土かるた</h2><p>地域のことばや文化に親しむ教材。</p><span class="state">準備中</span></article>'
const values = {
  origin: 'https://manabi-map.app', brand: 'まなびマップ', schoolBrand: 'Manabi Map（まなびマップ）',
  schoolAction: '<a class="primary" href="https://school.manabi-map.app/">学校の種類を選ぶ →</a>',
  homeAction: '<a class="primary" href="https://home.manabi-map.app/">地ファクトを開く →</a>',
  learningCards: cards, recoveryLink: '', recoveryNotice: '',
}
const html = template.replace(/<meta name="robots" content="noindex">/, '')
  .replace('<link rel="stylesheet" href="/portal.css">', `<style>${css}</style>`)
  .replace(/\s*<aside><h2>これまで学校サイトを使っていた方へ<\/h2>[\s\S]*?<\/aside>/, '')
  .replace('<p>移行候補のプレビューです。新しい行き先は公開確認後にご案内します。</p>', '')
  .replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Unknown template field: ${key}`)
    return values[key]
  })
if (html.includes('{{') || html.includes('noindex') || html.includes('旧URL')) throw new Error('Invalid public portal')
const files = {
  '/': ['text/html; charset=utf-8', html],
  '/robots.txt': ['text/plain; charset=utf-8', 'User-agent: *\nAllow: /\nDisallow: /auth/\nDisallow: /mypage\nDisallow: /favorites\nDisallow: /compare\nDisallow: /family/\n\nUser-agent: meta-externalagent\nUser-agent: Amazonbot\nUser-agent: GPTBot\nUser-agent: ClaudeBot\nUser-agent: CCBot\nUser-agent: Bytespider\nAllow: /api/v1/\nAllow: /data/\nDisallow: /\n\nSitemap: https://manabi-map.app/sitemap.xml\n'],
  '/sitemap.xml': ['application/xml; charset=utf-8', '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://manabi-map.app/</loc></url></urlset>\n'],
  '/llms.txt': ['text/plain; charset=utf-8', '# まなびマップ\n\n学ぶことと通う場所を見つける入口です。\n\n学校の種類を選ぶ: https://school.manabi-map.app/\n高校・高専: https://high-school.manabi-map.app/\n地ファクト: https://home.manabi-map.app/\nたねもじ（漢字）: https://kanji.manabi-map.app/\n'],
}
// Worker の本体は runtime.mjs（/api/v1/* の高校版への中継を含む）。本文をそのまま先頭へ写す
const runtime = await readFile(resolve(import.meta.dirname, 'runtime.mjs'), 'utf8')
if (/^\s*(?:import|export)\b/m.test(runtime)) throw new Error('runtime.mjs must not import or export')
const code = `${runtime}\nconst files = ${JSON.stringify(files)};\nexport default { fetch: (request) => handleRequest(request, files, fetch) };\n`
const output = resolve(process.argv[2] ?? 'dist-apex-portal/worker.mjs')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, code, { flag: 'wx' })
console.log(`生成済み: ${output}`)
