# サードパーティライセンス

制定日: 2026年7月5日

Manabi Map は、以下のオープンソースソフトウェアおよび地図データを利用しています。

## Manabi Map 本体

- ソースコード: AGPL-3.0-or-later
- 公開データ（学校情報等）: CC BY-SA 4.0

## 地図データ・地図タイル

- OpenStreetMap data and standard tiles
- ライセンス: Open Database License (ODbL)
- 表示: © OpenStreetMap contributors
- 著作権・ライセンス: https://www.openstreetmap.org/copyright
- タイル利用ポリシー: https://operations.osmfoundation.org/policies/tiles/

### Protomaps ベクタタイル（設定により使用）

地図タイルを自前配信する構成では、Protomaps の公開 basemap（PMTiles 形式）を利用します。元データは OpenStreetMap であり、ODbL の出典表記（© OpenStreetMap contributors）は引き続き必須です。

- Protomaps: https://protomaps.com/
- 表示: Protomaps © OpenStreetMap contributors
- 元データライセンス: Open Database License (ODbL)

## 住所検索（ジオコーディング）

住所・駅名・地名から地図の中心地点を求める処理に、以下のいずれかを利用します（設定により切替）。

### 国土地理院 住所検索 API（既定）

- 出典: 国土地理院（https://www.gsi.go.jp/）
- 利用規約: 国土地理院コンテンツ利用規約（公共データ利用規約 PDL1.0） https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html
- 表示: 住所検索: 国土地理院

### OpenStreetMap Nominatim（切替時）

- 出典: © OpenStreetMap contributors（https://www.openstreetmap.org/copyright）
- 利用ポリシー: https://operations.osmfoundation.org/policies/nominatim/
- 表示: 住所検索: OpenStreetMap / Nominatim

## 主な実行時依存

| パッケージ | ライセンス | URL |
|---|---|---|
| React | MIT | https://react.dev/ |
| React DOM | MIT | https://react.dev/ |
| React Router DOM | MIT | https://github.com/remix-run/react-router |
| React Markdown | MIT | https://github.com/remarkjs/react-markdown |
| Supabase JavaScript Client | MIT | https://github.com/supabase/supabase-js |
| Leaflet | BSD-2-Clause | https://leafletjs.com/ |

## 主な開発時依存

| パッケージ | ライセンス | URL |
|---|---|---|
| Vite | MIT | https://vite.dev/ |
| TypeScript | Apache-2.0 | https://www.typescriptlang.org/ |
| Tailwind CSS | MIT | https://tailwindcss.com/ |
| Oxlint | MIT | https://oxc.rs/docs/guide/usage/linter |
| Lightning CSS | MPL-2.0 | https://github.com/parcel-bundler/lightningcss |

## 現在検出されているライセンス種別

`web/pnpm-lock.yaml` に基づく現在の依存関係では、以下のライセンス種別が検出されています。

- 0BSD
- Apache-2.0
- BSD-2-Clause
- BSD-3-Clause
- ISC
- MIT
- MPL-2.0

詳細な依存関係は GitHub リポジトリの `THIRD_PARTY_NOTICES.md` と `web/pnpm-lock.yaml` を確認してください。
