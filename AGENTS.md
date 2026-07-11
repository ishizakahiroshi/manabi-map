# Agent Entry Point (manabi-map)

このリポジトリの運用ガイダンスは `CLAUDE.md` を正本とする。

- プロジェクト概要・ルール: `./CLAUDE.md`
- ユーザー向けドキュメント: `./README.md`
- ローカル/プライベート追記（存在する場合・コミットしない）: `./CLAUDE.local.md` / `./AGENTS.local.md` / `./docs/local/`

個人/グローバル AI ルールは意図的にこのリポジトリの外に置く。各 AI ツールの
グローバル設定を使うこと。本ファイルは fresh public clone でも有効に保つ。

作者環境では以下の専用 skill が用意されている（詳細は `CLAUDE.md` の「利用可能な skill」節）:

- `manabi-map-deploy` — バージョンリリース全体（backup → migration → データ投入 → 検証 → main マージ → タグ）
- `manabi-map-add-prefecture` — 新県データ投入（schools SQL + deviation SQL + 校パターン再分類）
- `supabase-migrate` — Supabase 本番 migration 適用（Docker 不要）
- `taxonomy-refactor` — 分類列の master + FK + trigger 化 refactor

skill が使えない環境では `CLAUDE.md` の「運用ルール」節を手順書として読み下す。

## Non-negotiables (full detail in CLAUDE.md)

<!-- TODO: プロジェクト固有の絶対ルールを 2〜4 個。例:
- 実データ（PII・本番 ID・トークン）は絶対にコミットしない
- 既定は dry-run。実操作は明示フラグ必須
- 公開 fixture はダミーのみ
-->

- 公開 fixture（テストデータ・サンプル設定・例示プロンプト）は実値ではなく **最初から合成データで書く**。動作確認の実値を fixture に化石化しない
- 公開ファイル（README/CLAUDE.md/AGENTS.md/src/**）の新規作成・大改訂時は、**コミット前に外部 KB の表示名列で grep し、ヒットがあればマスク or 一般化する**。手で実行する場合: `node scripts/secrets-scan.mjs --staged --block`。pre-commit hook（layer 2）が自動で走るが、書く瞬間の自問が一次防御
- 本リポジトリへのコミット・ビルド・公開はユーザー指示があるまで実行しない（house 標準）

ガイダンス間で矛盾が出たら `CLAUDE.md` を優先する。

<!-- many-ai-cli の承認マーカーブロックはここに自動注入される。本ファイルでは持たない。 -->
