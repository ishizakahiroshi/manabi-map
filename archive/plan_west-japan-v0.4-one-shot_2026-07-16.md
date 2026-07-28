---
type: plan
status: done
plan_id: west-japan-v0.4-one-shot
target_version: v0.4.0
execution_mode: one-shot-release-candidate
confirmation_policy: final-only
production_writes: forbidden
commit_push_deploy: forbidden
owner: ishizakahiroshi
review_status: superseded
execution_outcome: incomplete_superseded
superseded_by: plan_west-japan-v0.4-incremental-rollout_2026-07-17.md
due: 2026-07-23
last_reviewed: 2026-07-16
related:
  - report_west-japan-expansion-handoff_2026-07-16.md
  - reference_school-lifecycle-and-succession.md
  - archive/v0.3.2/plan_admission-selection-east-japan-rollout_2026-07-14.md
  - west-japan-v0.4/reference/reference_prefecture-execution-protocol.md
---

# [廃止・参照専用] v0.4 西日本27府県 one-shot 親実行plan

> **このplanを再実行しない。** 2026-07-17にone-shot方式を廃止し、
> [`plan_west-japan-v0.4-incremental-rollout_2026-07-17.md`](plan_west-japan-v0.4-incremental-rollout_2026-07-17.md)
> へ置き換えた。本書は、実行履歴、失敗したgate設計、既存成果物の由来を追跡するためだけに残す。
>
> 廃止理由は、27府県を横断して予備調査と監査を先行した一方、学校masterの新規候補を
> 現在の本番DBへread-only mappingできることと、3年度入試matrixの完成を県全体のrelease条件にしたためである。
> 新規県では本番mapping 0件が正常なのに、学校追加候補までHOLDする循環が発生し、27府県の適用候補が0行になった。
> 実質進捗は予備調査・共通基盤を中心に約30〜35%で、当初の「本番適用直前」には未達だった。

## 結論

この文書を新規セッションで1回実行し、西日本27府県を調査開始から本番適用直前のrelease candidateまで完遂する。途中のユーザー確認は行わない。調査不能・制度曖昧・学校identity不明は推測せず、最小単位で`HOLD`またはquarantineして他県を継続する。最後に27府県の結果、本番SQL、アプリ差分、検証、rollbackを1つの最終判断パッケージへまとめ、その時点で初めてユーザーが公開範囲を判断する。

本planの「完遂」は次を意味する。

- 27府県すべてのP0〜P4/G3を実行済み
- 学校identity/lifecycle、学科、入試v2の適用候補SQLを生成済み
- アプリ、静的生成、CIの必要変更を実装し、ローカル検証済み
- 本番read-only mapping、東日本非回帰、SQL SHA-256、適用順、backup/rollback手順を確定済み
- `PASS`、`PASS_WITH_EXCLUSIONS`、`HOLD`を全府県に付与済み
- ユーザーの最終判断以外に、調査・設計・生成上の次作業が残っていない

この親実行では、本番DB書込み、commit、push、tag、preview/main deployを行わない。これらは完了後のユーザー判断に基づく別実行とする。新規セッションの開始文で明示的に権限が追加された場合だけ、該当操作の専用skill/runbookを読み直して実行範囲を変更できる。

## 新規セッション開始文

以下をそのまま新規セッションへ渡す。

```text
docs/local/plan_west-japan-v0.4-one-shot_2026-07-16.md を実行してください。

親planと子planを正典とし、サブエージェントを記載のrole・model・effortで明示的に使って、西日本27府県を最終判断パッケージまで一括処理してください。公式資料の調査、本番DBのread-only照合、docs/local・scripts・webの編集、SQL生成、test、lint、typecheck、buildを許可します。

途中の質問・承認要求は不要です。問題は自動retryし、解決不能な最小範囲だけHOLD/quarantineして他県を継続してください。子agentに孫agentを作らせず、共有ファイルは単独writerだけが編集してください。

本番DB書込み、commit、push、tag、preview/main deployは行わないでください。最後に全27府県の結果と本番適用案をまとめ、そこで私が判断します。
```

## 対象とWave

対象は次の27府県で、重複・欠落を許さない。三重県はW3東海に固定する。

- W0 四国: 徳島県、香川県、愛媛県、高知県
- W1 中国: 鳥取県、島根県、岡山県、広島県、山口県
- W2 近畿: 滋賀県、京都府、大阪府、兵庫県、奈良県、和歌山県
- W3 東海: 岐阜県、静岡県、愛知県、三重県
- W4A 九州北部: 福岡県、佐賀県、長崎県、大分県
- W4B 九州南部・沖縄: 熊本県、宮崎県、鹿児島県、沖縄県

東日本20都道県は変更対象外であり、学校identity、relationship、name history、admission v2の全件数とmembershipを非回帰基準にする。

## 開始時に確定するC0既定値

今回の「途中確認なし」の指示により、旧handoffのC0確認は質問せず次で確定する。

1. 東日本を保持し、`REGIONS`と全国unionへ拡張する。`ACTIVE_REGION`を西日本へ単純差し替えしない。
2. 学校masterは公立・私立・国立・高専等の全設置者を対象にする。公立入試を本線、私立入試は別bundleとする。
3. 対象年度は原則2024〜2026年度。制度変更・再編で比較不能な期間は短縮理由を残す。
4. 学校別合格者得点の公式根拠がない偏差値は`null`。倍率から偏差値を推計しない。
5. 改称、統合、閉校、募集停止、校舎を学校名だけで上書きしない。法的学校単位の`record_key`、relationship、name historyで表現する。
6. 学校の県全件delete→insertを禁止する。入試再生成も`--input-schools-only`と全行`school_record_key`を原則にする。
7. 1 Waveを1つのrelease候補単位とする。ただし県単位の`HOLD`を許し、問題のない県を止めない。
8. 不明値は推計・差引・按分しない。`null`、detail、quality flag、quarantineのいずれかで継続する。

## 実行DAG

```text
C0 preflight / baseline / schema freeze
  -> W0 四国（新方式のpilot）
  -> W1 中国
  -> W2 近畿
  -> W3 東海
  -> W4A 九州北部
  -> W4B 九州南部・沖縄
  -> app / static / CI 統合
  -> 27府県独立横断監査
  -> 最終判断パッケージ
```

子planは次の順に実行する。

1. `west-japan-v0.4/plans/plan_00-preflight-and-contract.md`
2. `west-japan-v0.4/plans/plan_10-w0-shikoku.md`
3. `west-japan-v0.4/plans/plan_20-w1-chugoku.md`
4. `west-japan-v0.4/plans/plan_30-w2-kinki.md`
5. `west-japan-v0.4/plans/plan_40-w3-tokai.md`
6. `west-japan-v0.4/plans/plan_50-w4a-kyushu-north.md`
7. `west-japan-v0.4/plans/plan_60-w4b-kyushu-south-okinawa.md`
8. `west-japan-v0.4/plans/plan_70-app-static-and-ci.md`
9. `west-japan-v0.4/plans/plan_80-cross-wave-audit.md`
10. `west-japan-v0.4/plans/plan_90-final-decision-package.md`

W0のG3通過後にschema、generator、成果物形式を内部freezeする。W0で必要になった共通変更はW1開始前に単独writerが統合する。これはユーザー確認点ではない。

## サブエージェント、モデル、effort

モデル選定は2026-07-16時点の[OpenAI Models](https://developers.openai.com/api/docs/models)とCodex subagent運用に基づく。常時最大effortにはせず、判断の難しさに合わせる。

| role | 推奨model | effort | 担当 |
|---|---|---|---|
| `west-orchestrator` | `gpt-5.6-sol` | `high` | 親、依存管理、単独writer、最終統合 |
| `west-researcher` | `gpt-5.6-terra` | `high` | 県別P0/P1、公式PDF/Excel/HTML探索・抽出 |
| `west-adjudicator` | `gpt-5.6-sol` | `xhigh` | P2制度、identity/lifecycle、scope、相反資料の裁定 |
| `west-builder` | `gpt-5.6-sol` | `high` | P3 bundle/SQL、複雑なFK・lifecycle生成 |
| `west-runner` | `gpt-5.6-luna` | `medium` | HTTP、CSV、hash、件数、generator等の機械検査 |
| `west-auditor` | `gpt-5.6-sol` | `high` | writerと独立したP4/G3監査 |
| `west-integrator` | `gpt-5.6-sol` | `xhigh` | 横断矛盾、アプリ統合、最終go/no-go提案 |

Lunaへ制度解釈、同名旧新校、法的学校identity、scope比較、schema変更を任せない。`max`は使わず、Sol/xhighで裁定が割れた例外だけ親が追加検証する。

実行環境がagentごとのmodel/effort固定を提供しない場合は、親モデルを継承して続行する。モデルを理由に停止しない。各`_agent-result.json`へrequested/actual modelとeffortを記録し、差異を最終報告へ載せる。

## 並列度と書込所有権

- 現在の4 concurrency slotを前提に、親1＋直接子最大3とする。
- `max_depth=1`。子agentは孫agentをspawnしない。
- 1 dispatchは1県、原則3年度まで。
- P0/P1、P2、P3、P4のphase境界では必ず全子を待つ。収集中に裁定や生成を先行しない。
- 県担当は`artifacts/<wave>/<prefecture>/`だけを編集する。
- 親plan、manifest、checkpoint、shared generator、migration、`web/`は親または指定された単独writerだけが編集する。
- W2は6府県を3県ずつ2 cohortに分ける。他Waveも最大3県ずつqueueする。
- 同じ県のwriterとauditorを同一agentにしない。

## 県別の固定工程

詳細契約は`west-japan-v0.4/reference/reference_prefecture-execution-protocol.md`を正典にする。

1. P0 identity/lifecycle: 現行、前身、後継、改称、募集停止、閉校予定、校舎、県外本校campusを先に分類する。
2. P1 official facts: 直接再取得できる公式原資料から2024〜2026年度を抽出する。
3. P2 adjudication: 募集単位、選抜stage/track、scope、比較可能性、map roleを確定する。
4. P3 generation: identity維持SQL、lifecycle SQL、4 CSV、対象校限定admission SQLを生成する。
5. P4/G3: 機械監査と独立サンプル監査を通し、県を`PASS`、`PASS_WITH_EXCLUSIONS`、`HOLD`のいずれかにする。

P0を閉じる前にP1値を学校へ紐付けない。学校名ではなく法的学校単位の`record_key`を先に確定する。

## 東日本の教訓を強制gateにする

各県G3で次を必須検査する。

- 同名旧校・新校、改称、統合、前身後継の全候補
- 法的学校と校舎/campus、学校全体と学科/募集群のscope
- 募集停止日、閉校日、正式日未告示の`NULL`を区別
- 全v2行の`school_record_key`とDB上の県・校名・1件解決
- 対象校限定SQLで対象外学校、対象外県、前身校のunit/stat membership差分が0
- 県立一覧とは別に市立、国立、高専、広域通信制、定時制、多部制、離島校を監査
- 公式索引URLと直接GET可能な原資料URLを保存し、使用値のHTTP到達性と対象表・年度を確認
- PDF画像、結合セル、脚注を含む代表ページをレンダリング目視
- `admitted > examinees`等を自動補正しない
- 非公表値の按分、県計から学校別への推計、一括募集の学科按分をしない
- 全statsに検査方法、検査要素、`exam_method`の根拠を保持
- official host allowlistと偽装host拒否test
- Wave境界、県境界、ブロック境界の所属漏れと重複が0

## 自動retry、隔離、hard stop

ユーザーへ途中質問せず、例外を次で処理する。

1. 同じresearcherがURL、年度索引、ファイル形式、抽出方法を変えて1回retryする。
2. 別researcherが県公式入口、市教委、県アーカイブ、別の公式原表を再調査する。
3. adjudicatorが公式根拠だけでidentity/scopeを裁定する。
4. 解決不能なら最小の学校・年度・metricをquarantineし、他を継続する。
5. 県全体の一次資料または現役校identityが成立しない場合だけ、その県を`HOLD`にして次県へ進む。

状態の意味を固定する。

- `PASS`: 公開候補に必要なfacts、identity、SQL、検証がすべて成立。
- `PASS_WITH_EXCLUSIONS`: 公式非公表、正式日未告示、取得不能metricを理由付きで非表示/NULLにし、残りは成立。
- `HOLD`: 現役校identity不明、資料母集団不明、mapping不一致等により県全体を公開候補へ含めない。

全体hard stopは、既存データを破壊する恐れ、schema共通変更のrollback不能、workspace破損、read-only接続先を検証できない場合に限る。hard stopでも未依存の調査を可能な限り完了し、最終パッケージへ理由を残す。

## state、checkpoint、コンテキスト保護

実行開始時に次を作る。

- `west-japan-v0.4/execution/manifest.json`
- `west-japan-v0.4/execution/exception-register.csv`
- `west-japan-v0.4/execution/handoff-current.md`
- `west-japan-v0.4/execution/checkpoints/<node>.json`

親だけがstateを更新する。親plan本文へ実行ログを追記しない。子agentは県別成果物と`_agent-result.json`だけを返し、親への要約は20行以内とする。原PDF、全行CSV、探索ログを親contextへ貼らない。

manifestのnode状態は`pending / ready / running / passed / passed_with_exclusions / failed_retryable / blocked / skipped_by_policy`に限定する。各checkpointへbaseline SHA、input hash、artifact hashes、件数、gate、agent、open exceptions、exact next actionを保存する。

再開時は会話要約を正典にせず、親plan、manifest、handoff-current、現在node子plan、checkpoint、git/DB実測の順で復元する。hash driftがない完了nodeは再実行しない。

## 本番DB・公開の停止線

この実行で許可するのは本番DBのread-only照合までである。

- 本番project ref、schema migration、現行件数、`record_key` mappingをread-onlyで確認できる。
- backup、atomic transaction、assert、rollback、SQL/REST検証の手順とコマンドを作成できる。
- 本番接続へmutation SQLを流さない。
- commit、push、preview/main deploy、tagを行わない。
- release候補SQLは対象校限定、`ON_ERROR_STOP=1`、単一transaction内assertを満たす。

最終承認後の本番適用では`supabase-migrate`、リリースでは`manabi-map-deploy`を読み、backupのサイズ・SHA-256・restore list、対象外差分0、匿名REST、static JSON、preview、独自domain smokeまでを再検証する。

## 完了条件

次をすべて満たした時だけ親実行を完了とする。

- 対象集合が27府県ちょうどで重複0、欠落0
- 27府県すべてに最終状態、理由、成果物hashがある
- 各WaveのG3と横断G5結果がある
- release候補SQLに適用順、見込件数、SHA-256、rollback、対象外差分0 assertがある
- 東日本20都道県の非回帰結果がある
- generator test、frontend test、lint、typecheck、build、static/SEO/file-size検証結果がある
- code/data差分に未所有ファイルや同時writer競合がない
- quarantine/HOLDを1行単位で追跡できる
- `west-japan-v0.4/execution/final-judgment-report.md`が自己完結している
- 本番DB、git、deployへ未承認mutationが0

## 正典

- `docs/local/report_west-japan-expansion-handoff_2026-07-16.md`
- `docs/local/reference_school-lifecycle-and-succession.md`
- `docs/local/reference_school-data-collection-playbook.md`
- `docs/local/admission-selection-structure/c5/templates/`
- `docs/local/archive/v0.3.2/plan_admission-selection-structure.md`
- `docs/local/archive/v0.3.2/plan_admission-selection-east-japan-rollout_2026-07-14.md`
- `docs/local/archive/v0.3.2/report_east-japan-lifecycle-residual-fix_2026-07-16.md`
- `scripts/admission/README.md`
- `scripts/admission/gen-admission-v2.mjs`
- `web/supabase/migrations/202607140101_admission_selection_structure.sql`
- `web/supabase/migrations/202607160101_v0.3.2_school_lifecycle.sql`
