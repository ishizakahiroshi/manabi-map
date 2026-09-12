#!/usr/bin/env node
/**
 * 通信量バジェット検査（docs/local/plan_data-usage-audit.md C5）
 *
 * 目的は「増えたら気づく」こと。体験の良し悪しは測れない。
 * **CI が緑でも画面は保証されない。** 目視は別途必要（ui-change-verify）。
 *
 * 背景: 主な利用者は中高生でモバイル回線の残量が少ない、という製品の原則
 * （docs/reference_manabi-map-operating-rules.md「通信量（ギガ）」）。
 * 2026-09-11 に 2 件の事故が実測で見つかった。
 *   - Web フォントが県ページ 1 枚で約 2.8MB（本体の 9 倍）→ v0.9.1 で撤去
 *   - 地図の全国データが 3.79MB → C2 で 0.81MB へ分割
 * どちらも「入れた時点では誰も測っていなかった」ことが共通している。
 * この検査はその再発を機械で止めるためにある。
 *
 * 比較に使うのは **gzip level 9 のサイズ**。Cloudflare は実際には brotli を使うので
 * 実転送量とは一致しないが、ビルド間で安定して比較できる代理値として使う。
 * `.gz` ファイルは再圧縮されないのでファイルサイズをそのまま使う。
 *
 * 使い方: node scripts/check-payload-budget.mjs [--dist dist] [--json]
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const distArg = argv.indexOf('--dist')
const DIST = distArg >= 0 ? argv[distArg + 1] : 'dist'
const AS_JSON = argv.includes('--json')
const WEB_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/**
 * 個別ファイルのバジェット。
 * `budget` は gzip level 9 のバイト数（`.gz` は素のファイルサイズ）。
 * `measured` は 2026-09-11 の実測値。**根拠を 1 行ずつ必ず書くこと。**
 * 余裕はおおむね 15〜25%。これを超える増加は「気づくべき変化」とみなす。
 */
const FILE_BUDGETS = [
  {
    key: 'app-js',
    // **1 ファイルではなく「初回に必ず読む JS の集合」を測る。**
    // dist/index.html の entry <script> と <link rel="modulepreload"> を全部足す。
    // ルート単位の動的 import（C4）を入れると、共通依存が別チャンクへ切り出されて
    // entry と一緒に modulepreload される。`assets/index-*.js` だけを見ていると、
    // 切り出したぶんが測定から消えて「減った」と誤読する（実際は同時に落ちている）。
    entryModuleSet: true,
    budget: 290_000,
    measured: 233_105,
    measuredAt: '2026-09-12',
    why: 'アプリ本体（entry + modulepreload されるチャンク）。全画面に乗るので 1 バイトの増加が全画面に効く',
  },
  {
    key: 'app-css',
    pattern: /^assets\/index-[^/]+\.css$/,
    budget: 20_000,
    measured: 12_431,
    why: 'アプリ本体の CSS。全画面に乗る',
  },
  {
    key: 'map-js',
    pattern: /^assets\/MapPage-[^/]+\.js$/,
    budget: 75_000,
    measured: 57_733,
    why: '地図画面の追加チャンク。Leaflet 一式を含む',
  },
  {
    key: 'map-css',
    pattern: /^assets\/MapPage-[^/]+\.css$/,
    budget: 12_000,
    measured: 6_779,
    why: '地図画面の追加 CSS',
  },
  {
    key: 'map-payload',
    pattern: /^schools-map-[^/]+\.json\.gz$/,
    budget: 1_000_000,
    measured: 812_905,
    why: 'C2 で全国一括 3,790,673 B から分けたもの。ここが戻ると /map が元の重さに戻る',
  },
  {
    key: 'pref-page-html',
    // 県ページのうち最大のもの。2026-09-11 の実測では東京（54,511 B）が最大で、
    // 北海道（C1 で測った 37,740 B）ではない。校数ではなく本文量で決まる。
    pattern: /^pref\/[^/]+\/index\.html$/,
    pickLargest: true,
    budget: 70_000,
    measured: 54_511,
    why: 'SSR 出力の県ページ。検索からの着地が最も多いページ群の最大値（東京）',
  },
]

/**
 * 合計のバジェット。「その画面を初めて開いた人が払うバイト数」に近い単位で見る。
 * 個別が全部セーフでも合計で増えていれば気づけるようにする。
 */
const COMPOSITE_BUDGETS = [
  {
    key: 'pref-page-initial',
    parts: ['pref-page-html', 'app-js', 'app-css'],
    budget: 380_000,
    measured: 299_709,
    measuredAt: '2026-09-12',
    why: '県ページの初回表示。検索から来た人が最初に払う量（最大の県＝東京で測る）',
  },
  {
    key: 'map-initial',
    parts: ['app-js', 'app-css', 'map-js', 'map-css', 'map-payload'],
    budget: 1_300_000,
    measured: 1_120_813,
    measuredAt: '2026-09-12',
    why: 'トップから地図へ入るまでの累計（地図タイルを除く）。2026-09-11 の Preview 実測は 1,142,918 B で、C4 の分割後は 1,120,813 B',
  },
]

/**
 * 外部ドメインの allowlist。
 * **ここに無いホストが増えたら落ちる。**「外部から取ってくるものを足す前に転送量を実測する」
 * という原則（operating-rules の「通信量（ギガ）」）を機械で担保するための網。
 * 足すときは、足す理由と実測した転送量を docs/local/plan_data-usage-audit.md へ書いてから。
 */
const ALLOWED_HOSTS = new Set([
  'static.cloudflareinsights.com', // Web Analytics の beacon
  'cloudflareinsights.com', // 同 送信先
  'tile.openstreetmap.org', // 地図タイル
  'nominatim.openstreetmap.org', // 住所検索
  'msearch.gsi.go.jp', // 国土地理院の住所検索
  '*.supabase.co', // DB / 認証
])

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, base, out)
    else out.push({ rel: relative(base, full).split('\\').join('/'), size: st.size, full })
  }
  return out
}

function transferSize(file) {
  if (file.rel.endsWith('.gz')) return file.size
  return gzipSync(readFileSync(file.full), { level: 9 }).length
}

/**
 * dist/index.html が初回に必ず読む JS の集合を返す（entry script + modulepreload）。
 * プリレンダーした各ページ（県・学校・legal…）は同じ index.html を雛形にするので、
 * ここで測った集合がそのまま全ページの初期 JS になる。
 */
function entryModuleFiles(files, distPath) {
  const html = readFileSync(join(distPath, 'index.html'), 'utf8')
  const refs = new Set()
  for (const m of html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)) refs.add(m[1])
  for (const m of html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)) refs.add(m[1])
  const wanted = [...refs].map((r) => r.replace(/^\//, ''))
  const matched = files.filter((f) => wanted.includes(f.rel))
  if (matched.length !== wanted.length) {
    const missing = wanted.filter((w) => !matched.some((f) => f.rel === w))
    throw new Error(`[budget] index.html が参照する JS が dist にありません: ${missing.join(', ')}`)
  }
  return matched
}

function collectHosts() {
  const hosts = new Set()
  const add = (text) => {
    for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9.*-]+)/g)) hosts.add(m[1])
    for (const m of text.matchAll(/wss:\/\/([A-Za-z0-9.*-]+)/g)) hosts.add(m[1])
  }
  const indexHtml = join(WEB_ROOT, 'index.html')
  const headers = join(WEB_ROOT, 'public', '_headers')
  // index.html は自サイトの絶対 URL（OGP 等）を大量に含むので、外部読み込みになる
  // 属性だけを対象にする。CSP はディレクティブ本文をそのまま見る。
  if (existsSync(indexHtml)) {
    const html = readFileSync(indexHtml, 'utf8')
    for (const m of html.matchAll(/<(?:script|link|img|iframe)\b[^>]*?(?:src|href)="([^"]+)"/g)) add(m[1])
  }
  if (existsSync(headers)) {
    const text = readFileSync(headers, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue
      if (/Content-Security-Policy/i.test(line)) add(line)
    }
  }
  hosts.delete('manabi-map.app')
  return hosts
}

function main() {
  const distPath = join(WEB_ROOT, DIST)
  if (!existsSync(distPath)) {
    console.error(`[budget] ${distPath} がありません。先に pnpm build を実行してください。`)
    process.exit(2)
  }
  const files = walk(distPath)
  const rows = []
  const measuredByKey = new Map()
  const failures = []

  for (const b of FILE_BUDGETS) {
    const matched = b.entryModuleSet
      ? entryModuleFiles(files, distPath)
      : files.filter((f) => b.pattern.test(f.rel))
    if (matched.length === 0) {
      failures.push(`[budget] ${b.key}: 対象ファイルが見つかりません（pattern=${b.pattern}）`)
      continue
    }
    const sized = matched.map((f) => ({ ...f, t: transferSize(f) }))
    // entryModuleSet は「初回に必ず読む集合」なので合計で見る。それ以外は 1 ファイル。
    const target = b.entryModuleSet
      ? {
          rel: sized
            .sort((a, c) => c.t - a.t)
            .map((f) => f.rel)
            .join(' + '),
          t: sized.reduce((a, c) => a + c.t, 0),
        }
      : b.pickLargest
        ? sized.reduce((a, c) => (c.t > a.t ? c : a))
        : sized.sort((a, c) => c.t - a.t)[0]
    measuredByKey.set(b.key, target.t)
    const over = target.t > b.budget
    if (over) {
      failures.push(
        `[budget] ${b.key} が上限を超えました: ${target.t} B > ${b.budget} B（${target.rel}）\n` +
          `         ${b.measuredAt ?? '2026-09-11'} の実測は ${b.measured} B。理由: ${b.why}`,
      )
    }
    rows.push({ key: b.key, file: target.rel, size: target.t, budget: b.budget, over })
  }

  for (const c of COMPOSITE_BUDGETS) {
    const missing = c.parts.filter((p) => !measuredByKey.has(p))
    if (missing.length) {
      failures.push(`[budget] ${c.key}: 構成要素が測れませんでした（${missing.join(', ')}）`)
      continue
    }
    const total = c.parts.reduce((a, p) => a + measuredByKey.get(p), 0)
    const over = total > c.budget
    if (over) {
      failures.push(
        `[budget] ${c.key} が上限を超えました: ${total} B > ${c.budget} B\n` +
          `         内訳: ${c.parts.map((p) => `${p}=${measuredByKey.get(p)}`).join(' + ')}\n` +
          `         ${c.measuredAt ?? '2026-09-11'} の実測は ${c.measured} B。理由: ${c.why}`,
      )
    }
    rows.push({ key: c.key, file: `(${c.parts.join(' + ')})`, size: total, budget: c.budget, over })
  }

  const hosts = collectHosts()
  const unknown = [...hosts].filter((h) => !ALLOWED_HOSTS.has(h))
  if (unknown.length) {
    failures.push(
      `[budget] allowlist に無い外部ホストが増えました: ${unknown.join(', ')}\n` +
        `         足す前に転送量を実測し、docs/local/plan_data-usage-audit.md へ記録してから\n` +
        `         scripts/check-payload-budget.mjs の ALLOWED_HOSTS へ追加してください。`,
    )
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ rows, hosts: [...hosts], failures }, null, 2))
  } else {
    const pad = (s, n) => String(s).padStart(n)
    console.log('payload budget (gzip level 9 / .gz はそのまま):')
    for (const r of rows) {
      const mark = r.over ? 'OVER' : ' ok '
      const pct = Math.round((r.size / r.budget) * 100)
      console.log(`  [${mark}] ${r.key.padEnd(18)} ${pad(r.size, 9)} B / ${pad(r.budget, 9)} B (${pad(pct, 3)}%)  ${r.file}`)
    }
    console.log(`  外部ホスト: ${[...hosts].sort().join(', ') || '(なし)'}`)
  }

  if (failures.length) {
    console.error('')
    for (const f of failures) console.error(f)
    console.error('')
    console.error('[budget] 上限は「増えたら気づく」ための網です。上げる前に、')
    console.error('         その増加が利用者にとって必要かを docs/local/plan_data-usage-audit.md で判断してください。')
    process.exit(1)
  }
  console.log('[budget] OK: すべて上限内。allowlist 外の外部ホストもありません。')
}

main()
