---
type: plan
status: done
plan_id: west-japan-v0.4-w2
parent_plan: ../../plan_west-japan-v0.4-one-shot_2026-07-16.md
node_id: c3-w2
wave: W2
prefectures: [滋賀県, 京都府, 大阪府, 兵庫県, 奈良県, 和歌山県]
depends_on: [c2-w1]
artifact_root: ../artifacts/w2
execution_mode: autonomous
model_default: gpt-5.6-terra
effort_default: high
due: 2026-07-23
last_reviewed: 2026-07-20
review_status: superseded
superseded_by: ../../plan_west-japan-v0.4-incremental-rollout_2026-07-17.md
---

# W2 近畿

## 役割

滋賀、京都、大阪、兵庫、奈良、和歌山の6府県を、大規模校群、学区、市立校、独自選抜を他県の倍率意味へ流用せず処理する。

## dispatch

- cohort A: 滋賀、京都、大阪
- cohort B: 兵庫、奈良、和歌山
- 3 worker slotを厳守し、cohort内もP0/P1完了後にP2へ進む
- 大阪、兵庫はfacts量が大きいため、親は原表を読まずdecision capsuleと件数だけを受け取る
- 京都市、大阪府内市立、神戸市等の設置者入口は県/府立入口と別担当で独立確認する

## 必須監査

- 学区、選抜方式、共通/独自問題、特色/推薦等の県固有意味
- 大規模府県の学校/学科/募集unit全件突合と境界漏れ0
- 市立、定時制、多部制、専門学科、くくり募集、二次/追加
- 統合・改称・募集停止・新設のeffective dateと年度factsの帰属
- 一括募集を個別学科へ按分しない
- 比較不能な値を削除せずdetail＋flagへ隔離する

## G3-W2

- 6府県すべてに最終状態と成果物hashがある
- 大阪/兵庫の全件auditと別agentサンプルが完了
- 市立等の独立入口を確認し、所属漏れ0
- official facts、identity、scope、SQL、非対象差分0が県別に追跡可能
- 先行Waveと東日本のartifact/baseline drift 0
