# Manabi Map データセット

Manabi Map（まなびマップ）は、親子で学校選びを考えるための地図ノートです。このリポジトリで扱う学校基本情報は、公的資料をもとに編集し、**CC BY-SA 4.0** で公開しています。

## 収録内容

公開用データセットには、学校名、所在地、座標、設置区分、学校種、課程、学科、学校状態、公式サイト URL などを収録します。更新のたびにリポジトリの `web/public/` にある学校データから、公開用 JSON と CSV を生成します。

偏差値の編集推計は含めません。数値だけを切り出した序列化や二次利用を避け、方法と限界を文脈とともに扱うためです。

## 収録基準

**一次資料 100%・出典明示 100%・商用サイトからの転載ゼロ**を公開方針としています。

- 学校・教育委員会・官公庁が自ら公表した資料だけを出典とし、私立高校は学校法人・学校公式サイトを一次資料として扱います
- 公開 API の各学校レコードには学校公式 URL を、項目単位の出典があるデータには元資料の URL を同梱します
- 出典 URL を確認できない項目は公開 API に収録しません
- 偏差値の編集推計は公開 API に収録しません

## 安定エンドポイント

- 全都道府県: `https://manabi-map.app/api/v1/schools.json`
- 県別: `https://manabi-map.app/api/v1/schools/<prefecture>.json`（例: `gunma`）
- メタデータ: `https://manabi-map.app/api/v1/dataset.json`

いずれもリリース時に更新する静的 JSON です。検索条件付きリクエストや POST は提供しません。`/api/v1/` 内では後方互換性を維持し、破壊的変更が必要な場合は `/api/v2/` を新設します。

## ライセンスと出典表記

データセットは [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) です。利用・再配布時は、次の形式で出典を表記してください。

> 出典: Manabi Map（まなびマップ） https://manabi-map.app （CC BY-SA 4.0）

コードは [AGPL-3.0-or-later](LICENSE) です。コードとデータは、それぞれのライセンスに従って利用してください。

## 生成方法

リリース時に、リポジトリのルートから次を実行します。

```text
node scripts/export-dataset.mjs
```

既定では git 管理外の `dist-dataset/` に `manabi-map-schools.json` と `manabi-map-schools.csv` を出力します。GitHub Release への添付は、内容を確認したうえでリリース担当者が行います。

## 出所・更新・訂正

学校基本情報は、学校・教育委員会・官公庁が自ら公表した一次資料を根拠として編集しています。更新はデータ更新を含むリリース時に行います。掲載情報の削除・訂正は [takedown@manabi-map.app](mailto:takedown@manabi-map.app) へお知らせください。
