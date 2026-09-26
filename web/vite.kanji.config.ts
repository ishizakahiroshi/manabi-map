import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { gitVersion } from '@ishizakahiroshi/vite-plugin-git-version'

// 漢字アプリ（たねもじ。旧仮称 Manabi Map 漢字）専用の Vite 設定。
// 2026-09-24 C9 レビュー should 4: 仮称のままだった表記を正式名称に直した（このファイルは
// C1 で作った漢字アプリ専用のファイルなので変えてよい。34 行目の gitVersion の logName
// 'manabi-map-kanji' は内部の識別子なので変えていない）。
// 学校サイトの vite.config.ts とは分ける（親 plan D-2 / D-3）。
// - D-2: コードは web/src/kanji/、入口は web/kanji/index.html、出力は web/dist-kanji/。
//   学校サイトの web/index.html・web/src/main.tsx・web/vite.config.ts・web/public/・
//   functions/ には手を入れない。
// - D-3: Cloudflare Pages でも学校サイトとは別プロジェクトにし、Pages の Root directory を
//   web にする。リポジトリ直下を root にすると functions/（管理 API とメンテナンスの
//   middleware）まで漢字サイトに載るため。このファイルはビルド設定のみを担当し、
//   Pages 側の設定は親 plan C2 で行う。
const kanjiSrcDir = fileURLToPath(new URL('./src/kanji/', import.meta.url))

export default defineConfig({
  // root を web/kanji にする。実行時の cwd に依らないよう絶対パスで指定する。
  root: fileURLToPath(new URL('./kanji', import.meta.url)),
  // 学校サイトの web/public（schools-*.json.gz 等）を読み込ませない。
  publicDir: fileURLToPath(new URL('./kanji/public', import.meta.url)),
  // 既定だと学校サイトの dev サーバーと同じ web/node_modules/.vite を使い、同時に動かすと
  // 依存の事前バンドルのキャッシュを奪い合う（2026-09-23 レビューの指摘）。専用のキャッシュ先にする。
  cacheDir: fileURLToPath(new URL('./node_modules/.vite-kanji', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('./dist-kanji', import.meta.url)),
    emptyOutDir: true,
  },
  plugins: [
    react(),
    // web/src/index.css 先頭の `@import "tailwindcss"` を処理するために必要。
    tailwindcss(),
    gitVersion({ logName: 'manabi-map-kanji' }),
  ],
  resolve: {
    // root が web/kanji なので、web/kanji/index.html の `/src/kanji/main.tsx` はそのままだと
    // web/kanji/src/kanji/main.tsx に解決されて見つからない（2026-09-23 レビューで判明。
    // dev サーバーは SPA フォールバックで HTML を返すため白画面になり、build は通るので
    // build だけでは気づけない）。root の外にある web/src/kanji/ を指す絶対パスへ書き換える。
    alias: [
      { find: /^\/src\/kanji\//, replacement: kanjiSrcDir },
    ],
  },
  server: {
    // 学校サイトの dev サーバー（デフォルト 5173）と同時に動かせるようにする。
    port: 5174,
  },
  // Phase 1 は環境変数を使わないので envDir は指定しない（既定の web/kanji を見るが、
  // .env ファイル自体を置かないので実質未使用）。
})
