---
type: plan
status: draft
docsweep_state: planned
tags: [sqlite, static-generation, backup, data-migration]
owner: ishizakahiroshi
review_status: draft
related: [docs/plan_subdomain-entry-school-migration.md, docs/reference_sqlite-school-source-contract.md]
last_reviewed: 2026-09-27
due: 2026-10-04
work_id: WK-20260927T045835019-fa81c51a
ai_provenance_version: 1
ai_author_agent: codex
ai_author_runtime: many-ai-cli
ai_author_provider: openai
ai_author_model_id: unknown
ai_author_model_display: unknown
ai_author_reasoning: unknown
ai_author_model_source: unavailable
ai_execution_refs: [AIX-20260927T045835019-749f2ce4, AIX-20260927T133204820-c9608138, AIX-20260927T133944102-40f5caee, AIX-20260927T140139638-d4f2cd0c, AIX-20260927T140154258-c1a469f8, AIX-20260927T142311747-b9a02fbe, AIX-20260927T143351122-59cd2f6d, AIX-20260927T144139564-d21f3866, AIX-20260927T144343495-03c9c044, AIX-20260927T151505567-a21d1b47, AIX-20260927T151506349-606f90b4, AIX-20260927T151507062-ed8249fb, AIX-20260927T151507758-986a4fa8, AIX-20260927T152038644-ee0e54d0, AIX-20260927T152523029-03ea1403]
docsweep_parent: docs/plan_subdomain-entry-school-migration.md
---

# [計画] C1詳細: SQLite原本・静的生成・利用者DB分離

親: [総合入口と学校サブドメインへの移行](plan_subdomain-entry-school-migration.md)

## context配分

| C | 種別 | 内容 | 備考/注意点 | AI実行 | 実行モデル |
|---|---|---|---|---|---|
| C1 | planned | SQLite原本・取込み・共通スナップショットを作る | 合成データから実装。既存ID・型・公開範囲を維持 | AIX-20260927T133204820-c9608138; AIX-20260927T133944102-40f5caee; AIX-20260927T140139638-d4f2cd0c; AIX-20260927T140154258-c1a469f8; AIX-20260927T142311747-b9a02fbe; AIX-20260927T143351122-59cd2f6d; AIX-20260927T144139564-d21f3866; AIX-20260927T144343495-03c9c044; AIX-20260927T151505567-a21d1b47; AIX-20260927T151506349-606f90b4; AIX-20260927T151507062-ed8249fb; AIX-20260927T151507758-986a4fa8; AIX-20260927T152038644-ee0e54d0; AIX-20260927T152523029-03ea1403 | implementation: openai / gpt-6-sol / high; review: openai / unknown / unknown; verification: openai / unknown / unknown; implementation: openai / unknown / unknown; review: openai / unknown / unknown; implementation: openai / unknown / unknown; verification: openai / unknown / unknown; review: openai / unknown / unknown; implementation: openai / unknown / unknown; implementation: openai / unknown / unknown; implementation: openai / unknown / unknown; implementation: openai / unknown / unknown; review: openai / unknown / unknown; verification: openai / unknown / unknown |
| C2 | planned | 原本の世代バックアップと復元を作る | C1のスキーマ/版情報を使用。保存先の実体確認は設定前 |  |  |
| C3 | planned | 静的生成・管理更新・利用者参照を切り替える準備 | C1/C2後。実DBへの適用はC4 |  |  |
| C4 | planned | 実原本の移設・公開切替・旧原本の縮小 | 明示実行指示後。参照・復元・公開検収の順序を守る |  |  |

実行順序: `C1 → C2 → C3 → C4`。親C1で採用したデータ構成を具体化する子計画。子の実装/原本切替と親C2〜C4のURL・ブランド移行は別工程とし、同日にDB原本とドメインをまとめて変更しない。親C1は本書作成だけでは完了にしない。依存先が未完成のCを並列実行しない。C3内の合成テスト作成等は、編集ファイルと共有スキーマが重ならない範囲で分担できる。

## 目的・採用事項

2026-09-27(日)、ユーザーがSQLiteをローカル原本とする方針と計画作成を指示。学校・土地・教材など公開情報の原本をサービス別SQLiteで管理し、公開時にHTML/JSONへ生成する。Supabaseは認証・お気に入り・メモ・家族共有等の利用者固有保存を中心にする。利用者が増えてもローカル原本へアクセスは来ない。PC停止中も配布済みサイトは閲覧でき、原本の更新は次回公開時に反映する。

原本ファイル名の案は `schools.sqlite` / `land.sqlite` / `kanji.sqlite` / `karuta.sqlite`。書込み正本は各1つ。地域別Pagesの数だけDBを増やさず、配信時に分割する。MariaDB/MySQLは初期導入しない。並行書込み等でSQLiteが実測上支障になる場合に再評価する。最初に既存学校版を移行し、他サービスはこの原本・生成・バックアップの契約を適用する。未実装のかるたを架空の現行DBから移設した扱いにしない。

計画作成時は実装Cが全て未着手だった。2026-09-27のM2でC1の合成データ用最小CLIを作成し、後続セッションでリポ外の合成検証20テストを実行して成功した（下記の検証記録）。C1全体は未完了、C2〜C4は未着手。`due` は再確認日で移行日ではない。build・DB接続/変更・本番配布・同期設定・commit/push/tagはセッションの実行指示を確認する。計画作成を本番移設承認に読み替えない。

## 現状の根拠と変更対象

| 現存する入口 | 確認した依存・維持する契約 |
|---|---|
| `web/scripts/gen-schools-json.mjs` | Supabaseからschools・関連表・入試データを取得。取得部をローカル入力へ分離 |
| `web/scripts/gen-seo-pages.mjs` | manifestと生成済みJSONを読む。後段のHTML生成を再利用 |
| `web/src/lib/school-select.ts`、`web/scripts/lib/public-api.mjs` | 列の公開許可リスト、現行校・公式URL・出典等の公開条件 |
| `web/supabase/baseline_schema.sql` と `web/supabase/migrations/` | 学校/学科ID、型、RLS、RPC、FK。baselineだけで実本番状態を断定しない |
| `web/src/hooks/useSchools.ts` | 通常は静的読取、設定によるSupabase直読分岐もある |
| `web/src/pages/DashboardPage.tsx`、`web/src/components/SchoolDetailSheet.tsx` | 管理画面の学校/学科名直読、学校原本の修正と再生成受付 |
| `get_deviation_review_queue` / `correct_school_deviation`（SQL内） | 学校・学科・参考値のJOIN/書込み。SQLite採用後の二重正本を防ぐ |
| `web/src/hooks/useUserData.ts`、`useFamilyShare.ts` | 個人保存と家族共有。原本移設でも保存・権限を保つ |
| `web/package.json`、`.github/workflows/validate.yml` | 学校生成にSupabase用設定が必要な現在のbuild/CI |
| `web/supabase/functions/trigger-snapshot-rebuild/index.ts` | Pages hookの受付。ローカル原本の更新や生成は実行しない |
| `.github/workflows/nightly-backup.yml` | Supabaseの暗号化バックアップ。新SQLite原本は保護されない |

重要: `user_school_favorites`・`user_school_notes`・`user_school_deviations`の学校FKは `ON DELETE CASCADE`。学科へのFKもある。**学校原本を複製できても、Supabase学校行を先に削除してはいけない。** 家族RPCは主に利用者表と家族所属を読み、RLSは本人/家族の境界を維持する。

参照: 親計画の現行構成・C2利用者引継ぎ表（理由: ドメイン移行の認証ケースは本書へ重複せず引き継ぐ）。別サービスのprivateな内部計画・実データは本書へ転記せず、担当リポで同じ契約に照合する。

## データと配置の契約

- SQLite原本・作業スナップショット・SQL dump・個人データ・秘密はGitや公開成果物へ入れない。原本はGit作業ツリー外・同期フォルダ外を基本とし、公開リポにはスキーマ/処理/合成fixtureだけを置く。実パスは無視対象のローカル設定へ記録する。
- C/D/Eのいずれかを原本先、別物理ディスクとGoogle Driveをバックアップ候補にする。文字だけ異なる同一ディスクを独立故障対策と数えない。実体・空き容量・同期モード/残容量を設定前に調べる。公開用リンクを作らない。
- SQLiteには学校本体だけでなく、学科・出典・年度統計・名称履歴・学校関係・分類マスター等、現行生成に必要な関連データを含める。利用者の認証/メモ等は移さない。対象テーブルの閉包はC1で一覧化する。
- UUID/record_key/学科IDを再発番しない。UUIDはTEXT、真偽値は0/1＋制約、日時は時差を明示した表現、配列/JSON/enum/numericは列ごとに保存型と復元型を決める。NULL/空文字/順序/小数精度/閉校情報を比較する。
- 接続ごとにSQLite外部キーを有効化し検査する。単一書込みを基本とし、取込みはtransactionと排他制御で実行する。生成は確定スナップショットをread-onlyで読む。
- スナップショットにはschema版、dataset版、元データ版、作成時刻、テーブル件数、ファイルSHA-256を付ける。公開候補にはcode SHAと生成器版も紐付ける。ハッシュ対象と生成時刻を分離し、同じ入力の内容一致を検査する。
- Python標準`sqlite3`による取込み/バックアップと、既存JS生成器が読む正規化JSONスナップショットを実装の第一案にする。Pythonの対応版とJSON契約をC1で固定。Node側にSQLiteドライバを新規導入することは前提にしない。生成処理へ秘密値や個人データを渡さない。

## C1: SQLite原本と取込み・スナップショット

### 作業内容

到達点: [生成器の依存表・型・公開契約](reference_sqlite-school-source-contract.md)のC1-a〜C1-eを合成実装・検証済み。2026-09-27の静的調査で整理した25表をschema 3へ取り込み、正式ローカルsnapshot/manifestと明示入力adapterを接続した。今回の承認範囲は学校版のC1-b〜C1-eであり、他サービスへの共通manifest契約は未完了。C1全体のplannedは維持し、C2〜C4へ自動で進まない。

1. baselineに加えmigrationとコードを読み、原本/利用者/管理受付/運用設定を分類する。`scripts/`以下のデータ取込み・SQL生成・審査経路も検索し、Supabase原本へ書く経路を列挙する。`data_reports`、計測events、app_config等を無条件に原本へ移さない。
2. 学校用SQLiteスキーマ・schema migration、列の型対応、公開に必要な関連表、入力/出力契約を実装する。原本非公開列と公開用snapshotを別にする。サービスを跨いだ外部キーは作らない。
3. ローカル取込みをdry-run既定で実装。合成snapshotから重複ID、未知enum、孤立学科、NULL、履歴、数値を検証する。失敗時はtransactionを戻し、完了前のファイルを正本へ昇格しない。
4. Pythonから公開許可済みの正規化snapshotを出し、JS側が現在の学校レコード構造へ読むadapterを用意する。現行Supabase入力は比較/復旧用として切替完了まで残し、失敗時の暗黙フォールバックはしない。
5. 土地/漢字/かるたには同じmanifest契約とサービス別ファイルの境界を定義。既存入力があるものは担当リポでadapterを対応させ、無いものは初回投入仕様として記録する。privateの個別スキーマは担当リポ内に置く。

### 変更予定ファイル

既存: `web/scripts/gen-schools-json.mjs`（取得adapterの分離）、`web/src/lib/school-select.ts`、`web/scripts/lib/public-api.mjs`（公開契約の再利用）。新設案: `scripts/local-data/schema.sql`、`scripts/local-data/store.py`、`scripts/local-data/test_store.py`、`web/scripts/lib/school-source.mjs`、同テスト。公開fixtureは最初から合成する。実装開始時に並行作業との差分重複を確認する。

### 完了条件

合成データで取込み・再取込み・transaction失敗復旧・FK検査が成功。ID/型/公開JSON契約が一致し、非公開の未知列を増やしても公開に混入しない。無関係な認証/利用者表を読み込まない。DBエンジンと生成器の境界が文書化される。実原本取込みはC4まで未実施として区別する。

### C1の2026-09-27 M2実施記録

作成した最小成果: [合成試作README](../scripts/local-data/README.md)、schema.sql、store.py、example.synthetic.json。READMEに入力/型/ID/公開条件、現行取得関係から分かる未対応表、実行許可後の再現手順を記録した。C2のバックアップ実装ではなくC1の一部分である。

学校・学科を保存する。course_typeはgeneral/nullのみ。未知行列を破棄、未知最上位キーを拒否し、既存ID/独立record_keyを再発番しない。dry-runはメモリDB、applyだけBEGIN IMMEDIATEでupsertし、FK/enum/identity失敗でrollbackする設計。出力はread-only snapshotから完成した一時ファイルを排他的に最終名へ確定する。親レビュー指摘の「途中JSONの最終名残存」「commit後の標準出力失敗を未commitと断定」をソース上修正した。

公開JSONは現行BASIC_FIELDSの小さい部分集合で、activeかつHTTP(S)公式URLの学校だけ。学科は出典表の公式ゲート未対応のため公開しない。座標・課程・人数等の出典条件も未対応なので出さない。全snapshot・v1 API互換ではなく、既存生成器へ接続していない。学校/学科の実FKや利用者保存を変更していない。

実施した確認はソース/SQL/仕様の読取りと静的突合。合成入力は学校2行・学科1行を作成したが取込み件数ではない。取込み・再取込み・rollback・export・schema実行・テスト・buildはいずれも未実施。従って日次M2の実証条件も本C1の完了条件も未達。次はREADMEの再現手順を実行許可のあるセッションで確かめ、その後に関連表閉包・型/精度・正式manifest・JS adapterへ進む。原本/認証DB/実ホームへのアクセスはしていない。

親レビューは新規4ファイル全文と本書の差分を対象とした。出力の途中ファイルと例外メッセージの2指摘について、修正した処理を再読した。Python ASTの構文解析1ファイル、JSONの構文解析1ファイルは成功。モジュールのimportやCLI起動、DB作成、回帰ケースの実行はしていない。ソース上の修正反映と動作上の解消は別であり、READMEの中断・再取込み・rollback・公開条件の確認が残る。

### C1の2026-09-27 最小試作の合成動作検証

ユーザー指示に基づき、READMEの再現手順を実際のCLI子プロセスで検証した。入力・SQLite・JSONはリポ外のOS一時領域へ限定し、実データ、本番DB、認証設定へはアクセスしていない。全関連表と既存生成器への接続は次の区切りとする。最終URLの決定をこの検証の前提にしていない。

実行: `python -B scripts/local-data/test_store.py -v`。Python 3.14 / Windows、**20テスト成功**。テストは標準ライブラリのみで、各ケースの一時領域を回収する。最小試作の範囲内の実装・検証を完了したが、親子計画のH1、docsweep_state、C1のplannedは維持する。

| 確認項目 | 観測結果 |
|---|---|
| 初回・再取込み | 学校2行/学科1行。同じ入力の再取込みで行・件数不変。更新は反映し、入力に無い行は保持 |
| ID・型 | 学校/学科のUUIDと独立record_keyを維持。既存key/学校付替え拒否。NULL・時差付き日時を保持、公開booleanは真偽値 |
| 公開列・公開条件 | 公開学校1行/学科0行、許可11列に限定。内部メモ/追加未知列を保存・公開しない。非activeと公式URLなしを独立に除外 |
| dry-run | 新規DBを作らず、既存DBのバイト列とファイル一覧も不変 |
| rollback | 学校更新後の既存identity違反と新規孤立学科FK違反を別々に実行。既存DBの全行/版/バイト列を保持。再exportの名前・dataset版・内容SHA-256一致。新規失敗DBは残らない |
| commit失敗 | 障害注入でdataset更新後のcommitを失敗させ、行と版が元へ戻ることを確認 |
| 入力・DB拒否 | 重複id/key/JSONキー、未知enum、数値の真偽値、時差なし日時、不正URL、利用者表等の最上位キー、別用途/版違い/空DBを拒否 |
| 排他 | 実SQLite接続でBEGIN IMMEDIATEを保持し、別CLIのwriterがbusy timeoutで失敗、データ不変 |
| 出力完成・非上書き | read-only export成功、内容ハッシュ一致。既存JSON/DB/確定直前の競合出力を上書きしない |
| 途中JSON | 部分書込み、fsync、linkの失敗とKeyboardInterruptを注入。完成名を作らず一時物も回収 |
| 確定後の表示失敗 | BrokenPipeErrorを注入し、commit済みDB/完成JSONが保持されることを確認 |

発見・修正: `urlsplit` が非数値・範囲外ポートを分解時には拒否せず、公式URLとして取込みを通す不具合を2ケースで再現した。`store.py` のURL検査で `parsed.port` にアクセスして検証し、不正ポートの取込み拒否/出力除外と有効ポートの通過を回帰テストにした。schema.sqlとexample.synthetic.jsonは変更していない。

初回のテスト実行ではテスト側の接続閉じ忘れによる一時ディレクトリ削除エラーも発生した。SQLiteのcontext managerだけでは接続が閉じないため、テストで明示closeするよう修正。最終20テストは削除エラー・ResourceWarningなしで成功した。

既存未コミット変更は着手前のSHA-256一覧と対象ファイルの控えをリポ外に保存し、今回の編集をstore.py、test_store.py、README.md、本計画に限定した。アプリbuild、commit/push/tag、公開は実施していない。

最終確認: 今回の対象外にある既存未コミットファイルのSHA-256変更は0件。実Git indexも検査前後で一致した。変更4ファイルを隔離した一時indexで検査し、`git diff --cached --check` と秘密検査は成功（4ファイル走査、終了コード0）。秘密検査の設定で3文字未満の17語が除外されているため、その短語は未検査。初回テストが残した合成DBも、内容一覧を確認した対象だけを削除し、一時テストディレクトリを回収した。

検証の限界: 書込み/flush系の異常と中断は障害注入であり、OS強制終了・電源断・実媒体故障の実証ではない。全関連表、型/小数精度の完全対応、正式manifest、JS adapter、世代バックアップは未実装。今回のrollback検証をC2のバックアップ復元検証や本番受入と扱わない。次回は本C1の関連表閉包・型対応・正式manifest・既存生成器への接続から再開する。

### C1の2026-09-27 関連表・型・公開条件の範囲確定

ユーザーの継続指示に基づき、前段で提案した「必要な関連表と列の洗い出し」までを実施した。[契約文書](reference_sqlite-school-source-contract.md)を新設し、最小試作READMEからも接続した。実装の拡張・既存生成器の起動・本番接続は行っていない。

確認した取得経路は学校本体のSELECTと募集単位の別SELECTの2本。直接13表からbaselineの出方向FKを閉じると24表、SQL生成器が書く旧新統計対応を加え25表。baselineのpublic全43表のうち残る18表を利用者保存・受付/監査・運用/計測として除外した。認証schemaも取り込まない。45 migrationの一覧/対象DDL検索と、63スクリプトの書込み記述検索を併用した。これはローカルソースの静的範囲確定であり、実DBの現行schema・外部job・手動SQLの全経路監査ではない。

設計上の要点:

- アプリ用JSONとv1 APIの公開条件は異なる。試作の公開11列だけでは既存生成器へ接続できない。33学校列と各関連列を選択して渡し、既存JSの公開ゲートを再利用する。
- active学校だけを原本へ取り込むとinactive前身校とその入試履歴が欠落する。原本保存の範囲と生成の採用条件を分ける。
- 原本は既知全列を保存し、正式入力の未知列は拒否する。試作の未知列破棄を完全原本へ流用しない。
- NULL同値の一意性、状態コードと真偽値、学科ui_group、同一学校内の募集単位membershipはFKだけでは再現できない。数値精度・配列・日付・出典の対条件とともに合成受入へ追加する。
- 取得adapterはcatalog圧縮前のrowsを返す。現行生成器はトップレベルでenv読取/接続/出力するため、テストから直接importせず副作用のない部分を分離する。

次の順序はC1-a（基本7表）→C1-b（沿革3表）→C1-c（入試等15表）→C1-d（正式snapshot/manifest）→C1-e（adapter比較）。この静的調査時点では全段階が未実装だった（C1-aの後続実施は下記）。schema 1を欠落列の自動補完で正式原本へ昇格しない。各段階で合成検証し、C2以降や本番操作はこの調査の完了から自動で着手しない。

静的検証: SELECT文字列を副作用なしで解析し、学校33列・直接13表の取得列がbaselineに存在すること、契約文書の25表がFK閉包24表＋旧新対応1表と一致することを確認。3文書の相対リンク15件は実在し、対象を限定した `docsweep fix-related --dry-run --json` はfixes/applied/failedすべて空だった。今回の変更は文書のみであり、前段の20動作テストを今回再実行した扱いにはしない。

### C1-aの2026-09-27 基本7表の合成実装検証

ユーザー指定のC1-aまでを実装・検証した。新設は `scripts/local-data/schema-core.sql`、`store_core.py`、`test_store_core.py`、`example.core.synthetic.json`。READMEへ新旧CLIの境界と実行手順、契約文書へ到達点を追記した。schema 1の `schema.sql` / `store.py` / `test_store.py` / `example.synthetic.json` は変更せず、既存20テストを保持した。

版: 入力format `synthetic-school-core` / input_version 1、SQLite schema_version 2 / purpose `synthetic-school-core-c1a`、fixture dataset_version `synthetic-core-001`。7表だけの合成原本であり、25表の完全原本や正式snapshotではない。既存schema 1・用途/版不一致・空DBを拒否し、暗黙upgrade/削除/全置換を行わない。

実行: `python -B -m unittest discover -s scripts/local-data -p "test_*.py" -v`。Windows / Python 3.14、**40テスト成功（既存20＋C1-a追加20）、35.864秒**。CLIは子プロセス、書込み先はリポ外のOS一時領域に限定し、テストの一時ディレクトリは回収された。Nodeで既存 `public-api.mjs` の公開関数を呼ぶが、生成器・環境変数・認証設定・実学校データは読まない。公開サイト設定JSONは既存関数の依存として読む。

| 検証 | 結果 |
|---|---|
| 基本7表・全列 | baseline DDLの7表全列とNULL可否をSQLiteのPRAGMAで照合。fixtureの全行/全列を保存後に比較。学校2、学科1、出典1、course master 1、lifecycle master 2、recruitment master 2、field master 4を確認 |
| 型・ID | 独立UUID/record_key、NULL/空文字/0、時差付きtimestampと小数秒、course_times順序を保持。整数範囲・enum・実在日/日付順・JSON booleanを検査。座標7桁をDecimal経由で保存し、境界値のJSON numberとJS往復一致を確認 |
| 原本保持 | inactive学校とinactive masterも保存。同一入力の再取込みで全行不変。upsertで未指定行と既存timestampを保持 |
| 拒否 | 全7表で未知/欠落列・重複キー、未知/欠落表、入力/DB版不一致、孤立FK、不正URL/HTTP status/検証日時の組、ID/key変更と既存学科の学校付替えを拒否 |
| マスター整合 | is_active/is_recruitingと状態master、閉校/closingの募集不可、学科ui_groupとcourse masterを照合。master更新時は入力に無い子行も検査。必要な子を同時更新すると成功 |
| transaction | master→学校→学科→出典の途中FK失敗で全7表・dataset版・DBバイト列を維持。新規失敗DBは残らない。commit失敗とKeyboardInterruptの障害注入でも全表/版が復元 |
| 書込み境界 | 新規/既存/失敗dry-runでDBとファイル一覧不変。実SQLite writer lock競合を拒否。新規作成の競合相手を上書きせず、commit後の表示失敗では確定DBを保持 |
| 部分投影・公開 | 学校33列、学科5列、出典8列を明示選択。非公開メモ/created_atを渡さず、公式URLなしactive学校は部分投影に残す。既存API関数で公式/非公式/不在/両方、人数0、学科名/分類の出典条件、404保持を確認 |

レビューは同じAIによるDDL・コード・差分の自己レビューであり、独立AIレビューではない。SQLite制約とPython入力検証、commit前全行検査を組み合わせる。任意の直接SQL更新の安全性、OS強制終了/電源断/媒体故障の復旧は未検証。

既存変更の保護: 着手時の既存未コミット27ファイルのSHA-256一覧と編集対象の控えをリポ外へ保存した。今回編集した既存3ファイル（本計画・契約文書・README）を除く24ファイルの変更は0件、実Git indexのSHA-256も一致。新規4ファイルを含む対象7ファイルを一時Git indexへ隔離して `git diff --cached --check` と秘密検査を実行し成功した。秘密検査は7ファイル走査・検出0、3文字未満の監視語17件は設定上の除外で未検査。テストログと検証したコード/fixtureのSHA-256はリポ外の作業控えに保存し、dirtyなHEADだけを検証対象の識別情報にしていない。

今回の境界: C1-b/cの残る18表、C1-dの正式snapshot/manifestとschema migration、C1-eの取得adapter/地図/アプリ比較、他サービス共通manifest、C2〜C4は未着手。`project_core_rows()` は今回の公開条件を確かめる部分投影で、既存生成器へ接続していない。実データ・本番DB・認証設定は触らず、build・commit・push・tag・公開は実施していない。親子H1、docsweep_state、C1のplannedは維持する。

<a id="c1-b-through-e"></a>

### C1-b〜C1-eの2026-09-27 並列実装・統合検証

ユーザーが直前に提示した残りのC1-b〜C1-eを全承認し、サブエージェントでの並列作業を指示した。承認をC2〜C4、実データ/本番DB/認証設定、build・commit・push・公開へ拡大していない。既存40テストとschema 1/2実装はそのまま保持した。

分担は沿革、入試、adapterの3サブエージェントと、親AIによる25表取込み・版移行・snapshot/manifest統合。沿革/入試は独立したファイルで同時実装し、同じスキーマを重ねて編集しない形で合成した。沿革担当は親の統合実装とadapterを独立レビュー、入試担当も統合処理を読み取りレビューした。サブエージェントの成功報告だけで閉じず、親側で全テストとPython→JS結合を再実行した。

| 区切り | 実装した結果 | 証跡 |
|---|---|---|
| C1-b | 沿革3表全列、NULL安全な一意性、日付/年度境界、自己関係/FK拒否、閉校前身校・同名別ID・改称を保持 | `school_history.py` / `schema-history.sql` / `test_school_history.py`、15テスト |
| C1-c | 入試/偏差値/6masterの15表全列。NULL品質フラグ・旧統計一意性、active学科偏差値、人数/比較可能条件、出典、同校membershipを検査 | `school_admission.py` / `schema-admission.sql` / `test_school_admission.py`、24テスト。baselineの全列/NULL可否/FK先/更新削除actionを照合 |
| C1-d | 全25表とdataset/source両版を1transactionで確定。schema 2から新規DBへ明示copy migration。13表許可列snapshot＋全25表件数/15コード識別を持つmanifest | `store_school.py` / `school_fixture.py` / `example.school.synthetic.json` / `test_store_school.py`、15統合テスト |
| C1-e | 明示入力選択、snapshot検証、閉校前身校/入試子表の取得形復元、共通catalog化、既存アプリ/地図/API比較。env/接続読取は明示Supabase経路内だけ | `web/scripts/lib/school-source.mjs` / 同テスト、12テスト。生成器取得部とpackage呼出しを接続 |

版はschema_version 3、purpose/input format `synthetic-school-source`、input_version 1、fixture dataset_version `synthetic-school-001` / source_version `synthetic-input-001`。入力の合成宣言を実データ検出機能と扱わない。schema 1の不足情報を捏造するupgradeは無い。schema 2移行は `--from-core` の明示指定と新規出力先が必須で、元7表の全列/全行一致・未知表/列拒否を検査し、元DBを書き換えない。通常importはupsertで、削除/全置換を追加していない。

正式snapshotは13表をflatな列許可リストで保存し、学校はinactiveも保持する。master本体・原本非公開メモ・旧新対応を公開投影へ出さない。manifestには作成時刻と全25表件数、正規化snapshot全体SHA-256、snapshotファイルSHA-256、15ファイルの相対パス/内容SHA-256と一覧hashを持たせた。内容hashから時刻を分離し、Python/JSでキー順・配列順・小数表現を揃えた。hashは破損検出で署名ではない。

候補2ファイルを一時領域で完成・fsync・検証してから、出力先を排他的に予約し、manifestを最後に配置する。既存ディレクトリは空でも上書きしない。途中snapshotだけではadapterが受理しない。書込み/fsync/link失敗・KeyboardInterruptの障害注入で未完候補を回収し、確定後の表示失敗では完成候補を残すことを確認した。OS強制終了/電源断/媒体障害時の復旧は未検証でC2へ残る。

親が実行した検証:

- `python -B -m unittest discover -s scripts/local-data -p "test_*.py" -v`: **94テスト成功、45.097秒**（既存40＋沿革15＋入試24＋統合15）。全25表全列/NULL可否、再取込み、未知列拒否、最終表FK失敗/commit失敗で全行と両版rollback、明示移行、出力破損/版不一致を検証。
- `pnpm test:school-source`: **12テスト成功**。独立した合成Supabase取得形とsnapshotを、正規化rows、catalog、アプリ変換、地図、公開APIへ通して内容/ID一致を検査。既存公開ゲート、旧統計と新統計の二重集計防止、course_times順序を維持。
- `pnpm exec vitest run src/lib/admission.test.ts src/lib/mapPayload.test.ts`: **既存26テスト成功**。合成設定を使うテストのみで接続しない。
- Pythonが実際に生成した合成bundleをNodeのadapterで読み、inactive前身校・入試関連・座標の小数7桁/境界、Python/JSのコード識別15パスの一致を確認。PythonのverifyとJSのhash照合も通過。
- 対象JSの構文検査・対象oxlint・差分検査は成功。テスト入力/SQLite/候補JSONはリポ外OS一時領域またはメモリで作成し、テスト所有の一時物を回収した。生成器そのものは起動せず、public/distの生成・実データ比較・ブラウザ受入はしていない。

独立レビューの4指摘は、沿革snapshotの結合FK追加、移行元schema 2の未知列/表拒否、座標のnumeric(10,7)条件の両言語統一、コード識別必須15ファイル集合の統一として修正した。沿革担当による最終再読で4件とも反映を確認し、親の回帰/結合テストも成功した。

変更一覧: `scripts/local-data/` の新規10ファイル（history/admissionの各Python・SQL・test、store_school.py、test_store_school.py、school_fixture.py、example.school.synthetic.json）、README、本計画、契約文書、JS adapterと同テスト、生成器取得部、web/package.json。packageの既定入力は明示 `--school-source=supabase` とし、運用をローカル原本へ切り替えていない。新規adapter検査は `test:school-source` と既存testコマンドへ接続した。

着手時の既存未コミット31ファイルをSHA-256で記録し、今回編集する既存3文書を除く28ファイルは変更0件、実Git indexも一致した。検証ログ・最終対象コードhash・着手前控えはリポ外に保存する。C1-b〜C1-eの学校版合成検証は完了したが、他サービス共通manifest・C2の世代バックアップ・C3/C4の運用切替は未実施のため、親子H1/docsweep_state/C1 plannedは変更しない。

## C2: バックアップ・世代管理・復元

### 作業内容

1. 配置候補の実体・容量を読み取り確認し、正本1か所・別物理媒体・Google Driveの役割をローカル設定へ記録する。実パス/識別情報をpublic文書へ転記しない。
2. SQLite Backup APIを基本に完成したsnapshotを同期外へ作り、`integrity_check`/`foreign_key_check`、件数/版/ハッシュを検査してからバックアップ名へ確定する。稼働中DB本体だけのコピーや、同期フォルダ上のDB編集を禁止する。
3. 更新前と公開候補確定時に世代を作る方式を基本とし、保持世代数・頻度は実容量から設定する。上書き型の最新1本だけにしない。試算の3本/20GBは採用済み保持設定ではない。削除は対象一覧のdry-runと復元可能世代の確認を先に行う。
4. 完成ファイルを別ドライブ/Google Driveへ複製する。ローカルコピー成功とクラウド同期完了を分けて記録。未同期/容量不足/中断時に成功扱いせず再実行可能にする。未公開原本を含むため、アクセス範囲と必要な暗号化方式も決める。
5. 作業用の別場所へ復元し、同じ公開snapshotを再生成して件数/内容ハッシュを比較する。原本、公開成果物、利用者DBの復元を別々に検証する。

### 変更予定ファイル

新設案: `scripts/local-data/backup.py`、`scripts/local-data/test_backup.py`、`scripts/local-data/README.md`、無視対象の原本配置/復元runbook。必要なら`.gitignore`へ原本/途中snapshot混入防止を追加。既存`.github/workflows/nightly-backup.yml`のユーザーDB保護は継続し、SQLiteへ置き換えない。

### 完了条件

書込み中の合成DBから整合したバックアップを作れ、中断・同期失敗・破損を検出する。復元コピーから同じデータを生成できる。実媒体/Google Driveへの設定と復元実査はC4に残し、mockやファイル存在だけで同期完了としない。

## C3: 生成・利用者参照・管理編集・配布の移行準備

### 作業内容

1. 生成の既定入力をSQLite由来snapshotへ変更する候補を作る。manifest/詳細JSON/公開API/SEO/旧URL互換を維持し、原本抽出だけでなく学校データ生成がSupabaseへ依存しないことを検査する。ブラウザの認証・利用者保存用Supabase設定は残す。
2. 学校/学科への利用者FKを最小ID registryへ付け替える案を優先比較する。registryは原本ではなく派生ID索引で、必要項目/容量/更新権限を明示してから採否を確定。採用しない場合も同等のサーバー側ID検証を設計し、FKを単に外して終わりにしない。本番適用前のmigration候補と復旧手順を作る。
3. 新ID登録→静的公開→利用者保存の順序、閉校・統合・旧版からの保存、家族共有・削除の挙動を定義。本人/家族/他人のRLSは維持。旧schools行削除のcascadeが利用者保存へ届かないことを合成DBで検証する。
4. 管理修正は「提案受付→ローカル原本へ採用→再生成→公開確認」に一本化。審査RPC/学校名直読/原本直書込み/直接取得モードを改修し、受付済み・採用済み・公開済みを区別する。PC停止時は受付を保持し、公開済みにしない。
5. `trigger-snapshot-rebuild`とCI/buildの入力を改める。検査済み成果物をWranglerで配る経路を作り、Functionsの同梱先・環境差・プレビュー・ハッシュ確認を定義。同一候補を各分割先と互換APIへ配る。公開物のID索引/データ世代が一致しない場合は停止する。

### 変更予定ファイル

既存: `web/scripts/gen-schools-json.mjs`、`gen-seo-pages.mjs`、`verify-static-output.mjs`と同テスト、`web/package.json`、`.github/workflows/validate.yml`、`web/src/hooks/useSchools.ts`、`useUserData.ts`、`useFamilyShare.ts`、`web/src/pages/DashboardPage.tsx`、`web/src/components/SchoolDetailSheet.tsx`、`web/supabase/functions/trigger-snapshot-rebuild/index.ts`。C1で列挙した取込み/審査スクリプトも対象に含める。

新設案: ID参照・審査経路の`web/supabase/migrations/`ファイル、`scripts/local-data/publish.mjs`とテスト。migrationの実適用・公開はC4。baselineを直接書き換えるだけで実DB変更済みにしない。

### 完了条件

合成データで検索・地図・学校詳細が画面に見え、本人の保存/家族共有/非許可者の拒否が維持される。管理修正がSQLite原本と公開版へ一方向に反映される。原本停止時も既存配信は閲覧可能。原本DB/非公開列/個人データがdistに入らない。Supabase直接取得は移行後の通常経路として残らず、未変更の復旧候補とは区別される。

## C4: 実原本の移設・公開切替・縮小

### 作業内容

1. 対象SHA・並行編集・実スキーマ・件数と利用者保存の照合基準を確認。原本更新を一時停止し、その間の変更提案を別queueへ保持する。原本とユーザーDBのバックアップ/復元確認後、一貫したexportからSQLiteへ取込み、全関連表とIDを比較する。秘密・実データをログに出さない。
2. 実SQLiteのバックアップを予定媒体へ複製・復元する。生成候補を旧生成と比較し、日時など意図した差分以外を説明する。学校原本を削除する前に利用者参照migrationを適用し、保存内容の保持と実認証/家族共有を確認する。
3. ローカル生成版をPreviewで検収してから本番へ反映。既存Git自動公開との競合を解消する。Direct Upload/Git連携の制約・各site20,000files・単体25MiB・動的回数/CPUを確認。API新分割が必要なら親C1の互換設計と一緒に検証する。
4. 公開先の内容ハッシュ・生成世代・保存/管理更新を確認し、前版へ戻せる成果物を保管。原本への旧書込みが残らないことと参照依存の消失を確認後、旧Supabase原本の縮小対象/容量効果/復旧方法を一覧にし、削除の実行指示に従う。関係のある名前履歴やRESTRICT依存を無視して削除しない。
5. 実際の利用者DB容量/送信/認証人数、原本と各保存先の容量、生成/配布時間を記録し、HTMLの仮定と費用見通しを更新する。原本切替後のバックアップと少なくとも1回の更新公開を観察して完了判断へ進む。

### 停止条件・復旧

ID/件数/公開内容の説明できない差、FK孤立、復元不可、権限漏れ、ユーザー保存の変化、部分配布の世代不一致があれば次の変更を止める。学校原本の縮小は最後に行う。公開は直前成果物へ戻し、切替後に追加されたメモ等を過去へ巻き戻さない。原本を旧経路へ戻す必要がある場合は停止中queueとSQLite採用済み差分を照合し、古い原本からの上書き復元をしない。

### 完了条件

実SQLiteが原本として更新/生成でき、公開サイトの閲覧と利用者保存が継続する。旧原本がオンライン容量へ不要に残らず、例外の参照索引/設定は根拠付きで記録される。別媒体/Driveから復元し、同じ公開内容を再生成できる。実装・静的検査・Preview・本番検収・観察を区別し、未実施を完了にしない。

## 検証コマンドと報告

既存の関連検査は`web`で`pnpm typecheck`、`pnpm lint`、`pnpm test:static`、対象を絞ったVitest、Functions/RLS関連テストを使う。Python 3.14の合成検査は`python -B -m unittest discover -s scripts/local-data -p "test_*.py" -v`。C1-eまででPython94、JS adapter12、既存入試/地図26テストを実行した。DB移行/認証の実検収はテスト成功から推定しない。build・実生成・配布は実行指示後に実施する。

作成時の確認はソース/SQL/既存計画との突合、親子リンク、文書整合、公開情報スキャンまで。今回はアプリのテスト・build・DB接続・移設をしていない。C完了時は変更ファイル、入力/候補の版、検査結果、実環境確認の有無、残件を記録し、該当Cだけ状態を更新する。親全体は子計画の作成だけでdoneにしない。

## 費用・容量の基準

現在のHTMLの合成例: 利用者DBは共通100MB＋1,000人×60KB＝160MB/500MB（32%）。保存6,666人まで枠内、80%目安5,000人。月1,000認証利用者×1,500KB＋運用50MB＝1.55GB/5GB（31%）。保存総人数とMAUを混ぜない。原本は別容量であり、学校数/土地件数を増やしてもSupabase原本容量へ加算しない。ただし参照ID索引等の実容量は測る。

学校/土地/教材の原本DB合計約2.686GB、3本分約8.058GB/予算20GBという値は仮定。画像・音声・生成物・一時領域・保持世代・同期キャッシュを別加算する。Cloudflareの静的容量と動的枠、Supabaseの保存/転送/休止/バックアップ条件を満たすか実測で判断し、無料の恒久保証にしない。

資料: [容量・費用の検討HTML](review_portal-school-brand_2026-09-27.html)。仕様根拠: [SQLiteの適した用途](https://www.sqlite.org/whentouse.html)、[Backup API](https://www.sqlite.org/backup.html)、[Cloudflare Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)。

計画作成時の検証結果（2026-09-27）: 別エージェントが順序・既存依存・完了基準をレビューし重大な指摘なし。親子relatedのdry-runは追加修正0、provenance整合確認成功。対象公開3ファイルの秘密スキャンは検出0（3文字未満の設定監視語17件は対象外）。文書規約検査とHTMLの表示/保存/計算の回帰検査も成功。アプリやDBの実装検証ではない。
