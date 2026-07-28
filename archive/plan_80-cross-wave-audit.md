---
type: plan
status: done
plan_id: west-japan-v0.4-audit
parent_plan: ../../plan_west-japan-v0.4-one-shot_2026-07-16.md
node_id: c8-audit
depends_on: [c7-app]
execution_mode: autonomous-read-only-audit
model_default: gpt-5.6-sol
effort_default: xhigh
owner_role: west-auditor
due: 2026-07-23
last_reviewed: 2026-07-20
review_status: superseded
superseded_by: ../../plan_west-japan-v0.4-incremental-rollout_2026-07-17.md
---

# 27府県横断独立監査

## 到達結果

生成・統合担当とは別のauditorが、27府県、6 Wave、東日本baseline、アプリ成果物を横断し、公開候補へ残る誤帰属・欠落・回帰を検出する。このnodeは原則read-onlyで、修正は元nodeの単独writerへ返す。

## 監査

1. 府県集合が27ちょうど、重複0、欠落0、三重県=W3のみ。
2. 全府県にP0、sources、year facts、decision capsule、4 CSV、SQL、validation、agent resultがある。
3. 現役/旧校/新校/前身/後継/改称/閉校/募集停止/campusの状態矛盾がない。
4. `school_record_key`解決、scope、map role、membership、sourceのcross-file整合。
5. 市立、国立、高専、定時制、多部制、通信制、離島校の独立入口確認。
6. official URLの直接到達率、doc/year/page一致、HTTP status、host allowlist。
7. 対象校限定SQLに県全置換がなく、対象外学校/県/前身校の差分0 assertがある。
8. 東日本学校、relationship、name history、admission membership、静的表示の非回帰。
9. app test/build/static/gzip/25 MiB/SEO/sitemapの証跡。
10. dirty worktreeの既存ユーザー変更を上書きしていない。

## correction cycle

監査指摘を県・shared code単位で元writerへ返し、最大2巡修正する。修正後は該当県G3、横断監査、東日本非回帰を再実行する。未解決は推測せず`HOLD`または`PASS_WITH_EXCLUSIONS`へ落とす。

2agentの裁定不一致は、新しいSol/xhigh adjudicatorが公式根拠だけでtie-breakする。決着しない場合は安全側の`HOLD`とする。

## G5

- 27府県すべての最終状態が確定
- fatal exception 0、または全体hard stopとして理由と影響範囲が確定
- 未追跡のquarantine/HOLD 0
- SQL、artifact、test resultのhashがmanifestと一致
- 東日本baseline差分0
- correction後の再監査が完了
