# Changelog

本プロジェクトの変更履歴（[Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) 準拠・[SemVer](https://semver.org/lang/ja/) 準拠）。

各バージョンの詳細な実行記録は `docs/local/manual_release-vX.Y.Z_YYYY-MM-DD.md`（非公開・gitignored）にある。ここは公開レポの正史。

## [v0.3.1] - 2026-07-13

### Added
- 「情報募集中」項目からその場で情報提供・訂正報告できる簡易フォーム（`data_reports` テーブル + 管理者ダッシュボードのレポートタブで承認フロー）
- 管理者ダッシュボードの KPI タイルに前期間比 delta 表示（▲/▼/− + 数値 + 色。色だけに頼らずアクセシビリティ配慮）
- runtime メンテナンスモード切替（`app_config` テーブル + realtime 反映 + 管理者ダッシュボードのトグル UI + `scripts/maintenance.mjs` CLI）。従来の `VITE_MAINTENANCE_MODE` env var は DB 復元中など緊急時の保険として残す
- `school_deviation_values.estimate_basis` 列と `application_ratio_legacy AND is_active` を拒否する CHECK 制約（偏差値推計経路の恒久的品質防壁）
- 関東 6 都県の私立高校の入試実績 1,145 行（群馬 42/栃木 60/埼玉 100/千葉 177/東京 505/神奈川 261）。県教委・私学主管課の一括公表資料からの転記のみで、募集人員・応募者数が中心（受検/合格は一括資料に載らないため空欄・秋以降に追補予定）。茨城は一括公表なしにより対象外

### Changed
- 自宅設定後の地図初期ズームを、最寄り 15 校目までの距離ベース fitBounds に変更（10〜40km でクランプ・都市部は狭く / 地方は広く自動調整）。従来は東日本リージョン初期値の zoom 5（日本全図）に据え置かれ、毎回手動ズームが必要だった
- 管理者ダッシュボードの型を `web/src/types/admin.ts` に集約し、UI と Cloudflare Pages Functions で単一ソース化

### Fixed
- 保存済み自宅の復元経路でも通学圏へ自動 fit するよう修正（v0.3.0 東日本拡大でリージョン zoom が 5 に広がり顕在化していた症状）

## [v0.3.0] - 2026-07-12

### Added
- 東日本 13 道県（北陸 3・甲信越 3・東北 6・北海道）の学校データを投入し、対応地域を**東日本 20 都道県・2,589 校**へ拡大
- 入試実績（募集・志願・受検・合格 × 年度・20 都道県 × 直近 3 年）を学校詳細シートに表示（`school_admission_stats` テーブル新設・県教委等の公的資料の転記のみ）
- 管理者ダッシュボード基盤（日次スナップショット収集 workflow + Cloudflare Pages Functions の管理者 API + ダッシュボード画面）
- アプリ側メンテナンスモード（バナー表示 + 書込停止）
- schools.json の build hash 付き URL 化（`schools-manifest.json` 経由・キャッシュ反映ラグ解消）

### Changed
- ACTIVE_REGION を関東 1 都 6 県から東日本 20 都道県へ（郵便番号上 3 桁の複数レンジ対応・bbox 拡張・地図初期表示・検索例の文言）
- 校名の短縮表示を「立」を含まない公立正式名（北海道・宮城・長野の「北海道◯◯高等学校」形式）に対応
- secrets-scan にメールアドレス検知（allowlist 方式）を追加

### Fixed
- 2026-07-12 リリース前監査の修正一式（検索圏 bbox の福井嶺南・東京都島嶼の被覆漏れ / ホーム地点ラベルの県名処理一般化 / Supabase 直読みモードのページング / 長野県の読みがなデータ 58 件修正）

## [v0.2.4] - 2026-07-10

### Fixed
- OAuth callback の error クエリ検知と失敗のユーザー表示・LINE ボタン文言統一（Google ログイン有効化を含む）

## [v0.2.3] - 2026-07-09

### Added
- SEO 基盤（robots.txt / sitemap.xml / 学校別プリレンダー 1,362 校）・学校詳細シートの住所・郵便番号表示

## [v0.2.2] - 2026-07-08

### Added
- 偏差値修正ワークフロー（管理者上書き RPC・「私の記録」の [自署] ラベル・レビューキュー）・BottomTabBar・マイページ・リージョン内検索連動（地図 bounds 方式の絞り込み）

## [v0.2.1] - 2026-07-07

### Changed
- 偏差値バンドを「40 台 / 40 未満」に分割ほか UI 改善・version 表記の git タグ単一ソース化

## [v0.2.0] - 2026-07-07

### Added
- 関東 1 都 6 県への拡大（1,362 校）・学科分類の master 化（MEXT 17 分類 → UI 10 分類・`course_type_master` + trigger）

## [v0.1.5] - 2026-07-06

### Added
- Cloudflare Pages のレスポンスヘッダ設定 `web/public/_headers`（`X-Frame-Options: DENY` / `X-Content-Type-Options: nosniff` / `Referrer-Policy: strict-origin-when-cross-origin` / `Permissions-Policy` で camera/microphone/payment/usb を無効化）
- テスト基盤 vitest 導入（`web/vitest.config.ts` / `web/src/lib/format.test.ts` / `web/src/lib/geo.test.ts`）
- `pnpm-workspace.yaml` を追加し依存の hoisting を明示制御
- Supabase マイグレ `202607070201_v0.1.5_dedup_and_triggers.sql`（`user_school_deviations` の `department_id=NULL` 重複掃除 + `unique nulls not distinct` 化 + `moddatetime` トリガによる `updated_at` 自動更新）

### Changed
- `useUserData`: お気に入り/メモ/自己偏差値の取得失敗時に空データで上書きしない挙動へ改修。`toggleFavorite` を楽観更新 + DB 失敗時ロールバック方式へ変更
- `AppContext.persistHome`: fire-and-forget 設計を維持しつつ select/update/insert 失敗を `console.error` で追跡（住所値は PII のためログに載せない）
- `AuthContext`: `supabase.auth.getSession()` に catch を追加し、ストレージアダプタ異常でも `loading` がスタックしないよう修正

### Fixed
- （v0.1.4 派生 hotfix / v0.1.4 タグには含まれない・main には既に反映済）
  - nightly-backup workflow を URL 形式単一 Secret から `SUPABASE_DB_HOST/PORT/USER/NAME/PASSWORD` の split-secret + `PGPASSWORD` 方式へ書き換え。libpq URL parse エラー時の password fragment 漏洩を構造で排除
  - Supabase Free の Direct connection が IPv6-only で GHA runner から到達不能な問題を Session Pooler 経由に切替
  - Supabase 17.6 と Ubuntu 24.04 標準の `pg_dump` v16.14 の meta-version 不一致を PostgreSQL 公式 apt repo + `postgresql-client-17` で解消

## [v0.1.4] - 2026-07-06

### Added
- nightly-backup workflow（`.github/workflows/nightly-backup.yml`）: 毎日 JST 03:00 に Supabase を `pg_dump` → gzip → age 暗号化 → Cloudflare R2 `nightly/YYYY-MM-DD.dump.gz.age` へ PUT。30 日保持
- AdSlot 骨組み（`src/data/ad-slots.ts` / `src/lib/utm.ts` / `AdSlot.tsx`）と UTM 自動付与（`utm_source=manabi-map` / `utm_medium=<placement>` / `utm_campaign=v0.1.4-launch` / `utm_content=school-<id>`）。ダミー案件のみ・実案件は ASP 承認後の別 diff
- 法務ページに「5.5 広告表示について」節（AdSense 不使用・PR ラベル明示・UTM は集計目的）と利用規約「第 9 条 広告」を詳細化

### Changed
- Leaflet attribution UX 改修: `map.attributionControl.setPrefix(false)` で「Leaflet |」を消去。学校詳細シート open 時は `body[data-sheet-open="true"]` トグルで attribution を CSS 非表示
- attribution テキストロジックを `src/lib/attribution.ts` に集約（Protomaps 化に向けた下地）

## [v0.1.3] - 2026-07-06

### Added
- 課程（全日制 / 定時制 / 通信制）と連携校スキーマ（`school_course_time[]` / `main_school_name` / `campus_type`）を追加
- 全校生徒数 + 年度（`total_students` / `enrollment_year`）と男女比（`male_ratio`）フィールド
- 群馬県立太田フレックス高等学校を追加（群馬 79 校に）
- 学校詳細シートに「規模: 約 800 人（2026 年）」「男女比: 男 55% / 女 45%」表示
- schools 静的化: `web/scripts/gen-schools-json.mjs` で Supabase から `web/public/schools.json` を吐き出し、`useSchools` はデフォルトで `/schools.json` を fetch（Supabase egress を Free 枠 5 GB 内に）
- float-bar / bottom sheet に「課程」フィルタ 3 チップ（**通信制は初期 OFF**）

### Changed
- Cloudflare Web Analytics（クッキーレス）有効化

## [v0.1.2.3] - 2026-07-05

### Added
- OGP メタタグと hero 画像を追加（SNS シェア対応）

## [v0.1.2.2] - 2026-07-05

### Fixed
- 徒歩/自転車の所要時間係数を現実寄りに調整（徒歩 12 → 15 min/km・自転車 4 → 5 min/km）

## [v0.1.2.1] - 2026-07-05

### Fixed
- 桐生市立商業高校が「商業高校」に短縮されてどの市か分からなくなる短縮校名バグを修正

## [v0.1.2] - 2026-07-05

### Added
- 密集ピンを `leaflet.markercluster` でクラスタ化
- 4 モードの所要時間（徒歩 / 自転車 / バス / 車）表示
- float-bar フィルタを 4 分類ドロップダウン + 半径スライダーに刷新
- ピンラベルを 2 行化して長い校名でも偏差値を見せる
- 偏差値フィルタに「未測定」オプション追加
- 学科フィルタに「総合学科」を独立グループとして追加
- PC でマウスホバー時にピンを最前面 + アクセント枠

### Fixed
- 学科フィルタが `commercial_*` / `agricultur*` の細分値を拾えていなかった問題
- float-bar の `overflow:auto` でポップオーバーがクリップされる問題

### Changed
- CLAUDE.md に広告ポリシーを Non-negotiable として追記

## [v0.1.1] - 2026-07-05

### Added
- 校舎アイコン（ピン内部モチーフを本から校舎へ）
- UI 仕上げとドキュメント刷新
- ライセンス確定（コード AGPL-3.0-or-later / データ CC BY-SA 4.0）

## [v0.1.0] - 2026-07-05

### Added
- 群馬県版 MVP を https://manabi-map.app で本番公開
- 住所ジオコーディング（OSM Nominatim / 400ms デバウンス）
- Leaflet + OpenStreetMap タイルでの地図表示
- お気に入り機能・学校ごとの家族メモ
- LINE ログイン（Custom OIDC・非 OIDC 構成で HS256 問題を回避）+ 匿名ログイン
- Cloudflare Pages Git 連携による main push = 本番自動デプロイ
