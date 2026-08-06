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

## フィールド定義

<!-- BEGIN GENERATED: dataset-fields -->

この節は `web/scripts/gen-dataset-fields.mjs` が生成する。**手で編集しない。**
列挙値の実体は `web/src/types/school.ts`、収録フィールドの実体は
`web/scripts/lib/public-api.mjs` にある。

### 学校レコードのフィールド

| フィールド | 型 | 収録条件 | 説明 |
|---|---|---|---|
| `id` | string (uuid) | 必須 | 学校の内部 ID。安定しているが、外部参照には `record_key` を推奨 |
| `record_key` | string | 必須 | `school-<uuid>` 形式の安定キー。再生成しても変わらない。外部システムとの突き合わせに使う |
| `name` | string | 必須 | 学校名（正式名称） |
| `name_kana` | string \| null | 任意 | 学校名のふりがな。未収集の学校は null |
| `type` | string (enum) | 必須 | 学校種。値は下記「学校種（type）」 |
| `ownership` | string (enum) | 必須 | 設置者。値は下記「設置者（ownership）」 |
| `gender_type` | string (enum) | 必須 | 共学・別学の区分。値は下記「共学別学（gender_type）」 |
| `prefecture` | string | 必須 | 所在の都道府県名（例: 群馬県） |
| `city` | string \| null | 任意 | 所在の市区町村名。総務省 全国地方公共団体コードで正規化 |
| `address` | string \| null | 任意 | 所在地（都道府県から始まる表記） |
| `postal_code` | string \| null | 任意 | 郵便番号（ハイフンあり） |
| `latitude` | number \| null | 任意 | 緯度（10 進度）。出典が確認できた学校のみ |
| `longitude` | number \| null | 任意 | 経度（10 進度）。出典が確認できた学校のみ |
| `official_url` | string | 必須 | 学校公式サイトの URL。**これが確認できない学校は公開 API に収録しない** |
| `course_times` | string[] \| null | 任意 | 課程。値は下記「課程（course_times）」。複数持つ学校がある |
| `campus_type` | string (enum) \| null | 任意 | 校地の種別。値は下記「校地種別（campus_type）」 |
| `total_students` | number \| null | 出典があるときのみ | 全校生徒数。出典が登録された学校だけに出る |
| `enrollment_year` | number \| null | 出典があるときのみ | `total_students` / `male_ratio` の基準年度 |
| `male_ratio` | number \| null | 出典があるときのみ | 男子比率（0〜1）。出典が登録された学校だけに出る |
| `provenance` | object | 必須 | 出典情報。読み方は下記「provenance の読み方」 |
| `lifecycle` | object | 必須 | 学校の状態。読み方は下記「lifecycle の読み方」 |

### 列挙値

#### 学校種（type）

| 値 | 意味 |
|---|---|
| `high_school` | 高等学校 |
| `kosen` | 高等専門学校（5 年制） |

#### 設置者（ownership）

| 値 | 意味 |
|---|---|
| `prefectural` | 都道府県立 |
| `municipal` | 市区町村立 |
| `national` | 国立 |
| `private` | 私立 |
| `union` | 組合立（複数自治体による一部事務組合が設置） |

#### 共学別学（gender_type）

| 値 | 意味 |
|---|---|
| `coed` | 共学 |
| `boys` | 男子校 |
| `girls` | 女子校 |

#### 課程（course_times）

| 値 | 意味 |
|---|---|
| `fulltime` | 全日制 |
| `parttime` | 定時制 |
| `correspondence` | 通信制 |

#### 校地種別（campus_type）

| 値 | 意味 |
|---|---|
| `main` | 本校 |
| `partner_school` | 連携校（通信制の学習等支援を行う提携先） |
| `satellite_campus` | サテライト校地（本校とは別の校地） |
| `support_school` | サポート校 |

#### 学校状態（lifecycle.lifecycle_status_code）

| 値 | 意味 |
|---|---|
| `planned` | 開校予定（設置認可済みで開校前） |
| `active` | 在校（通常運営） |
| `closing` | 在校生のみ（募集を終えたが在校生がいる） |
| `closed` | 閉校 |

#### 募集状態（lifecycle.recruitment_status_code）

| 値 | 意味 |
|---|---|
| `unknown` | 未確認（一次資料で確認できていない） |
| `not_started` | 募集開始前 |
| `recruiting` | 募集中 |
| `no_external_high_school_intake` | 高校段階の外部募集なし（中高一貫の内部進学のみ等） |
| `stopped` | 募集終了 |

### ネストした項目

#### `provenance` の読み方

| キー | 説明 |
|---|---|
| `official_url` | その学校の公式サイト URL。レコード直下の `official_url` と同じ値 |
| `last_built_at` | この JSON を生成した時刻（ISO 8601・UTC） |
| `field_sources` | 項目単位の出典。配列の各要素が 1 つの資料を表す |

`field_sources` の各要素:

| キー | 説明 |
|---|---|
| `field_name` | 出典が紐づく項目。`テーブル名.列名` 形式（例: `schools.official_url`） |
| `official_url` | 元資料の URL |
| `doc_title` | 元資料の題名 |
| `published_at` | 元資料の公表日（不明なら null） |
| `source_page_or_table` | 元資料内の位置（ページ番号・表番号など） |
| `last_verified_at` | 最後に到達を確認した時刻 |
| `last_http_status` | 最後に確認したときの HTTP ステータス。404 でも行は消さず、到達できなかった状態として残す |

**`field_sources` が空配列のとき**は「項目単位の出典が登録されていない」を意味する。データが誤っているという意味ではない。`latitude` / `longitude` / `course_times` / `campus_type` は出典が登録されていれば値を出し、`total_students` / `enrollment_year` / `male_ratio` は**出典が登録された学校にだけフィールド自体が現れる**。

出典が一次資料でないと判定された項目（`is_official_source` が false）は、公開 API に値を出さない。

#### `lifecycle` の読み方

| キー | 説明 |
|---|---|
| `lifecycle_status_code` | 学校の状態。値は上記「学校状態」 |
| `recruitment_status_code` | 募集の状態。値は上記「募集状態」 |
| `opened_on` | 開校日（不明なら null） |
| `closed_on` | 閉校日（不明なら null） |
| `recruitment_ended_on` | 募集終了日（不明なら null） |
| `status_official_url` | 状態の根拠にした一次資料の URL |

<!-- END GENERATED: dataset-fields -->

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
