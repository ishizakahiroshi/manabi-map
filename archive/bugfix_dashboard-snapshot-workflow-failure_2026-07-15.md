---
type: bugfix
status: done
due: null
tags: [github-actions, supabase, postgrest, dashboard]
owner: ishizakahiroshi
review_status: verified
related: []
last_reviewed: 2026-07-20
---

# [完了] 障害対応記録: Dashboard snapshot ワークフロー失敗

## 完了確認（2026-07-20）

修正後の定期実行は 2026-07-17〜2026-07-20 JST に4回連続成功した。手動実行だけでなくcron経路も正常なため、様子見を完了とする。

## 症状

GitHub Actions の `Dashboard snapshot`（cron上は毎日06:15 JST。GitHub側の混雑で開始が遅れる場合あり）が 2026-07-11 の運用開始以降、**成功実行が一度もなく 4 回連続失敗**していた。ユーザーは GitHub からの失敗通知メールで気付いた。

再現手順:
1. `gh run list --repo ishizakahiroshi/manabi-map --workflow="Dashboard snapshot"` で確認すると 07-11 / 07-12 / 07-13 / 07-14 すべて `failure`
2. `gh run view <id> --log-failed` で末尾を見ると `node scripts/dashboard-snapshot.mjs` が 19〜25 秒で例外終了
3. エラーは `Error: Supabase /rest/v1/dash_daily?on_conflict=snapshot_date failed (400)`

影響: 管理者ダッシュボード（`web/src/pages` の想定利用先）に日次スナップショットが一切蓄積されておらず、GSC/Cloudflare/アプリ内指標のグラフが空の状態。

## 根本原因（root cause）

**3 つの独立した原因が順に表面化した。**

### 原因 1: `dash_*` テーブルが本番 Supabase に未作成

`web/supabase/migrations/202607100101_dash_snapshot_tables.sql`（`dash_daily` 等 5 テーブル + `dash_app_counts()` 関数を作成する migration）がリポジトリには存在するが、本番 DB には一度も適用されていなかった。CLAUDE.md の運用ルール上「migration は人間が内容確認してから適用する」ため、SQL ファイル作成後の適用作業が漏れていた。

anon key で `GET /rest/v1/dash_daily` を直接叩くと `PGRST205: Could not find the table 'public.dash_daily' in the schema cache` の 404 が返り、未作成であることを確認した。

### 原因 2: `scripts/dashboard-snapshot.mjs` の一括 upsert がキーセット不整合（原因 1 の陰に隠れていた別バグ）

`scripts/dashboard-snapshot.mjs:206`（修正前）:

```js
const daily = new Map(dates.map((date) => [date, { snapshot_date: date }]))
```

5 日分の行を `{ snapshot_date }` のみで初期化し、GSC/Cloudflare のデータが取得できた日だけ `Object.assign` で列を追加していく設計。さらに `app_users_total` 等の累積指標（237-242 行目）は **最終日（`endDate`）の行にしか付与されない**（過去日を現在値で上書きすると日次差分が壊れるための意図的な設計）。

結果として `[...daily.values()]`（247 行目）で作る 5 行の JSON オブジェクトは、日によって持っているキーが異なる状態になる。PostgREST の一括 upsert は「配列内の全オブジェクトが同じキーセットを持つこと」を要求するため、`PGRST102: All object keys must match` で 400 を返す。

migration 適用後に再実行しても同じ 400 が出たことで、テーブル未作成とは別にこのバグが存在することが判明した。curl で直接 PostgREST に投げて再現・確認済み:

```
$ curl -X POST ".../rest/v1/dash_daily?on_conflict=snapshot_date" \
    -d '[{"snapshot_date":"2026-07-10","gsc_clicks":1},{"snapshot_date":"2026-07-11","gsc_clicks":1,"app_users_total":5}]'
{"code":"PGRST102","details":null,"hint":null,"message":"All object keys must match"}
```

### 原因 3: `return=minimal` の空bodyを常にJSON解析していた

原因2を含む修正版main `15bfa71` で2026-07-16 08:57 JSTに手動実行したところ、PostgRESTへのupsert自体は成功したが、`prefer: resolution=merge-duplicates,return=minimal`の成功レスポンスが空bodyだった。共通関数`supabaseRequest()`は204以外を無条件に`response.json()`へ渡していたため、`SyntaxError: Unexpected end of JSON input`で終了した。

空bodyは正常な成功応答として`null`を返し、bodyがある場合だけJSON解析する必要があった。

## 修正内容

### 対応 1: migration を本番 Supabase に適用

`supabase-migrate` skill の手順（pg_dump フルバックアップ → `psql -v ON_ERROR_STOP=1 -f` で適用 → `supabase_migrations.schema_migrations` に手動 INSERT → 検証）で適用した。バックアップは `docs/local/backups/backup_pre_dash_snapshot_tables_20260715_1040.dump`。

### 対応 2: `daily` Map の初期化時に全カラムを `null` で埋めて揃える

```js
// before
const daily = new Map(dates.map((date) => [date, { snapshot_date: date }]))

// after
// PostgREST の一括 upsert は全行が同じキーセットを持つことを要求する (PGRST102)。
// 一部の日だけ値が付く列があるため、先に全カラムを null で埋めて揃える。
const dailyColumns = {
  gsc_clicks: null, gsc_impressions: null, gsc_avg_position: null, sitemap_page_count: null,
  cf_visits: null, cf_pageviews: null, app_users_total: null, app_users_line: null,
  app_users_anon: null, favorites_total: null, notes_total: null, home_points_total: null,
}
const daily = new Map(dates.map((date) => [date, { snapshot_date: date, ...dailyColumns }]))
```

修正は `scripts/dashboard-snapshot.mjs:204-213` 付近（`main()` 冒頭）。`Object.assign` で後から値を上書きする既存ロジックはそのまま流用できるため、他の変更は不要。

### 対応 3: Supabase成功レスポンスの空bodyを許容する

`supabaseRequest()`で先に`response.text()`を読み、成功時は空文字なら`null`、非空なら`JSON.parse()`するよう変更した。失敗時はPostgRESTのresponse bodyも例外へ含め、次回の診断性も改善した。修正commitは`4fdf25c`。

## 変更ファイル

| ファイル | 内容 |
|---|---|
| `scripts/dashboard-snapshot.mjs` | `daily` Map の全カラム `null` 初期化（PGRST102対策）と、成功時の空response body許容（`4fdf25c`） |
| 本番 Supabase（DB のみ、リポジトリのファイルは無変更） | `web/supabase/migrations/202607100101_dash_snapshot_tables.sql` を適用。`dash_daily` / `dash_gsc_queries` / `dash_gsc_pages` / `dash_cf_referers` / `dash_cf_dims` / `dash_app_counts()` を作成、`schema_migrations` に version 記録 |

## 検証

- [x] anon key で `GET /rest/v1/dash_daily` が 404 → 200 に変わったことを確認（migration 適用後）
- [x] curl で「キーセット不一致」の payload を送ると `PGRST102` が再現することを確認（修正前の挙動の裏付け）
- [x] Node で修正後の `daily` Map 構築ロジックを単体実行し、全行のキーセットが一致することを確認
- [x] curl で「キーセットを揃えた」payload を anon key で送ると `PGRST102` は出ず、期待通り RLS エラー（`42501` / service role なら通る）に変わることを確認
- [x] 修正版main `15bfa71` の手動実行 `29460064938` で、原因3（成功時の空body）が表面化することを確認
- [x] `4fdf25c`をmainへpushし、手動実行 `29460173882` が29秒で成功したことを確認
- [x] ログ `snapshot complete: 2026-07-11 to 2026-07-15` を確認
- [x] main反映後のscheduled実行が4回連続で成功（2026-07-17〜2026-07-20 JST）

## 再実行履歴

| JST | run | head | 結果 | 内容 |
|---|---:|---|---|---|
| 2026-07-16 08:57 | [29460064938](https://github.com/ishizakahiroshi/manabi-map/actions/runs/29460064938) | `15bfa71` | failure | PostgREST成功時の空bodyをJSON解析して失敗 |
| 2026-07-16 08:59 | [29460173882](https://github.com/ishizakahiroshi/manabi-map/actions/runs/29460173882) | `4fdf25c` | success | 2026-07-11～15のsnapshot保存完了 |

## 備忘

- 4 回の失敗はすべて「テーブル未作成」由来の 400 だったため、原因 2（PGRST102）はテーブル作成後の再実行で初めて表面化した。テーブルを作る migration と、それに書き込むスクリプトの両方を同時に本番相当でテストしていなかったのが根本の運用ギャップ
- `PGRST102: All object keys must match` は PostgREST の一括 insert/upsert 全般に共通する制約。他の `dash_*` 系 upsert（`dash_gsc_queries` 等）は 1 行ずつ同じキーセットで生成しているため該当しないが、今後同様に「行ごとに条件付きで列を足す」バルク upsert を書く際は要注意
- migration 適用の pg_dump バックアップは `docs/local/backups/backup_pre_dash_snapshot_tables_20260715_1040.dump`（gitignored 領域）
