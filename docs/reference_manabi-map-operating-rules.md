# Manabi Map の製品・運用ルール

`CLAUDE.md` から降格した、公開リポジトリで共有する製品境界・表示・データ・リリース規約の正本。機械で強制できるルールは、本文ではなく参照先のコードやテストを更新する。

## 製品の境界

- Web 完結（PWA）で、ネイティブアプリ / exe 化は行わない。
- 学校選びの補助を目的とし、巨大な偏差値サイト・ランキングサイト・合否煽りにはしない。
- 商用偏差値サイトのスクレイピング・数値転載、自由口コミの大量収集、有料課金の本実装は行わない。
- 学校・教育委員会・報道機関への対外的な持ち込みや告知は現在保留。自然流入と受け身の問い合わせ対応は続ける。

## 広告

- 手動選定した塾・予備校・学校・通信教育など、進路・教育に直接関係する広告だけを控えめに表示する。
- ランダム配信の無差別アドネットワーク、金融・ギャンブル・アダルト・情報商材、モーダル / 自動再生 / 追従バナーは使わない。
- 広告は `PR` と明示し、NPO / 自治体連携版では全 OFF とする。実装は `web/src/components/AdSlot.tsx` を入口にする。

## SSR・hydration

- プリレンダーは `web/src/entry-server.tsx` と `web/scripts/gen-seo-pages.mjs` の React 実出力を使う。別 HTML を手書きして同じ画面を再現しない。
- `useState` の初期値で `localStorage` / `sessionStorage` を読まない。初回 render は既定値、復元は `useEffect` で行う。
- fetch 結果で初期表示が変わるページは `web/src/lib/initialData.ts` の `#__MM_INITIAL__` に埋め込み、`#root` の外に置く。
- 静的出力は `web/scripts/verify-static-output.mjs` と `web/scripts/verify-static-output.test.mjs` で検査する。文字列の完全一致ではなく、必要なタグと内容の包含を検査する。

## ナビゲーション

- 導線を変えるときは `web/src/components/Sidebar.tsx` と `web/src/components/SiteFooter.tsx` の両面を確認する。地図画面にはフッターが無い。
- フッターの表示ラベルは `web/data/site-footer-links.json`、公開方針の文言は `web/data/dataset-claims.json` を正本とし、コンポーネントへ直書きしない。
- 静的出力テストで再ハードコードを検出する。

## データ・公開 API・個人情報

- 検索地点は「自宅住所」ではなく中心地点として扱い、お気に入り・メモ・個人推計は RLS で本人限定にする。
- 偏差値相当値は公的資料を参考にした編集推計で、根拠が確認できないものは掲載しない。商用サイト由来の値を混ぜない。
- 静的 HTML には画面表示として含められるが、公開 API には偏差値相当値を出さない。`findDeviationLeak()` が `/api/v1/` の JSON を検査する。
- データセットの定義・出典・ライセンスは `DATA.md`、DB の構造・RLS は `web/supabase/migrations/` と `web/supabase/baseline_schema.sql` を正本とする。

## リリース・外部サービス

- `main` は本番、`develop` は Preview。main へ直接コミットせず、release plan の検証とユーザーの明示承認を経てマージする。
- Cloudflare Pages は main push で本番反映される。タグは versioned release の記録用アンカーであり、デプロイの代替ではない。
- Supabase の schema / RLS / function 変更は `web/supabase/migrations/` に置く。学校データの大量投入は公開 repo に出す意思がある場合だけ migration 化し、適用は人間が内容確認してから行う。
- 外部サービスの設定はリポジトリ検索で推測しない。作者環境の `docs/local/reference_external-services.md` を Read し、変更と同じターンで台帳も更新する。
- `scripts/maintenance.mjs` の on / off / status は service role key を読むため、秘密を出力・ログ・コミットしない。

## 秘密情報と公開 fixture

- 公開 fixture・サンプル設定・例示プロンプトは最初から合成データで書く。実データや外部 KB の表示名を公開ファイルへ残さない。
- layer 1 は `node scripts/secrets-scan.mjs --staged --block`、layer 2 は `.githooks/pre-commit`、layer 3 は `.github/workflows/secrets-scan.yml`。
- 秘密値は repo 外の環境へ置き、公開ファイルにはパスや鍵の値を写さない。
