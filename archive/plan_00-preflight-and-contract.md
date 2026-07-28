---
type: plan
status: done
plan_id: west-japan-v0.4-c0
parent_plan: ../../plan_west-japan-v0.4-one-shot_2026-07-16.md
node_id: c0-preflight
depends_on: []
execution_mode: autonomous
model_default: gpt-5.6-sol
effort_default: high
owner_role: west-orchestrator
due: 2026-07-23
last_reviewed: 2026-07-20
review_status: superseded
superseded_by: ../../plan_west-japan-v0.4-incremental-rollout_2026-07-17.md
---

# C0 preflight、基準点、共通契約

## 到達結果

W0を安全に開始できる基準点と共通仕様を確定し、以後のWaveが同じschema、generator、成果物形式を使える状態にする。ユーザー確認は挟まない。

## 実行

1. `docsweep brief`、repo指示、親plan、県別protocol、handoff、現行migration、generator READMEを読む。
2. git branch/SHA/statusを実測し、既存のユーザー変更をmanifestへ記録して保護する。
3. 本番接続はread-onlyでproject ref、version、schema migration、学校/relationship/admission件数を採取する。
4. 東日本20都道県について、学校、前身後継、名称履歴、unit/stat/source/flagの非回帰baselineを保存する。
5. 西日本27府県の集合を機械的に検査し、重複0、欠落0、三重県=W3をassertする。
6. C0既定値をdecision logへ書く。質問はしない。
7. `execution/manifest.json`、`exception-register.csv`、`handoff-current.md`、checkpointを作る。
8. artifacts directory、template copy規約、`_agent-result.json` schemaを固定する。

## C0単独writerの設計課題

- `ACTIVE_REGION`差し替えではなく、東西`REGIONS`＋全国unionの互換設計を差分案として固定する。
- 公式host追加は県別成果物から集約し、suffix spoof拒否testを必須にする。
- 静的成果物の最大ファイル25 MiB未満assertをCI設計へ追加する。
- v2 generatorの本番候補は全行`school_record_key`＋`--input-schools-only`に固定する。
- 学校identity、lifecycle、学科、admissionの適用順と対象外差分0 assert templateを固定する。

## agent割当

- baseline/read-only棚卸し: `west-runner`, Luna/medium
- schema・region・generator設計監査: `west-adjudicator`, Sol/xhigh
- 最終統合とshared file所有: `west-orchestrator`, Sol/high

同時にshared fileを編集しない。runner/adjudicatorは原則read-onlyで提案を返し、orchestratorだけが統合する。

## G0

- baselineの取得時刻、branch、SHA、DB project ref、件数、hashがある
- 既存dirty worktreeの所有者不明変更を上書きしていない
- execution modeが`one-shot-release-candidate`、production mutationが禁止と記録されている
- C0既定値、県集合、artifact契約、状態enumがmanifestと親planで一致する
- schema gapの扱い、retry、HOLD、最終判断だけという確認方針が固定されている

G0失敗時も、破壊しない範囲の公式資料入口調査は継続する。production mappingを確認できない場合は、全県SQLを最終的に`HOLD`扱いにして調査・生成は止めない。
