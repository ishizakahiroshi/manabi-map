---
type: manual_release
status: done
tags: [release, v0.3.3, press-kit, dashboard, operations]
owner: ishizakahiroshi
last_reviewed: 2026-07-23
related:
  - apply-runbook_v0.3.3.md
  - recap_2026-07-23_v033-release-and-west-remediation.md
---

# [完了] v0.3.3 リリース記録（デプロイ済み運用・認知導線のpatch）

> **西日本の公開リリースではない。** 西日本27府県のデータ投入・DB migration・地域公開は
> v0.4.0 の段階展開で扱う。この記録は、先行して本番反映された v0.3.3 相当の画面・運用改善を
> tag と公開履歴へ整合させるためのもの。

## リリース引数

| 項目 | 値 |
|---|---|
| repo | manabi-map |
| version | v0.3.3 |
| channels | cloudflare-pages |
| mode | interactive（プレビューUIは人間検収） |
| dry-run | false |
| 起点 branch | develop |
| ターゲット branch | main |

## リリース内容

1. メディア・教育関係者向けの `/press` プレスキットと導線を追加。
2. 非管理者が `/dashboard` を開いたとき、管理者判定後にトップへ戻すUXへ修正。APIの管理者制限は維持。
3. Dashboard snapshot の空応答処理を修正し、日次の検索・流入計測の継続性を改善。
4. v0.4で使う西日本データ収集・PDF抽出・候補検査ツールを公開リポジトリへ整備（利用開始・地域公開はv0.4）。

## DB適用

- v0.3.3でのDB書込み・データ投入: なし
- `202607160201_v0.4_west_contract.sql`: **未適用（v0.4で別承認）**
- `202607200101_admission_quality_reason_metric_not_published.sql`: **未適用（v0.4で別承認）**

## 段階完了チェック

- [x] STEP 0: schema_migrationsのread-only監査
- [x] STEP 1: CHANGELOG / README更新、typecheck / lint / test、full secrets-scan
- [x] STEP 2: develop previewの機械検収
- [x] STEP 2b: ユーザーによるプレビューUI検収（2026-07-23・確認OK）
- [x] STEP 3: mainマージ、`v0.3.3` tag push、本番検収
- [x] STEP 4: 申し送り・recap（2026-07-23・`recap_2026-07-23_v033-release-and-west-remediation.md`）

## 検証結果

- DB read-only: `202607160101`（v0.3.2）は適用済み。`202607160201` と `202607200101`（v0.4候補）は未適用であることを確認。
- ローカル: `pnpm typecheck` 成功、`pnpm lint` 成功（既知のI18n fast-refresh警告2件のみ）、`pnpm test` 成功（unit 54件・static 5件）。
- 秘密情報: `node scripts/secrets-scan.mjs --all-tracked --block` 成功（157 files）。
- develop preview: CI（typecheck/test/build、secrets scan）・Cloudflare Pagesとも成功。manifest 2,591校、sitemap 2,593 URL、`/press` HTTP 200、学校詳細の静的表示を確認。

## リリース結果

- main merge commit: `167ee08`（`release: v0.3.3 プレスキット / 管理画面リダイレクト / 日次計測の空応答対応`）
- tag: `v0.3.3` push 済み（2026-07-23）
- 追加commit: `c8022fa`（`web/package.json` 0.3.2 → 0.3.3、README 掲載校数 2,590 → 2,591）
- Cloudflare Pages: main 再ビルド完了（manifest `generatedAt` 2026-07-22T15:03:31Z）
- 本番検収: manifest 2,591校 / sitemap 2,593 URL / `/press`・トップとも HTTP 200
- DB書込み: なし（v0.4候補migration 2本は未適用のまま）

## rollback

- コード: v0.3.2へrevertまたは前commitへ戻す
- DB: v0.3.3では変更なし

## 申し送り

- 本記録は、2026-07-22に先行してmainへ反映された変更を正式なrelease手順へ戻すために作成した。
- v0.4候補migrationは、v0.3.3の本番DBに適用しない。v0.4専用runbookでbackup・適用・データ投入・検証を行う。
- v0.4.0は未完了でありrelease候補ではない（`plan_west-japan-v0.4-incremental-rollout_2026-07-17.md`）。
  **内訳の現況（2026-07-23 時点・本 md 起票後に進捗あり）**: S1は27/27府県・2,520校完了。Block 5・6はG4承認済み。
  投入前是正パック（大阪の学科名46行・熊本2行・大阪の`course_times`21校）と福岡R7 backfillは**完了**し、
  大阪・熊本・福岡の**S4やり直しも3県ともPASS**（`west-japan-v0.4-incremental/execution/remediation-pack-2026-07-23.md`）。
  残るのは Block 6/5 の freeze、**Block 7 の S5監査→review→G4（最後の未承認G4）**、本番適用前バッチ台帳の整備。
  滋賀石山remediationは2026-07-20 resolved済み（奈良はR8 6行 examinees誤混入が本番適用時の申し送りとして残存）。
- OGP是正（同日中に解決）: `web/index.html` のog:descriptionが「2,590 校」のままだったため `8bf4a00` で2,591校へ修正し、main `56899e4` として反映。本番HTMLで更新を確認済み。tagは`v0.3.3`のまま動かしていない。
- **gotcha**: `changelog-freshness` の検査項目4（index.htmlのOGP数字）を、READMEを直した時点で同時に確認しなかった。次回は「校数を直す」ときにREADME / index.html OGP / CHANGELOG を必ずセットで grep する。
