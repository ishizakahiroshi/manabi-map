---
type: reference
status: draft
tags: [source-contract, synthetic]
owner: ishizakahiroshi
review_status: draft
related: [docs/plan_subdomain-entry-school-migration_c1_sqlite-static-source.md]
last_reviewed: 2026-09-27
---

# サービス共通のローカル成果物 manifest v1

学校・土地・漢字・かるたの成果物の境界、版、生成記録、ファイル一致を共通に検査する追加形式。現在の実装は合成候補のみ。SQLite原本や既存サービスのmanifestを置換せず、利用者の認証・設定・学習記録は含めない。

## 契約

最上位キーは次の12個だけ。`format: local-source-manifest`、整数`format_version: 1`、`service: school|land|kanji|karuta`、`artifact_role: source-snapshot|published-dataset`、`synthetic: true`、非空の`dataset_version`と`source_version`、時差付きISO日時`created_at`、`payload`、`counts`、`artifacts`、`code`。

- `payload`は`format`、文字列`version`、`entrypoint`だけ。`version`はサービス固有の内容スキーマ版。共通形式の版とは分ける。
- `counts`は非空の名前→件数辞書。名前は`[a-z][a-z0-9_]*`、値は0以上のJavaScript安全整数。真偽値は拒否する。未確認を0にしない。
- `artifacts`は非空の`{path, media_type, sha256}`配列。path昇順、重複なし。entrypointが含まれること。SHA-256はファイルbytesそのものの小文字64桁hex。
- `code`は`{identity: "sha256", files: [{path, sha256}], sha256}`。filesは非空でpath昇順、重複なし。全体SHAはfilesをASCII JSON、キー昇順、空白なしで直列化したbytesのSHA-256。生成元コードの記録であり、署名・現在のcheckout一致の証明ではない。
- pathはASCIIの`[A-Za-z0-9_./-]+`。区切りは`/`、空segment・`.`・`..`は禁止。絶対path、drive、backslash、URLは受け付けない。検証器はpathを開かず、呼出側が明示したpath→bytes辞書だけを読む。
- dataset/source版は呼出側が出典と更新単位を定める。欠落値を時刻やGit SHAから推測しない。created_atは内容の一致判定から分離し、再生成時はartifactごとのSHAを比較する。

共通検証器はmetadataの形式とartifact bytesの一致を検証する。サービス固有の値・出典・件数の意味・配布可否は各adapterで検査する。`synthetic: true`は呼出側の宣言であり、実値を自動識別・匿名化する機能ではない。異なるserviceを取り違えないため、呼出側は`expected_service`を必ず指定する。

## 学校の互換adapter

`scripts/local-data/school_common_manifest.py`は既存schema 3の`verify_bundle`を先に実行し、旧manifestとsnapshotを変更せず共通envelopeを返す。旧manifest自体もartifactに含むため、既存のsemantic content hash、25表件数、15ファイルのproducer identityを保持する。旧export、JS adapter、既定入力は変更しない。

```
python -B scripts/local-data/school_common_manifest.py --bundle <合成bundleのdirectory>
```

読取りのみで、結果JSONを標準出力へ返す。保存・配信・既存ファイルの置換はしない。envelope内のpathの基点は入力bundle。別の場所にenvelopeを保存しても、その保存先から暗黙にartifactを探索しない。呼出側は保存したenvelopeと対応するbytesを明示して再検証する。

## サービス別の境界

| service | 現在の接続と次の段階 |
|---|---|
| school | schema 3の合成bundleから追加envelopeへ接続。学校固有の契約は[学校原本契約](reference_sqlite-school-source-contract.md) |
| land | 担当リポで既存の施設生成記録と明示payload bytesを接続。地域固有スキーマは担当リポに保持。別生成経路や外部タイルを検証済みに含めない |
| kanji | [prepare/verify CLI](../web/scripts/kanji-content-pipeline.mjs)と[Python bridge](../scripts/local-data/kanji_content_manifest.py)で合成内容候補・共通manifest照合・世代差分へ接続済み。実原本parser・実データ版の契約は未実装。[教材境界](reference_kanji-karuta-source-boundaries.md)で範囲を定義 |
| karuta | 既存入力は未実装。権利・出典・素材と配布単位を初回仕様で定めてから投入器へ進む |

本形式の追加だけでは、原本移設、世代バックアップ、復旧、データ取得、権利確認、公開切替は完了しない。
