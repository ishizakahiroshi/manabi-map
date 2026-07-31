---
type: plan
status: done
plan_id: west-japan-v0.4-app
parent_plan: ../../plan_west-japan-v0.4-one-shot_2026-07-16.md
node_id: c7-app
depends_on: [c6-w4b]
execution_mode: autonomous
model_default: gpt-5.6-sol
effort_default: high
owner_role: west-integrator
due: 2026-07-23
last_reviewed: 2026-07-20
review_status: superseded
superseded_by: ../../plan_west-japan-v0.4-incremental-rollout_2026-07-17.md
---

# アプリ、静的成果物、CI統合

## 到達結果

西日本のrelease candidateを東日本を壊さず表示できるコードへ統合し、production mutationなしでtest/build/static検証を完了する。shared codeは1名の`west-integrator`だけが編集する。

## 実装対象

- `ACTIVE_REGION`単純差替えを廃し、東西`REGIONS`と全国union/選択状態へ拡張する
- 郵便番号、address、bbox、地図中心、県所有者表示、検索の東西回帰test
- 27府県の公式host allowlistとsuffix spoof拒否test
- identity/lifecycle、前身後継、校舎、募集区分、出典導線のUI
- 静的JSON、manifest、gzipの生成・読込
- gzip magic byte判定。URL拡張子だけで二重展開しない
- 最大単一ファイル25 MiB未満のCI assert
- SEO URL、sitemap、代表校View Sourceの件数検証
- Dashboard snapshotの成功時空bodyを安全に扱う既存fixの回帰

## データ源

本番DBへ西日本SQLを適用しない。local/scratch DBまたはSQL-derived release-candidate datasetで静的生成を行う。本番read-onlyデータはbaseline照合にだけ使う。production dataをfixtureへ化石化せず、test fixtureは合成値にする。

## agent割当

- region/UI/静的統合writer: Sol/high、1名
- 機械test、size、hash、URL検査: Luna/medium、read-only
- identity/表示/回帰監査: Sol/high、writerと別

## G4

- generator tests、frontend tests、lint、typecheck、buildが成功
- 東日本20都道県の検索、郵便番号、初期地図、SEOが回帰していない
- 西日本27府県の代表校がlocal previewで表示される
- 現行校、前身校、校舎、入試区分、公式出典をサンプル確認
- 静的JSON/gzipが読め、最大ファイルが25 MiB未満
- sitemap/SEO件数と期待学校件数が一致
- public fixtureへの実値混入がない
- 本番mutation、commit、push、deploy、tagが0
