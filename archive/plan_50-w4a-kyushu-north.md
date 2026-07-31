---
type: plan
status: done
plan_id: west-japan-v0.4-w4a
parent_plan: ../../plan_west-japan-v0.4-one-shot_2026-07-16.md
node_id: c5-w4a
wave: W4A
prefectures: [福岡県, 佐賀県, 長崎県, 大分県]
depends_on: [c4-w3]
artifact_root: ../artifacts/w4a
execution_mode: autonomous
model_default: gpt-5.6-terra
effort_default: high
due: 2026-07-23
last_reviewed: 2026-07-20
review_status: superseded
superseded_by: ../../plan_west-japan-v0.4-incremental-rollout_2026-07-17.md
---

# W4A 九州北部

## 役割

福岡、佐賀、長崎、大分を処理する。福岡の大規模校群と政令市立、長崎の離島/分校候補を独立監査する。

## dispatch

- cohort A: 佐賀、長崎、大分
- cohort B: 福岡。空きslotは福岡市、北九州市等の市立入口と大規模全件audit
- P0/P1、P2、P3、P4をphase barrierで分離する
- 福岡の全件監査とwriterを別agentにする

## 必須監査

- 福岡市、北九州市等の市立校を県立一覧と別入口で確認
- 離島校、分校/校舎、定時制、通信制campusの法的identity
- 学区、選抜区分、特色/推薦、二次/追加の母集団
- 統合・改称・募集停止のeffective dateと旧年度factsの帰属
- 大規模県の境界校、未所属unit、重複membershipが0

## G3-W4A

- 4県すべてに最終状態と成果物hashがある
- 福岡の学校/学科/unit全件auditと市立別入口監査が完了
- 長崎等の離島/分校identityに未裁定PASSがない
- 対象外、東日本、先行Wave差分0
