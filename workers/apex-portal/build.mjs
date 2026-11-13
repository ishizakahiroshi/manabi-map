import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { brandMark, favicon } from '../../web/apex-portal/portal.mjs'

// The portal itself holds no personal data, account or third-party assets. Visits are counted by cookieless
// Cloudflare Web Analytics, whose beacon Cloudflare injects at the edge (see PAGE_CSP in runtime.mjs).
const root = resolve(import.meta.dirname, '../..')
const template = await readFile(resolve(root, 'web/apex-portal/index.html'), 'utf8')
const css = await readFile(resolve(root, 'web/apex-portal/portal.css'), 'utf8')
// たねもじは 2026-11-04 に kanji.manabi-map.app で公開した（本人の「自走してデプロイまでやっていい」）
// たねワード（英語）は 2026-11-13 に english.manabi-map.app で公開した。印はアプリのアイコンと同じ絵（英語のノートの線と A）
const badge = (id) => `<span class="badge" aria-hidden="true"><svg><use href="#pin-${id}"/></svg></span>`
const cards = `<article>${badge('kanji')}<h2>たねもじ</h2><p>漢字を学ぶ教材。</p><a class="primary" href="https://kanji.manabi-map.app/">たねもじを開く →</a></article><article>${badge('english')}<h2>たねワード</h2><p>英単語を学ぶ教材。</p><a class="primary" href="https://english.manabi-map.app/">たねワードを開く →</a></article><article>${badge('karuta')}<h2>郷土かるた</h2><p>地域のことばや文化に親しむ教材。</p><span class="state">準備中</span></article>`
// 学校の種類は、学校入口（school.manabi-map.app）を経由せず、ここから直接それぞれの行き先へ送る（2026-11-12 本人の案）。
// 種類と行き先は学校入口の一覧と同じにする。学校入口の種類が増減したら、ここも合わせる
const schoolKinds = [
  ['小学校', 'https://school.manabi-map.app/primary/'], ['中学校', 'https://school.manabi-map.app/middle/'],
  ['高校・高専', 'https://high-school.manabi-map.app/'], ['大学・短大', 'https://school.manabi-map.app/university/'],
  ['専修学校（専門学校を含む）', 'https://school.manabi-map.app/vocational/'],
]
const values = {
  origin: 'https://manabi-map.app', brand: 'まなびマップ', brandMark: brandMark(), favicon: favicon(), schoolBrand: 'Manabi Map（まなびマップ）',
  schoolAction: `<ul class="kinds" aria-label="学校の種類">${schoolKinds.map(([name, url]) => `<li><a class="primary" href="${url}">${name} →</a></li>`).join('')}</ul>`,
  homeAction: '<a class="primary" href="https://home.manabi-map.app/">地ファクトを開く →</a>',
  // 地ファクトのロゴは文字（chifact. と名前）。書体・色・点の色は地ファクトの画面と同じにする
  homeBrand: '<p class="service-brand chifact">chifact<span>.</span><small>｜地ファクト</small></p>',
  // 訪問を数えていること（Cookie を使わないアクセス解析）を確かめられるよう、プライバシーポリシーへつなぐ。
  // 総合入口のポリシーは総合入口が自分で配る（/legal/privacy/。2026-11-13 本人決定。以前は高校版のページへ飛ばしていた）。
  // 呼び名は高校版のフッター（web/data/site-footer-links.json）と同じにする
  // 公開データ（API）の案内（/data/）へもつなぐ（2026-11-13 本人決定）
  footerLinks: '<a href="/data/">公開データ・API</a> <a href="/legal/privacy/">プライバシーポリシー</a>',
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
// /data/: 全部の学校の種類の公開データへの案内（人が読むページ）。件数・大きさ・SHA-256 は各サイトの /data/ と dataset.json が正本なので、
// ここには書かない（古くならないように、行き先だけを並べる）。機械が読む一覧は /api/catalog.json（runtime.mjs）
const dataKinds = [
  ['高校・高専', 'https://high-school.manabi-map.app/data/', 'https://high-school.manabi-map.app/api/v1/dataset.json', 'CC BY-SA 4.0'],
  // 4 種は国の資料（文部科学省の学校コード・国土数値情報）を結び付けたもので、元の資料に合わせて CC BY 4.0。
  // 高校・高専は学びマップが一次資料から集めたデータで CC BY-SA 4.0。正本は各 dataset.json の license
  ['小学校', 'https://school.manabi-map.app/data/', 'https://school.manabi-map.app/api/v1/primary/dataset.json', 'CC BY 4.0'],
  ['中学校', 'https://school.manabi-map.app/data/', 'https://school.manabi-map.app/api/v1/middle/dataset.json', 'CC BY 4.0'],
  ['大学・短大', 'https://school.manabi-map.app/data/', 'https://school.manabi-map.app/api/v1/university/dataset.json', 'CC BY 4.0'],
  ['専修学校（専門学校を含む）', 'https://school.manabi-map.app/data/', 'https://school.manabi-map.app/api/v1/vocational/dataset.json', 'CC BY 4.0'],
]
const dataPage = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>公開データ・API | ${values.brand}</title>`
  + `<link rel="canonical" href="https://manabi-map.app/data/">${values.favicon}`
  + '<style>body{font-family:system-ui,sans-serif;line-height:1.7;max-width:760px;margin:0 auto;padding:16px;color:#222}code{word-break:break-all}li{margin:6px 0}</style></head><body><main>'
  + `<h1>公開データ・API</h1><p>${values.brand}は、学校の種類ごとの基本情報を、固定 URL の JSON で配っています。認証は不要で、どのサイトからも読めます。</p>`
  + '<h2>全部の一覧（機械向け）</h2><p><a href="/api/catalog.json">/api/catalog.json</a> に、学校の種類ごとの件数・ライセンス・API の URL をまとめています。</p>'
  + '<h2>学校の種類ごと</h2><p>ファイルの大きさと SHA-256、保存用のリンクは、それぞれの説明のページにあります。</p><ul>'
  + dataKinds.map(([name, page, dataset, license]) => `<li><a href="${page}">${name}</a>（<a href="${dataset}">dataset.json</a>${license ? `・${license}` : ''}）</li>`).join('')
  + '</ul><p>ライセンスが種類で違うのは、データの元が違うためです。高校・高専は学びマップが学校・教育委員会などの一次資料から集めたデータで、CC BY-SA 4.0 です。小学校・中学校・大学短大・専修学校は、文部科学省の学校コードと国土数値情報（CC BY 4.0）の位置を結び付けたデータで、元の資料に合わせて CC BY 4.0 です。出典表記は各 dataset.json の attribution にあります。</p>'
  + '<p><a href="https://manabi-map.app/api/v1/dataset.json">https://manabi-map.app/api/v1/</a> は、高校版の /api/v1/ と同じファイルを返す互換の入口です。</p>'
  + '<p><a href="/">まなびマップの入口へ</a></p></main></body></html>\n'
// /legal/privacy/: 総合入口（manabi-map.app）だけのプライバシーポリシー。書くのは runtime.mjs と PAGE_CSP で実際にしていることだけ。
// 各サービスの中での扱いは、それぞれのサービスのポリシーが正本なので、ここには写さず行き先だけを並べる
const privacyPage = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>プライバシーポリシー | ${values.brand}</title>`
  + `<link rel="canonical" href="https://manabi-map.app/legal/privacy/">${values.favicon}`
  + '<style>body{font-family:system-ui,sans-serif;line-height:1.7;max-width:760px;margin:0 auto;padding:16px;color:#222}li{margin:6px 0}</style></head><body><main>'
  + `<h1>${values.brand} プライバシーポリシー</h1>`
  + `<p>この文書は、${values.brand}の入口（https://manabi-map.app/）での情報の扱いを書いたものです。入口から開く各サービスでの扱いは、それぞれのサービスのプライバシーポリシーをご覧ください。</p>`
  + '<h2>1. 運営者・連絡先</h2><ul><li>運営者: ishizakahiroshi（個人による OSS プロジェクト）</li><li>連絡先: <a href="https://high-school.manabi-map.app/legal/privacy/">高校・高専のプライバシーポリシー</a>の「1. 運営者・連絡先」にあるメールアドレス</li></ul>'
  + '<h2>2. 入口で受け取る情報</h2><p>入口には、ログイン・入力欄・お気に入りなどの機能はありません。氏名・メールアドレスなどの個人情報は受け取りません。Cookie も使いません。</p>'
  + '<h2>3. アクセス解析</h2><p>訪問の数を知るために、Cloudflare Web Analytics を使っています。Cookie を使わない計測で、ページの表示や読み込みの速さなどが Cloudflare へ送られます。詳しくは <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare のプライバシーポリシー</a>をご覧ください。ほかの解析・広告のスクリプトは読み込みません。</p>'
  + '<h2>4. 配信の記録</h2><p>入口は Cloudflare のサービスで配信しています。配信のため、Cloudflare が IP アドレスなどの通信の情報を扱います。</p>'
  + '<h2>5. 各サービスのプライバシーポリシー</h2><ul>'
  + '<li><a href="https://high-school.manabi-map.app/legal/privacy/">高校・高専（Manabi Map）</a></li>'
  // 2026-11-13 時点で、ほかのサービス（school / home / kanji / english）には専用のポリシーのページが無い（実物を開いて確認）。できたらここへ足す
  + '</ul><p>小学校・中学校・大学短大・専修学校、地ファクト、たねもじ、たねワードには、まだ専用のプライバシーポリシーがありません。用意したら、ここに載せます。</p>'
  + '<h2>6. 改定</h2><p>2026-11-13 制定。</p>'
  + '<p><a href="/">まなびマップの入口へ</a></p></main></body></html>\n'
const files = {
  '/': ['text/html; charset=utf-8', html],
  '/robots.txt': ['text/plain; charset=utf-8', 'User-agent: *\nAllow: /\nDisallow: /auth/\nDisallow: /mypage\nDisallow: /favorites\nDisallow: /compare\nDisallow: /family/\n\nUser-agent: meta-externalagent\nUser-agent: Amazonbot\nUser-agent: GPTBot\nUser-agent: ClaudeBot\nUser-agent: CCBot\nUser-agent: Bytespider\nAllow: /api/v1/\nAllow: /api/catalog.json\nAllow: /data/\nDisallow: /\n\nSitemap: https://manabi-map.app/sitemap.xml\n'],
  '/sitemap.xml': ['application/xml; charset=utf-8', '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://manabi-map.app/</loc></url><url><loc>https://manabi-map.app/data/</loc></url><url><loc>https://manabi-map.app/legal/privacy/</loc></url></urlset>\n'],
  '/llms.txt': ['text/plain; charset=utf-8', '# まなびマップ\n\n学ぶことと通う場所を見つける入口です。\n\n学校の種類を選ぶ: https://school.manabi-map.app/\n高校・高専: https://high-school.manabi-map.app/\n地ファクト: https://home.manabi-map.app/\nたねもじ（漢字）: https://kanji.manabi-map.app/\nたねワード（英語）: https://english.manabi-map.app/\n\n## 公開データ（API）\n\n全部の学校の種類の一覧: https://manabi-map.app/api/catalog.json\n説明: https://manabi-map.app/data/\n'],
  '/data/': ['text/html; charset=utf-8', dataPage],
  '/legal/privacy/': ['text/html; charset=utf-8', privacyPage],
}
// Worker の本体は runtime.mjs（/api/v1/* の高校版への中継を含む）。本文をそのまま先頭へ写す
const runtime = await readFile(resolve(import.meta.dirname, 'runtime.mjs'), 'utf8')
if (/^\s*(?:import|export)\b/m.test(runtime)) throw new Error('runtime.mjs must not import or export')
const code = `${runtime}\nconst files = ${JSON.stringify(files)};\nexport default { fetch: (request) => handleRequest(request, files, fetch) };\n`
const output = resolve(process.argv[2] ?? 'dist-apex-portal/worker.mjs')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, code, { flag: 'wx' })
console.log(`生成済み: ${output}`)
