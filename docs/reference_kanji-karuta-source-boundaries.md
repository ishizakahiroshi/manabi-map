---
type: reference
status: draft
tags: [kanji, karuta, source-contract, synthetic]
owner: ishizakahiroshi
review_status: draft
related: [docs/plan_subdomain-entry-school-migration_c1_sqlite-static-source.md]
last_reviewed: 2026-09-27
---

# 漢字・かるたの初回投入と内容データの境界

[SQLite原本計画C1](plan_subdomain-entry-school-migration_c1_sqlite-static-source.md)の「既存入力がないサービスは初回投入仕様」を具体化する。漢字は合成入力から配布候補・共通manifest照合・世代差分まで実装済み。実原本parser・実データ版の契約と、かるたの入力・型・生成器は未実装。ここで記録するのは準備用の合成契約であり、実原本を移行した証跡ではない。

## サービスごとの所有範囲

| 対象 | 現在の入力 | 初回投入の範囲 | 除外するもの |
|---|---|---|---|
| 漢字 | 学習者プロフィール・端末設定と、独立した合成内容のprepare/verifyを実装。実原本の内容入力は未実装 | 漢字・読み・画数・部首・意味・筆順・教材集合・出典 | 学習者名、プロフィール、成績、端末設定、利用者が作った字のセット、認証情報 |
| かるた | 本リポのコード検索で入力なし | 実装を始める担当リポで、札の識別子、読み札・取り札、地域、出典、画像/音声の権利と版を決める | 学習者・プレイ履歴、連絡先、許諾回答の原文、非公開研究資料 |

漢字の [KanjiStore](../web/src/kanji/lib/store.ts) は利用者側の保存境界で、内容原本の保存場所ではない。今回そこへの書込み・移行・schema変更はない。かるたの型やadapterを架空の既存入力に合わせて作らない。サービス間の外部キーを設けない。

## 漢字の準備用契約 version 1

[types.ts](../web/src/kanji/data/types.ts) と [validate.ts](../web/src/kanji/data/validate.ts) は `format: kanji-content-preparation` / `schemaVersion: 1` / `synthetic: true` のデータだけを受け付ける。これは共通manifestそのものではない。実投入時には別の版を定義し、共通manifestの版・出典版・件数・hash・生成器識別へ対応付ける。実データを `synthetic: true` と付け替えて通してはならない。

[prepare/verify CLI](../web/scripts/kanji-content-pipeline.mjs)は、明示した合成入力を[正規化・世代差分処理](../web/src/kanji/data/pipeline.ts)へ渡し、リポ外の明示scratch直下へ新規の候補だけを生成する。[Python bridge](../scripts/local-data/kanji_content_manifest.py)が[共通manifest](reference_local-source-manifest.md)を生成・照合し、版・件数・hashを内容bytesから読み戻す。内容schemaと差分の再検証はCLI側で行う。候補の `artifact_role: published-dataset` は形式上の役割であり、公開済みを意味しない。

- 識別子は漢字1 Unicode scalarの `U+XXXX`（大文字16進数）。互換漢字を自動で統合しない。異体字セレクタ付きの列は本版の対象外で、実入力を確認して別途設計する。
- 項目の状態は `available`（値と出典ID必須）、`not_collected`（未取得）、`unverified`（未確認）、`not_applicable`（該当なし）。後3者は理由必須で、値を持たせない。空文字・0・空配列を未確認の代用にしない。
- 読みの音読み/訓読みの片方は空でもよいが、両方空を確認済みとはしない。意味は言語別に持ち、UI言語一覧とは独立する。言語が無いことは翻訳済みを意味しない。
- 筆順は自作した `M/L/Q/C` 命令と0〜109の有限座標の配列。SVGのマークアップやURLを受け付けない。これは正規化後の合成形式で、KanjiVGの実パーサー・全命令対応・字体や筆順の正確さは未検証。
- 出典不明、未知の項目（SKIP等の索引や利用者情報を含む）、重複ID、孤立した参照、画数と線数の不一致、学年間の重複を拒否する。出典レコードも自作fixtureの識別だけを許す。自由文字列の内容を秘密判定する機能ではないため、fixtureは最初から合成する。

## 級の選択と教材の可用性

既存のプロフィールの `Level` は目標級。内容契約の `ContentCollection` は教材範囲であり、選択された級だけを根拠にデータがあると扱わない。今回のUIは変更しない。

初回は小学校の各学年の集合、常用漢字全体、そこから小学校分を除いた集合を分ける。小学校集合は累計ではなく学年ごとの割当。全集合が確認済みの場合にだけ完全な差集合を検査する。準備用fixtureに実件数を強制せず、実投入時に原本版とともに件数・差分を検証する。

協会の級別表に由来する4級・3級・準2級の割当は本契約に含めない。許諾を確認するまでは級別集合を作らず、小学校以外の常用漢字を一つの範囲として扱う。許諾後の追加は出典と条件を持つ別の契約変更とする。利用者の自作セットは個人の学習データであり、配布する共通原本へ取り込まない。

## 実投入前に残す確認

原本の取得、公式の字数・字体・読み・筆順照合、配布条件の現行確認は未実施。KanjiVG・KANJIDIC2等を使用する際は、原本URL・版・取得日・hash・変更履歴・帰属表示・ライセンスを記録し、不要な索引を許可リストで除外する。取得・定期更新の手順と頻度、最終の表示文言、素材ごとの配布条件を確認してから実版を追加する。データの条件をソフトウェア全体のライセンスと混同しない。

かるたは素材が存在する前にレコード数やライセンスを仮定しない。画像・音声を伴う場合は個別ファイルの出典・権利・hashと欠落を記録する初回仕様を担当リポで作る。公開referenceは私的資料・ローカルパスを依存先にしない。

## 検証の範囲

[合成テスト](../web/src/kanji/data/validate.test.ts) は状態の区別、参照整合、未知項目の拒否、Unicode、座標・画数、教材集合を検査する。[CLIテスト](../web/scripts/kanji-content-pipeline.test.mjs)は候補の生成・再検証・改竄拒否・競合と部分書込み失敗を検査する。構造検査の成功は実際の教材の正確性・許諾・本番投入・利用者の確認を証明しない。既存UI、実取得、raw XML/SVG adapter、実データ版の契約・保存先と公開処理は今回の実装に含めない。
