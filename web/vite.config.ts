import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// バージョン単一ソース: git タグ（`vX.Y.Z`）から build 時に注入する。
// - HEAD がタグ commit のとき   : "0.2.1"        （＝リリース本番表示）
// - タグから進んでいるとき      : "0.2.1+3-abc1234"（＝develop / main プレビュー）
// - dirty（ローカル未 commit）   : "0.2.1+3-abc1234-dirty"
// - git が使えない / タグ無し    : package.json の version にフォールバック
//
// 環境変数 VERSION_OVERRIDE があれば無条件でそれを使う（緊急脱出用）。
// Cloudflare Pages は shallow clone なので、build 前に tags を fetch しておくこと
// （package.json の "build" スクリプトで `git fetch --tags --depth=1 || true` を実行）。
function resolveVersion(): string {
  if (process.env.VERSION_OVERRIDE) return process.env.VERSION_OVERRIDE
  try {
    const raw = execSync('git describe --tags --always --dirty --match "v*"', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim()
    // raw examples: "v0.2.1", "v0.2.1-3-gabc1234", "v0.2.1-3-gabc1234-dirty", "abc1234" (タグ無し)
    const m = raw.match(/^v(\d+\.\d+\.\d+)(?:-(\d+)-g([0-9a-f]+))?(-dirty)?$/)
    if (m) {
      const [, semver, ahead, sha, dirty] = m
      if (!ahead) return `${semver}${dirty ?? ''}`
      return `${semver}+${ahead}-${sha}${dirty ?? ''}`
    }
    // タグが 1 つも無い環境（新規リポ等）: sha だけ返る
    if (/^[0-9a-f]{7,}(-dirty)?$/.test(raw)) return `0.0.0+${raw}`
    return raw
  } catch {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
      version: string
    }
    return `${pkg.version}+nogit`
  }
}

const APP_VERSION = resolveVersion()
// build ログに残す（Cloudflare Pages の build log から確認できる）
console.log(`[manabi-map] APP_VERSION = ${APP_VERSION}`)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
})
