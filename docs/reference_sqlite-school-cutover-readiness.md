---
type: reference
status: draft
tags: [sqlite, school, cutover, registry, rls]
owner: ishizakahiroshi
review_status: draft
related: [docs/plan_subdomain-entry-school-migration_c1_sqlite-static-source.md, docs/reference_sqlite-school-source-contract.md]
last_reviewed: 2026-09-27
---

# 学校原本の切替準備: 参照・受付・IDの境界

[SQLite原本計画C3](plan_subdomain-entry-school-migration_c1_sqlite-static-source.md#c3-生成利用者参照管理編集配布の移行準備)に向けた調査と合成試作の契約。2026-09-27の作業ツリー、baseline DDLと後続migrationを確認した。実DB・認証設定・実データ・外部サービスは参照していない。節1〜7は調査時点、節8以降は後続の候補実装を記録する。registry、受付状態、公開制御の実サービスへの適用は未実施。実DBの適用履歴・実効ACL/RLS・容量は未確認。

最新は[節11の第6区間契約](#sqlite-wave6-contract)と[残る5判断](#sqlite-wave6-decisions)。節10までの未実装事項は当時の記録として残す。全原本hashの初回照合、署名付き合成受渡し、queue内の公開許可消費は第6区間で実装したが、実認証・既存同意との同期・実配信・UIの検収は残る。

**結論:** snapshot入力adapterができても、管理補正RPC、審査RPC、名称の直読、利用者・受付・監査のFKが旧原本へ残る。生成コマンドだけを切り替えて学校行を削除してはならない。C3は「ID参照」「受付と採用」「生成・公開」の3単位に分けられるが、共通する世代識別と状態遷移を先に定義する必要がある。

## 1. 読取り・書込み・受付の現状

以下のリンクは公開コードだけを指す。ローカル補助スクリプトやリポ外の手動SQL・外部jobを含む全運用経路の監査完了を意味しない。

| 経路 | 現在の動作と依存 | 切替に必要なこと |
|---|---|---|
| [gen-schools-json](../web/scripts/gen-schools-json.mjs) → [school-source](../web/scripts/lib/school-source.mjs) | `--school-source=supabase` はschoolsとadmission_recruitment_unitsをページ取得し、関連13表の内容を使う。snapshot選択時はpairを検証して同じ生成器用rowsへ戻す。認証設定の読取りはSupabase選択後 | 既存adapterを再実装しない。実データ版の入力契約、隔離出力先、候補全体の世代・hashを追加する |
| [package.json](../web/package.json) / [validate workflow](../.github/workflows/validate.yml) | `gen:schools-json` の既定は明示supabase。buildもそのコマンドを呼ぶ。CIの生成はSupabase設定の有無で条件実行 | snapshotを渡す生成コマンドと再現用入力を定義。利用者認証用のフロント設定まで消さない |
| [useSchools](../web/src/hooks/useSchools.ts) | 通常は静的manifest→map/full JSON。`VITE_SCHOOLS_SOURCE === 'supabase'` のとき学校・募集単位を直読 | 移行後の通常フロントから直読分岐を外す。復旧用の生成入力とブラウザ常用経路を区別 |
| [useSchoolDetail](../web/src/hooks/useSchoolDetail.ts)、[prefIndex](../web/src/lib/prefIndex.ts)、[searchIndex](../web/src/lib/searchIndex.ts) | 静的manifestと学校単体・県別・検索索引を読む | 一覧/詳細/検索/APIの世代不一致を防ぐ。旧キャッシュからのID保存も試験対象 |
| [DashboardPage](../web/src/pages/DashboardPage.tsx) | data_reportsを読み、schoolsとschool_departmentsから名称を直読。受付のstatus/reviewed_at/reviewed_byを更新 | 名称は同一公開世代の静的索引等で解決する候補。受付の採用・公開状態をサーバーで制御 |
| [SchoolDetailSheet](../web/src/components/SchoolDetailSheet.tsx) → `get_deviation_review_queue` | 管理者向けに提出数・平均・中央値等を取得。RPCは利用者の偏差値をschools / school_departments / school_deviation_valuesにJOIN | 学校/学科IDと提出集計を返し、名称・比較用公開値を同じ候補版で補う等の契約が必要。利用者別原記録をローカル原本へコピーしない |
| 同画面 → `correct_school_deviation` | 管理者・PIN・ロックアウトを検査し、school_deviation_valuesを直接INSERT/UPDATE、deviation_correction_logsへ記録。画面も一時的に補正値を表示 | 原本直書きから提案受付へ変更。認証・PIN・監査を失わず、受付成功を公開反映と表示しない |
| [DataReportForm](../web/src/components/DataReportForm.tsx) → data_reports | 学校/任意学科、項目、提案値、出典、コメント、報告者IDをINSERT。自動で学校原本へ採用しない | 受付を維持。公開原本へは審査済みの必要項目だけを抽出し、報告者ID・私的コメントを混入させない |
| 同詳細画面 → [trigger-snapshot-rebuild](../web/supabase/functions/trigger-snapshot-rebuild/index.ts) | 本人トークンと管理者を確認し、deploy hookへPOST。hook受理でokを返し、生成・公開完了は待たない | PC停止時にも保持できる公開要求queueと結果照合へ置換。受付、生成成功、公開成功を別状態にする |
| [gen-admission-v2](../scripts/admission/gen-admission-v2.mjs) | 対象の募集単位をDELETE後、統計・子表・旧新対応をINSERTするSQLを出力 | SQLiteのupsertへ文字通り流用しない。対象範囲の置換、ID維持、古い行の扱いを明示する |
| [official-fetch](../scripts/admission/official-fetch.mjs)、[mext-schools-fetch](../scripts/admission/mext-schools-fetch.mjs) | 資料取得・ファイル出力。採用済み原本とは別 | 取得と審査・採用を分離し、既存の出典・欠測管理を保つ。今回実行なし |
| [smoke-supabase](../web/scripts/smoke-supabase.mjs) | schools直読に加え利用者お気に入りの操作も含む | 読取りだけの検査と誤認しない。切替後に学校原本の存在を前提にしない検査へ見直す。今回未実行 |

本人の保存は [useUserData](../web/src/hooks/useUserData.ts)、家族共有は [useFamilyShare](../web/src/hooks/useFamilyShare.ts) が担当する。これらと認証、自宅、運用設定、管理ダッシュボード集計、eventsは原本SQLiteへ移す対象ではない。

## 2. 旧原本を削除すると影響するFK

[baseline_schema.sql](../web/supabase/baseline_schema.sql) のFKと利用者policyを静的確認した。学校/学科の原本25表側の依存は [既存原本契約](reference_sqlite-school-source-contract.md) を参照。以下は原本外にも残る参照である。

| 参照元 | 学校FKの削除動作 | 学科FKの削除動作 | 保持する内容 |
|---|---|---|---|
| user_school_favorites | CASCADE | なし | 本人の優先度・状態 |
| user_school_notes | CASCADE | なし | 本人のメモ類 |
| user_school_deviations | CASCADE | NO ACTION（省略既定）、NULL可 | 本人の値・メモ・提出同意 |
| data_reports | CASCADE | SET NULL、NULL可 | 受付と審査状態・学校/学科への対応 |
| deviation_correction_logs | CASCADE | NO ACTION（省略既定）、NOT NULL | 補正の監査履歴 |

**学校削除は利用者3表だけでなく受付・監査も失わせる。** 学科についても削除が拒否される場合と参照がNULLになる場合がある。registry導入では利用者3表だけを付け替えて完了にしない。

名前履歴・前身/後継関係にはRESTRICTもあるため、旧原本縮小時には25表側を含む依存を再列挙する。利用者のauth.usersへのCASCADEは本人アカウント削除の境界として別に残す。

## 3. 最小ID registryの比較候補

優先候補はSupabaseに次の2表を残す方式。どちらも原本schools/school_departmentsへのFKを持たせない。原本削除のCASCADEをregistryへ伝えないためである。（10/1 注: 利用者データを Supabase から D1 へ移す決定（9/30）により、この 2 表を D1 に作るかは判断 D8 で決める。移行の計画は docs/local/plan_auth-cloudflare-migration.md）

| 候補 | 必須列・制約 | 任意の運用metadata |
|---|---|---|
| school_id_registry | `id uuid PRIMARY KEY`。既存IDをそのまま使用 | 初出dataset識別子。現役/閉校を表す業務列は持たせず、別の公開索引で解決 |
| department_id_registry | `id uuid PRIMARY KEY`, `school_id uuid NOT NULL` → school registryへRESTRICT。`UNIQUE (school_id, id)` | 初出dataset識別子。所属学校の後付け変更は原則拒否し、誤登録の訂正手順を別定義 |

名称、住所、偏差値、出典、学習者IDは入れない。学校/学科の名称表示は静的索引で解決する。過去IDの表示に必要な名前までregistryへ入れる案は容量・更新責任が増えるので、現在/過去名称の静的索引と比較してから採否を決める。UUID列だけでも索引・行・WAL等の容量があるため、削減量を単純に列のバイト数で確定しない。

全参照元のschool_idをschool registryへ変更し、学科ありの行は `(school_id, department_id)` をdepartment registryの複合キーへ参照させる案を検討する。NULL学科は学校単位の記録として許す。学校FKは別に残し、複合FKのNULL許容で学校存在確認まで抜けないようにする。

現コードで確認できたuser_school_deviationsは学校と学科それぞれの単独FKで、同校membershipの制約は見つからなかった。複合FKを足す前に既存の不一致を計数・隔離し、勝手に学校IDを直さない。data_reports・監査履歴にも同じ確認が要る。これは実DBに不一致が存在するという断定ではない。

registryは公開済み履歴を含む追記中心の索引にし、閉校・統合や新snapshotに存在しないことだけでIDを消さない。旧画面で開いた学校への保存を保持する。前身校の本人メモを後継校へ自動付け替えしない。`ON DELETE RESTRICT`と更新権限制限を候補とし、退役IDへの新規保存を許す期間・無期限保持の扱いは仕様決定が必要。

別案の「旧schools/school_departmentsをIDだけ残して縮小」は既存の型・GRANT・RPC・業務triggerへの影響が大きい。FKを削除してアプリだけでID確認する案はサーバーで整合を保証できないので採用しない。FK以外を採用する場合も、同等のtransaction内検証と権限試験が必要。

## 4. RLS・RPC・権限の維持条件

- 利用者3表の本人限定policy `auth.uid() = user_id` を維持する。INSERT/UPDATEのWITH CHECKも保持し、ID移行を理由にservice権限で利用者保存を代行しない。
- 家族の共有RPCは匿名を拒否し、呼出者のactive membershipと所有者側のshare_favorites/share_notesを検査して利用者表を返す。学校原本をJOINしないので学校情報の移行のために共有認可を広げない。[共有既定OFF migration](../web/supabase/migrations/202609180101_v0.9_family_join_share_defaults_off.sql)の既定と既存行保持も維持する。（10/1 注: 利用者データを D1＋Better Auth へ移す決定（9/30）の後も、この検査を Worker 側へ移せば同じ条件を保てる。移行の計画は docs/local/plan_auth-cloudflare-migration.md）
- [save_mine_consent](../web/supabase/migrations/202609180105_v0.9_save_mine_consent_atomic.sql) はNULL学科のセンチネルと学科行のvisibilityを同transactionで変更する。値0のセンチネルは欠測の勝手な補完ではなく既存保存契約。`UNIQUE NULLS NOT DISTINCT (user_id, school_id, department_id)` と同意撤回を保持する。
- data_reportsの本人INSERT・管理者SELECT/UPDATE、投稿レート制限、補正の管理者/PIN/ロックアウト、監査の管理者SELECTを維持する。根拠はbaselineと [補正強化migration](../web/supabase/migrations/202608040107_v0.5_audit_c7_db_integrity.sql)。（10/1 注: D1＋Better Auth へ移す決定（9/30）により、PIN の試行記録とロックも移行後は D1 に置く。移行の計画は docs/local/plan_auth-cloudflare-migration.md）
- 新registryの更新は専用の信頼された同期処理だけに許す。anon/authenticatedに原本やregistryのINSERT/UPDATE/DELETEを与えない。ID索引のSELECT公開範囲は別途明示する。新表のRLS有効化と明示GRANTを含む新migrationで管理し、baselineの編集だけで移行済みにしない。
- Supabase上の最終DDLとACLはbaselineだけでは確定しない。[後続の明示GRANT migration](../web/supabase/migrations/202609240102_explicit_grants_legacy_tables.sql)等も含め、C4前に実適用履歴を確認する。

## 5. 受付から公開までの状態と順序

現在のDashboardの `applied` はstatus更新だけで、SQLiteへの採用や公開完了と結び付いていない。画面本文も別途学校データを更新すると説明している。既存の `applied` 行を新しい「公開検証済み」に自動変換してはならない。

候補の状態は「受付→審査→採用→候補生成→公開要求→公開確認」。不採用、生成失敗、公開失敗を別に記録する。既存受付のstatusを増やすか、採用/公開を別テーブルにするかは未決。最低限、受付ID、期待する元dataset、採用後dataset、候補manifest hash、公開要求ID、確認した公開世代を関連付ける。二重実行のidempotency key、古い提案の競合、同意撤回時の提出集計再評価も定義する。

安全な候補順序は次のとおり。

1. ローカル原本から同一snapshot・出力候補・ID索引を作り、静的検証する。既存の公開物や利用者情報を書き換えない。
2. 候補の新しい学校/学科IDをregistryへ登録・照合する。既知IDの所属が変わる、登録に失敗する、世代/hashが一致しない場合は公開へ進まない。
3. 全配布先へ同一候補を公開し、manifest・ID集合・詳細・APIの一致を確認する。PC停止/公開失敗はqueueに残し、公開済みにしない。
4. 確認した公開世代を記録してから受付の公開状態を進める。ブラウザは確認済みIDで保存する。registry登録済みだが未公開のIDへの直接保存を許すか拒否するかは、現行本人RLSに追加する公開世代ゲートの要否として決める。

実DBの移行案はregistry作成→全IDと既存参照の照合→新FKを追加/検証→旧FKを外す順を候補とする。`NOT VALID`を使う場合もVALIDATE完了前に旧原本を縮小しない。DDLのlock・transaction境界、既存不整合の扱い、復旧SQLを合成PostgreSQLで検証してからC4へ渡す。Python/SQLiteのFK検証だけをPostgreSQLのRLS検証としない。

復旧時は公開成果物を前版へ戻しても、registry追加分と切替後の本人メモを巻き戻さない。旧原本に無い新IDの利用者保存が発生した後、旧FKを単純に再追加できるとは限らない。差分と受付queueを保存し、旧原本への整合した差分反映か前方修正の方針を先に決める。

## 6. 生成・配布で未決の仕様

| 論点 | 現状 | 次に固定する契約 |
|---|---|---|
| 実原本入力 | C1は合成snapshotで検証済み。実取得は未実施 | 実入力版、出典/秘密の除外、合成宣言と実データの区別。現在の合成フラグを付け替えて流用しない |
| 出力の隔離 | gen-schools-jsonはweb/publicへファイル群を順に書き、manifestを最後に出す | 任意の候補出力directory、入力とcode識別、途中失敗の回収、公開前検証。最後のmanifestだけでは複数ファイルの配布がatomicとは限らない |
| 公開世代 | 公開schools-manifestのschoolDataVersionは生成内容のhash。単体詳細と県別JSONのパスは固定 | ローカル原本manifestと公開manifestを結ぶrelease識別子、全ファイルhash台帳、旧詳細キャッシュ・世代混在の拒否/保持方針 |
| SEO/API | [gen-seo-pages](../web/scripts/gen-seo-pages.mjs)はdistのJSON/APIとSSR成果物を読む。[verify-static-output](../web/scripts/verify-static-output.mjs)が既存の静的契約を検査 | 既存の公開列制限・旧URL・県別API・gzip・SEO・件数を同一候補に対して検査。SEOの新DB取得処理は不要 |
| Functions | Functionsの認証・管理API・middlewareが静的成果物と共存 | 分割先ごとの同梱・ルート・環境設定を明示。認証用Supabase接続を原本依存と誤認して削除しない |
| 起動経路 | Git連携buildとdeploy hookが現行 | ローカルpublishとの競合排除、queue消費者・再試行・取消・多重公開ロック、Preview/本番の識別 |
| 配布先の制約 | コード調査だけでは外部サービスの現行制約を確認できない | Wrangler実行形式、プロジェクト方式、ファイル数/サイズ制限等は実配布前に現行条件を確認する。今回ネットワーク確認なし |
| 認可の実証 | 既存ソースを静的照合しただけ | 合成PostgreSQL環境で本人/家族/非許可者/匿名の試験。実認証と既存保存保持はC4の別受入 |

## 7. 次の実装単位と受入条件

| 単位 | 実装候補 | 合成の受入条件 |
|---|---|---|
| C3-a: ID索引と移行候補 | 許可列だけのID索引生成器、registry DDL・権限・FKの新migration候補、復旧手順 | 全旧ID維持、非公開列なし、重複/孤立/学科付替え拒否。学校原本を削除しても本人・受付・監査が残る。NULL学科/同意/家族認可を維持 |
| C3-b: 受付・審査の契約 | 提案/採用/公開の状態遷移とidempotency、補正受付RPC候補、提出集計RPCの原本JOIN除去 | 非管理者拒否、同意撤回、古い元版・二重採用・再公開拒否、停止時queue保持。採用と公開の状態を混同しない |
| C3-c: 隔離生成 | 既存generatorの出力先注入、副作用なしの実行関数、snapshot明示コマンド、公開hash台帳 | 認証設定なしで合成入力から生成可能。学校/検索/詳細/API/SEOのID・公開列一致。既存出力無変更、途中失敗で未完候補を完成扱いしない |
| C3-d: 公開のdry-run | publish前検査、registry照合、配布要求計画、公開結果確認interface | 不一致世代・未登録ID・破損・未承認先を拒否。通信しないstubで失敗/再試行/前版復旧。実Wrangler公開はC4 |
| C3-e: UIと統合受入 | 名称直読・原本直接取得・補正表示・再生成表示の切替 | 検索/地図/詳細/保存/家族共有が同一合成候補で動く。画面実物と拒否経路を確認してからC3を閉じる |

C2の復元可能な候補・版識別契約を受け取った後、まずC3-aのID索引とC3-cの隔離出力関数を別ファイルで進められる。ただし新registryの本採用、世代識別、未公開IDの保存可否、受付状態は先に文書で固定する。C3-bのRPCとC3-eの画面を契約未確定のまま別々に作らない。

上記の第2区間で追加したのは本referenceだけ。コード・migration・UIを変更せず、build・実生成・DB接続・公開を実行していない。以下はその後の第3区間の実装であり、registry/受付/RLS/UIの切替は引き続き未実施。

## 8. 第3区間で実装した合成候補の生成

### ID候補索引

`scripts/local-data/school_id_index.py`の`build_index(bundle, previous=None)`は検証済みの既存snapshot pairから、全学校の`id`と全学科の`id`/`school_id`だけを抽出する。inactive学校も含める。schema/dataset/source版、snapshot内容・ファイルhash、索引hashを持ち、前版指定時は過去IDを保持する。`diff.added`と`diff.retained_absent`は比較用で、削除命令ではない。既知学科の所属変更、重複、孤立、未知列、不正hashは拒否する。

`write_index(bundle, output, previous=None, apply=False)`は既定無書込みで、明示applyだけが新規候補を排他的に確定する。CLIは`python -B scripts/local-data/school_id_index.py --bundle <scratch>/bundle --output <scratch>/id-index.json --apply`。出力は`school-id-index-candidate` v1、`state: candidate`、`synthetic: true`であり、registryへ登録された証明ではない。前版の内容hash連鎖も署名や公開検収ではない。

### 隔離された学校JSON

`web/scripts/gen-schools-json.mjs`の`generateSchoolCandidate({snapshotPath, manifestPath, outputRoot})`は、既存snapshot adapterと学校JSON生成処理を使い、リポ外・入力bundle外の新しい候補ディレクトリへ出力する。既存先は空でも拒否する。import時に生成・認証設定読取りはせず、snapshot経路でSupabaseへ接続しない。既定の明示supabase生成は既存の公開先を維持する。

`web`から次を実行する。snapshotは合成専用で、都道府県は既存の都道府県分類に一致させる。学校名・住所等は架空の値を使う。未知県を黙って県別出力から落とさず、候補生成を拒否する。

```text
pnpm exec tsx scripts/gen-schools-json.mjs --school-source=snapshot --snapshot=<scratch>/bundle/snapshot.json --snapshot-manifest=<scratch>/bundle/manifest.json --output-root=<scratch>/school-json-candidate
```

map/full、検索索引、学校詳細、県別、公開APIのJSONと既存`schools-manifest.json`を生成し、最後に`candidate-manifest.json`を確定する。候補manifestは入力2ファイル/内容hash、生成コード・静的設定のhash、全生成ファイルのpath/size/SHA-256と一覧hash、`scope: school-json-only`を持つ。`web/scripts/lib/school-candidate.mjs`の`verifySchoolCandidate(outputRoot)`でファイル集合と全bytesを再検査する。これは署名・配布のatomic性・本番コード一致の保証ではない。

同じsnapshotの作成時刻を生成時刻として用いるため、同じ入力と生成コードからの候補を比較できる。途中失敗では自分が作ったと確認できるファイルだけを回収し、他プロセスの出力は残す。SEO/SSR/build、registry登録・公開ゲート、受付RPC、実認証/家族共有、UIの切替はこのJSON候補の成功に含めない。

## 9. 第4区間の共通契約（ローカル合成試作）

この節はC3-a/b/dの実装用契約。既存の実サービス、受付RPC、画面、配布先を切り替える決定ではない。過去節の「未実装」は各調査時点の記録であり、本区間の成果と区別する。最小registryの正式採用、退役・未公開IDへの保存可否、実行者の認証方法は実移行前の判断として残す。

| 境界 | 合成試作の契約 |
|---|---|
| 入力 | schema 3の検証済みsnapshotと既存ID候補索引。全学校・過去IDを維持し、公開対象だけに切り詰めない |
| 候補識別 | `datasetVersion`, `sourceVersion`, `snapshotSha256`, `contentSha256`, `candidateManifestSha256`, `artifactsSha256`の厳密6項目。candidateManifestSha256は`candidate-manifest.json`のファイルbytesのSHA-256で、入力manifestのhashとは異なる |
| 未登録 | `school-id-index-candidate`の存在・hash一致だけでは登録済みとしない |
| 合成登録 | `school-registry-receipt` v1、`synthetic: true`, `state: registered`。既存索引のsource、index_sha256、累積ID集合とregistry_sha256、receipt_sha256を検査。実DBの登録証明や署名ではない |
| 受付と採用 | `received → reviewed → adopted → generated → publish_requested → publication_confirmed`。採用は期待元版と現在tipを比較し、二重採用を拒否または同一要求の再実行に限定。原本へ書き込んだ証拠とはしない |
| 同意 | 審査したconsent revisionと採用時を照合。採用前の撤回・再同意は再審査する。採用済み祖先の撤回は、その内容を含む累積版全体を要再評価として採用・生成・公開要求・初回確認・変更投影を止める。未採用の無関係提案の撤回は他提案を止めない。公開済みの事実を自動で消さない |
| 生成・公開失敗 | 完了状態に進めず、要求と試行履歴を保持する。停止・再開後も同じ要求を追跡し、別世代の結果で完了させない |
| 順序逆転 | 試作ではdataset版の再利用を拒否し、公開要求・初回確認でtargetとqueueの現在版が一致することを要求する。古い要求は消さず保留し、確認済みの同一結果の再読取りは履歴として扱う |
| 合成公開確認 | `school-publication-stub-result` v1、`synthetic: true`, `state: publication_confirmed`, `requestId`, `destination`, `candidate`。candidateは上記6項目。許可先は`stub://school-publication`だけで、外部通信経路は実装しない |
| 復旧 | 前版の全候補を再検証してstubの公開先を戻す。registryの過去ID・切替後の本人メモを残す。利用者表を古いbackupで全置換しない |

現行`data_reports.status = applied`は従来の審査表示であり、新しい公開確認へ自動変換しない。SQLite queue内のActorや同意記録は合成試験用で、Supabase認証・PIN・RLSの代わりではない。PG候補SQLは`scripts/local-data/sql-candidates/`に隔離し、実migration配置へ置かない。候補のhashは破損検出であって、信頼できる実行者による採用・登録・配布の認可ではない。

UIのC3-eは別区間とし、未採用の状態やRPCを先行接続しない。C4の実原本・実認証・実配布・媒体受入と、本区間の合成検証を分けて記録する。

### 実装入口と試験の範囲

- `school_registry.py`: `simulate_registration(candidate, previous=None)`で累積IDの合成receipt、`validate_receipt(receipt, candidate=None)`で既存ID検証器を再利用した照合、`render_registration_sql(candidate)`でUUIDだけの登録候補を作る。SQLの実行・DB接続は含めない。
- `sql-candidates/registry_cutover.sql`: 5表の学校FKと3表の同校学科FKを新registryへ変更する合成候補。新FKの全検証後に旧FKを外し、失敗時はtransaction全体を戻す。旧学校行の削除、利用者表の書換え、既存RLS・RPC変更は含めない。
- `sql-candidates/registry_recovery_check.sql`: 復旧に不足する旧学校/学科IDを読み取り列挙する。registryを削除したり、切替後の本人メモを古いbackupで置換したりしない。
- `school_review_queue.py`: リポ外の新規SQLiteへ合成受付を保存する。`Queue`の`submit/review/adopt/generated/request_publication/confirm_publication`と`set_consent/fail`を使う。`adopted_change`は許可列だけの採用予定変更で、実原本に反映するadapterではない。Actorは試験入力であり認証機構ではない。
- `web/scripts/lib/school-publish-gate.mjs`: 既存候補manifest・Python ID/receipt検証器を利用する`dryRunSchoolPublication`と、通信経路のない`createSchoolPublicationStub`。stubはメモリ内の輸送試作であり、永続queueは前項が担当する。外部配布の受入証拠にしない。
- `web/scripts/school-cutover-integration.test.mjs`: Pythonの実export出力から学校JSON生成、ID登録模擬、永続queue、公開失敗と再試行、別プロセスのqueue再読込み・確認までをつなぐ。

Pythonの通常合成試験は`python -B -m unittest discover -s scripts/local-data -p "test_*.py"`。JSの学校入力・生成・gate・通し試験は`web`で`pnpm test:school-source`。PostgreSQLは別の明示試験で、`python -B scripts/local-data/sql-candidates/test_registry_postgres.py --postgres-bin <installed-bin> --scratch <new-local-directory>`を使う。新規clusterをloopbackだけで起動し、終了時に停止する。既存DBへの接続先や環境変数のPG設定を流用しない。

PG試験はbaselineから選択した実DDL・policy・家族RPCと同意migrationを使う。auth関数・auth.users・旧学校の業務列には合成shimを使うため、Supabase全schema、実JWT認証、PIN/ロックアウト、投稿レート制限の実行検証とは分ける。試験の件数と独立レビュー結果はSQLite計画の第4区間実績に記録する。

家族お気に入りRPCは合成PGで戻り列`status`と会員条件の無修飾`status`の衝突を再現した。`sql-candidates/family_favorites_qualification.sql`は列修飾だけの修正候補で、元エラー再現後に同候補を適用して家族認可を検査する。既存migrationは未変更、実サービス発生有無は未確認。正式対応はSQLite計画C5で追跡する。

採用済み内容の同意撤回後にsource chainを再評価・修正して解除する経路、採用予定変更を原本transactionへ反映するadapter、実認証付き受付RPCは第5区間で扱う。常用の管理更新への接続は別途検収する。

## 10. 第5区間の契約（合成試作限定）

本節はローカル合成DBと隔離SQL候補の契約であり、registry正式採用・退役/未公開IDの保存方針・実行者認証方式の製品決定ではない。

- 原本adapterはschema 3の25表と既存exportを使う。変更列は既存投影の`deviation_value`だけ。学校/学科の所属を検査し、対象の有効な偏差値行が厳密に1行のときだけ更新する。NULL学科は学校単位の行を意味し、全学科更新にはしない。曖昧な対象・不正値・no-opを拒否する。
- 採用元CASはdataset版とsnapshot内容hashを照合する。変更後の全25表の実内容から版を決め、既存snapshot/exportの内容hashを採用先へ渡す。callerが予定targetを渡しただけでは原本適用済みにしない。
- この元版CASは既存の公開用snapshot投影が対象で、非投影列だけの変更を初回CASで検知する契約ではない。`preview`はread-onlyの予測に限り、採用先は必ず`apply`の実receiptから取る。receipt以後は全25表・全列のhashも照合し、原本の別経路変更を拒否する。初回から全原本hashを固定する運用は常用接続前の残判断とする。
- 原本変更・metadata・適用receiptは同じ原本transactionへ保存する。queueと原本の2ファイルをatomicとはしない。queueに先に要求を保存し、原本commit後に停止した場合は同一要求のreceiptと現原本を照合してqueueを追随させる。同じ要求IDの別内容、現在tipと異なるreceipt、未照合の公開進行を拒否する。
- receiptは要求ID、元版、実適用先、変更と直前値、全内容hash、要求hash、receipt hashを持つ。hashは破損検出用で、実行者認可の証明ではない。
- queueの既定はreceiptを必要とする経路。旧予定採用は明示`planning_stub`のfixture専用で、実適用の証拠にしない。採用予定・実原本反映・生成・公開確認を区別する。
- 採用済み祖先の撤回は累積版を停止する。再評価要求には対象revision・理由/証拠・全影響対象を固定し、撤回した値と異なる訂正が実原本へ適用されたreceiptを検査してから新しい審査/候補へ進む。再同意で旧審査を復活させない。旧候補と公開要求を再利用せず、公開済みの履歴は保持する。
- 受付SQLは隔離schemaの候補のみ。本人ID・初期状態・管理者判定を入力から信用しない。匿名拒否、非NULL学科、偏差値だけの受付は今回の合成仮定であり、既存受付の利用条件を変更する決定ではない。実JWTとローカルqueueのActorは別物とする。

担当範囲はAがadapter/専用試験とschema 3のreceipt表許容、Bがqueue/専用試験、Cが隔離受付SQL/PG試験、親が統合試験・共通文書・台帳。担当交代レビューで確定指摘を再現し、修正後に指摘者が再確認する。UI・SEO/SSR・実データ・実配布は本区間に含めない。

### 実装入口

- `school_source_apply.SourceAdapter(path, synthetic=True)`: `generation()`、`preview(request_id, expected, changes)`、`apply(...)`、`read_receipt(request_id)`、`verify_receipt(...)`。`before_commit`/`after_commit`の障害注入を備える。`cancel(...)`は原本内に取消tombstoneを残し、遅れて届く同じ適用要求を拒否する。`before_values`はchanges順の整数配列。receipt表は原本のtransaction内に保存し、公開snapshotへ出さない。
- `Queue.plan_adoption`→`application_request`→adapter apply→`reconcile_application`: 原本commitとqueue commitの間で停止しても、現在の原本とreceiptを再照合できる。未照合pendingがある間は生成・公開を停止。撤回後に実適用済みと判明した場合も実tipを記帳し、停止を保ったまま再評価する。
- `Queue.request_reevaluation`→新しい適用要求→`reconcile_application`: 全撤回対象の訂正とrevisionを固定。古い審査・候補を無効化し、公開要求IDを履歴から再利用させない。`cancel_pending`は原本のtombstone確定後にqueueを取消し、commit間停止の再試行を可能にする。
- `sql-candidates/review_intake.sql`と`test_review_intake_postgres.py`: 以下の保護を検査する隔離候補。正式migration・実RPC/UI接続は含めない。
- `createQueueBoundSchoolPublicationStub({queuePath, pythonExecutable})`: 成果物の検査後、公開模擬の状態変更直前に`Queue.assert_publication_ready`で同意revision・原本receipt/tip・候補・要求を再照合する。撤回後の成功receipt再読取りもここでは拒否する。旧`createSchoolPublicationStub`は成果物単体の試験専用で、queueを使う通し経路へ直接つながない。公開検査後の同時撤回と実輸送は分散transactionではなく、本番接続時に別途扱う。

### 受付候補の保護対応と試験境界

| 保護 | 既存実装と候補の対応 | 合成PGでの検証 / 限界 |
|---|---|---|
| 本人・管理者 | `auth.uid()`と`admin_users`所属をサーバー側で取得。owner/role/statusの自己申告を受け付けない | RPC実行権限、非管理者・他人受付・直接write拒否。auth.uid/usersはshim、実JWT/OAuth/PostgRESTは未実施 |
| 受付とレート制限 | `data_reports`へ本人とpendingを固定し、baselineの実rate triggerを通す | 通常利用者の5件/10分と並行要求を実行。匿名2件/global300の分岐は新候補が匿名拒否のため未実施 |
| PIN・ロックアウト | 既存`admin_pin_attempts`とpgcryptoを利用。5失敗/15分の候補処理を保持 | 合成PIN照合・失敗回数・ロック中拒否・期限切れを実行。旧原本を更新する`correct_school_deviation`本体は呼ばず、既存/新規endpointの並行運用は未検収 |
| 同意・revision | 本人だけが撤回、revisionを増分。審査はrevisionと提案値をCAS | 他人撤回、撤回後/古いrevisionの審査、再利用を拒否。既存`save_mine_consent`の学校単位同意との同期は未接続 |
| 変更範囲・所属 | 候補は`field=deviation`、20..80、非NULL学科。受付・審査時に同校所属を検査 | ローカルqueueの`deviation_value`・0..100・NULL学校単位と同じ業務仕様とは扱わない。移送時の明示変換と正式採用条件は未決 |
| 状態・監査 | 候補はpending/reviewed/rejected/withdrawnのみ。監査と変更を同transactionへ保存 | 既存reportの内容/状態変更、不正遷移、監査直接writeを拒否。旧appliedを採用/公開確認へ変換しない |

PG候補からローカルqueueへ認証付きで配送する仕組み、学校単位同意との同期、実行者の鍵/認証方式は未実装。PG候補のowner/監査列を公開JSONへ投影しない。Python Actorは合成入力のままであり、PGの認証試験と同じ証拠にはならない。今回の通し試験は合成queue受付から始まり、実認証transportを検収したものではない。

<a id="sqlite-wave6-contract"></a>

## 11. 第6区間の契約と実運用前の残判断

合成受付PGからqueue・原本・生成候補・公開模擬処理までを接続した段階である。以下は現在の試作契約であり、本番の認証方式や同意仕様を正式採用する決定ではない。実装/保存ログの到達点は[SQLite計画の第6区間](plan_subdomain-entry-school-migration_c1_sqlite-static-source.md#sqlite-wave6-current)に記録する。

| 境界 | 第6区間で進んだ点 | 引き続き未検収の点 |
|---|---|---|
| 受付の受渡し | `school_intake_transfer.issue_envelope/verify_envelope`を`Queue.ingest_transfer`から利用。合成executor所属のPG exportとHMAC検証を接続。receipt modeでは署名なしのsubmit/reviewを拒否 | 本番executor、実JWT/OAuth/PostgREST、鍵発行/失効/更新、実エンドポイント |
| イベントと同意 | request/revision/主体/学校/学科に束縛。完全再送は現在状態のno-op、未受信の古いrevisionや同revision別内容を拒否。欠落/unknown/falseの同意では新しい公開許可を出さない | 既存`save_mine_consent`と学校単位同意の同期。合成イベントの`school_consent`は同期済みの証拠ではない |
| 全原本CAS | receipt modeのgenerationは`dataset_version` / `snapshot_content_sha256` / `source_content_sha256`の3項目。25表の全列全行を初回からtransaction内で照合し、metadata/receiptはhash対象外。旧2項目はreceipt modeで拒否 | 実原本の取込み/運用接続と、他の更新経路を含む検収。公開候補の6項目identityは別契約として維持 |
| 撤回・訂正 | 訂正原本を署名済み再審査と同意に束縛。再同意だけでは旧審査を復活させず、訂正候補にも元requestの後続撤回を伝える | 実利用者への説明、学校全体への撤回の波及範囲、既存同意の移行 |
| 公開許可 | `Queue.issue_publication_permit/consume_publication_permit`で要求/候補/同意revisionに束縛した一回の許可を永続化。queueに到達済みの撤回と消費を`BEGIN IMMEDIATE`で順序付け、成功再送も現在状態を確認 | PGから未配送の撤回、実配信先の世代切替/失効、CDNと公開済みbytesの除去。queue、JSメモリ、配信先は同一transactionではない |

受付値は20..80・学科必須を維持し、SQLの`deviation`から原本の`deviation_value`への項目名変換を明示する。元のローカルadapterの0..100・NULL学校単位と、受付SQLの業務仕様を暗黙に統一しない。PIN・原監査・実ユーザーIDを公開artifactへ投影しない。HMACは合成イベントの改変検知/発行者照合候補であり、最新revisionの証明にはならない。

再現時は既存のPython合成試験と学校JS試験を使う。PGからの一巡を検証する場合は、隔離受付PG harnessの`--export-scenario`で新規scratch配下へ出力し、`SCHOOL_INTAKE_SCENARIO`にそのファイルを明示する。無指定の学校JS成功ではPG一巡のskipを見落とさない。実認証・実媒体・画面・実配布の検収は別に記録する。

<a id="sqlite-wave6-decisions"></a>

### 残る5判断と、判断前に詰める技術事項

以下は未採用の比較案。実行再開の承認と、利用者挙動や運用方式の採否を区別して記録する。技術調査は対応するC3設計で進め、共通契約へ反映してから依存する実装を接続する。

| 判断 | 比較案と推奨理由 | AIが先に調査・具体化すること | 採用時に決めること |
|---|---|---|---|
| D1 executor認証 | 推奨候補は最小権限executor＋非対称署名。queueは公開鍵だけを持てる。HMAC継続は試作に近いが検証側も署名できる | 実認証adapter、鍵ID/更新/失効、認証失敗時停止、監査と配置の設計 | 運用主体と鍵管理責任、認証方式 |
| D2 ID registry | 推奨候補は最小registryへFKを段階移行。表示列と分離できるが同期/復旧運用が増える。旧学校表をID参照先に残す案はFK変更を減らせるが旧表依存が残る | 全参照元の一覧、容量比較、切替/復旧候補。実効schema/件数確認は実接続の範囲が決まってから | registry採否、移行と旧表縮小の対象 |
| D3 廃止/非公開IDへの新規保存 | 推奨候補は既存IDを保持し、新規保存は公開世代/退役状態で別判定。過去メモを保ちつつ受付を制御できる。新規保存も継続許可する案は旧画面との互換性が高いが非公開対象への入力が増える | 過去ID保持、旧キャッシュ、RLS/RPC/UIで同じ条件を守る受入ケース | 利用者に許す新規保存と表示説明。ID削除/自動付替えは行わない |
| D4 同意の適用範囲 | 推奨候補は本人/学校の同意と提案revisionを別に確認。誤適用を防げるが説明と依存管理が増える。提案単位へ集約する案には既存同意の移行説明が要る | 学校・学科・提案・訂正の依存関係、既存RPCとの同期/撤回ケース | 同意文面、学校単位撤回の範囲、既存同意の扱い |
| D5 実配信の撤回競合 | 推奨候補は永続outbox/再照合と配信先の世代条件付き切替/失効。対応能力の確認が必要。直列worker＋補償案は導入が容易な可能性があるが一時露出が残る | 配信先の条件付き更新能力、順序配送/最新revision照合、遅延時停止と障害回復 | 許容する撤回反映時間と停止条件、配信方式 |

判断の期限はC3後段の実接続設計確定前、遅くともC4実切替前。日付と改修工数は未見積もり。D3/D4は利用者挙動の選択を含み、D1/D2/D5も技術調査だけで運用責任や許容範囲を決定しない。現状の制約下で使えるのはローカル合成接続と障害回復の検証までである。実運用の撤回即時性や配信保証は未達であり、C3-eのUI/SEO/SSR、C5実効RPC照合、C4実原本/実配布を完了扱いにしない。
