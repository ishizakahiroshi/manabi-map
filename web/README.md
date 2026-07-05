# Manabi Map — Web フロントエンド

Vite + React + TypeScript + Tailwind CSS + Supabase。

## セットアップ

```bash
cd web
pnpm install
cp .env.example .env.local   # 実値を記入（Supabase Dashboard → Data API）
```

`.env.local` は gitignored。コミットしないこと。

## 開発サーバー

```bash
pnpm dev
```

http://localhost:5173 が開く。スマホ表示確認は DevTools のデバイスモード（390px 基準）。

## 型チェック / Lint / ビルド

```bash
pnpm typecheck   # tsc --noEmit
pnpm lint        # oxlint
pnpm build       # dist/ に成果物
pnpm preview     # ビルド成果物のローカル確認
```

## 構成

- `src/pages/` — 画面（トップ / 地図 / お気に入り / 認証コールバック / 法務）
- `src/components/` — サイドバー・ログインシート・学校詳細シート等
- `src/contexts/` — 認証状態・アプリ状態（自宅地点・トースト）
- `src/hooks/` — Supabase データ取得（学校・お気に入り・メモ・私の記録）
- `src/lib/` — Supabase client・ジオコーディング・表示規約（§7.7）
- `public/legal/` — 利用規約・プライバシーポリシー（Markdown）

## デプロイ（Cloudflare Pages）

- Build command: `cd web && pnpm install && pnpm build`
- Build output directory: `web/dist`
- 環境変数: `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
- SPA ルーティングのため `public/_redirects` で `/* /index.html 200` を配信
