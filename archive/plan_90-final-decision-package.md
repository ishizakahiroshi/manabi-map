---
type: plan
status: done
plan_id: west-japan-v0.4-final
parent_plan: ../../plan_west-japan-v0.4-one-shot_2026-07-16.md
node_id: c9-final
depends_on: [c8-audit]
execution_mode: report-only
model_default: gpt-5.6-sol
effort_default: xhigh
owner_role: west-orchestrator
due: 2026-07-23
last_reviewed: 2026-07-20
review_status: superseded
superseded_by: ../../plan_west-japan-v0.4-incremental-rollout_2026-07-17.md
---

# 最終判断パッケージ

## 到達結果

ユーザーが途中ログや子成果物を読まずに公開範囲を判断できる、自己完結した`execution/final-judgment-report.md`を作る。このnodeでも本番DB、git、deployへmutationしない。

## 必須内容

- 実行mode、開始/終了時刻、baseline branch/SHA/version、dirty worktree保護結果
- 27府県の`PASS / PASS_WITH_EXCLUSIONS / HOLD`一覧と理由
- Wave別go/no-go推奨
- 学校、学科、募集unit、stats、sources、flagsの期待件数
- 新設、改称、統合、募集停止、閉校、前身後継、campus一覧
- quarantineした全学校/年度/metricと表示影響
- 公式資料の直接到達率、404等の未解決と代替根拠
- SQL一覧、対象、適用順、見込件数、SHA-256
- backup、atomic transaction、assert、rollback、匿名REST検証手順
- 対象外学校/県/前身校と東日本20都道県の非回帰結果
- generator、frontend、lint、typecheck、build、static、gzip、25 MiB、SEO結果
- 変更ファイル一覧、未commit状態、既存ユーザー変更との分離
- requested/actual model・effort、agent failure/retry、model deviation
- 本番適用後の期待件数と公開後smoke項目

## ユーザーへ提示する判断

結論を先に書き、次の選択肢と具体的影響を示す。

1. 全PASS府県と安全な除外を含め、v0.4本番適用・公開へ進む。
2. HOLDを含むWaveを外し、通過Waveだけ本番適用・公開する。
3. 指定したHOLD/quarantineを再調査してから公開する。
4. 今回は公開しない。

推奨案はG5結果から親が1つ選び、理由、公開府県、非表示項目、残riskを明記する。ここが本実行で唯一のユーザー判断点である。

## 完了処理

- manifestを`completed_for_final_judgment`へ更新する
- 全checkpointとartifact hashを再照合する
- `handoff-current.md`を最終状態へ上書きする
- 本番mutation、commit、push、tag、deployが0であることを再確認する
- 次の正確なコマンド/skill、適用対象、rollback参照を報告する
- 親planや子planへ長い実行ログを追記しない
