import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { gitVersion } from '@ishizakahiroshi/vite-plugin-git-version'

// バージョン単一ソース: git タグ（`vX.Y.Z`）から build 時に注入する。
// - HEAD がタグ commit のとき   : "0.2.1"        （＝リリース本番表示）
// - タグから進んでいるとき      : "0.2.1+3-abc1234"（＝develop / main プレビュー）
// - dirty（ローカル未 commit）   : "0.2.1+3-abc1234-dirty"
// - git が使えない / タグ無し    : package.json の version にフォールバック
//
// 環境変数 VERSION_OVERRIDE があれば無条件でそれを使う（緊急脱出用）。
// Cloudflare Pages は shallow clone なので、build 前に tags を fetch しておくこと
// （package.json の "build" スクリプトで `git fetch --tags --depth=1 || true` を実行）。
//
// 実装は @ishizakahiroshi/vite-plugin-git-version に抽出済み（2026-07-07）。
// 背景: docs/local/plan_vite-plugin-git-version.md
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    gitVersion({ logName: 'manabi-map' }),
  ],
})
