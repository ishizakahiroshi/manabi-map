import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { gitVersion } from '@ishizakahiroshi/vite-plugin-git-version'

// 学校サイトの住所（origin）の正本は web/data/site.json（読み方は scripts/lib/site.mjs と同じ）。
// index.html の canonical・OGP・JSON-LD は住所の部分を __SITE_ORIGIN__ と書いておき、ここで差し込む
// （docs/local/school/plan_school-subdomain-move.md C1）。dev サーバーとビルドの両方で効く。
const SITE_ORIGIN_PLACEHOLDER = '__SITE_ORIGIN__'
const site = JSON.parse(readFileSync(new URL('./data/site.json', import.meta.url), 'utf8')) as { origin: string }

function siteOriginHtml(): Plugin {
  return {
    name: 'manabi-map-site-origin',
    transformIndexHtml: {
      // 'pre' にするのは、Vite が og:image・twitter:image・link の href を資産として解決するより前に
      // 絶対 URL へ戻すため。後だと __SITE_ORIGIN__/og-hero.png を相対パスの資産として扱ってしまう。
      order: 'pre',
      handler(html) {
        // 手書きの URL に戻すと、住所の切替（同 plan C4）で index.html だけが取り残される。
        if (!html.includes(SITE_ORIGIN_PLACEHOLDER)) {
          throw new Error(
            `index.html に ${SITE_ORIGIN_PLACEHOLDER} が無い（住所は web/data/site.json から差し込む）`,
          )
        }
        return html.replaceAll(SITE_ORIGIN_PLACEHOLDER, site.origin)
      },
    },
  }
}

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
  // .env ファイルの探索先。既定は web/（従来どおり）。
  // 環境変数 MANABI_MAP_ENV_DIR を設定すると、リポジトリ外のディレクトリを見る。
  // 秘密をリポジトリ配下に置かないための仕組み（環境変数に入るのはパスだけ・値は入らない）。
  // 未設定なら従来どおり web/.env.local を読むので、他環境・CI・Cloudflare Pages は無影響
  // （Pages はファイルではなく Pages env を process.env として渡すため、そもそも影響しない）。
  envDir: process.env.MANABI_MAP_ENV_DIR || undefined,
  plugins: [
    react(),
    tailwindcss(),
    gitVersion({ logName: 'manabi-map' }),
    siteOriginHtml(),
  ],
})
