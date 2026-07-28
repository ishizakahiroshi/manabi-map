---
type: plan
status: done
plan_id: west-japan-v0.4-w4b
parent_plan: ../../plan_west-japan-v0.4-one-shot_2026-07-16.md
node_id: c6-w4b
wave: W4B
prefectures: [熊本県, 宮崎県, 鹿児島県, 沖縄県]
depends_on: [c5-w4a]
artifact_root: ../artifacts/w4b
execution_mode: autonomous
model_default: gpt-5.6-terra
effort_default: high
due: 2026-07-23
last_reviewed: 2026-07-20
review_status: superseded
superseded_by: ../../plan_west-japan-v0.4-incremental-rollout_2026-07-17.md
---

# W4B 九州南部・沖縄

## 役割

熊本、宮崎、鹿児島、沖縄を処理する。離島校、分校、県外本校のcampus、独自配点/選抜scopeを重点監査し、西日本27府県の県別生成を閉じる。

## dispatch

- cohort A: 熊本、宮崎、鹿児島
- cohort B: 沖縄。空きslotは離島/分校/campusと独自制度の独立監査
- P2は独自制度とscopeをSol/xhighで裁定
- P4はwriterとは別のauditorを使う

## 必須監査

- 鹿児島・沖縄等の離島校、分校、校舎を法的学校と区別
- 広域通信制の県内campusを県内本校として登録しない
- 独自配点、推薦/特色、二次/追加、学科内コースの母集団
- 旧校/新校、統合、改称、募集停止、正式閉校日未告示
- 公式原表の画像/脚注/内数と抽出合計

## G3-W4B

- 4県すべてに最終状態と成果物hashがある
- 離島、分校、campusの未裁定PASSがない
- 独自制度を他県の倍率定義へ単純化していない
- 対象外、東日本、先行Wave差分0
- 27府県すべてがmanifestへ登録され、県別phase未実行が0
