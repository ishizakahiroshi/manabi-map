---
type: plan
status: done
plan_id: west-japan-v0.4-w3
parent_plan: ../../plan_west-japan-v0.4-one-shot_2026-07-16.md
node_id: c4-w3
wave: W3
prefectures: [岐阜県, 静岡県, 愛知県, 三重県]
depends_on: [c3-w2]
artifact_root: ../artifacts/w3
execution_mode: autonomous
model_default: gpt-5.6-terra
effort_default: high
due: 2026-07-23
last_reviewed: 2026-07-20
review_status: superseded
superseded_by: ../../plan_west-japan-v0.4-incremental-rollout_2026-07-17.md
---

# W3 東海

## 役割

岐阜、静岡、愛知、三重を処理する。三重はW3だけに所属させ、近畿との重複を禁止する。愛知の複合的な選抜・募集単位は専用のSol/xhigh裁定を必須とする。

## dispatch

- cohort A: 岐阜、静岡、三重
- cohort B: 愛知。空きslotは名古屋市等の市立入口と複合選抜の独立監査
- 愛知P2はresearcherの自己裁定を禁止し、必ず`west-adjudicator`がdecision capsuleを確定
- P3後は別auditorがmap主値とdetailの分離を再検証する

## 必須監査

- 愛知の募集群、選抜段階、志願/受検/合格母集団を他県の単純倍率へ置換しない
- 名古屋市等の市立校、国立、高専を別入口で照合
- 定時制、多部制、分校、山間部校、再編校
- 三重のWave所属が1件だけで、W2成果物に混入していないこと
- 同名/改称/統合前後の年度帰属と`record_key`

## G3-W3

- 4県すべてに最終状態、件数、hashがある
- 愛知P2にSol/xhighの独立裁定記録がある
- 名古屋市等の市立入口と県立入口のunionが重複0
- 三重のWave重複0
- 対象外・東日本・先行Wave差分0
