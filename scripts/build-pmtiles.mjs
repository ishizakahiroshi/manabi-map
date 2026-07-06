#!/usr/bin/env node
/**
 * build-pmtiles.mjs — 日本領域の PMTiles を Protomaps 公式 daily build から切り出す薄いラッパー。
 *
 * 設計方針（docs/local/map-migration-research-report_2026-07-06.md §1.2 の重要な発見）:
 *   - **planetiler / tippecanoe は不要**。Protomaps が全球 basemap PMTiles（z0-15・約 120 GB）を
 *     daily build で無償公開しており、`pmtiles extract` が **リモート URL に対して HTTP Range で
 *     指定 bbox の分だけダウンロード**するため、planet 120 GB を落とさずに日本だけ切り出せる。
 *   - 生成物（推定 3〜6 GB @z15 / 2〜3 GB @z14）は Cloudflare R2 無料枠 10 GB 内に収まる見込み。
 *   - 月次更新は「差分」ではなく **ファイル丸ごと再生成 → R2 に上書き upload**（PMTiles は read-only 形式）。
 *
 * 前提ツール（このリポジトリには同梱しない・実行環境に用意する）:
 *   - go-pmtiles CLI（単体バイナリ）。https://github.com/protomaps/go-pmtiles/releases
 *     例（Linux）:
 *       curl -L https://github.com/protomaps/go-pmtiles/releases/latest/download/pmtiles_Linux_x86_64.tar.gz | tar xz
 *   - PATH に `pmtiles` を通すか、環境変数 PMTILES_BIN で実体パスを指定する。
 *
 * このスクリプトがやること:
 *   1. 当日（UTC）の daily build URL を組み立て、`pmtiles extract <url> <out> --bbox=... --maxzoom=...` を実行する。
 *   2. 当日 build がまだ無い（HTTP エラー）場合は前日分へ 1 回フォールバックする（build 遅延対策）。
 *   3. 生成後のサイズを表示する（R2 無料枠 10 GB 内かの目視確認用）。
 *
 * このスクリプトがやらないこと（人間 / CI の責務）:
 *   - R2 バケット作成・カスタムドメイン設定（コード外の手作業）。
 *   - R2 への upload（`pmtiles upload` を使う。CI では下記コメントの手順、
 *     ローカルでは --upload と R2_* 環境変数を渡した時のみ実行する）。
 *   - Cloudflare 認証情報の保持（このスクリプトは R2 の秘密鍵を一切持たない）。
 *
 * 使い方:
 *   node scripts/build-pmtiles.mjs                       # japan.pmtiles を z0-15 で生成
 *   node scripts/build-pmtiles.mjs --maxzoom=14          # z0-14（サイズ半減・高校選び用途は実用十分）
 *   node scripts/build-pmtiles.mjs --out=japan.pmtiles   # 出力先を明示
 *   node scripts/build-pmtiles.mjs --date=20260706       # daily build の日付を固定（既定は当日 UTC）
 *   PMTILES_BIN=/opt/pmtiles node scripts/build-pmtiles.mjs
 *
 * R2 への upload（生成後・別ステップ。秘密情報が要るので環境変数で渡す）:
 *   pmtiles upload japan.pmtiles japan.pmtiles \
 *     --bucket="s3://manabi-map-tiles?region=auto&endpoint=$R2_ENDPOINT"
 *   （AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY / AWS_SECRET_ACCESS_KEY=$R2_SECRET_KEY を環境に設定）
 *
 * GitHub Actions での月次自動更新の workflow 案は `docs/local/drafts/pmtiles-monthly-update.yml`
 * にある（.github には意図的に置かない — R2 バケット確定・secrets 登録が済んでから配置する）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'

// 日本の bounding box（西端の与那国島〜東端の南鳥島 / 南端の沖ノ鳥島〜北端の択捉島を含む広め）。
// research レポート §1.2 と同値。
const JAPAN_BBOX = '122.93,20.42,153.99,45.56'
const BUILD_BASE = 'https://build.protomaps.com'
const PMTILES_BIN = process.env.PMTILES_BIN || 'pmtiles'

function parseArgs(argv) {
  const opts = { maxzoom: '15', out: 'japan.pmtiles', date: null, upload: false }
  for (const a of argv) {
    if (a === '--upload') opts.upload = true
    else if (a.startsWith('--maxzoom=')) opts.maxzoom = a.slice('--maxzoom='.length)
    else if (a.startsWith('--out=')) opts.out = a.slice('--out='.length)
    else if (a.startsWith('--date=')) opts.date = a.slice('--date='.length)
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/build-pmtiles.mjs [--maxzoom=15] [--out=japan.pmtiles] [--date=YYYYMMDD] [--upload]')
      process.exit(0)
    }
  }
  return opts
}

/** UTC の YYYYMMDD 文字列（offsetDays=1 で前日） */
function utcDateStr(offsetDays = 0) {
  const d = new Date(Date.now() - offsetDays * 86400_000)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function runExtract(dateStr, out, maxzoom) {
  const url = `${BUILD_BASE}/${dateStr}.pmtiles`
  console.log(`[build-pmtiles] extract ${url} -> ${out} (bbox=${JAPAN_BBOX} maxzoom=${maxzoom})`)
  const res = spawnSync(
    PMTILES_BIN,
    ['extract', url, out, `--bbox=${JAPAN_BBOX}`, `--maxzoom=${maxzoom}`],
    { stdio: 'inherit' },
  )
  if (res.error) {
    console.error(`[build-pmtiles] failed to spawn "${PMTILES_BIN}". go-pmtiles CLI を PATH に通すか PMTILES_BIN で指定してください。`)
    console.error(res.error.message)
    process.exit(127)
  }
  return res.status === 0
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const primaryDate = opts.date || utcDateStr(0)

  let ok = runExtract(primaryDate, opts.out, opts.maxzoom)
  if (!ok && !opts.date) {
    // 当日 build 未生成のことがあるため前日分へ 1 回フォールバック
    const prev = utcDateStr(1)
    console.warn(`[build-pmtiles] ${primaryDate} の build が取得できませんでした。前日 ${prev} にフォールバックします。`)
    ok = runExtract(prev, opts.out, opts.maxzoom)
  }
  if (!ok) {
    console.error('[build-pmtiles] extract に失敗しました。')
    process.exit(1)
  }

  if (existsSync(opts.out)) {
    const gb = statSync(opts.out).size / 1024 ** 3
    console.log(`[build-pmtiles] done: ${opts.out} = ${gb.toFixed(2)} GB（R2 無料枠 10 GB 内かを確認）`)
  }

  if (opts.upload) {
    console.log('[build-pmtiles] --upload は安全のためこのスクリプトからは実行しません。')
    console.log('  次を手動 or CI で実行してください（R2_* を環境に設定した上で）:')
    console.log(`  pmtiles upload ${opts.out} ${opts.out} --bucket="s3://manabi-map-tiles?region=auto&endpoint=$R2_ENDPOINT"`)
  }
}

main()
