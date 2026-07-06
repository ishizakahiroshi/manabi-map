<!-- このファイルはプロジェクト固有ルールのみを書く。個人/グローバル AI ルール
（言語・確認スタイル・出力フォーマット等）は各 AI ツールのグローバル設定へ。
fresh public clone でも有効な内容に保つこと。 -->

# manabi-map 開発ガイド

## プロジェクト概要

**Manabi Map（まなびマップ）は「親子で使う、学校選びの地図ノート」**。住所を入れると通える高校が地図に表示され、気になる学校をお気に入り保存し、文化祭・説明会・通学経路・親子の感想を学校ごとに家族でメモできる進路検討サービス。中学生と保護者が対象。**巨大な偏差値サイトではなく、進路選択を管理するプロダクト**を目指す（企画書 §2）。

群馬県版として 2026-07-05 に v0.1.0 を本番公開（https://manabi-map.app）。個人 OSS（コード AGPL-3.0 / データ CC BY-SA 4.0）。偏差値は商用サイトから転載せず、公的資料に基づく「Manabi Map 独自推計」を掲載する。

## やらないこと（スコープ外）

AI からの機能追加打診を防ぐため、明示的に切り捨てている範囲:

- **ネイティブアプリ / exe 化**: Web 完結（PWA）で通す。App Store / Play Store には出さない
- **巨大偏差値サイト化・ランキングサイト化**: 偏差値を単体で大きく見せない（§7.7 表示規約）。学校の序列づけ・合否煽りをしない
- **自由口コミの大量収集**: 荒れやすいので当面やらない（将来やるなら構造化口コミ・承認制）
- **塾送客メディア化**: 塾アフィリは信頼を損なわない範囲の 1〜2 枠のみ（§7.5）。広告の種類は下記「広告ポリシー」に厳格に従う
- **商用偏差値サイトからのスクレイピング・数値転載**: 絶対にしない（`plan_data-acquisition-strategy.md`）
- **有料課金・決済の本実装**: v0.1 は無料 OSS。収益は広告＋塾アフィリのみ

## 広告ポリシー（Non-negotiable・絶対に守る）

未成年（中高生）と保護者が使う進路サービスであり、**信頼がプロダクトの核**。広告は「進路・教育に直接関係するもの」だけを、控えめに入れる。ここは例外なく守る。

**入れてよい広告（進路・教育系のみ）**:
- 学習塾・予備校・個別指導・オンライン教室
- 大学・専門学校・私立高校・通信制高校の学校広告
- 通信教育・模試・問題集/参考書など受験関連

**絶対に入れない広告**:
- **無差別アドネットワークのランダム配信**（Google AdSense 等の、内容を選ばず自動表示されるディスプレイ広告）。教育カテゴリに限定配信できない限り使わない
- 消費者金融・カードローン / ギャンブル / アダルト / 情報商材・情報教材 / 出会い系 / その他 進路と無関係な広告全般
- モーダル・インタースティシャル・自動再生動画・追従バナー（§7.5.3 禁じ手リスト）

**実装方針**: 広告枠は塾アフィリ（A8/もしも等）や教育系 ASP から**手動で選定した案件**を出す。「広告を増やしたい」「AdSense を貼れば楽」という打診はしない（この方針より収益を優先しない）。NPO/自治体連携版では広告全 OFF（§7.5.4）。

## 技術スタック

| 層 | 採用 | 備考 |
|---|---|---|
| フロント | React 19 + TypeScript(strict) + Vite | `web/` 配下 |
| スタイル | Tailwind CSS v4（`@theme` トークン） | オレンジ #ff7a3d 基調 |
| 地図 | Leaflet + OpenStreetMap タイル | 素の Leaflet を useRef/useEffect で制御 |
| ジオコーディング | OSM Nominatim（400ms デバウンス） | 将来 国土地理院 API へ切替検討 |
| バック | Supabase（PostgreSQL + Auth + RLS） | 専用 API サーバーなし・フロントから直接 |
| 認証 | LINE（Custom OIDC）＋ Anonymous | LINE は非 OIDC 構成で HS256 問題を回避（下記注意） |
| ホスティング | Cloudflare Pages（Git 連携・自動デプロイ） | main push = 本番反映 |
| ドメイン | manabi-map.app（Cloudflare Registrar） | Email Routing で hello@/takedown@/sns@ 等を転送 |

**LINE 認証の注意**: Supabase Custom Provider は「openid なしで作成 → 非 OIDC タイプ化 → userinfo は `/oauth2/v2.1/userinfo` + JWKS 空欄 → 後から openid 追加」の順で構成すること。素直に OIDC で作ると LINE のウェブログイン（ID トークンが HS256 署名）と Supabase の ES256 検証が衝突して必ず失敗する。再現手順の正典は `docs/local/archive/v0.1.1/plan_phase-1-app-implementation.md` の「Task B 完全完了」節。

## ディレクトリ構成

- `web/` — フロントエンド（Vite + React）
  - `src/pages/` — 画面（トップ / 地図 / お気に入り / 認証コールバック / 法務）
  - `src/components/` — サイドバー・ログインシート・学校詳細シート等
  - `src/contexts/` — 認証状態（AuthContext）・アプリ状態（AppContext: 自宅地点・トースト）
  - `src/hooks/` — Supabase データ取得（useSchools / useUserData）
  - `src/lib/` — supabase client・geo（ジオコーディング/距離）・format（§7.7 表示規約）
  - `public/legal/` — 利用規約 / プライバシーポリシー / サードパーティライセンス（Markdown）
  - `public/` — アイコン一式・manifest・_redirects（SPA ルーティング）
- `scripts/` — secrets-scan.mjs / install-hooks.{ps1,sh}
- `.githooks/` — pre-commit（secrets-scan layer 2）
- `docs/local/` — 非公開の企画・plan（gitignored）。旧版は `docs/local/archive/<version>/`
- `LICENSE` / `THIRD_PARTY_NOTICES.md` — ライセンス（AGPL-3.0 / 依存一覧）

## 主要コマンド

```
cd web && pnpm install     # 依存インストール（初回・.env.local を用意）
cd web && pnpm dev         # 開発サーバー（http://localhost:5173）
cd web && pnpm typecheck   # 型チェック（tsc --noEmit）
cd web && pnpm lint        # oxlint
cd web && pnpm build       # 本番ビルド（dist/）
node scripts/secrets-scan.mjs --staged --block   # 手動 secrets-scan（layer 1）
```

Supabase / LINE の接続情報はリポジトリ外に保管する。`web/.env.local`（gitignored）に `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` を転記して使う。作者ローカルの保管パスなど個人環境固有の情報は `CLAUDE.local.md`（gitignored）に記載する。

## AI 作業共通ルール

ビルド・コミット禁止、secrets-scan 責務、plan/bugfix/pending md の作成ルール等の AI 作業共通ルールは、各利用者のグローバル AI 設定に従う（作者環境の例: `~/.claude/CLAUDE.md` および `~/.claude/guides/`）。

## 利用可能な skill（作者環境）

このプロジェクト向けに専用 skill を用意している（作者環境の `~/.claude/skills/` 配下）。**skill を起動できる環境なら、下記の操作は直接手作業でやらず skill 経由が原則**（手順の一貫性・記録の再現性のため）。skill が無い環境（他人の clone や別 AI CLI）では手動手順として本 CLAUDE.md 下記の「運用ルール」を読み下してください。

| 用途 | skill | 起動語 |
|---|---|---|
| バージョンリリース全体（backup → migration → データ投入 → 検証 → プレビュー → main マージ → タグ） | `manabi-map-deploy` | 「manabi-map リリース」「v0.x.y 出して」「関東の次のリリース」 |
| 新県データ投入（schools SQL + deviation SQL + 校パターン再分類 + course_type_master 確認） | `manabi-map-add-prefecture` | 「◯◯県 追加」「manabi-map に◯◯県入れて」「新県 データ投入」 |
| Supabase 本番へ migration 適用（Docker 不要・psql 直叩き・backup + schema_migrations 記録） | `supabase-migrate` | 「Supabase migration 適用」「本番 DB に SQL 流して」「pg_dump backup 取って」 |
| フリーテキスト分類列 → master + FK + trigger 化（表記ゆれ・分類漏れ対策） | `taxonomy-refactor` | 「分類を master 化」「course_type refactor」「表記ゆれ対策」 |

学科分類の正典は `~/.claude/guides/reference_mext-highschool-classification.md`（MEXT 学校教育法施行規則 §81 + 学校基本調査 17 分類）。新県データ投入時は必ず参照。

## 運用ルール（このプロジェクト固有）

### ブランチ / リリースフロー（2026-07-05 制定）

- **main = 本番**。Cloudflare Pages の Git 連携により main への push が即・自動で https://manabi-map.app にデプロイされる。**main へ直接コミットしない**
- **修正・機能追加は `develop` ブランチで行う**。develop への push は Cloudflare Pages が**プレビュー環境**（`https://<hash>.manabi-map.pages.dev`）を自動生成するので、そこで動作確認する（Supabase 認証のリダイレクトは `*.manabi-map.pages.dev` 登録済みでプレビューでも動く）
- リリース手順: develop で修正 → プレビューで確認 → main へマージ（= 本番デプロイ）→ 節目で `manual_release-vX.Y.Z_日付.md` を作成し `git tag vX.Y.Z` を打つ（タグは記録用アンカー・デプロイには無影響）
- 参照: `docs/local/archive/v0.1.1/manual_release-v0.1.0_2026-07-05.md`（初回リリースの記録・定常手順）

### Supabase DB 変更の適用方針

- DB 変更は **Supabase SQL Editor への手貼りを標準にしない**。原則として `web/supabase/migrations/` 配下に migration SQL を置き、`supabase db push` で適用できる形にする
- `web/supabase/migrations/` に置くのは schema 変更・RLS・関数など、公開 repo に載せてよい DB 構造変更を基本とする。学校データの大量 `insert` / `update` は GitHub 上で丸見えになるため、公開する意思がある場合だけ migration 化する
- 学校データ投入 SQL は原則 `docs/local/`（gitignored）に置き、適用は人間が `psql` などで実行する。作業分担用は `docs/local/seed-parts/*.sql`、適用用にまとめる場合も `docs/local/*.sql` を使う
- migration は人間が内容確認してから適用する。AI は SQL ファイル作成・検証までは行ってよいが、ユーザー指示なしに本番 Supabase へ `db push` / `psql` 実行しない
- ローカル/個人環境の接続情報、DB パスワード、Supabase access token、project ref は公開ファイルに書かない。必要なら `CLAUDE.local.md` や gitignored なローカルメモに置く
- 適用前チェック: `pnpm typecheck` / `pnpm lint`、migration SQL の `begin;` / `commit;`、新規テーブル有無、商用偏差値サイト由来データが混じっていないことを確認する
- 標準コマンド例（project link 済みの場合）:

```
cd web
pnpm dlx supabase db push
```

### データ・PII の扱い

- ユーザーの検索地点は「自宅住所」ではなく「中心地点」として扱う（企画書 §16.5）。お気に入り・メモ・個人偏差値記録は RLS で本人限定
- 偏差値シードは公的資料のみ・`source_type='manabi_estimate'` / `estimate_method='v1_<pref>_<year>'`。商用サイト由来の値を混ぜない
- 削除・訂正要請は takedown@manabi-map.app（24h 受信確認・7 日以内対応）

## secrets-scan 配線（このリポ固有）

責務・一般化ルールはグローバル正典に従う（上記「AI 作業共通ルール」参照）。本リポの配線:

- layer 1（手動検証）: `node scripts/secrets-scan.mjs --staged --block`
- layer 2（pre-commit hook）: `.githooks/pre-commit`（導入は `scripts/install-hooks.ps1` / `.sh`）
- layer 3（CI）: `.github/workflows/secrets-scan.yml`
- env: `KB_ROOT` / `FAMILY_ROOT`（未設定なら構造 regex のみで継続。詳細は `scripts/secrets-scan.mjs` の冒頭コメント）

## 関連ドキュメント

| 項目 | パス |
|---|---|
| ユーザー向け README | `README.md` |
| Codex/他 AI 用入口 | `AGENTS.md` |
| フロントエンド開発ガイド | `web/README.md` |
| 進行中の plan（群馬全域 v0.1.2 / 関東 v0.2 / SNS 等） | `docs/local/plan_*.md` |
| v0.1 の企画・設計・実装記録（アーカイブ・非公開） | `docs/local/archive/v0.1.1/`（MVP 詳細企画書 / OSS 憲章 / データ取得戦略 / モック / phase-1 実装 plan / recap 等） |
