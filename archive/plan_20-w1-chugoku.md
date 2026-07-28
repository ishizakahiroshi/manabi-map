---
type: plan
status: done
plan_id: west-japan-v0.4-w1
parent_plan: ../../plan_west-japan-v0.4-one-shot_2026-07-16.md
node_id: c2-w1
wave: W1
prefectures: [鳥取県, 島根県, 岡山県, 広島県, 山口県]
depends_on: [c1-w0]
artifact_root: ../artifacts/w1
execution_mode: autonomous
model_default: gpt-5.6-terra
effort_default: high
due: 2026-07-23
last_reviewed: 2026-07-20
review_status: superseded
superseded_by: ../../plan_west-japan-v0.4-incremental-rollout_2026-07-17.md
---

# W1 中国

## 役割

鳥取、島根、岡山、広島、山口の5県をW0でfreezeした契約へ載せる。大都市市立校、県別資料差、離島/分校/校舎、過去の統廃合を独立入口で監査する。

## dispatch

- cohort A: 鳥取、島根、岡山
- cohort B: 広島、山口。空きslotは広島市等の市立入口・再編候補監査
- 各cohortでP0/P1全員完了後にP2、P3、P4へ進む
- P2とP4は同じagentにしない

## 必須監査

- 広島市等の市立高校を県立一覧だけで済ませない
- 中山間・離島の分校/校舎と法的学校を区別する
- 統合前の旧校と現行校へ年度factsを正しく分属する
- 学校計、学科計、募集群、二次/追加の重複を除く
- Excel/PDF/画像表の抽出合計を県公表計へ突合する
- W0 freeze外のschema gapを発見したら、子が変更せず親integratorへ送る

## G2

- 5県すべてに最終状態、件数、hash、source到達率がある
- 市立/国立/高専/定時制/通信制の独立照合結果がある
- 旧校/現行校、校舎/school scopeの未裁定をPASSにしていない
- 対象外差分0、東日本差分0、W0 artifact hash drift 0
- correction cycleは最大2回で収束、未収束は最小単位HOLD
