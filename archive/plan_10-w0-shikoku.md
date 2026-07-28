---
type: plan
status: done
plan_id: west-japan-v0.4-w0
parent_plan: ../../plan_west-japan-v0.4-one-shot_2026-07-16.md
node_id: c1-w0
wave: W0
prefectures: [徳島県, 香川県, 愛媛県, 高知県]
depends_on: [c0-preflight]
artifact_root: ../artifacts/w0
execution_mode: autonomous
model_default: gpt-5.6-terra
effort_default: high
due: 2026-07-23
last_reviewed: 2026-07-20
review_status: superseded
superseded_by: ../../plan_west-japan-v0.4-incremental-rollout_2026-07-17.md
---

# W0 四国

## 役割

徳島、香川、愛媛、高知の4県でP0〜P4/G3を完了し、新しいidentity先行・対象校限定方式をpilot検証する。W0の完了後に共通schema、generator、成果物形式を内部freezeする。

## dispatch

- cohort A: 徳島、香川、高知を各1 researcherで並列
- cohort B: 愛媛を1 researcherで実行し、空きslotは市立/高専/再編候補の独立監査へ回す
- P2は各県Sol/xhigh adjudicator、P3はSol/high builder、P4はwriterと別のSol/high auditor

親1＋子最大3を守る。各県は`artifacts/w0/<prefecture>/`だけを編集する。

## 必須監査

- 県立一覧以外の市立、国立、高専、定時制、通信制、分校/校舎
- 過去3年度の制度変更、募集群、学科内コース、内数
- 再編、募集停止、閉校予定、同名/改称候補のidentity
- 公式資料の索引URLと直接GET URL、PDF/Excelの代表目視
- 全v2行`school_record_key`、対象外membership差分0

## W0内部freeze

4県のcorrection cycle後、親が次を固定する。

- 不足した共通reason/master codeの扱い
- official host allowlistの追加形式
- identity/lifecycle SQL template
- 対象校限定admission SQLと非対象差分0 assert
- validation reportとagent resultのschema

共通migrationが必要ならW0内で単独writerが作成し、4県を再生成・再監査する。W1以降で同じ問題を場当たり変更しない。

## G1

- 4県すべてに最終状態と成果物hashがある
- 現役校identity不明をPASSにしていない
- official sourceの使用値が直接再取得可能、または理由付き除外
- generator validate、SQL生成、独立監査が完了
- W0共通変更後に4県を再検証済み
- 東日本baseline差分0

親へ返すのは4県の状態、件数、quarantine、freezeした共通仕様だけとする。
