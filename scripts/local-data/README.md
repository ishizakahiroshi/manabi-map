# 合成データ用のSQLite原本試作

## 明示接続のPostgreSQL復元アダプター

`restore_pg_adapter.py` は明示した接続先と期限を使い、同snapshotの採取、新規復元先の所有確認、transaction内外の照合を行う。`restore_pg_catalog.py` はPostgreSQL 18の明示allowlistからcatalog収集・ACL再生のSQL候補を生成する。候補のhashは提案値であり、独立レビュー後のpin採用、dumpのTOCと復元SQLのレビューを別に行う。未支持のobjectは無視せず拒否する。

`restore_transport_adapters.py` の `AgeCodec` / `R2Store` / `FilesystemStore` は `restore_transport.prepare` → `publish` → `recover` に接続する。独立して保持したpinで復号前のサイズ・hashを検査し、復帰後は `restore_bundle.validate` へ渡す。環境からの認証探索や自動起動CLIはなく、既存workflowも切り替えない。

保証は支持するDB部分に限る。非MVCCの全writer停止は外部controllerの責任で、freeze receipt自体はロックではない。役割は復元先に同一定義で存在する必要があり、role作成・パスワード・外部providerは扱わない。秘密を含むSQL、bundle、接続情報やidentityは公開fixtureやログへ保存しない。通常のoffline試験は `python -B -m unittest discover -s scripts/local-data -p "test_restore_*.py"`。合成試験の成功は実対象の復元検収を意味しない。

## C2 世代バックアップと復元

学校schema 3の世代作成・検証・別場所への復元は`backup.py`、ローカル複製と削除しない保持候補の検査は`backup_replica.py`。既定はdry-run。実行方法と検証境界は[バックアップ契約](../../docs/reference_sqlite-backup-contract.md)を参照する。公開用snapshotと原本DBのバックアップは別物で、原本DBを配信フォルダへ置かない。Google Driveの同期や別媒体への実配置は、この合成実装だけでは完了しない。

UNCへのファイル転送は別の`backup_transport.py`を統合CLIの`replicate-remote`から使う。SQLiteはUNC上で開かず、読み戻したローカルコピーを検証する。RDP転送ドライブは明示`--rdp-drive`が必要。失敗時も手元の完成世代とリモートの試行結果を残す。不完全な保存先を上書きする再試行や常駐の自動再試行は行わない。

## C3 学校・学科のID候補索引

`school_id_index.py --bundle <scratch>/candidate-001 --output <scratch>/id-index-001.json`で、検証済みschema 3 snapshotから学校IDと学科ID/所属学校だけの候補を検査する。`--apply`で新規ファイルへ確定し、`--previous <scratch>/id-index-previous.json`で過去IDを保持した差分を作る。廃校等で入力から消えたIDを削除せず、学科の学校付替えは拒否する。候補の生成はSupabase registryへの登録・公開ではない。切替全体は[参照と生成の準備](../../docs/reference_sqlite-school-cutover-readiness.md)を参照する。

## C3-a/b/d 登録・受付・公開の合成試作

`school_registry.py`は既存ID索引から合成登録receiptとUUIDだけのSQL候補を作る。`sql-candidates/`は実migrationの配置先ではなく、隔離PostgreSQL向けの学校/学科registry・全5参照表のFK切替・読み取り復旧検査を置く。既存学校の削除や実DB接続は行わない。

`school_review_queue.py`はリポ外の新規SQLiteへ合成受付を保存し、審査・採用記録・生成・公開要求・公開確認を別状態で追跡する。Actorは合成の役割入力であり、認証/RLSではない。採用予定の許可列投影を返すが、実原本へ書き込む処理は持たない。従来の`applied`を公開済みに変換しない。

公開前検査は`web/scripts/lib/school-publish-gate.mjs`。候補・登録receipt・公開要求の版/hashと、各JSONのID/所属を照合する。許可先は通信しないstubのみ。仕様・API・実行例・未検収範囲は[切替準備の第4区間](../../docs/reference_sqlite-school-cutover-readiness.md#9-第4区間の共通契約ローカル合成試作)を参照する。

通常試験: `python -B -m unittest discover -s scripts/local-data -p "test_*.py"`。PGは既存バイナリと新規専用scratchを明示して`python -B scripts/local-data/sql-candidates/test_registry_postgres.py --postgres-bin <installed-bin> --scratch <new-local-directory>`。`web`の`pnpm test:school-source`は既存学校入力/隔離生成に加えgateとPython→JSの通し試験を実行する。実認証・実データ・実公開の検収には読み替えない。

## C1-b〜C1-e 学校25表（schema 3）の契約

`store_school.py` は基本7表・沿革3表・入試等15表をまとめて扱う学校版の合成原本CLI。`school_history.py` / `school_admission.py` と各SQLに追加18表の列・制約を分け、既存schema 1/2と40テストを変更せず残す。`example.school.synthetic.json` は `school_fixture.synthetic_payload()` で既存の合成例だけから構成する。

入力formatは `synthetic-school-source` / input_version 1 / schema_version 3、DB purposeも `synthetic-school-source`。`synthetic: true`、dataset_version、source_version、全25表と全既知列を必須とする。真偽値・整数・日付・時差・座標の精度はschema 2と同じ。未知表/列は拒否し、主キー/record_keyを自動発番しない。既定はdry-run。全表を1transactionでupsertし、入力に無い行を残す。削除・全置換の受付は無い。

沿革ではNULL安全な一意性、日付/年度境界、自己関係禁止とinactive前身校を維持する。入試ではNULL学科の旧統計、NULL指標の品質フラグ、active学科偏差値、学校内unit_key、同一学校membership、比較可能な人数、指標ごとの出典と引用80文字を検査する。masterや親の更新後も残存行を検査し、矛盾を黙って修正しない。偏差値のvalue/yearにbaselineにない範囲制約は足さない。旧統計/偏差値の学科参照はbaselineのFKに合わせ、同校制約を新たに課すのは既存契約のmembershipだけ。

### 明示的な移行と再現手順

Python 3.14標準ライブラリを使う。`<scratch>` はリポ外・同期フォルダ外の合成専用場所とし、DB/候補JSONを公開成果物の場所へ置かない。

```text
python -B scripts/local-data/store_school.py import --input scripts/local-data/example.school.synthetic.json --db <scratch>/schools-v3.sqlite
python -B scripts/local-data/store_school.py import --input scripts/local-data/example.school.synthetic.json --db <scratch>/schools-v3.sqlite --apply
python -B scripts/local-data/store_school.py export --db <scratch>/schools-v3.sqlite --output <scratch>/candidate-001
python -B scripts/local-data/store_school.py verify --bundle <scratch>/candidate-001
```

schema 2から移す場合だけ、importへ `--from-core <scratch>/core.sqlite` を付け、schema 3の**新しい出力先**と25表の入力を渡す。元DBはread-onlyで、全7表・全列・全行が入力で完全に保たれることを確認する。未知列/表のある元DB、変更/欠落した旧行、既存出力先、同じDBへの上書きを拒否する。schema 1は情報が欠けるため移行対象外。schema 2の不足18表を捏造せず、入力側で明示する。schema 3への同版upsertは通常のimportで行う。

### 正式なローカルsnapshot / manifest

候補ディレクトリには `snapshot.json` と `manifest.json` を保存する。snapshotは `school-source-snapshot` format_version 1で、schema_version、synthetic、dataset_version、source_versionと、生成器が読む13表の明示列投影を持つ。全schoolsを含め、inactive前身校を復元可能にする。内部メモ、原本timestamp、master本体、旧新統計対応を投影しない。学校33列と、関連を組むためのFK列を持つflat入力であり、そのまま公開配信するJSONではない。

manifestは `school-source-manifest` format_version 1で、同じ版情報、created_at、全25表の件数、content_sha256、snapshot_sha256、code識別情報を持つ。snapshot_sha256はsnapshotファイル全体のバイト列。content_sha256はsnapshot全体をキー辞書順・配列順保持・数値は指数なし/末尾0なし（-0は0）で正規化したUTF-8のSHA-256。created_atはmanifestだけなので内容hashに入らない。

codeは取込み/SQL/adapter/生成器/既存変換の15ファイルのリポ相対パスと内容SHA-256、その一覧の正規化hash。Python/JSの必須ファイル集合を統合テストで照合する。dirty作業ツリーをHEADだけで識別しない。これらのhashは内容破損の検出であり署名・認証ではない。絶対パスや認証情報をmanifestへ入れない。

read-only transactionで原本を整合検査・抽出し、候補の一時ディレクトリで2ファイルを完成・fsync・検証する。その後、出力ディレクトリを排他的に予約し、snapshot、manifestの順でhard linkする。**manifestを最後の完成印**とし、検証関数/adapterは両方のhashと版が一致するまで読み込まない。既存の空ディレクトリも上書きしない。書込み・fsync・link・中断で失敗した場合は自分の候補を回収する。hard link非対応の媒体は失敗する。OS強制終了や電源断で残るmanifest無しディレクトリは完成品として扱わず、実媒体故障の復旧保証はC2へ残す。

### 取得adapterと検証

`web/scripts/lib/school-source.mjs` はsnapshotの版/hash/列/基本型/FKを検証し、学校・学科・出典・沿革・前身校・募集単位・入試子表の既存取得形を復元する。学校と子は決定的に並べ、course_times順序は保持する。学校のactive判定と、既存 `public-api.mjs` の公式URL/出典/品質ゲートを分ける。catalog化、アプリ変換、地図倍率、公開APIは既存の純粋処理を再利用する。

生成器は `--school-source=snapshot --snapshot=<file> --snapshot-manifest=<file>` または `--school-source=supabase` の明示選択を要求する。env/認証読取とSupabase importは後者を選んだ後だけ。ローカル入力の失敗でSupabaseへfallbackしない。既存packageコマンドには明示supabaseを付け、運用の既定を切り替えていない。生成器全体の実行は今回行っておらず、この説明を実生成/公開の指示とは扱わない。

```text
python -B -m unittest discover -s scripts/local-data -p "test_*.py" -v
cd web
pnpm test:school-source
pnpm exec vitest run src/lib/admission.test.ts src/lib/mapPayload.test.ts
```

Pythonは全列/NULL可否、25表再取込み、最終表失敗/commit失敗時の全表と両版復旧、明示移行、出力失敗/破損拒否を検査する。JSは独立した合成Supabase取得形とsnapshotをrows・catalog・アプリ・地図・APIで比較し、同名別ID、閉校前身校、座標欠損、公式URL欠損、旧新統計の二重集計防止、出典/品質ゲートを検査する。Pythonが作る実際の合成bundleをJS adapterで読む統合テストも含む。実学校データ・本番DB・認証設定・既存public/dist成果物へアクセスしない。

C2の世代バックアップとC3の管理更新・生成経路は合成原本で実装している。実媒体への配置、実原本取込み・実認証・利用者参照・運用切替は未検収。共通manifestの合成adapter接続も実原本の移行を意味しない。schema 3は合成専用であり、本番入力を受け付けるように宣言を偽装しない。

## C3 合成原本適用と受付・再評価

schema 3の管理更新試作は[切替準備の第5区間契約](../../docs/reference_sqlite-school-cutover-readiness.md#10-第5区間の契約合成試作限定)を参照する。`school_source_apply.py`はリポ外の合成原本だけを対象に、既存の偏差値行をtransactionで変更し、実内容由来の版と永続receiptを保存する。`school_review_queue.py`の既定はこのreceiptを照合する経路であり、予定targetだけの`adopt`は明示`source_mode='planning_stub'`のfixtureに限定する。

合成経路は`plan_adoption`→`application_request`→`SourceAdapter.apply`→`reconcile_application`→既存export→隔離学校JSON生成。原本commit後にqueueが停止しても再照合できる。撤回後は`request_reevaluation`で全影響対象の訂正を審査し、実原本適用receiptを検査して新候補から再開する。取消は`cancel_pending`で原本内tombstoneを先に確定し、遅れて届く要求を拒否する。旧公開履歴は消さない。

追加試験はPythonの通常discoverに含む。認証付き受付候補は`python -B scripts/local-data/sql-candidates/test_review_intake_postgres.py --postgres-bin <installed-bin> --scratch <new-local-directory>`で別途実行する。新規loopback clusterだけを使い、終了時に停止する。実JWT/PIN、既存学校単位同意と候補同意の同期、RPCからローカルqueueへの認証付き配送はこのコマンドの成功で検収済みにしない。合成PINと候補処理を試験する範囲は参照契約の保護対応表へ記載する。

## C1-a 基本7表（schema 2）

`store_core.py` / `schema-core.sql` / `example.core.synthetic.json` は、学校・学科・field sourceとcourse/lifecycle/recruitment/field-sourceの4masterを扱う。7表の既知全列を保存するC1-aの合成実装であり、25表の完全原本ではない。旧schema 1の `store.py` / `schema.sql` / `example.synthetic.json` / `test_store.py` は変更せず維持する。下記「schema 1 最小試作」以降は旧CLIの説明。

入力formatは `synthetic-school-core`、`input_version: 1`、DB `schema_version: 2`、用途は `synthetic-school-core-c1a`。入力例の最上位キーと7表を全て必須とし、行のNULL可の列も省略せず渡す。未知表・未知列・欠落列・重複キーを拒否し、元のID/keyやtimestampを自動生成しない。入力に無い行は保持するupsertであり、削除・全置換は実装しない。schema 1や他用途のDBは拒否し、upgradeや上書きをしない。

- JSON booleanはtrue/falseのみ。整数はPostgreSQL integerの範囲と列別制約を検査する。NULL、0、空文字を保持し、DDLが非空を要求する列だけ空白を拒否する。
- 座標はJSON numberをDecimalで読み、または十進文字列を受け、numeric(10,7)の範囲と精度を検証して固定7桁TEXTで保存する。8桁目の丸めは行わない。投影時だけ明示的にnumberへ変換する。
- 日付は実在するYYYY-MM-DD、日時は時差付きISO（秒必須、小数秒は最大6桁）をそのまま保持する。course_timesの要素・非空と順序、enum、HTTP(S)出典、検証日時とHTTP statusの組を検査する。404の出典も保持する。
- 全7表とdataset版は1つの `BEGIN IMMEDIATE` で確定する。master更新時も入力に無い既存の学校/学科を検査し、状態フラグ・ui_groupの矛盾を拒否する。自動導出や黙った修正は行わず、必要な子の変更を同じ入力に含める。
- FK・UNIQUE・boolean・enum・範囲・日付順などはSQLite制約、UUID/日付/URL/Decimal/配列要素等はPythonの入力検証、表間状態はcommit前の全行検査が担当する。任意の直接SQL更新を対応済みの更新経路とは扱わない。

Python 3.14標準ライブラリで取込み、既定はdry-run。既存DBがあればread-onlyでメモリへコピーして検証する。書込みは `--apply` のときだけ。`<scratch>` はリポ外・同期フォルダ外の合成専用ディレクトリにする。

```text
python -B scripts/local-data/store_core.py --input scripts/local-data/example.core.synthetic.json --db <scratch>/core.sqlite
python -B scripts/local-data/store_core.py --input scripts/local-data/example.core.synthetic.json --db <scratch>/core.sqlite --apply
python -B -m unittest discover -s scripts/local-data -p "test_*.py" -v
```

fixtureは学校2行（現行/閉校）、学科1行、出典1行、course master 1行、lifecycle master 2行、recruitment master 2行、field master 4行。masterのinactive行も保存する。`synthetic: true` は宣言であって実データ検出機能ではない。

`project_core_rows()` は検証用の部分投影で、学校33列・学科5列・出典8列だけを明示選択する。原本の非公開メモ・created_at・master全列を渡さない。active学校は公式URLなしでも投影し、v1 APIの判定は既存 `public-api.mjs` へ渡して検証する。出典の公式/非公式/不在/両方、人数0、学科名/分類の出典条件、404保持を確認する。Pythonに公開ゲートを複製しない。

C1-aテストには既存公開API関数を実行するNodeが必要（新規パッケージ不要）。全入力/DB/出力はOS一時領域で作成・回収する。リポ外の設定・認証・実学校データ・ネットワークへ接続せず、生成器をimportしない。Node側の既存公開API関数は公開サイト設定JSONを読む。schema 2自体には正式snapshot/manifestや残る18表は追加せず、冒頭のschema 3で扱う。部分投影を既存生成器へ接続しない。

2026-09-27、Windows / Python 3.14で既存20＋C1-a追加20の計40テストが成功。全列/NULL可否のDDL照合、初回/再取込み、dry-run、全7表のrollback、master更新後の既存子整合、ID、公開条件を検証した。障害注入はcommit失敗・KeyboardInterrupt・作成競合・commit後の表示失敗であり、電源断/OS強制終了/実媒体故障の検証ではない。

## schema 1 最小試作

Python 3.14の標準ライブラリだけを使う。学校と学科の一部分をローカルに取り込み、公開許可列のさらに小さい部分集合をJSONへ出す。ネットワーク、環境変数、認証、Supabase、実原本への接続機能はない。入力の `synthetic: true` は作成者の宣言であり、実データの自動検出ではない。合成入力専用とし、実データを渡さない。

2026-09-27、リポ外の一時領域で合成データによる取込み・再取込み・rollback・出力を検証し、`test_store.py` の20テストが成功した。既存生成器の入力やv1公開APIとは互換でなく、`web/dist` へ配置しない。子計画C1全体は未完了。

## 入力・型・ID

`example.synthetic.json` が入力の例。最上位は例の5キーだけを受け付け、利用者表等の追加キーを拒否する。行内の未知列は保存前に破棄し、列名・値をログへ出さず件数だけ返す。これは完全原本を保存する移行器ではない。

| 対象 | この試作の契約 |
|---|---|
| UUID | 正規形の小文字UUIDをTEXTで保存。新規発番なし |
| record_key | school-/department-と独立UUID。idと同値とは仮定せず保持。既存idのkey変更を拒否 |
| 学校の型 | high_school/kosen、ownershipの5値、gender_typeの3値を既存SQL制約から採用 |
| 真偽値 | JSONのtrue/falseのみ。SQLiteでは0/1、出力ではboolean |
| 日時 | 時差付きISO日時文字列を保持。自動補完・再採番なし |
| 学科 | school_idのFKを接続ごとに有効化。既存学科の学校付替えを拒否 |
| course_type | 初回はcanonical masterのgeneralまたはnullだけ。他の有効コードも未対応として拒否 |
| NULL/空文字 | official_url/course_typeはnull可。必須文字列の空・空白だけを拒否。空文字への暗黙変換なし |
| 数値/配列/履歴 | 座標numeric、course_times配列、人数、年度、旧校名、学校関係は未対応。入力の未知列として捨てるため実原本を渡さない |

根拠は `web/supabase/baseline_schema.sql` の schools/school_departments、`202607070401_v0.2.0_course_type_master.sql` のgeneral、`202607070402_v0.2.0_taxonomy_mext.sql`。実DBのschema確認ではない。course_typeは本来masterへのFKであり、この小さいCHECKを完全なenum定義と扱わない。

## transactionとファイル

importの既定はdry-run。既存DBがあれば読み取り専用でメモリへBackup APIコピーし、メモリ上で同じ取込みを行う。存在しなければメモリ上だけでschemaを作る。DBファイルを書き込むのは明示 `--apply` のみ。保存先の親ディレクトリは事前に用意する。

applyは `BEGIN IMMEDIATE` で学校→学科→dataset版を1transactionにまとめる。入力の重複id/key、未知enum、孤立学科、既存identityの変更、SQLite制約失敗は拒否しrollbackする。同じid/keyの再取込みはupsert、入力に無い行は保持する。全置換・削除はしない。学校の更新後に学科が失敗した場合も更新前へ戻ることを合成データで確認した。

schema_version/purposeの一致しない既存DBを拒否する。空の任意DBへ追記しない。新規applyの失敗は当該実行が排他的に作ったDBファイルを閉じて削除する。既存DBは削除しない。schema migration、同時複数writerの運用、媒体バックアップは未対応。

exportはDBをread-onlyで開き、1読取りtransactionの内容を同じ出力先ディレクトリの一時ファイルに完成・flush/fsyncしてからhard linkで最終名を排他的に確定する。既存出力を上書きしない。hard link非対応の媒体では失敗し、当該一時ファイルを回収する。書込み途中・fsync・linkの例外、KeyboardInterrupt、確定後の標準出力失敗は障害注入で検証した。OSによる強制終了や実媒体故障は未検証であり、一時物の残存や電源断時の永続性を保証しない。エラー表示だけでcommit前の失敗と断定せず、再試行前に結果を読む。DBもJSONもリポ外の合成作業ディレクトリに置く。実ホーム・同期フォルダ・本番の場所を例に使わない。

## 公開条件と関連表の残り

次段階の対象表・型・公開条件・実装順は [SQLite学校原本の契約](../../docs/reference_sqlite-school-source-contract.md) を参照する。直接参照13表＋master11表＋旧新入試対応1表の25表を整理済み。schema 1の実装はこの最小試作のままとし、基本7表は冒頭の別版CLIで扱う。

`web/src/lib/school-select.ts` と `web/scripts/lib/public-api.mjs` を正本として読む。本試作の出力はBASIC_FIELDSのうちid、record_key、name、type、ownership、gender_type、prefecture、address、official_url、is_integrated、updated_atだけ。`is_active = true` かつHTTP(S)公式URLを持つ学校だけを出す。URLは厳しめに検査するため既存JSとの完全一致を主張しない。

学科は保存するが**公開しない**。既存公開APIは `school_field_sources` の公式出典で学科名・分類を制御しているため、出典表未対応の段階では落とす。座標・課程・校地種別や出典必須の人数等も出さない。内部メモ・未知列は出力SQLに入れない。

現行生成器が読む関連表の閉包として、次は未対応:

- school_field_sources、school_deviation_values、school_admission_stats
- school_relationshipsと前身schools、school_name_history
- admission_recruitment_units、admission_recruitment_unit_departments
- school_admission_selection_stats、school_admission_stat_exam_components、school_admission_stat_quality_flags、school_admission_stat_sources
- course_type_master全体、入試・状態・募集・関係等の参照masterとその型/制約

上記は `GENERATOR_SCHOOL_SELECT` と `gen-schools-json.mjs` の取得関係からの一覧。全migration/FKグラフの完全閉包監査ではない。認証、利用者保存、family、管理受付、運用設定は本試作へ入れない。既存生成器/API/RLS/学校FKは変更していない。

出力formatは `synthetic-school-public-subset`。schema版、入力dataset版、作成時刻、学校件数、内容ハッシュを持つ。ハッシュはformat/schema_version/synthetic/dataset_version/schoolsをsort_keys=True、UTF-8、コンパクトJSONで直列化したSHA-256。created_atと件数とハッシュ自身は対象外。出力ファイル全体のハッシュ、code SHA、生成器版、全表件数を持つ正式manifestは後続。

## 合成データの再現手順

リポ直下から、書込み可能なリポ外の合成専用場所を `<scratch>` に指定する。既存の実原本パスを指定しない。

```text
python scripts/local-data/store.py import --input scripts/local-data/example.synthetic.json --db <scratch>/schools.sqlite
python scripts/local-data/store.py import --input scripts/local-data/example.synthetic.json --db <scratch>/schools.sqlite --apply
python scripts/local-data/store.py import --input scripts/local-data/example.synthetic.json --db <scratch>/schools.sqlite --apply
python scripts/local-data/store.py export --db <scratch>/schools.sqlite --output <scratch>/public-1.json
```

確認済み: 初回dry-runでDB未作成、apply後は学校2/学科1、再取込みでも同件数。exportは学校1/学科0、例のstatus_note無し。is_integratedはboolean、idと独立record_keyを維持する。active=falseとofficial_url=nullはそれぞれ独立したケースでも非公開。既存DBへのdry-runはDBバイト列とファイル一覧が不変。

rollbackの再現: 合成入力のコピーで最初の学校名を変更し、学科のschool_idを未登録の正規UUIDへ変更してapplyする。失敗後に新しい出力名でexportし、学校名・dataset版・内容SHA-256が前回と一致することを確認する。新規DBへの同入力では失敗後にDBが残らないことも確認する。重複id/key、type/ownership/gender_typeの未知値、course_type未知値、真偽値1、時差なし日時、別用途DB、出力既存、同時writerを別ケースにする。未実施を成功件数へ含めない。

## 自動テストと検証範囲

リポ直下から実行する。標準ライブラリのみを使い、各ケースの入力・DB・JSONはOSの一時ディレクトリに作成して回収する。一時領域がリポ配下ならテストは停止する。`-B` はリポ内へのbytecode生成を抑止する。

```text
python -B scripts/local-data/test_store.py -v
```

2026-09-27の結果: Python 3.14、Windowsで20テスト成功。取込み・出力は実際のCLI子プロセスを使う。初回作成、再取込み、更新、入力に無い行の保持、ID/key、NULL/日時/boolean、公開許可11列、未知列の破棄、公開条件、内容ハッシュを照合した。

失敗ケースは、既存学科の学校付替えと新規孤立学科のFK違反を分けた。前者だけではFK制約まで到達しないため、後者では学科id/keyも別の合成UUIDに変える。両方で先行する学校更新をrollbackし、既存DBのバイト列不変、新規失敗DBの削除を確認。commit失敗は障害注入で行・dataset版の復元を確認した。別用途/schema版不一致/空DBの拒否、5秒の書込みロック競合時の失敗、既存JSON・競合出力の非上書きも確認した。

不具合修正: `urlsplit` は分解だけではポートを検査しないため、非数値/65535超のポートを持つURLが取込みを通過した。`parsed.port` の検証を追加し、取込み拒否と既存合成DBからの出力除外をテストした。有効なポート付きURLは公開できる。URL検査全体の既存JSとの完全互換を保証する変更ではない。

JSONの書込み途中・fsync・link失敗とKeyboardInterruptは障害注入、書込みロックとhard linkによる正常出力はローカル実行。例外前の途中JSONは完成名に残らず、一時ファイルも回収された。確定後の標準出力失敗ではDB/完成JSONを保持する。実媒体故障、OS強制終了、複数writerの運用保証、全関連表、正式manifest、既存生成器接続は今回の検証範囲に含めない。
