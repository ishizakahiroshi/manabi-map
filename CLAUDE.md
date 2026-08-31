<!-- このファイルは常時ロードする入口と正典索引。詳細本文はリンク先で管理する。 -->

# manabi-map 開発ガイド

## プロジェクト概要

- Manabi Map は、親子で学校を探し、地図・お気に入り・家族メモを使う進路検討サービス。
- Web / React / TypeScript / Vite / Supabase / Cloudflare Pages で構成する。公開の説明は [`README.md`](README.md) を読む。
- 最新版は `git tag --sort=-v:refname | head -1` と [`web/package.json`](web/package.json) を正本とする。CLAUDE.md に版番号や校数を固定値で書かない。
- コードは AGPL-3.0-or-later、公開データは CC BY-SA 4.0。全国版のデータ範囲と出典は [`DATA.md`](DATA.md) を読む。

## 製品境界・広告・データ

製品のやらないこと、教育系広告だけを許可する方針、個人情報・偏差値相当値・公開 API の境界は [`docs/reference_manabi-map-operating-rules.md`](docs/reference_manabi-map-operating-rules.md) を正本とする。

- ネイティブ化、ランキングサイト化、商用偏差値の転載、自由口コミ大量収集、有料課金の本実装は提案しない。
- 公開 fixture は合成データだけで作る。外部 KB の表示名・実値・秘密を公開ファイルへ残さない。
- 既存の表示・API・RLS のガードを緩める提案をしない。機械的な強制層は正本コードとテストを読む。

## 技術スタックと配置

| 層 | 正本 |
|---|---|
| React / TypeScript / Vite | `web/src/`、`web/package.json` |
| Supabase / RLS / migrations | `web/supabase/` |
| Cloudflare Pages | `.github/workflows/`、`README.md` |
| scripts / secrets-scan | `scripts/`、`.githooks/` |
| 公開データ・ライセンス | `DATA.md`、`LICENSE`、`THIRD_PARTY_NOTICES.md` |

## 主要コマンド

```text
cd web && pnpm typecheck
cd web && pnpm lint
cd web && pnpm test
node scripts/secrets-scan.mjs --staged --block
```

依存インストール、build、環境変数の置き場所は [`web/package.json`](web/package.json) と [`CLAUDE.local.md`](CLAUDE.local.md) を読む。鍵の値を出力しない。

## SSR・hydration の不変条件

SSR、初期データ、storage 復元、静的出力の検査は [`docs/reference_manabi-map-operating-rules.md`](docs/reference_manabi-map-operating-rules.md) と `web/src/entry-server.tsx` / `web/src/contexts/` / `web/scripts/verify-static-output.mjs` を入口にする。

## ナビゲーションの不変条件

導線変更は `web/src/components/Sidebar.tsx` と `web/src/components/SiteFooter.tsx` の両面、表示データは `web/data/site-footer-links.json` / `web/data/dataset-claims.json`、検査は `web/scripts/verify-static-output.test.mjs` を確認する。

## 運用・リリース

- `main` は本番、`develop` は Preview。release plan の検証とユーザーの明示承認を経て main へマージする。main へ直接コミットしない。
- リリース・backup・復元・maintenance の詳細は [`docs/reference_manabi-map-operating-rules.md`](docs/reference_manabi-map-operating-rules.md) と `docs/local/plan_release-vX.Y.Z*.md` / `docs/local/manual_*.md` を読む。
- AI はユーザー指示なしに commit、build、本番 deploy、Supabase `db push` / `psql` を実行しない。

## Supabase・外部サービス

- schema / RLS / function は `web/supabase/migrations/`、適用前の構造確認は `web/supabase/baseline_schema.sql` と migration 本文を使う。学校データ大量投入は公開範囲を確認してから行う。
- Cloudflare / Supabase / GSC / GitHub Secrets の実効設定は repo 検索で推測しない。作者環境の `docs/local/reference_external-services.md` を先に Read する。
- maintenance の on / off / status は `node scripts/maintenance.mjs <status|on|off>`。service role key をログ・会話・公開ファイルへ出さない。

## secrets-scan

- layer 1（手動）: `node scripts/secrets-scan.mjs --staged --block`
- layer 2（pre-commit）: `.githooks/pre-commit`。導入は `scripts/install-hooks.ps1` / `.sh`
- layer 3（CI）: `.github/workflows/secrets-scan.yml`
- env や needles の詳細は `scripts/secrets-scan.mjs` と `CLAUDE.local.md`。公開 clone でも構造 regex は動かす。

## AI と project skill

- 個人・グローバル AI 規約、言語・確認スタイル・plan の作成規則は各 AI ツールの global settings に置く。
- 作者環境向けの repo skill は `.claude/skills/`。使える場合は deploy、migration、県追加、field backfill、GSC、監査follow-upの手作業を skill 経由にする。
- 学科分類の正典は作者環境の `reference_mext-highschool-classification.md`。新県データ投入時に参照する。

## 関連ドキュメント

- ユーザー向け: [`README.md`](README.md)、[`DATA.md`](DATA.md)
- 製品・運用正本: [`docs/reference_manabi-map-operating-rules.md`](docs/reference_manabi-map-operating-rules.md)
- 進行中の plan / runbook: `docs/local/plan_*.md` / `docs/local/manual_*.md`
- 作者環境の外部サービス台帳: `docs/local/reference_external-services.md`
- 過去記録: `docs/local/archive/<version>/`

## 文書変更時の検査

```text
node scripts/check-claude-md.mjs
```

行数・節長・正本リンクを検査する。予算を上げる前に詳細本文を正本側へ降格する。
