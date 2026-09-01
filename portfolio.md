---
schemaVersion: 1
color: "#4aa3a0"
initials: "mm"
cat:
  ja: "Web サービス / TypeScript"
  en: "Web Service / TypeScript"
tagline:
  ja: "通える高校を地図で見ながら、親子で決める。"
  en: "See the high schools within reach on a map, and decide together."
short:
  ja: "地点を検索すると通える範囲の高校が地図に出て、親子で比較・記録・検討できる進路管理サービス（全国 47 都道府県・OSS）。"
  en: "Search a location and the high schools within reach appear on a map, so parent and child can compare, record, and plan together (all 47 prefectures, OSS)."
tech: ["TypeScript", "Map", "Web"]
store: null
live: "https://manabi-map.app"
guide: null
featured: false
features:
  - icon: "◉"
    title:
      ja: "通える範囲が地図で分かる"
      en: "See what is actually within reach"
    desc:
      ja: "地点を検索すると周辺の高校が地図に並びます。縮尺バーの長さが固定なので、ズームしても「この長さ＝だいたい何 km」の感覚がそのまま使えます。"
      en: "Search a location and nearby high schools appear on the map. The scale bar keeps a fixed on-screen length, so your sense of distance survives zooming."
  - icon: "▤"
    title:
      ja: "学校ごとに家族でメモを残せる"
      en: "Keep notes per school, shared with family"
    desc:
      ja: "文化祭・説明会で見聞きしたこと、通学経路の感想を学校ごとに書き込めます。同じアカウントでログインすれば PC とスマホで同期します。"
      en: "Jot down what you saw at open days and how the commute felt, school by school. Sign in and your notes follow you between phone and desktop."
  - icon: "◇"
    title:
      ja: "数字は根拠を確認できた範囲だけ"
      en: "Only figures whose basis can be checked"
    desc:
      ja: "偏差値は商用サイトから転載せず、公的資料を参考にした編集推計として扱います。一次資料まで辿れない項目は公開しません。"
      en: "Deviation figures are editorial estimates based on public documents, never copied from commercial sites. Anything that cannot be traced to a primary source is not published."
  - icon: "◈"
    title:
      ja: "保存する個人データは最小限"
      en: "The service keeps as little about you as it can"
    desc:
      ja: "設定した地点は住所の文字列を保存せず、ラベルを一般化し、緯度経度をおよそ 100m 単位まで丸めて持ちます。距離も経路も従来どおり使えます。"
      en: "For your saved location the service stores no address string: the label is generalised and the coordinates are rounded to roughly 100m. Distances and routes work exactly as before."
---
## ja

地点を検索すると、通える範囲の高校が地図に出てきます。親子で比較・記録・検討できる進路管理サービスです。全国 47 都道府県・5,096 校を収録し、OSS として公開しています。都道府県ごと・市区町村ごとの一覧ページからも探せて、一覧には所在地が並ぶので、似た名前の学校を開かずに見分けられます。

偏差値は商用サイトから転載せず、公的資料を参考にした編集推計として、根拠を確認できた範囲だけ掲載しています。

設定した地点について保存する内容は最小限にしてあります。住所の文字列は保存せず、ラベルは一般化し、緯度経度はおよそ 100m 単位まで丸めた値だけを持ちます。周辺の学校を出す・距離を測る・経路を開くという用途は、この精度で従来どおり動きます。

## en

Search a location and the high schools within reach appear on a map. It is a career-planning service where parent and child can compare, record, and think it through together, covering 5,096 schools across all 47 prefectures of Japan and open-sourced. Prefecture and municipality index pages list each school with its address, so near-identical school names can be told apart without opening them.

Deviation figures are editorial estimates based on public documents, never copied from commercial sites, and are published only where the basis can be verified.

The service deliberately keeps as little as it can about your saved location: no address string is stored, the label is generalised, and coordinates are rounded to roughly 100m. Listing nearby schools, measuring distance and opening a route all work the same at that precision.
