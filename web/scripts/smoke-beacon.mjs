// Cloudflare Web Analytics の beacon が本番で注入されているか確認するスモークテスト。
// Automatic setup は edge がブラウザ UA にだけ beacon を注入するため、curl 既定 UA では
// 検出できない（plan_analytics-measurement-repair.md の実測記録）。必ずブラウザ相当の
// UA を使う。CSP enforce 昇格後に beacon がブロックされると計測が静かに止まるので、
// デプロイ後や CSP 変更後に手動で回して外形確認する。
//
// 実行例:
//   node scripts/smoke-beacon.mjs
//   node scripts/smoke-beacon.mjs --url https://manabi-map.app/pref/gunma/
//   node scripts/smoke-beacon.mjs --url https://example.pages.dev/
//
// beacon が見つかれば 0、見つからなければ 1 で終了する。
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'https://manabi-map.app/' },
  },
})

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const MARKERS = ['cloudflareinsights', 'beacon.min.js']

await (async () => {
  const url = values.url
  console.log(`smoke-beacon: GET ${url} (browser UA)`)
  let response
  try {
    response = await fetch(url, {
      headers: {
        'user-agent': BROWSER_UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    })
  } catch (err) {
    console.error(`smoke-beacon: fetch 失敗 — ${err.message}`)
    process.exitCode = 1
    return
  }

  if (!response.ok) {
    console.error(`smoke-beacon: HTTP ${response.status} ${response.statusText}`)
    process.exitCode = 1
    return
  }

  const html = await response.text()
  const found = MARKERS.filter((m) => html.includes(m))

  if (found.length === 0) {
    console.error(`smoke-beacon: beacon 未検出（${MARKERS.join(' / ')} が無い）`)
    console.error('  CSP enforce 済みか・UA がブラウザ相当か・URL が本番を向いているか確認')
    process.exitCode = 1
    return
  }

  console.log(`smoke-beacon: OK — 検出マーカー ${found.join(', ')}（${html.length} bytes）`)
})()