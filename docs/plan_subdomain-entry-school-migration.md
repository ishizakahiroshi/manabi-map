---
type: plan
status: draft
docsweep_state: planned
tags: [subdomain, school, portal, migration]
owner: ishizakahiroshi
review_status: draft
related: [docs/reference_portal-grand-design.md, docs/design_portal-grand-design_2026-09-27.html, docs/plan_subdomain-entry-school-migration_c1_sqlite-static-source.md]
last_reviewed: 2026-09-28
due: 2026-10-04
work_id: WK-20260927T012339619-12c91aa3
ai_provenance_version: 1
ai_author_agent: codex
ai_author_runtime: many-ai-cli
ai_author_provider: openai
ai_author_model_id: unknown
ai_author_model_display: unknown
ai_author_reasoning: unknown
ai_author_model_source: unavailable
ai_execution_refs: [AIX-20260927T012339619-802f5465, AIX-20260927T013035154-418add22, AIX-20260927T014245084-b8ed6267, AIX-20260927T020842634-377a5976, AIX-20260927T022021395-e4091a1f, AIX-20260927T023525215-afd3f979, AIX-20260927T025536733-91e225ce, AIX-20260927T033306106-5d29fec0, AIX-20260927T042101147-61a75c66, AIX-20260927T043840191-2ce59749, AIX-20260927T045329626-7282b173, AIX-20260927T045915321-c91c2c5c, AIX-20260927T133203809-1be98664, AIX-20260927T134321078-340d3dfa, AIX-20260927T224037255-d31ce0ae, AIX-20260927T233259210-a4511260, AIX-20260928T011802664-b8f39eda]
---

# [計画] 総合入口と学校サブドメインへの移行

## context配分

| C | 種別 | 内容 | 子 plan | 備考/注意点 | AI実行 | 実行モデル |
|---|---|---|---|---|---|---|
| C1 | planned | URL対応表・配信単位・容量を確定する | [SQLite原本・静的生成](plan_subdomain-entry-school-migration_c1_sqlite-static-source.md) | ホストと別Pages方針は採用済み。経路ごとの互換動作・実Pages割当・容量・利用者引継ぎの未検収を詰める | AIX-20260927T025536733-91e225ce; AIX-20260927T033306106-5d29fec0; AIX-20260927T042101147-61a75c66; AIX-20260927T043840191-2ce59749; AIX-20260927T045329626-7282b173; AIX-20260927T045915321-c91c2c5c; AIX-20260927T133203809-1be98664; AIX-20260927T134321078-340d3dfa; AIX-20260927T233259210-a4511260 | implementation: openai / unknown / unknown; implementation: openai / unknown / unknown; implementation: openai / unknown / unknown; implementation: openai / unknown / unknown; implementation: openai / unknown / unknown; implementation: openai / unknown / unknown; implementation: openai / gpt-6-sol / high; review: openai / unknown / unknown; implementation: openai / unknown / unknown |
| C2 | planned | 学校入口と高校版の経路・認証・SEOを整える | — | C1の確定表を画面・静的生成・Functionsへ同時反映 | AIX-20260928T011802664-b8f39eda | verification: openai / unknown / unknown |
| C3 | planned | 総合入口と旧URL互換配信を作る | — | C2のURL・公開API成果物を使用。独立した配信先で検収 | AIX-20260928T011802664-b8f39eda | verification: openai / unknown / unknown |
| C4 | planned | 並行公開・予告・切替・観察を行う | — | 本番反映は別途明示指示。失敗時は公開先と転送を戻す |  |  |

実行順序: 総合入口のグランドデザイン確認済み → `C1 → C2 → C3 → C4`。C1全体は未完了だが、2026-09-27に学校入口 `school.manabi-map.app` と高校入口 `high-school.manabi-map.app` の別Pages・別出力を採用した。高校をschool配下のサブディレクトリへ集約する案は不採用。同じリポ内で入口を管理するA2と、将来の全学校種別への対応予定を明記する方針は維持する。最新承認では候補のローカル実装・合成ビルド・検証・commitに着手し、C2の準備を先行する。本番配備・DNS・実認証・公開日は未承認/未検収であり、C2〜C4の完了とは扱わない。

先行資料: [採用したグランドデザイン](reference_portal-grand-design.md)・[画面と構成のプレビュー](design_portal-grand-design_2026-09-27.html)。C3の設計基準とする。当面は現名称を継続し、総合入口と学校サービスの表示ブランドを独立して切り替えられる設計にする。新名称の決定を移行の前提にしない。変更時は候補の先行利用・商標の一次確認を行う。デザインの採用を本番移行の承認とは扱わない。

協議資料: [総合入口・学校移行・ブランド運用の検討シート](review_portal-school-brand_2026-09-27.html)。既回答を引き継ぎ、費用・配信上限・将来拡張・利用者引継ぎ・更新同期・復旧を比較する。ブラウザ内で新たに選んだ回答は、共有して採用内容を本書へ反映するまで検討記録として扱う。資料の改訂とC1調査の実施を、C1の確定完了やC2〜C4の実装・本番承認と同一視しない。

## 概要

2026-09-28 ローカル候補の追加: 旧apexの認証・家族招待・保存画面を専用学校シェルへ解決する `LEGACY_SCHOOL_SHELL` bindingと、同origin内の安全な認証復帰先を実装した。総合入口は `web/apex-portal/` の独立出力とし、公開確認前のサービスリンクは無効にする。候補buildは完成した同一合成世代の15公開artifactを旧apex/high-schoolで照合し、過去の合成chunk保持・片側欠損/改変の拒否・前世代からの復元を検査する。school 5 / high-school 87 / apex 70 filesで容量・混入gateを通過した。合成providerを使う実React画面でcallback成功・各失敗・timeout・家族招待待機の再開を確認し、総合入口はPC/スマホで実視認した。実OAuth、実旧asset全件、CloudflareのFunctions bundle/header適用、両Pagesの実世代切替とrollbackは別検収。D2の公開順/世代差許容とD3の救済期間/復旧目標は未採択のまま、C1〜C4全体の状態を変更しない。

### 最新の再開入口: 別ホスト・別Pagesの採用（2026-09-27）

正式入口の設計は、学校一覧が `https://school.manabi-map.app/`、高校・高専が `https://high-school.manabi-map.app/`。総合入口のapexも別配信にする。URLを分けるだけでなく、学校入口に高校の全HTML/JSONを同梱せず、Pagesプロジェクトと出力ディレクトリを分離する。ファイル上限は配信先単位なのでサブディレクトリでは枠を分けられない。設定候補は `web/data/deployment-targets.json`、ローカル生成は `web/scripts/build-school-candidates.mjs`、容量検査は `web/scripts/verify-deployment-capacity.mjs` を入口とする。設定内のプロジェクト名はローカル候補IDで、Cloudflare上の作成済み状態を表さない。既存 `web/data/site.json` は本番切替まで維持する。

経路、認証・保存、Android、切替と復旧の調査成果を本書へ反映した。固定した入力に対する局所試験と合成の経路試験の成功は報告済みだが、新しい学校経路・総合入口・旧origin救済・公開TWAの実装と実環境検収は残る。この追記では試験を再実行しておらず、C1の確定完了やC2〜C4の完了にはしない。過去の移転準備とAndroid試作の実績も保持する。

再開順は、**採用済みD1で分離候補・容量を検証 → D2の切替中の公開API世代を確定 → C2/C3の旧認証救済・互換配信を実装 → Web検収 → Android検収 → D3の期間と復旧目標・公開日を判断**。D4の公開Android IDはWeb検収後に決める。旧計画の「同じパスを一括転送」を、新しい総合入口・高校入口へそのまま適用しない。D1の採用をD2〜D4の採用へ広げない。

| ID / 決める時点 | 採用内容または未採用の推奨案 | 選択が変えるもの |
|---|---|---|
| D1 / 採用済み | 学校入口 `https://school.manabi-map.app/` と高校・高専 `https://high-school.manabi-map.app/` は別Pages・別出力。総合入口も別配信 | 高校の詳細・地域・認証・データは高校originへ。容量枠を分離する。実プロジェクト割当、認証・DAL設定、DNSと切替は未実施 |
| D2 / C3配備設計前 | URL切替中は完成済み公開APIの世代G0を固定して旧apexとhigh-schoolへ配布。原本更新の公開は切替後 | 一時的なG0/G1混在を許容するなら許容時間・公開順・検知・復旧条件が必要。固定中の緊急修正は切替を中止して再検収 |
| D3 / C4公開日決定前 | 事前告知14日以上、切替後の旧origin救済・旧資産保持28日以上を設計上の下限候補とする | 長い候補は事前28日・切替後56日以上。利用状況と保管負担を確認して決める。復旧30分以内も未実測の目標候補。期間満了だけで旧保存を削除せず、旧APIは停止しない |
| D4 / Web検収後、Android公開準備前 | 試作IDを残し、表示ブランドに依存しない公開用packageを別に確定する | 自分用試用を先行する案もある。公開用ID・署名・DAL・ストア登録の確定や実施はまだない |

AIが詰める必須事項は、旧callback専用の学校シェル、旧originでの連携・招待再開、旧世代資産の参照関係、PWA scope、保守時の認証/DAL応答、API世代比較と片側失敗時の復旧。これらを「直すかどうか」の選択に戻さず、C2〜C4の実装・検収条件として扱う。以下の本文と公開コードから再調査でき、非公開の作業資料がなくても再開可能とする。

`manabi-map.app` を学校探しと学習コンテンツの総合入口とし、学校種別入口を `school.manabi-map.app`、既存の高校・高専検索を `high-school.manabi-map.app` へ置く。既存の学校詳細、検索結果、お気に入り、家族メモ、公開APIを継続して使える移行にする。

本書は2026-09-27(日)時点の公開可能な実装計画。採用範囲は総合入口・学校サイトの配置・既存高校版の移行に限定する。全体戦略の内部資料、検討履歴、別サービスの事業判断・開発日程・構成詳細、非公開の実測利用者数は転記しない。実装担当は本書と公開リポジトリのコードから着手できる。

現在は分離候補のローカル実装・合成検証に着手している。DNS、Cloudflareの実配備、認証設定、本番DBは変更しない。`due` は計画の再確認目安であり、公開予定日ではない。今回のローカルbuild・commit承認をpush・tag・本番反映・実DB操作の承認に広げない。

## 現行構成と再利用する準備

初回調査基準: ローカル `develop` / HEAD `5796796b2cd4d134e6b1668da429b5af6e1aa175`。初回の作業ツリーはcleanだった。追加調査時点では本計画・HTML等の未コミット変更がある。下記のソース確認と、C1に記載する2026-09-27のPages管理画面の限定観測を区別する。DNS全体・認証設定・実ログインは未確認。

| 領域 | ソースで確認した現状 | 今回への意味 |
|---|---|---|
| 学校Web | `web/src/App.tsx`、React / TypeScript / Vite、`web/src/entry-server.tsx` | SPAと事前生成HTMLを併用。ルーターだけ直す移行では足りない |
| origin | `web/data/site.json` は `https://manabi-map.app`。`web/scripts/lib/site.mjs` と `web/vite.config.ts` が参照 | origin集約は実装済み。パスの名前空間化は別作業 |
| 移転告知 | `web/src/data/site-move.ts`、`SiteMoveNotice.tsx`、`useSiteMoveNotice.ts`、`siteMove.ts` | 新ホストはschoolだが `switchDate: null`。予告が出ているとは扱わない |
| 静的生成 | `gen-schools-json.mjs`、`gen-seo-pages.mjs`、`lib/public-api.mjs` | 学校別HTML・詳細JSON・地域ページ・公開API・SEOを生成 |
| Pages Functions | リポ直下 `functions/`。`_middleware.ts` が既知SPA経路・保守応答を担当 | 学校配信のRootを安易に `web` へ変えるとFunctionsを落とす |
| 認証・保存 | `AuthContext.tsx` は現在のoriginの `/auth/callback` へ戻す。Supabase PKCE / persistSession | 新originで再ログインが必要。匿名利用者は事前の連携が必要 |
| 学校種別 | `web/src/types/school.ts` は `high_school` と `kosen` | 高専を高校へ分類し直したり、既存IDを付け替えたりしない |
| 漢字版 | `web/vite.kanji.config.ts`、`web/kanji/`、`web/src/kanji/`、出力 `web/dist-kanji/` | 学校とビルドが分離済み。`schoolUrl` はまだapex。公開済みかは別途確認 |
| CI | `.github/workflows/validate.yml` | 学校の生成・build検証はSupabase用Secretの有無で条件分岐。skipを成功と数えない |

ローカルに残る `web/dist` は11,718ファイル（HTML 6,423、JSON 5,244、その他51）。追加調査で総量564,266,800 bytes、全校公開API `api/v1/schools.json` は22,437,140 bytes（約21.4 MiB）と再集計した。`index.html` の更新日時は2026-09-27 00:43:28 +09:00。これは既存成果物の集計であり、今回のHEADから再生成した数でも本番の配置数でもない。

既存のローカル移転計画には「origin集約・告知実装」の完了記録と、「同じパスでschoolへ転送」「apexトップを一時302」「旧公開API維持」「学校は既存Pagesを利用」の未実施手順がある。本書は準備を再実装せず、総合入口と学校種別入口を加えた差分をC1で整理する。既存計画の完了状態・過去承認を変更せず、新しいURL・配信方式まで承認済みとは扱わない。

作者環境に既存計画がある場合の参照: `docs/local/school/plan_school-subdomain-move.md`（理由: 過去の実施証跡との整合確認用。本書の実装仕様はこの非公開文書へ依存させない）。

## 今回採用する仕様と実装案の区別

ブランド差替えの必須要件と定点観測・切替方針の共通正本は [製品・運用ルール「ブランドと URL」](reference_manabi-map-operating-rules.md#brand-portability)。本計画のC2・C3はその実装と検収を担当する。

**採用する仕様**: 総合入口と学校サイトを分ける。総合入口の「高校を探す」と共有・検索導線は目的の画面へ直接つなぐ。schoolトップは種別を選ぶだけの中間画面にせず検索も置く。学校種別の追加、データ統合、新DB、共通認証サーバーは今回実装しない。家族共有・お気に入り・認証・公開データのガードは維持する。

**採用した配信構成**: 学校入口・高校版・総合入口を同じリポの別ビルド・別Pagesへ置く。高校を `/high-school/` に集約する旧案は不採用。下記のURL表は採用ホストへ更新した実装基準であり、転送・認証・実配備が完了した証拠ではない。将来の学校種別追加に伴う地域境界や分割数は未決。既存Pagesをどの役割へ割り当てるかは、実配備時に管理設定と整合させる。

```text
manabi-map.app/                 総合入口（新しいportal配信）
  高校を探す ────────────────→ high-school.manabi-map.app/
  学習コンテンツ ────────────→ kanji.manabi-map.app/ など公開確認済みの行き先
school.manabi-map.app/          学校種別と検索を同じ画面に置く学校入口
  高校・高専を探す ───────────→ high-school.manabi-map.app/
high-school.manabi-map.app/     既存高校版（独立したPagesと出力）
  school/:id/                  高校・高専の安定IDによる詳細（共通経路案）
  api/v1/*                     学校の公開データ
manabi-map.app/api/v1/*         旧クライアント向けの互換応答を維持
```

総合入口のカードは表示名・説明・URL・公開状態を設定へ集約する。`home`、`kanji`、`karuta` の行き先を扱える形とし、公開確認済みのサービスだけリンクを有効にする。未公開先を「利用できる」と表示しない。別サービスの実装・認証・DBを総合入口へ持ち込まない。

学校枠には「現在は高校・高専。今後、すべての学校種別を順次用意する予定です。」と表示する。大学・専門学校は進学先という共通の枠を持つが、分類・検索・見せ方の違いは別途検討する。全種別対応の方針は、今回の移行で全種別のデータ・機能を実装する指定ではない。

## URL移行の対応表（採用ホスト、実環境未検収）

ブランドと接続先の設定は分離する。表示名を変更しても下記のURL・学校ID・保存データは自動変更しない。将来ドメイン自体を移す必要が生じた場合は、origin設定・認証・転送・検索・利用者案内を別の移行として扱う。

全行で末尾スラッシュ、URLエンコード、クエリ、GET/HEADを確認する。任意URLの一括トップ転送は行わない。例示するID・座標・tokenはテスト時に合成値を使う。

| 現在のapex上の経路 | 最終配置案・互換動作 |
|---|---|
| `/` | 最終的に総合入口を200で返す。入口完成までの302を使う場合も恒久301にしない |
| `/map`、`/search`、`/schools/` | high-schoolの同じパスへ対応転送。地図座標・検索条件を保持 |
| `/school/:id/` | high-schoolの同じ詳細パスへ301。高専も安定IDと実際の種別を保つ |
| `/pref/:pref/`、`/pref/:pref/:city/` | high-schoolの同じパスへ301。当面は現行高校・高専データの地域ページ。全学校種を網羅すると表記しない |
| `/favorites`、`/compare`、`/mypage`、`/dashboard` | high-schoolの同じパスへ。サーバー上のユーザーデータと管理者ガードを維持 |
| `/family/join#token=…`、旧 `/family/join?token=…` | high-schoolの同じ経路へ。fragmentはサーバーに来ないため実ブラウザで確認。旧query形式、旧originでURLからtokenを除去したログイン待ち、リンク再開も別ケースとして検証 |
| `/auth/callback` | 通常の一括転送から除外。移転期間中は旧originで認証を完了できるようにし、終了後はhigh-schoolで再開する案内へ。認証code・verifier・セッションを新originへ転送しない |
| `/legal/*`、`/guide/*`、`/about/`、`/press/`、`/data/` | 既存の学校向け内容はhigh-schoolの同じパスへ301。総合入口独自の説明・規約が必要なら別パスを明示して衝突を防ぐ |
| `/api/v1/*` | 両originで同一世代の公開JSONを200 + CORSで返す。転送を前提にしない |
| `/api/admin/*`、`/api/csp-report` | 一括301から除外。旧画面の存続期間中は従来の認可・POSTを維持、終了後は明示的な終了応答。portalで管理APIを複製しない |
| `/school-data/*`、各種索引JSON、`/assets/*`、画像、manifest、配布PDF等 | 旧タブと外部参照を棚卸し。存続期間中は旧版アセットとデータを維持し、その後も必要な公開資産は対応URLへ。portal用同名ファイルとの衝突に注意 |
| `/robots.txt`、`/sitemap.xml`、`/llms.txt` | apexは総合入口用、schoolは学校入口用、high-schoolは高校版用。apexの旧サイトマップを無条件転送しない |
| 存在しない経路 | 404。SPAシェルや総合入口を200で返さない |

高校入口のhost名は、高専の型やIDを高校へ変える指定ではない。画面には「高校・高専」の収録範囲を表示する。既存高校版の詳細・地域・認証・APIに `/high-school/` prefixを付けない。schoolは軽量な検索・種別入口として高校版へ送客し、高校版のデータを二重配備しない。表の公開APIを返す「両origin」は旧apexとhigh-schoolを指す。

## C1: URL対応表・配信単位・容量の確定

### 作業内容

`App.tsx` の全Route、`functions/_middleware.ts` のSPA_ROUTES、`gen-seo-pages.mjs` の全出力、`web/public/` の資産、`functions/api/` のエンドポイントを照合し、上表を実装用の対応表にする。既存移転計画と差がある「パス変更」「portal公開時のapex」「API維持」「認証例外」を確定し、重複する実行指示を残さない。

現行学校のPages Rootはリポ直下、出力は `web/dist`。新候補では学校入口を `web/school-portal/` から `dist-school-portal`、高校版を `dist-high-school` へ分離する。高校用 `functions/` は静的成果物とは別に管理し、学校入口へ誤配備しない。候補buildのFunctionsソースコピーは本番bundleの完成を意味しない。実配備のRoot・build・環境変数名・Custom domains・Preview・DNS・証明書は別途確認し、設定名と変更前後だけ記録する。

### 2026-09-27の追加調査と未確定事項

対象の学校Pagesプロジェクトの管理画面で、Rootはリポ直下、buildは `cd web && pnpm install && pnpm build`、出力は `web/dist`、本番ブランチは `main`、自動デプロイ有効、build watchのIncludeは `*` と確認した。同プロジェクトのCustom domainsではapexの接続とSSL有効を確認し、schoolドメインは未登録だった。これは当該プロジェクトの観測範囲であり、他プロジェクトの存在やDNS全体の状態を確定するものではない。同じリポにportalを追加するときは、学校とportalのどちらを再生成する変更か、build watchと共通データ・設定の依存関係も決める。

未確認: Supabase/OAuthの実効許可戻り先、DNS全体、schoolとhigh-schoolの実接続、実ログイン・連携・招待、旧apexとhigh-schoolの本番API照合、契約・請求の細部。公開日、事前告知・旧セッション救済期間、APIの公開順・許容する一時的世代差、復旧目標時間も未決定である。これらを未確認のまま本番公開可とはしない。

ソースで確認した更新経路は `SchoolDetailSheet.tsx` → `trigger-snapshot-rebuild` → 単一のPages deploy hook。応答の成功はhookの受付成功であり、公開完了ではない。学校データ生成ごとに `generated_at` が付くため、別々のDB再取得からhigh-schoolと旧apexの互換APIを生成しても同じ世代になる保証はない。C3で一度生成した公開API成果物を両候補へ配る案と、一つの配信元で互換APIを返す案を比較する。軽量なschool入口へ学校データは複製しない。後者に新基盤・課金が必要なら構成差を判断資料へ示す。

利用者引継ぎについては、匿名利用者を含む保存データがDBにあること、中心地点のDB復元、家族招待のorigin単位の待機状態を確認した。詳細はC2の表を受入条件の正本とする。コードを読めたことと実際に引き継げたことは分け、外部設定確認と実認証はC4前に残す。

料金・上限の比較条件として、Pages Freeは1サイト20,000ファイル、単一ファイル25 MiB。これは現在の契約がFreeとの確認ではない。残存distの上限との差8,282は追加可能校数ではなく、単一ファイルの全校APIも別に増加を見積もる。学校別HTML + 詳細JSON + 地域 + 共通資産で見積もり、旧HTMLを新旧二重生成せず、互換URLは転送で扱う。URLに `/high-school/` を付けても配信先のファイル上限は分かれない。将来の規模で不足する場合は配信分割を別途検討する。[公式上限](https://developers.cloudflare.com/pages/platform/limits/)

### 費用・将来拡張の初期比較履歴（当時の推奨案）

初期比較では同じリポ内の学校・portalを別Pagesへ配信する案を推奨した。採用済みのホストと配信単位は冒頭のD1を正本とする。Workersへの基盤移行と全学校種別のデータ拡張は、この移行の必須作業にはしない。リポの置き場、配信先、URLの階層は別の設計項目であり、A2の採用だけで有料契約や配信方式まで確定したとは扱わない。

Pages有料プランの100,000ファイル枠は、Workers Paidの実行枠とは別。Pages側には `PAGES_WRANGLER_MAJOR_VERSION=4` が必要で、単一ファイル25 MiBの上限は残る。Workers Static AssetsもFree 20,000 / Paid 100,000ファイルで単体25 MiB。後者の増枠にはWrangler 4.34以降が必要。実契約がどのPagesへ適用されるかは未確認。[Pages上限](https://developers.cloudflare.com/pages/platform/limits/)・[Workers静的配信](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)

FunctionsのFree枠はWorkersと合算でアカウント全体100,000リクエスト/日。Workers Paidは月額最低5 USDで、月10,000,000リクエスト・30,000,000 CPU msを含み、超過はそれぞれ100万あたり0.30 USD / 0.02 USD。静的配信だけなら無料でも、現行 `_routes.json` は学校HTMLをFunctionsから除外しておらず、全閲覧を静的無料とは見積もれない。保守応答・経路制御を確認せずに除外を増やさない。[Functions料金](https://developers.cloudflare.com/pages/functions/pricing/)・[Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)

同じリポへ接続できるPagesは標準で5プロジェクト。増枠申請の余地はあるが、学校種別ごとに無制限に分けられるとは仮定しない。Freeの月500 builds、アカウント同時1 build、各20分の制限も別に評価し、変更監視パスで不要な生成を減らす。[Monorepos](https://developers.cloudflare.com/pages/configuration/monorepos/)・[Pages builds](https://developers.cloudflare.com/pages/platform/limits/)

以下は将来の実校数の予測ではなく、既存distを基準にした合成シナリオ。追加1校につきHTML 1件・個別JSON 1件、全校APIは現行22,437,140 bytes / 5,088校の平均容量が増えると仮定した。新地域・索引・資産の追加は別途必要で、既存校の履歴増加だけでも容量は増える。

| 合成の追加校数 | ファイル数（地域等の追加前） | 全校APIの推算 MiB |
|---|---:|---:|
| 0 | 11,718 | 21.40 |
| 1,000 | 13,718 | 25.60 |
| 5,000 | 21,718 | 42.43 |
| 20,000 | 51,718 | 105.51 |

全校APIは既に47都道府県別ファイルを併設しているが、全校ファイルを残せば単体上限の問題は解消しない。今回のv1のURL・全配列形式・公開対象範囲を維持し、全学校種別を追加する段階では新バージョンと種別×地域の分割を比較する。v1自体が単体上限に近づいたら、同URLの互換配信元変更または正式なAPI移行を別途具体化する。v1を無告知で目録や先頭ページへ置き換えない。

アプリの地図用データは全国の軽量索引を読み、詳細を学校別に読む実装。県別ファイルの存在だけで地域単位の遅延読込み済みとは扱わない。全種別展開では索引の取得単位、現在の `high_school | kosen` 型とDB制約、近隣校計算の生成時間も再評価する。生成時間・メモリの増加は未測定であり、単純比例で所要時間を約束しない。

変更予定ファイル: 本書（確定表・判断根拠）、新設予定 `web/data/site-routes.json`（学校入口・経路の設定。機微情報なし）。ローカル既存計画がある場合は未実施部分から本書への実行入口も整理するが、履歴・完了記録は保存する。

### 完了条件

全経路が「移す・残す・終了・新設」のいずれかへ対応し、高専、認証callback、公開API、旧アセットの受け皿がある。配信単位と `/high-school/` の採否を本書へ記録済み。外部設定未確認ならその項目を残し、C4の公開可否を未判定にする。

### 追加比較: 学校種別・地域別の無料配信とDB費用

2026-09-27の追加依頼は、学校種別を別サブドメイン・別Pagesへ分け、小学校など大きな種別は東日本・西日本等へ分ける案を、0 USD / Workers Paid 5 USDの必要性とDB費用まで含めてHTMLで比較すること。地域で探す利用を初期設計の仮説とし、全国・東西横断の結果統合を初期必須にしない。全国検索の需要が無いと実測した意味ではなく、高校・大学の広域検索まで一律に制限する決定でもない。

推奨する比較案P1は、共通ブランド・同じ操作の画面から都道府県・地域を選び、担当する配信先へ移動する構成。別ホストへの遷移は許容する案とし、境界の隣県を探すリンク、地域変更、詳細への直リンクを保つ。名前だけを東西に分けて同じPagesへ接続しても容量枠は増えない。学校詳細HTML・個別JSON・地域ページ・共通資産を各出力に数え、全データの二重配備をしない。2分割で収まるとは仮定せず、片側でも2万ファイルまたは単体25 MiBを超えたら分割数や出力単位を見直す。最新の実校数と生成数を用いてC1で割り付けを確定する。

前版の「学校の既存Pagesを維持してWorkers移行は後段」という推奨は高校版の移行に限る。全学校種別を一つのPagesへ集約する根拠にはしない。P1に対する比較案P2は、学校を一つの配信先にまとめ、有料枠や別配信方式を評価する構成。P1/P2の選択はまだ未採用であり、課金契約・本番URLの変更承認ではない。

**Cloudflareを0 USDで運用できる条件**: 各Pagesがファイル数・単体サイズ内に収まり、Functions/Workersのアカウント合算がFreeの1日10万回とCPU等の実行制限内、Pagesの月500 builds・同時1 build等の共有枠内に収まること。静的配信の閲覧回数には従量課金がないが、現在の学校HTMLはmiddlewareを通るため無条件に静的無料とは数えない。分割しても動的処理・生成の共有枠は増えない。同一リポにGit接続できるPagesは標準5件なので、入口・漢字・かるた等も含めて数え、増枠申請または公開方法を比較する。ルール上の枠を守り、枠回避のためのアカウント増設は前提にしない。

**月5 USDが必要になる条件**: 動的処理のFree上限を超え、その処理を維持する場合などにWorkers Paidを検討する。地域分割をしたから5 USDが必須になるわけではない。Pagesのファイル増枠の有料プランとは別契約であり、Workers Paidだけで既存Pagesの2万ファイル枠が拡大するとは扱わない。

**現在の設計方針（2026-09-27追記）**: 学校・土地・教材など公開情報の原本をローカルのSQLite/MySQL/MariaDB等へ置き、生成時だけ読んでHTML・JSONへ書き出す。Supabaseは認証・お気に入り・メモ・家族共有等の利用者固有データを中心にする。前版の「学校原本もSupabaseへ保管する」費用試算を主案から外す。DBエンジンはSQLiteを採用。最小ID参照表の有無・実配置・更新受付方式は子計画で確定する。現在の原本が移設済みという意味ではなく、以下の参照依存の解消・検収後に実施する別工程である。原本の全件削除や既存保存機能の撤去で無料化しない。本人/家族のRLS・安定した学校/学科IDを維持し、サブドメイン間でログイン状態が自動共有されない点も変わらない。

**生成・配布の主案**: ローカル原本の同一スナップショットから生成し、公開項目と容量を検査した成果物をWranglerでPagesへ配布する。Cloudflare上でのbuildを使わない場合、月500buildの利用は0で、配布回数は別集計。APIのレート制限や既存の自動Git公開との競合、Functionsの同梱、公開先ごとの権限は確認する。新規Direct UploadプロジェクトとGit連携プロジェクトは作成方式に制約があり、既存Git連携にはWranglerで手動配備できるが、設定切替は別途設計する。同一Git連携5件を独自アップロード方式の上限として数えない。ドラッグ＆ドロップは1,000filesでFunctionsの制約もあるため、この規模には使わない。[Direct Upload公式](https://developers.cloudflare.com/pages/get-started/direct-upload/)

Supabase公式比較ではFreeはDB 500 MB/プロジェクト、月間アクティブ利用者50,000、通常転送5 GBとキャッシュ転送5 GBは別枠、ファイルStorage 1 GB、無料activeプロジェクト数制約と非活動時の停止がある。Proは組織あたり月25 USDからで、月10 USDのCompute creditによりMicro 1台分を含む。追加のMicroを月中継続すれば1台あたり約10 USDが増える。DBを共有する案なら地域分割数をそのままDB月額へ掛けない。学校のローカルdist約538 MiBは生成ファイルの合計であり、DB 500 MB枠を超えた証拠ではない。[Supabase料金](https://supabase.com/pricing)・[課金単位](https://supabase.com/docs/guides/platform/billing-on-supabase)・[Compute](https://supabase.com/docs/guides/platform/manage-your-usage/compute)・[転送枠](https://supabase.com/docs/guides/platform/manage-your-usage/egress)

通常の学校データ取得は静的ファイルだが、`VITE_SCHOOLS_SOURCE=supabase` の場合はDB直読に切り替わる。現在の本番での実効値は未照会。保守用 `app_config` の読取りや利用計測 `events` の書込みもあり、「学校を静的配信すれば閲覧時のDB通信がすべてゼロ」とは扱わない。無料枠の判定ではこれらも合算する。Supabaseの認証利用者・転送等は組織単位の共有枠、DB容量はプロジェクト単位の上限として確認する。キャッシュ転送5 GBを通常DB転送へ足して10 GBとは計算しない。

| 構成例 | Cloudflare | Supabase | 合計/月（税別） |
|---|---:|---:|---:|
| 配信・処理・DBとも無料枠内 | 0 USD | 0 USD | 0 USD |
| 動的処理のみPaid、DBはFree | 5 USD | 0 USD | 5 USD |
| 配信・処理はFree、DBはPro Micro 1台 | 0 USD | 25 USD | 25 USD |
| 動的処理Paid、DBはPro Micro 1台 | 5 USD | 25 USD | 30 USD |

上表は新規構成を比較する内包枠内の基本料金で、現在の契約・請求額・最大料金の保証ではない。Pages Proを選ぶ費用、R2、超過、追加DB Compute、ドメイン更新、有料の地図・住所検索・AI等は含めず、利用するものを別途加算する。今回の協議だけで契約変更しない。

0 USDの成立を判定するため、現行のSupabaseプラン・組織/プロジェクト数・DB実容量（索引と認証等を含む）・通常/キャッシュ転送の当月値と日次傾向・認証利用者数（匿名を含む）・Storage・Edge Functions・Realtimeの利用量、バックアップ/復元と非活動時の停止条件を確認する。Cloudflareは動的リクエストの日次ピーク・CPU・build回数・各候補生成物を確認する。現時点では実利用量・現請求は未取得。将来校数や転送量を仮定した試算と、観測した数値は分ける。Supabaseを別DBへ置換する場合は認証・RLS・家族共有・バックアップの移植も必要であり、静的配信の分割案に黙って含めない。

### 2026-09-27 M1: 実装前の判断表（URL採用反映）

今日の調査は初期対応表を具体化するためのソース突合。ライブ設定確認・候補生成・動作検収ではない。現在もsite.jsonはapex、SITE_MOVE.switchDateはnull。候補ホスト定数を採用の証拠とせず、C1全体は未完了のまま。

| 判断項目 | 具体案と推奨理由 | 残る判断・確認 |
|---|---|---|
| 高校・高専入口 | 採用済み: `high-school.manabi-map.app/`、学校入口は `school.manabi-map.app/`。別Pages・別出力でファイル容量枠を分離する | 高専のtype=kosenとIDを維持。URLは再判断しない。実認証・配備・切替は未検収 |
| 配信 | 同じリポで学校入口・高校版・総合入口を別出力・別Pages。高校Functionsはrepo rootに維持。将来はSQLiteの同一候補をWrangler配布 | 既存Pages割当、新規方式、Git自動公開との競合解消、hook更新先は未決。過去の管理画面観測を現在の実効設定と扱わない |
| 旧リンク | 初期対応表どおりパス単位301。地図/検索条件、学校UUID、高専、pref、市、保存画面、家族招待を保持。apex rootはportal 200 | 採用したhigh-schoolへの対応表を全経路で検収する。fragment/token・末尾slash・未知404・旧資産/既存タブは未検収。callback/APIを包括転送しない |
| 公開API | 旧apexの/api/v1/*をJSONの200で継続し、high-schoolと同じ完成成果物を配る案を推奨。全配列・県別形式・CORS維持 | 公開順・許容世代差・部分失敗時の戻し担当/時間は未決。新種別をv1へ無告知で追加しない |
| callback | high-school originの/auth/callbackを許可。旧originで開始した認証は旧origin内で完了。code/verifier/sessionを転送しない | AuthContextの4経路はlocation.originを使用。Supabase許可URL/Site URL、Google/LINE側callbackの実効値、旧認証猶予期間は未確認。provider→SupabaseとSupabase→アプリを区別 |
| 公開条件 | 新旧認証・保存・招待、全URL、API同世代、復旧を確認後に公開日を決める | 日付/猶予/復旧時間、DNS/契約/容量、hook対応は未確認。ドメインと実原本の切替は別工程 |

依存: URL/配信の採用 → 経路・認証・互換実装 → Preview/実認証検収 → 公開日/猶予確定 → 別指示による公開。判断の再確認日は本書dueで、公開日ではない。改修対象の目安はC2〜C4、工数は未見積り。URL非依存のSQLite合成試作は進める。

根拠として開いたソース: App.tsx、AuthContext.tsx、site.json、site-move.ts、functions/_middleware.ts、web/public/_redirects・_routes.json、school-select.ts、gen-schools-json.mjs、lib/public-api.mjs。Router宣言と主要経路群を既存表へ突合したが、全生成物/全リンクの網羅検収は未実施。学校HTMLはFunctions対象、公開API/データ/資産の一部はexcludeというコードを確認した。

2026-09-27の公式再参照: Pages Freeは20,000files/site、25MiB/asset。パスprefixだけでは枠は分かれない。現契約や候補容量の実測ではない。[Pages limits](https://developers.cloudflare.com/pages/platform/limits/)

Direct Uploadはローカル成果物の配布経路。新規プロジェクトのGit連携切替制約と、既存Git連携の手動配備を分けて設計する。[Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)

SupabaseのredirectToは許可URLへ登録する。productionは正確なURL指定を推奨する公式説明を参照したが、実設定値は未取得。[Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)

親レビューで判断表の差分と公式3資料を再確認した。AuthContextの4か所が現在のoriginを戻り先に使うこともソースで照合した。URLはその後のユーザー指示で採用済み。実設定の確認、実認証や本番配信の動作検収は引き続き未実施。

## C2: 学校入口と既存高校版の移行準備

### 受入調査で確定した追加条件（2026-09-27）

- **旧callbackの転送除外だけでは不足する。** 調査時の `functions/_middleware.ts` はcallbackへ `ASSETS.fetch('/')` の本文を返し、`AuthCallbackPage.tsx` は成功後に `/` へ戻る。rootを総合入口に置換するとcallbackにも総合入口HTMLが返る合成反例を確認した。旧origin専用の学校認証シェル・必要資産・完了後の新origin再ログイン案内を用意し、認証開始から完了まで旧origin内で成立させる。これは本番障害の観測記録ではない。
- `/high-school/*` prefixは不採用。採用したhigh-school hostでRouterの全宣言と静的生成、Functions、公開API、データ・資産、manifest、robots/sitemap、DALまで対応表へ含める。GET/HEAD、末尾slash、query、日本語path、未知URL/学校IDの404、fragmentは別々に検収する。
- 匿名連携の旧origin救済を切替後も使えるようにする。現行の旧host予告は切替日の翌日以降に終了するため、その表示期間に依存しない。招待token除去後の旧origin pendingは新originから読めないので、元リンクの再開と旧origin救済を案内する。中心地点は画面表示後の非同期DB保存が成功し、再ログイン・再起動後も復元されるところまで確認する。
- PWAの開始originをhigh-schoolへ変えるときはscopeを明示し、同originの学校詳細・callback・家族招待を含める。旧PWA/旧APKが総合入口へ着地する場合の学校案内・更新導線も検収する。開始URLの変更だけで移行完了としない。

### 2026-09-27 M1からの引継ぎ

正式ホストの採用に沿って分離候補の実装を進める。旧callback・公開API世代・実認証・配備設定を残したままC2全体を完了にしない。以後、学校入口はschool、既存高校版の認証・詳細・保存はhigh-school originを意味する。

実装担当は着手時のAI実行記録へ残す。外部表示の棚卸し責任は運営者、実査担当は実施記録に残す。共通の変更対象台帳は作者環境の `docs/local/reference_brand-and-naming.md`。公開仕様と下記の完了条件は、その非公開文書がなくても読めるものとする。

### 作業内容

school `/` に種別と検索を配置し、高校入口に現在の検索・地図への導線を置く。総合入口を経由しない直リンクでも使えるようにする。学校詳細・地域・お気に入り・家族共有の既存機能を保つ。

学校のブランド設定を一元化する。候補は `web/data/brands.json`（新設案）に機能識別子ごとの表示名・短縮名・言語別表記・ロゴ・共有画像を持たせ、ブラウザと静的生成の両方が参照する構成。既存のorigin設定とは分け、表示名をDB・API・学校ID・localStorageキーへ使わない。ヘッダー・フッター・title・OGP・JSON-LD・PWA manifest・アイコンの代替テキストを対象とする。規約、README、紹介・配布資料、画像内の文字、外部掲載の表示名は差替え一覧を作り、生成可能なものは同じ設定から出力する。

経路設定をRouter、内部リンク、共有URL、QR、JSON-LD、canonical、sitemap、OpenAPI、llmsへ反映する。`origin` にパスを混ぜない。SSRの `data-mm-route` とclient経路を一致させ、`isPrerenderedForRoute` の判定・初回storage復元・静的importの不変条件を維持する。SPA fallbackは既存middlewareで扱い、全パスの200化をしない。

ゲストには移転前のGoogle/LINE連携を案内し、連携済み利用者にはhigh-schoolでの再ログインを案内する。既存の `switchDate` は公開日合意までnullを維持する。旧 `site-move.ts` のschool向け設定はまだ有効化せず、実切替の実装時に採用したhigh-schoolへ更新する。`noticeDays: 28` は切替後のお知らせ表示期間であり、事前告知やゲスト救済の猶予日数ではない。ログイン開始originとcallbackを一致させる。

| 引継ぎ対象 | 現行コードから分かる条件 | 移行時の確認 |
|---|---|---|
| お気に入り・メモ・私の記録 | `useUserData.ts` が匿名を含む利用者のDBデータを読む。匿名セッションが別originへ自動移行する実装はない | 旧originで連携し、新originで同じアカウントにログインして同じデータへ到達する。DB消失とセッションからの到達不能を混同しない |
| Google/LINE連携済みの利用者 | `AuthContext.tsx` は現在のoriginのcallbackを使う | GoogleとLINEを別ケースにし、再ログインと連携衝突 `identity_already_exists` を検証。異なるアカウントの自動統合を前提にしない |
| 中心地点 | `AppContext.tsx` は端末保存に加え、セッションがあれば `home_locations` へ保存・DBから復元する | 保存成功済みの地点は同じアカウントで復元確認。未ログイン・端末にしか残らない地点は再設定を案内し、全員に再設定が必要とは説明しない |
| 言語・地図ズーム・告知dismiss・ホーム画面追加 | originや端末に依存する状態 | 新originの初期値と再設定を確認。名称変更だけではこれらのキーを変えない |
| 家族招待 | `FamilyJoinPage.tsx` はfragment優先で旧queryも読取。tokenをURLから除去し、ログイン往復用pendingを旧originへ10分保存する | 新旧URL、token除去後のログイン待ち、期限切れ、リンク再開を分けて確認。旧originのpendingが新originに移ったとは扱わない |
| マイデータJSON | `lib/export.ts` のダウンロードは可読データで内部IDを含まない | 保存用控えとして扱う。これだけで自動復元・移行ができるとは案内しない |

旧認証の猶予中はcallback単体でなく、その画面と連携完了に必要な旧JS/CSS・manifest・学校データ・APIの受け皿を維持する。既存タブが遅延importや古いハッシュ付きJSONを要求するケースを合成データで試す。`gen-schools-json.mjs` は旧ハッシュ付きJSONを生成時に掃除するため、必要な旧資産の保持期間・配置・終了応答を明示する。apexとhigh-schoolの間で認証code、verifier、セッションを転送する仕組みは追加しない。

変更予定ファイル: `web/data/site.json`・C1の経路設定、`web/src/App.tsx`・`AppTree.tsx`・`main.tsx`・`entry-server.tsx`、`web/src/pages/` の上表該当ページ（学校入口は新設。`AuthCallbackPage.tsx`・`FamilyJoinPage.tsx`を含む）、`web/src/components/Sidebar.tsx`・`SiteFooter.tsx`・`BottomTabBar.tsx`・`HeroQrCode.tsx`・`SchoolDetailSheet.tsx`、`web/data/site-footer-links.json`、`web/src/hooks/useFamilyShare.ts`・`useSiteMoveNotice.ts`・`useUserData.ts`、`web/src/contexts/AuthContext.tsx`・`AppContext.tsx`・`I18nContext.tsx`、`web/src/data/site-move.ts`、`web/src/components/SiteMoveNotice.tsx`、`web/src/lib/siteMove.ts`・`ssrRoute.ts`・`mapView.ts`・`export.ts`、`web/src/i18n/ja.ts`・`en.ts`、`web/public/manifest.webmanifest`。既に不変条件を満たすファイルは確認と既存テストの再利用にとどめる。

生成・配信側: `web/index.html`・`web/vite.config.ts`、`web/scripts/gen-seo-pages.mjs`・`gen-schools-json.mjs`・`lib/site.mjs`・`lib/public-api.mjs`・`verify-static-output.mjs`・`verify-static-output.test.mjs`、`web/public/_routes.json`・`_headers`・`_redirects`・`robots.txt`、`functions/_middleware.ts`・`_middleware.test.ts`、`web/supabase/functions/trigger-snapshot-rebuild/index.ts`。関連テスト（`siteMove.test.ts`、`ssrRoute.test.ts`、`mapView.test.ts`等）を更新する。対象一覧はC1の経路表と検索結果で補完する。

### 完了条件

PC・スマートフォンで学校トップの検索、高校入口、地図、詳細、地域、比較が画面に見え、直リンク再読込でも使える。既存の高専を検索・閲覧できる。SSR初期表示が消えず、未知経路404・管理者以外の拒否・保守応答が維持される。型検査・lint・関連テストを通す。build承認後は同SHAの生成物でURL・上限・SEOを検査する。

Google・LINE等のOAuth同意画面、利用中の認証メール（件名・本文・送信者表示）、SNS・外部掲載、配布PDF・QRの現表記・管理場所・変更担当・検証手順を棚卸しする。利用していない項目は根拠付きで対象外とする。設定集約の実装で本番のブランド名や外部設定は変更せず、改名時に何を更新するかが判別できる状態を完了条件とする。client ID・callback・秘密鍵は表示名と区別する。外部設定の反映・メール送信・対外連絡は各操作の実行指示に従う。

合成の別ブランド設定に切り替えたPreviewで、画面・生成HTML・OGP・JSON-LD・manifest・画像に新しい表記が反映されることを確認する。旧表示名の残存検索では、現行の表示と履歴・URL・内部識別子を区別する。同じ学校URL・ID・ログイン・お気に入り・家族メモが使え、設定と資産を元に戻せることを確認する。画像やPWAのキャッシュ更新も確認し、検索エンジン側の表示更新完了は即時検証できるものと扱わない。

## C3: 総合入口と旧URL互換配信

### 受入調査で追加した実装・停止条件（2026-09-27）

旧認証シェルとその資産が完成するまでは、学校候補が動いてもapexを総合入口へ接続しない。既存タブが後から読むJS/CSS、ハッシュ付きJSON、manifest、法務・guide Markdown、配布PDFの参照を辿り、総合入口の同名資産との衝突を防ぐ。現行public一覧の存在は旧配備の資産を全て保持した証拠にはならない。旧世代へ戻した後も、新世代を開いていたタブに必要な資産を残して検収する。

D2の方針に沿って候補SHA・両配備ID・公開データ世代・全APIファイルのハッシュを対応付ける。G0固定中に片側だけG1になれば切替を停止して同じ世代へ戻す。公開APIはFunctionsの除外対象なので、middlewareのテスト成功だけではJSONの200・CORS・cache・世代一致を検収したことにならない。総合入口へ学校の管理Functionsを複製せず、旧画面が必要とする管理/APIのPOSTを301やHTML応答へ変えない。

### 作業内容

新設予定 `web/portal/` に軽量な総合入口を作る。「高校を探す」を高校入口へ直結し、schoolトップへのリンクも用意する。画面上の利用目的・公開状態・問い合わせ先を明確にし、未公開サービスのカードは状態表示だけにする。学校のSupabase clientや全国データを初期ロードしない。

portal用のHTML・CSS・ブランド設定・robots・sitemap・404・セキュリティヘッダーを独立させる。旧 `/api/v1/*` は高校版生成時の同一成果物をapexのportal出力へ同期する方式を第一案とする。high-school側の更新時にapexの互換APIも更新する手順・検査を組み込む。APIは移転のために終了しない。

同期案を採る場合は次の公開手順を実装する。具体的な公開方式と許容時間はC1で確定し、二つの配信先を原子的に切り替えられるとは仮定しない。

1. 公開データを一度だけ生成し、候補SHA、データ世代、対象ファイルの内容ハッシュ、生成時刻を記録する。高校版と旧apexの互換APIが別々にDBを再取得して同世代と見なす処理はしない。
2. 同じ成果物をhigh-schoolと旧apexの互換API候補へ組み込み、CORS・MIME・gzip・キャッシュ・スキーマ・内容を事前検査する。軽量なschool入口へ学校データを複製しない。候補検査に片方でも失敗したら両方とも公開せず、現在の公開版を維持する。
3. 事前に決めた順で公開し、配備完了を確認する。deploy hookの受付成功だけで完了と記録しない。片方が成功して他方が失敗した場合は後続操作を止め、成功側を記録済みの旧成果物へ戻し、両方の旧世代を照合する。再試行と切戻しの時間上限・担当を公開前に決める。
4. 両originの公開APIを照合する。現行の固定URLは `max-age=3600` なので、配信先の最新応答と利用者のブラウザに残る旧キャッシュを分けて確認する。配信先の世代不一致を単にキャッシュのせいにして終了しない。

一つの配信元で両originの互換APIを返す方式を選ぶ場合は、上の複製手順をその方式の受入条件へ置き換える。URL、CORS、応答形式、終了しない方針は維持し、追加基盤・費用・障害時の依存先を明示する。

portalとサービスカードはC2の機能識別子ごとのブランド設定を参照し、表示名と接続URLを別フィールドで持つ。学校の改名は学校カードにも反映し、portal自身や他サービスの改名を強制しない。ブランド変更手順に設定・資産・静的ページの再生成、手動文書の差替え、Preview検収、本番反映、戻し方を記載する。観測結果から自動改名する処理は導入しない。既存Pagesのmain自動デプロイと、今回未決定の両配信先の同期方式を区別する。

hostを限定したzoneの転送ルールと、portal側で返す例外を分ける。apex `/`・公開API・認証callback・旧APIのPOSTを包括301で巻き込まない。学校の `_redirects` を両ホスト共通の転送表にしない。現在のFunctions対象では `_redirects` が適用されない場合もあるため、転送を処理する層を各行で決める。[公式Redirects仕様](https://developers.cloudflare.com/pages/configuration/redirects/)

変更予定ファイル: 新設予定 `web/portal/package.json`・`index.html`・`src/`・`public/`、新設予定 `web/scripts/prepare-portal-compat.mjs` と検査、`web/package.json`、`.github/workflows/validate.yml`（portal単体検査を学校DB条件から独立）、`web/src/kanji/config/app.ts`・`web/src/kanji/pages/pages.test.ts`・`web/src/kanji/components/sheets.test.ts`（学校リンクのみ）、本書の配信表。新規ファイルは実装案であり現存しない。

### 完了条件

portalのPreviewで総合入口が200で見え、「高校を探す」から直接高校検索へ進める。未公開先へ誤誘導しない。旧公開APIがJSONで読め、学校用認証・管理Functionsがportalへ配備されていない。PC・スマートフォン・キーボードで導線を確認し、互換API同期と転送例外をテストする。

学校とportalの表示名をそれぞれ独立して切り替える検証を行い、カード・戻りリンク・SEO表記の整合を確認する。名称の変更だけではリンク先や機能識別子が変わらず、ブランド変更手順と差替え一覧がレビュー可能になっている。

別リポのサービスを掲載するカードも、提供側・掲載側・使用中の設定や資産の版・表示名・URLを対応付ける。両方の候補版で事前検証し、改名の公開時には両方の公開表示を確認する手順を残す。同時公開を前提にせず、切替順序と一時的な表記差・残件を記録する。

## C4: 並行公開・予告・切替・観察

### 公開前に残る実環境検収（2026-09-27）

候補SHAと配備・データ世代を同定してから、新規Google/LINE認証と取消、匿名連携、保存と終了後再起動、切替途中の旧callback、招待の明示受諾・待機・再開、全経路と初期HTML/SEO、旧タブの遅延読込、両origin API、管理認可、PWA/Androidを検収する。既存ログイン状態での表示や局所試験を代用しない。認証URLのquery/fragment、Cookie、storage、招待tokenの生値を証拠へ残さない。

hard maintenanceは調査時点ではcallbackも503にするため、旧認証救済期間との運用を設計する。将来のDALも保守時に200 JSONを維持する対応が必要。soft maintenanceは全DB書込みの凍結ではない。保守フラグだけで利用者保存を完全停止したと扱わない。

部分失敗の検収では、学校のみ準備済み、総合入口のみ準備済み、認証許可不足、片側API更新、旧chunk欠落、旧配備へ復旧済みだが301を記憶したブラウザ、新版APKを別々に試す。旧originへ戻した後も新originと必要資産を維持し、切替後に保存した利用者データを残す。D3の期間・担当・監視可能時間・復旧目標を実測結果で確定するまで、公開日を設定しない。

### 作業内容

1. 本番操作の明示指示後、高校版へhigh-schoolドメイン、軽量な学校入口へschoolドメインをそれぞれ接続する。高校版のDNS・TLS・Supabaseの許可戻り先・必要なOAuth設定・管理用Edge Functionの許可originをそろえる。高校版は既存DBを使う。プレビューと本番の設定差を確認する。
2. canonicalは旧apexのまま並行動作を検収する。Google・LINEのログインと連携、ゲスト、お気に入り、家族メモ、中心地点、管理操作、招待リンクを確認する。事前告知開始・学校の切替・旧セッション救済終了・apexのportal接続を別の段階として、日付・猶予・終了条件を決めてから告知を公開する。認証や保存データへの到達に未解決事項が残れば、終了日だけを根拠に救済経路を閉じない。
3. 旧originで始めた認証は旧originで完了させる。PKCEはローカルのverifierを必要とするため、callbackのcodeだけhigh-schoolへ送っても引継ぎにはならない。これは現行storage実装と[Supabase PKCE仕様](https://supabase.com/docs/guides/auth/sessions/pkce-flow)からの設計判断。ゲスト連携用の旧ページ・資産・callbackと、認証後に戻る画面・必要APIを保持する期間・例外経路を決め、終了条件を満たすまでapexをportalへ付け替えない。既存callbackは `/` へ戻すため、apexトップの転送開始と旧フロー完了を同時に成立させる方法を検証する。
4. high-schoolの最終origin・経路・SEOを含む候補を検証して公開し、同SHAとデータ世代の反映を確認する。旧学校URLを最終URLへ転送するが、救済期間のcallback・連携・招待・戻り先・必要資産は確定済みの例外経路として維持する。総合入口未接続中のapex `/` を302にする場合も旧フローを壊さないことが前提となる。
5. 猶予終了後、互換APIを含むportalの候補を検収し、apexをportalへ接続する。`/` の一時302を解除し総合入口200を確認する。期限後の旧callbackはcodeやerror値を転送せず、high-schoolでログインを再開する案内を返す。旧ゲスト状態が自動移行したと案内しない。
6. 学校のサイトマップ、Analytics、GSC、旧URL・新URLの状態を確認する。ルートが総合入口として残るため、全サイト一括移転ツールの適用を前提にしない。2週間の観察を開始し、旧リンクからの到達、404、認証失敗、API更新、検索登録を記録する。

変更予定ファイル: `web/data/site.json`・`web/src/data/site-move.ts`（値の切替）、`README.md`・`DATA.md`・`portfolio.md`・`docs/reference_manabi-map-operating-rules.md`、`web/public/legal/`・`web/public/guide/deviation-with-care.md`・`web/public/press/`（配布PDF/QRも旧URL誘導を点検）、`web/data/dataset-claims.json`・`web/src/data/ad-slots.ts`・`web/src/lib/export.ts`、`scripts/export-dataset.mjs`・`scripts/dashboard-snapshot.mjs`・`scripts/admission/official-fetch.mjs`、`web/scripts/smoke-beacon.mjs`・`check-payload-budget.mjs`、本書の切替結果。既に設定参照になっている箇所は重複改修しない。外部のSNS投稿・告知送信は本計画の実行に含めない。

### 完了条件・戻し方

総合入口200、高校直リンク、旧学校URLの対応転送、認証・保存・招待・API互換、school・high-school・apexのportalそれぞれのcanonical/sitemapが実環境で成立する。クエリ・fragment保持は合成値でブラウザ確認する。Functionsの実行範囲は `_routes.json` のexclude優先を踏まえて確認する。[公式Routing仕様](https://developers.cloudflare.com/pages/functions/routing/)

切替直前に旧Pages配備ID・候補SHA・ドメイン接続・zoneルール・認証戻り先・origin設定・互換API世代を控える。認証不能、保存済みデータへ到達不能、API内容不一致、ループ、広範な404なら先へ進まない。apexを旧配信へ戻し、追加転送を解除し、旧origin設定・SEOを再配信する。high-schoolからapexへの逆301は作らず、既にキャッシュされた旧→high-school転送の利用者用にhigh-schoolも稼働を維持する。利用者DBの原本移設はドメイン切替と分離する。ドメイン復旧時に利用者データを過去へ巻き戻さない。学校原本移設は後述の参照・バックアップ手順を別途検証する。

両配信先の一方だけが更新された場合はC3の部分失敗手順を使い、コードだけでなくデータ世代・ドメイン・転送・認証設定も記録した状態にそろえる。切替前に作業担当、判定担当、各段階の停止条件、目標復旧時間、旧配備へ戻せることを確認する。復旧所要時間は現時点では未測定。Previewの復旧確認と本番での実施証跡を区別する。

## 完了条件

全Cの変更と検証結果を記録し、実装済み・静的検証済み・本番反映済み・実機検収済み・観察中を区別する。C4の観察が残る間は計画を完了・archive扱いにしない。新しい課金・配信基盤・DB変更が必要になった場合は本計画へ黙って追加せず、具体的な差分と影響を示して判断を求める。

## 検証

実装時のコマンド: `cd web` 後 `pnpm typecheck`・`pnpm lint`・`pnpm test`。buildの明示指示後に学校入口・高校版・総合入口の各buildを検証し、高校版は `pnpm verify:static`、各配信先はファイル総数・単体サイズを確認する。文書検査はリポ直下で `node scripts/check-claude-md.mjs`。新設の総合入口portalの具体的なbuild/testコマンドはC3でpackage.jsonへ登録する。

受入確認はURL表の全行について「HTTP状態・Location・最終URL・表示内容・認証状態・API世代」を記録する。テストとCIだけで実ログインや画面検収済みとはしない。Preview検証を本番検証へ読み替えない。

CIの公開データ生成・build・SEO・容量検査は `.github/workflows/validate.yml` の `HAS_SUPABASE_BUILD_ACCESS` で省略され得る。portal単体検査をこの条件から独立させ、学校側は対象候補で生成・検査が実際に走った証拠を残す。公開APIの世代・旧資産・認証待機・招待待機・片側公開失敗を検証範囲へ含める。

計画作成・追加調査で実施: HEADと作業ツリー、現行経路、origin設定、移転告知、認証・共有・保存先、静的生成、Functions、漢字版分離、CI、既存distの読み取り、公式仕様の参照、学校Pagesプロジェクトの管理画面の限定観測。DNS全体、認証管理画面、実認証、build、デプロイ、DB照会、両originの本番API照合、契約・請求の細部の確認は未実施。C1の確定条件は未充足で、C2〜C4の実装・本番操作は行っていない。

2026-09-27の判断資料・前版の検証: Q0・A2・B1の回答をHTMLへ固定し、A1の保留理由を継承。費用・容量、将来増加の合成シナリオ、保存データ・認証・API同期・部分失敗時の復旧を追加した。ローカルHTTPでChromiumを使い1280 / 390 / 320 pxを実測し、SVG 6点の文字はみ出し0、内部リンク切れ0、図・表の横はみ出し0（折り畳み展開時も確認）、JavaScriptエラー0。選択・メモの保存と再読込、採用済み3件の保持、未選択への推奨入力、Markdown生成・保存、保存不可時の案内、static表示を確認し、PCとスマートフォンの画像も目視した。これは検討HTMLの検証であり、学校アプリや本番移行の受入検証ではない。

判断資料lintは欠け0・用語注意1（API/JSON等は用語集で説明）。本計画と検討HTMLの2ファイルに対する公開前の機密情報検査は一致0・未走査0。氏名等の短すぎる監視語17件は既存scanner仕様で対象外。文書ガイダンス検査は成功した。

2026-09-27の費用・地域分割版の再構成: 無料の成立条件、学校種別と必要時の地域分割、学校用DBの共有、月額0 / 5 / 25 / 30ドルの条件付き比較を先頭へ整理した。新P1を未回答で追加し、旧A1は保留の履歴へ移した。かるた・漢字・土地情報は別途容量とDB要否を見積もる対象として残し、学校用DB1 projectの料金表を全サービス合計と扱わない。新版HTMLをローカルHTTPのChromiumで1280 / 390 / 320 px、折り畳み展開状態を含め確認。SVG 2点の文字はみ出し、内部リンク切れ、図・表による文書の横はみ出し、JavaScriptエラーはいずれも0。P1の選択・メモ・推奨入力・Markdown出力・下書き削除、採用済み3件の保持、旧version 2保存からのA1選択とメモの移行、実際の再読込後の保存維持、保存不可時の案内、static表示を確認。PCとスマートフォンの表示画像を目視した。本番の契約・DB使用量や学校アプリの動作確認を意味しない。

同版の資料lintは欠け0・注意2。P1を7択とする注意は後続の無効化済み履歴5入力を含む集計で、実際に選択できるP1は2択。用語注意は用語集で説明済み。対象HTML・計画の公開情報スキャンは2ファイル・検出0・未走査ファイル0（設定上、3文字未満の監視語17件は対象外）。差分の空白検査も成功。

### 前版の数量換算モデル（2026-09-27・ローカル原本案の前）

以下は前版の検証履歴。学校・土地原本をSupabaseへ含めるDB試算とCloudflare上で全件buildする初期値は、後続のローカル原本案によって置き換えた。配信ファイル数とAPIサイズの計算は引き続き比較に利用する。

料金表だけでは課金の要否を判断できないため、検討HTMLの冒頭へ編集可能な容量モデルを追加した。最大事業規模・需要予測は未確定であり、初期値は合成シナリオ。緑は80%以下、黄は80%超〜100%、赤は100%超とし、80%は資料上の設計目安。現状確認済みを示す色ではない。入力・出力条件は回答と別に保存し、決定サマリにも含める。

| 対象 | 初期の将来規模・配信先数 | 最大サイトfiles / 20,000 | DBの別仮定 |
|---|---|---:|---|
| 学校 | 小学校20,000/3、中学校10,000/2、高校等6,000/1、その他24,000/4。計60,000校・10配信先 | 14,867（74.335%） | 1校関連全体10KB、累計保存1,000人×60KB、共通100MBで760MB（500MBの152%） |
| 漢字 | 2,136字×8files、2配信先 | 8,744（43.72%） | 現行IndexedDBのような端末保存を想定。同期DB新設は別試算 |
| かるた | 100種類×100枚×4files、3配信先 | 13,800（69%） | 教材静的配信・端末履歴保存のモデル。実装容量は未測定 |
| 土地 | 2,000地域×8files、2配信先。1地域500件 | 8,200（41%） | 全100万件をDBへ置く場合のみ、行・索引込み2KiB/件＋固定100MB＝2,148MB（429.6%）。必須DBとはしない |

学校は現行11,718filesから校別HTMLとJSON各5,096を除いた1,526を、各配信先の共通・地域分の仮定に使用。各校2filesに、1,000校単位の新API chunkを追加するモデルで、上限9,232校/site・80%目安7,233校/site。小学校2万校を均等2分割すると21,536files/siteで超過し、3分割なら14,867。均等に割れる保証はなく、実際の最大地域で再計測する。各学校種別の学校数は公開統計ではなく容量用の仮定で、分類・サイト数を採用した記録ではない。

学校APIは22,437,140bytes/5,088校から4,409.82bytes/校を計算。新1,000校chunkは約4.21MiBだが、既存v1全件API21.40MiBも維持するため、最大ファイルのバーへ85.6%として残した。既存APIの増量は別途計算。漢字最大4MiB、かるた最大0.5MiBは素材の設計仮定。土地JSONは公開1件2KiBで、500件/地域なら約0.977MiB、12,800件/地域で25MiB。土地のDB側2KiB/件は独立した仮定で、JSONからDB容量を換算したものではない。地図タイル・航空写真・巨大ZIP・履歴増大はこの容量に含めない。

全18配信先（入口1含む）を月4回ずつ更新すると72builds/月（14.4%）、毎日30回なら540（108%）。同一Gitリポ直接連携は5件の標準枠を超えるため、増枠の可否や独自CI配布の運用・CI枠を確認する必要がある。Pages account100件上限も別に確認する。4サービス合計4,000訪問/日×5動的処理で20,000回/日（20%）、同じ処理なら20,000訪問/日が10万回の到達点。bot・背景処理・CPU時間は未測定。

DB通常送信は月1,000認証利用者×1,500KB/月＋生成管理500MB/月で2GB/月（40%）、同条件の到達点は約3,000人/月。認証人数は50,000人/月に対し2%。累計保存人数とは別入力。学校DBの1人60KBは認証4KB＋お気に入り50×0.3KB＋メモ20×2KB＋地点等1KBの合成仮定。共通100MBは学校・ユーザー以外の予算で現在値ではない。DB容量はKB=1000bytes、MB=100万bytesとし、KiBは1024bytes。地域別サイトを増やしても原本DB容量は減らない。Supabaseはproject別500MBのほか組織合算の期間平均によるFair Use判定もあるので、2projectの容量を自由な1GB枠とは扱わない。

予測バー版の確認: Chromiumで1280 / 390 / 320px、全折り畳み展開を含め横はみ出しなし。初期値の計算結果、2分割による赤表示、80%・100%の色境界、毎日更新の超過、土地JSONの単体上限超過、無効入力時の案内、予測入力の再読込後の維持とサマリへの出力を確認。旧回答version2の移行と採用済み3件の保持も再確認。PC・スマートフォンの予測バーを画像で目視。学校APIの過小評価と土地JSON/DB仮定の混同は並列レビューで修正した。これは資料の検証であり本番容量・契約・認証・配信の受入ではない。

### ローカル原本＋オンライン利用者保存への設計変更（現行案）

ユーザー提案に合わせ、静的な公開情報はローカル原本、利用者固有の保存はオンラインという分離を設計方針へ反映した。SQLite/MySQL/MariaDBの選定や実移設は未実施。元DBを閲覧のたびに公開する構成ではなく、生成済みファイルを配布するので公開済みサイトはPC停止中も閲覧できる。原本更新は次の配布時に反映される。

HTMLの新初期値は共通・運用予算100MB＋累計保存1,000人×60KB＝160MB、Supabase Free500MBの32%。同じ仮定では6,666人まで枠内、6,667人で超過。80%の400MBを設計目安とする場合は5,000人。これはMAU枠ではなく保存総人数で、長文・履歴増加時は1人あたり容量を増やす。共通100MBはスキーマ・拡張・最小設定・運用記録等の予算、認証user行は60KB側に入れ、二重計上を避ける。最小ID索引を残す場合も共通枠へ計上して実測する。

学校6万校・土地100万件・漢字2,136字・かるた1万枚の原本DBは、学校10KB/校＋土地2KiB/件＋漢字8KiB/字＋かるた2KiB/枚という独立仮定で2,685.978112MB。原本・複製等3本なら約8.058GB、原本用作業予算20GBに対し40.29%。ローカル空き容量の実測ではなく、画像・音声・生成物・一時領域も別に必要。ローカル原本の件数を増やしてもSupabase原本容量を増加させないモデルへ変更した。

配布18先×月4回＝72公開/月だが、ローカル生成＋Wrangler配布ならCloudflare buildは0。比較操作でCloudflare生成へ戻すと72build/月、毎日更新なら540build/月になる。ユーザーDB転送は原本生成読出しを除き、1,000認証利用者×1,500KB/月＋その他運用50MB/月＝1.55GB（31%）。この条件の送信上限は3,300人/月。各仮定は入力で変更でき、実利用量・CPU・ログ・Storageや休止/バックアップ条件は別途確認する。

#### 原本移設の依存と実施順序

1. 安定IDと利用者保存のバックアップ・件数を確定する。`web/supabase/baseline_schema.sql` の `user_school_favorites`、`user_school_notes`、`user_school_deviations` は学校IDへ `ON DELETE CASCADE` のFKを持つ。学科IDのFKも対象。学校・学科の行を先に削除しない。最小ID registryへのFK付替え、または同等のサーバー側参照検証を設計し、学校閉校・旧版の保存・新IDの配布順序も検証する。registry案は未採用。
2. `web/scripts/gen-schools-json.mjs` の取得部分をローカルDB/スナップショット入力へ分離する。現行 `school-select.ts`・`lib/public-api.mjs` の公開許可リストを維持し、原本DBファイルや利用者データを公開しない。`gen-seo-pages.mjs` のmanifest/JSON入力契約、v1 APIと安定IDを保つ。SQL型・拡張関数をローカルDBへそのまま流用しない。
3. 管理更新の正本を一本化する。`DashboardPage.tsx` の学校/学科名直読、`get_deviation_review_queue` の学校/学科/参考値JOIN、`correct_school_deviation` の原本書込みを切り替える。「提案受付→ローカル採用→生成」等を比較する。個人記録や家族共有の保存は継続し、原本編集と混ぜない。family共有RPCはユーザー表とfamily_members中心なので、本人/家族/非許可者の権限検査を維持する。
4. `web/package.json` の生成入力、`.github/workflows/validate.yml` のSupabase生成Secret依存、`trigger-snapshot-rebuild` の単一Pages hook前提を再設計する。現在のhookはローカル原本へ反映しない。公開候補を一度作り、版とハッシュを記録し、全配信先へ同じ世代を配る。既存Git自動公開と競合させず、失敗・PC停止中の更新受付・旧配信への復旧を確認する。
5. `.github/workflows/nightly-backup.yml` のSupabaseバックアップとは別に、ローカル原本の別媒体バックアップと復元を検証する。利用者保存のFK/RLS移行・バックアップ・復元が確認できるまで旧原本を縮小しない。データベース操作、実生成、配備はこの設計更新では行わない。

検討HTMLは予測モデルを更新し、旧回答・メモ・利用者数を保持する。旧モデルの原本読出し用500MB/月の仮定だけを新モデルの運用50MB/月へ置換し、計算前提を本文へ明示。学校/土地の件数を増やしても利用者DBが160MBのままであること、利用者6,666/6,667人で閾値をまたぐこと、ローカル/Cloudflare生成の切替、旧モデル保存からの移行をChromiumで確認。PC1280px・スマートフォン390/320px、採用済み回答とP1保存の回帰確認を実施した。本番アプリ/データの移行検収ではない。

### 合意追記: ローカル原本と複数箇所のバックアップ

2026-09-27、ローカル原本から公開ファイルを生成しSupabaseを利用者保存中心にする方針についてユーザー了承。SQLiteまたはMySQL/MariaDB等を候補とし、C/D/EドライブやGoogle Driveへバックアップを置く運用を検討対象に加えた。エンジン・配置場所・保持世代・頻度は未確定。DBのインストール、ドライブや同期の設定、原本移動・実バックアップはこの追記で実行していない。

編集・取込みする正本はローカル1か所へ固定し、複数コピーを独立編集する二重正本にしない。SQLiteはBackup APIまたはVACUUM INTO等で整合したスナップショットを作る。書込み中のDB本体だけの単純コピーや、稼働中DBを同期フォルダで直接運用することをバックアップ手段にしない。完成したコピーを整合性・件数・データ版等で検査してから日付付きで別ドライブ/Google Driveへ複製し、同期完了と別場所への復元を確認する。復元は確認済みコピーをローカル作業領域へ戻してから使う。WAL等を含む稼働状態を理解せず原本ファイルを移動しない。[SQLite Backup API](https://www.sqlite.org/backup.html)・[WAL](https://www.sqlite.org/wal.html)・[VACUUM INTO](https://www.sqlite.org/lang_vacuum.html)

C/D/Eが別の物理ディスクか、空き容量、別媒体への分散、Google Driveの残容量を配置前に確認する。文字だけ別の同一ディスクを独立した故障対策として数えない。同期だけで誤削除から戻れるとは仮定せず、過去世代を残す。保持世代数とPC側の同期コピーを含め、各保存先の使用量を計算する。現HTMLの3本・20GBは容量比較用の仮定であり、実配置/空き容量の確認ではない。ローカル原本には未公開項目が入り得るため、同期先も公開リンクにせず、公開用生成物との分離を維持する。MariaDB等の採用時はその方式に適したバックアップ/復元手順へ置き換える。

2026-09-27、ユーザーがSQLite採用と実装計画作成を指示。[SQLite原本・静的生成・利用者DB分離の子計画](plan_subdomain-entry-school-migration_c1_sqlite-static-source.md)をC1へ紐付けた。SQLiteはサービス単位、正本1か所、整合した世代バックアップを別媒体とGoogle Driveへ複製する方針。作成時は全C未着手だったが、現在は子計画の[第6区間の到達点](plan_subdomain-entry-school-migration_c1_sqlite-static-source.md#sqlite-wave6-current)まで合成実装・検証が進んでいる。実認証・画面・実原本・クラウド同期等の検収は残り、ドメイン切替とは別工程として実施する。

### 2026-09-28 ブランド設定のローカル検証

C2/C3の表示設定を `web/data/brands.json` へ集約し、学校・学校入口・総合入口の現名称を維持した。React/i18n、初期HTML、OGP/JSON-LD、PWA名称、データセット名と出典へ接続し、置換構文を含む合成名称でも文字列を再解釈しない。画像内文字・装飾ロゴ・外部掲載・メール等は手動管理の範囲として残す。

型検査・lint（既存警告10件、errorなし）・Vitest575件・static117件、合成候補の3出力と容量/混入gate、PC/390pxのローカル表示を確認。独立レビューで見つかった再帰置換とJSON-LD画像固定を修正した。origin/認証許可URL/公開flag/ID/保存キーの変更や本番公開は行っていない。公開/救済期間、実認証/配備/実原本の検収は継続し、H1/docsweep_stateを終端変更しない。差替え・旧設定への復元は[運用規約](reference_manabi-map-operating-rules.md#brand-portability)を参照。
