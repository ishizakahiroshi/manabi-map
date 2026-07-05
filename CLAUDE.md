<!-- このファイルはプロジェクト固有ルールのみを書く。個人/グローバル AI ルール
（言語・確認スタイル・出力フォーマット等）は各 AI ツールのグローバル設定へ。
fresh public clone でも有効な内容に保つこと。 -->

# manabi-map 開発ガイド

## プロジェクト概要

<!-- TODO: 1〜2 段落で、このプロジェクトが何で、誰のためのもので、何を解決するかを書く。
README から重複してでも、AI が常時ロードして思考の前提にできる粒度で。
現状: `docs/local/` 配下の `manabi-map_MVP_詳細企画書.md` / `manabi-map_OSS.md` / `manabi-map_mvp_mock.html` / `収益化.md`（いずれも gitignored・非公開）で企画・モック段階。 -->

## やらないこと（スコープ外）

<!-- TODO: 「機能追加の打診」を AI から防ぐため、明示的に切り捨てている範囲を列挙する。
例: GUI / exe 化 / 複数 DB 対応 / 自動アップデート / 多言語 UI 等。 -->

## 技術スタック

<!-- TODO: 実装着手時に確定。企画書側で決まったフロント/バック/ホスティングを 1 行ずつ表に。 -->

| 層 | 採用 | 備考 |
|---|---|---|
| フロント | TODO | |
| バック | TODO | |
| ホスティング | TODO | |

## ディレクトリ構成

<!-- TODO: ルート直下の主要フォルダ・ファイルを 1 行解説付きで列挙する。
詳細は別ドキュメントに譲ってよい。 -->

## 主要コマンド

<!-- TODO: 開発・テスト・ビルドのよく使うコマンドを 1 行ずつ。 -->

## AI 作業共通ルール

ビルド・コミット禁止、secrets-scan 責務、plan/bugfix/pending md の作成ルール等の AI 作業共通ルールは、各利用者のグローバル AI 設定に従う（作者環境の例: `~/.claude/CLAUDE.md` および `~/.claude/guides/`）。

## 運用ルール（このプロジェクト固有）

- <!-- TODO: スコープを絞る方針、安全側のデフォルト、テストの最低ライン、PII 取扱い等 -->

## secrets-scan 配線（このリポ固有）

責務・一般化ルールはグローバル正典に従う（上記「AI 作業共通ルール」参照）。本リポの配線:

- layer 1（手動検証）: `node scripts/secrets-scan.mjs --staged --block`
- layer 2（pre-commit hook）: `.githooks/pre-commit`（導入は `scripts/install-hooks.ps1` / `.sh`）
- layer 3（CI）: `.github/workflows/secrets-scan.yml`
- env: `KB_ROOT` / `FAMILY_ROOT`（未設定なら構造 regex のみで継続。詳細は `scripts/secrets-scan.mjs` の冒頭コメント）

## 関連ドキュメント

| 項目 | パス |
|---|---|
| ユーザー向け README | `README.md`（TODO 作成） |
| Codex/他 AI 用入口 | `AGENTS.md` |
| MVP 詳細企画書（非公開） | `docs/local/manabi-map_MVP_詳細企画書.md` |
| OSS 検討（非公開） | `docs/local/manabi-map_OSS.md` |
| 収益化検討（非公開） | `docs/local/収益化.md` |
| モック（非公開） | `docs/local/manabi-map_mvp_mock.html` |
| ローカル作業ノート（非公開） | `docs/local/` |
