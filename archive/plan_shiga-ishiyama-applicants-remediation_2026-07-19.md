---
type: plan
status: done
plan_id: shiga-ishiyama-applicants-remediation
parent_block: block-4-kinki-a
parent_plan: plan_west-japan-v0.4-incremental-rollout_2026-07-17.md
target_prefecture: 滋賀県
scope: 石山高等学校 一般選抜 applicants 2024/2025 抽出誤り修正
production_writes: forbidden
commit_push_deploy: forbidden
owner: ishizakahiroshi
review_status: verified
last_reviewed: 2026-07-20
due: 2026-07-26
tags: [remediation, block-4, shiga, ishiyama, applicants, admission]
related:
  - plan_west-japan-v0.4-incremental-rollout_2026-07-17.md
  - west-japan-v0.4-incremental/execution/block-4-kinki-a-review.md
  - west-japan-v0.4-incremental/execution/contract-freeze-block-5.md
  - west-japan-v0.4-incremental/blocks/block-4-kinki-a/shiga/
---

# 滋賀 石山高校 applicants 抽出誤り remediation plan

## 完了（2026-07-20）

複数学科校で末尾学科の応募者数が0の場合に、その0を学校全体値として採用してしまう抽出条件を修正した。石山の2024/2025 applicantsはそれぞれ343/342へ復元され、candidate.sqlは `3b8e90bf39a5edccc9ba14e6040c3b9ddd17c2a30b951ae02fdf135e00f0f692` に更新した。絶対パス固定の4段生成を2回再実行してSHA一致を確認し、既存の使い捨てPostgreSQLで本適用・冪等再適用とも成功した。

## 背景（Block 4 G4 で切り出し・2026-07-19）

Block 4 近畿A の滋賀 S5 独立監査（`docs/local/west-japan-v0.4-incremental/blocks/block-4-kinki-a/shiga/audit-report.md`）で major-1 として発見された **本番地図に影響する** データ瑕疵。Block 4 の G4 で「1: 採用候補として freeze・Block 5 へ進む」を承認しつつ、本件は **別 plan として独立管理** することが決定された（ユーザー指示 2026-07-19）。Block 5 の実行と本 remediation は **並行 or 独立** で実施可能。

## 問題

- **対象**: 滋賀県立石山高等学校（record_key `school-<uuid5(滋賀県-石山高等学校)>`）
- **原表**: 滋賀県教育委員会 公式「一次募集入学許可予定者数」PDF（R6/R7 = 2024/2025）
- **現在値**（`docs/local/west-japan-v0.4-incremental/blocks/block-4-kinki-a/shiga/input-v2/admission-selection-stats-v2.csv`）:
  - 2024 石山 applicants = **0**（音楽科の 0 を拾った）
  - 2025 石山 applicants = **0**（音楽科の 0 を拾った）
- **正しい値**（原表 PDF 目視・PyMuPDF 独立抽出で確認）:
  - 2024 石山 普通科 applicants = **343**
  - 2025 石山 普通科 applicants = **342**
  - 音楽科 applicants は 2024/2025 とも 0（原表の記載どおり）
- **原因**: `_s2s3-build-bundle.py` の抽出ロジックで、石山（普通科＋音楽科の 2 学科校）のうち音楽科側の値のみを stats に採用し普通科側を欠落させた
- **本番地図への影響**: `web/src/lib/admission.ts` のロジックにより、applicants=0 が本番地図で **倍率 0.00・「under1」表示** となり、実際の受験者・保護者へ誤情報を提供するリスク
- **同型欠陥の孤立性**: S5 監査で他 8 校の複数学科校を全確認し、この欠陥は石山 1 校の 2 行のみに孤立していると確認（膳所 2024 applicants は ±1 の丸め誤差のみ・別 minor）

## 目的

滋賀 candidate.sql に載る石山 applicants 2 行を原表どおり（普通科 343/342）に修正し、本番地図で誤情報が表示されない状態にする。同時に `_s2s3-build-bundle.py` の抽出ロジックを是正して再発を防ぐ。

## スコープ外（別 issue）

- 膳所 2024 applicants ±1 の丸め誤差（滋賀 S5 minor-1・別途確認）
- R8 quarantine（新制度の選抜区分別サブ行・S3 段階で quarantine 済）
- 私立 R6/R8 の private bundle 化要否

## 工程（S3 remediation → S4 rerun 相当）

### R1: 原因調査（`_s2s3-build-bundle.py` 抽出ロジック）

- 石山を含む複数学科校の抽出コードパスを特定
- 音楽科側だけを拾うロジックの根本原因（テーブル行の座標範囲・列判定・普通科 vs 学科別の集計単位）を明確化
- 独立実装（S5 監査時の PyMuPDF 抽出コード `tmp/s5-audit-shiga/`）を参照

### R2: 抽出ロジック修正

- `_s2s3-build-bundle.py` を編集し、石山を含む複数学科校の普通科 applicants を正しく拾えるようにする
- 同ロジックが石山以外で回帰を起こさないよう、S5 監査で PASS 済の 44 校を回帰対象とする
- 修正は「石山限定パッチ」ではなく「抽出ロジック改善」で行う（同型ミスを他年度・他校で再発させない）

### R3: 4 CSV / candidate.sql 再生成

- `_s2s3-build-bundle.py` 再実行 → input-v2/*.csv 上書き
- `_s3-assemble-sql.py` 再実行 → candidate.sql 再アセンブル
- 決定的再実行で SHA-256 一致確認
- 変更差分は理想的には石山 2 行の applicants のみ・他 88 stats 行と 44 校の値は不変
- 新 SHA 実測 → `_s3-agent-result.json` に `s3_remediation_ishiyama` セクション追記

### R4: 検証（S4 相当）

- 使い捨てローカル PostgreSQL 18（port 55460 の pgdata を再構築 or 別 port）で rollback / 本適用 / 冪等 3 段検証
- 石山 2 行の applicants が新値になっていることを SELECT で実測
- 期待件数 8 項目全一致（remediation で件数は変わらない・値だけ変わる）
- 東日本 10 表 baseline 差分 0
- 本番 read-only: 滋賀 schools 0 件・record_key 衝突 0

### R5: レビュー・記録

- 修正の要約を `docs/local/west-japan-v0.4-incremental/blocks/block-4-kinki-a/shiga/validation-report.md` に「§修正履歴・石山 applicants remediation」節として追記
- 同 dir の `_s3-agent-result.json` に旧 SHA `1b04bbd3...` / 新 SHA を pre/post で記録
- `docs/local/west-japan-v0.4-incremental/execution/manifest.json` の滋賀 candidate.sql SHA と s3_remediation_ishiyama セクションを更新
- 本番適用前バッチ台帳（`block-4-kinki-a-review.md` §11・`contract-freeze-block-5.md` §6）から本項目を「resolved」に降格

## 停止線（本 plan の実行中も継続）

- 本番 DB への書き込み・commit・push・tag・deploy 禁止
- 修正は `docs/local/west-japan-v0.4-incremental/blocks/block-4-kinki-a/shiga/` 内の Python スクリプトと生成物のみ
- generator (`scripts/admission/gen-admission-v2.mjs`)・migration・他県 dir は編集禁止

## 完了条件

- 石山 2024/2025 applicants が本番想定表示（343/342）で map ready
- candidate.sql の新 SHA が manifest.json / handoff に反映
- S5 監査での major-1 が「resolved」に降格
- 独立再実行で決定性再現・東日本非回帰 0

## Block 5 との関係

- Block 5（近畿B）と **並行実施可能**（本件は滋賀 dir 限定・generator 未編集・Block 5 の京都/大阪/兵庫 dir と直接衝突しない）
- 本 plan の完了は Block 5 G4 の前提条件ではない
- 本番適用時に「Block 4 の滋賀 candidate.sql を本 plan の新 SHA で置換」する形で反映

## 実行 AI への指示

本 plan を新規セッションで受け取った AI は、上記 R1〜R5 の順に単独 writer として実行し、追加プロンプトなしで完了させる。Block 5 実行 AI とは別セッションが望ましい（並行実施可）。
