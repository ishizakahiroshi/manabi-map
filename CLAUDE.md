<!-- このファイルはプロジェクト固有ルールのみを書く。個人/グローバル AI ルール
（言語・確認スタイル・出力フォーマット等）は各 AI ツールのグローバル設定へ。
fresh public clone でも有効な内容に保つこと。 -->

# manabi-map 開発ガイド

## プロジェクト概要

**Manabi Map（まなびマップ）は「親子で使う、学校選びの地図ノート」**。住所を入れると通える高校が地図に表示され、気になる学校をお気に入り保存し、文化祭・説明会・通学経路・親子の感想を学校ごとに家族でメモできる進路検討サービス。中学生と保護者が対象。**巨大な偏差値サイトではなく、進路選択を管理するプロダクト**を目指す（企画書 §2）。

群馬県版として 2026-07-05 に v0.1.0 を本番公開（https://manabi-map.app）。現行の最新リリースは `git tag --sort=-v:refname | head -1` / `web/package.json` の `version` を正典とすること（この CLAUDE.md にバージョン番号を直書きすると更新漏れで stale 化する）。個人 OSS（コード AGPL-3.0 / データ CC BY-SA 4.0）。偏差値は商用サイトから転載せず、公的資料を参考にした「Manabi Map 編集推計」を、根拠を確認できた範囲で掲載する。

## やらないこと（スコープ外）

AI からの機能追加打診を防ぐため、明示的に切り捨てている範囲:

- **ネイティブアプリ / exe 化**: Web 完結（PWA）で通す。App Store / Play Store には出さない
- **巨大偏差値サイト化・ランキングサイト化**: 偏差値を単体で大きく見せない（§7.7 表示規約）。学校の序列づけ・合否煽りをしない
- **自由口コミの大量収集**: 荒れやすいので当面やらない（将来やるなら構造化口コミ・承認制）
- **塾送客メディア化**: 塾アフィリは信頼を損なわない範囲の 1〜2 枠のみ（§7.5）。広告の種類は下記「広告ポリシー」に厳格に従う
- **商用偏差値サイトからのスクレイピング・数値転載**: 絶対にしない（`plan_data-acquisition-strategy.md`）
- **有料課金・決済の本実装**: 本サービスは無料 OSS で通す。収益は広告＋塾アフィリのみ

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

Supabase / LINE の接続情報はリポジトリ外に保管する。既定では `web/.env.local`（gitignored）に `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` を転記して使う。

**env をリポジトリ配下に一切置かない運用（推奨）**: 環境変数 `MANABI_MAP_ENV_DIR` に `.env.local` を置いたディレクトリの絶対パスを設定すると、`vite.config.ts`（`envDir`）・`web/scripts/gen-schools-json.mjs`・`scripts/maintenance.mjs` の 3 つがそのディレクトリを参照する。未設定なら従来どおり `web/` を見るため、他環境・CI・Cloudflare Pages は無影響（Pages はファイルではなく Pages env を `process.env` として渡すので元から無関係）。**環境変数に入るのはパスだけで、鍵の値は入らない。** 特に `scripts/maintenance.mjs` は service role key を読むため、この方式だとリポジトリ配下に本物の秘密が置かれなくなる。

作者ローカルの保管パスなど個人環境固有の情報は `CLAUDE.local.md`（gitignored）に記載する。

## AI 作業共通ルール

ビルド・コミット禁止、secrets-scan 責務、plan/bugfix/pending md の作成ルール等の AI 作業共通ルールは、各利用者のグローバル AI 設定に従う（作者環境の例: `~/.claude/CLAUDE.md` および `~/.claude/guides/`）。

### 外部サービスの設定は推測で答えない（必ず台帳を Read する）

Cloudflare / Supabase / Google Search Console / GitHub Secrets の設定は、**リポジトリを grep しても分からない**（設定の実体が外部サービス側にあるため）。台帳は `docs/local/reference_external-services.md`（gitignored・作者環境のみ）。

**次のいずれかに該当したら、答える前・手を動かす前に必ず Read する:**

- 「〜は設定されているか」「〜は有効か」「〜入れてなかったっけ」に類する問い
- 外部サービスの設定を変更する作業
- 「コードに無いから未導入」と結論づけそうになったとき

**推測で答えると誤診する。**2026-08-06 に Cloudflare Web Analytics を「未導入」と誤診した実例がある（Automatic setup は edge でブラウザ UA にだけ beacon を注入するため、`curl` の既定 UA では検出できない）。**bot 判定を伴う機能を curl で検証すると偽陰性が出る。**

台帳を持たない環境（他人の clone・別 AI CLI）では、**推測で断定せずユーザーに確認する**こと。

外部サービスの設定を変更したら、**同じターンで台帳を更新する**。誤診したら台帳の「AI が誤診した実例」節に、なぜ間違えたかとどう検証すべきだったかを追記する。

### plan の進捗は親の表だけで判断しない

親子構成の plan では、**親の `## context配分` の 1 行が子 plan 全体（内部 C1〜Cn）を指す**。親が `plan` でも子の大半が完了していることがある。**必ず子 plan の表と実行記録まで開く。**2026-08-06 に `plan_seo-growth-strategy.md` の C5 を未着手と誤診した実例がある（実際は内部 C1〜C5 が実装済み・本番反映済みで、残りは C6 のみ）。

### ナビゲーション面は 3 つある（1 つ直して「対応した」にしない）

導線（メニュー項目・リンク）を足す・変えるときは、**必ず次の 3 面すべてを確認する**。

| 面 | 実体 | 出る場所 |
|---|---|---|
| サイドバー | `web/src/components/Sidebar.tsx` | 全画面（ハンバーガーメニュー）。**アプリ利用者が最初に触る** |
| フッター（React） | `web/src/components/SiteFooter.tsx` | トップ・県ハブ・学校ハブ・404 の 4 画面のみ。ページ最下部 |
| フッター（プリレンダー） | `web/scripts/gen-seo-pages.mjs` の `FOOTER_HTML` | 検索・直リンク・クローラーが最初に受け取る静的 HTML |

- **`Sidebar.tsx` の中だけで 2 箇所ある**（「サービス情報」の項目群と、最下部のリンク行）
- 表示ラベルの実体は `web/data/site-footer-links.json`。**コンポーネントに文字列を直書きしない**
  （公開方針の文言は `web/data/dataset-claims.json`。どちらも `verify-static-output.test.mjs` が再ハードコードを検出する）
- 地図画面と学校詳細にはフッターが無いので、**フッターだけ直すと地図から辿れないまま残る**

2026-08-07 に `/data/`（公開データと API）の導線を追加した際、フッターだけ直して「全ページから 1 ホップ」と報告し、
サイドバーを見落とした。指摘を受けて直した後も `Sidebar.tsx` 内の 2 箇所目を見落として再指摘された。
**面を先に列挙してから着手し、変更後は全面で再確認する。**

### メンテナンスモードの AI トリガー

- ユーザーが「メンテにして」「メンテモード ON」「メンテ入れて」等と言ったら、`node scripts/maintenance.mjs on` を実行する。
- 「メンテ解除」「メンテ OFF」「メンテ戻して」等は `node scripts/maintenance.mjs off` を実行する。
- 状態確認は `node scripts/maintenance.mjs status` を実行する。
- CLI は `.env.local` の service role key を読むため、キーを出力・ログ・コミットしない。参照先は `MANABI_MAP_ENV_DIR`（設定時）または `web/`（未設定時）。
- DB 復元中など CLI が DB に到達できない非常時だけ、既存の env var + Retry deployment 経路を使う。

## 利用可能な skill（作者環境）

このプロジェクト向けに専用 skill を用意している。**skill を起動できる環境なら、下記の操作は直接手作業でやらず skill 経由が原則**（手順の一貫性・記録の再現性のため）。skill が無い環境（他人の clone や別 AI CLI）では手動手順として本 CLAUDE.md 下記の「運用ルール」を読み下してください。

配置は 2 系統に分かれる:

- **本リポ専用の 4 本**（`manabi-map-deploy` / `manabi-map-add-prefecture` / `manabi-map-info-wanted-field` / `manabi-map-field-backfill`）は **リポ内 `.claude/skills/` にある**（2026-07-23 に作者環境の横断棚から移設・以降ここへ新設）。`.gitignore` が `.claude/` を丸ごと除外しているため **clone には含まれない**（作者環境固有の絶対パスを公開しないため）
- **横断 skill**（`supabase-migrate` / `taxonomy-refactor` / `changelog-freshness` など）は作者環境の `~/.claude/skills/` 配下

| 用途 | skill | 起動語 |
|---|---|---|
| 本番反映全体（versioned / no-tag、backup → migration → データ投入 → 検証 → プレビュー → main マージ → 条件付きタグ） | `manabi-map-deploy` | 「manabi-map リリース」「タグなしで本番反映」「DB migration の続き」 |
| 新県データ投入（schools SQL + deviation SQL + 校パターン再分類 + course_type_master 確認） | `manabi-map-add-prefecture` | 「◯◯県 追加」「manabi-map に◯◯県入れて」「新県 データ投入」 |
| nullable な学校情報を「情報提供募集中」型で追加（テンプレ・i18n・CSS・実装メモ生成） | `manabi-map-info-wanted-field` | 「情報提供募集中 field 追加」「空欄可能フィールド」「manabi-map-info-wanted-field」 |
| 欠損項目の一括補完（公式カタログから抽出 → 出典つき SQL 生成 → gap を理由つきで記録） | `manabi-map-field-backfill` | 「欠損項目 補完」「学科 埋めて」「ふりがな 補完」「一括補完」 |
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
| 進行中の plan | `docs/local/plan_*.md` |
| **外部サービス設定の台帳（Cloudflare / Supabase / Google / GitHub）** | `docs/local/reference_external-services.md` — 上記「外部サービスの設定は推測で答えない」の参照先 |
| 設定済み項目・調査結果などの参照資料 | `docs/local/reference_*.md`（SEO / Search Console・Supabase provider・データ収集 playbook 等） |
| 手順書（バックアップ・復元・メンテナンスモード・リリース） | `docs/local/manual_*.md` |
| 過去バージョンの企画・設計・実装記録（アーカイブ・非公開） | `docs/local/archive/<version>/`（v0.1.1 に MVP 詳細企画書 / OSS 憲章 / データ取得戦略 / モック / phase-1 実装 plan / recap 等） |
