-- =====================================================================
-- v0.2.0 C9: KPI イベントログ（events / admin_users / events_summary_daily）
--
-- 設計方針（plan_v0.2.0-release_c10_app-features.md §C9）:
--   - INSERT は anon / authenticated とも許可（未ログイン・匿名・LINE/Google 全員）
--   - raw の SELECT ポリシーは **誰にも作らない**。未成年サイトのため
--     「個別ユーザーの検討履歴は作者もアプリ経由では見られない」設計。
--     閲覧は日次集計 view（events_summary_daily）経由のみで、
--     view の出力自体も admin_users 所属判定でゲートする。
--   - props は lib/analytics.ts 側のホワイトリスト union 型で PII を排除
--     （住所文字列・氏名・LINE displayname・自宅座標は型レベルで載らない）。
--     DB 側でもサイズ上限 check で暴発を防ぐ。
--   - school_id / user_id に schools への FK は張らない（計測ログが本体データの
--     削除・入替をブロックしないため）。user_id のみ auth.users へ
--     on delete set null で張り、アカウント削除時にリンクを自動切断する（開示/削除対応）。
--   - 肥大化対策: 集計は view で足りる想定。raw の archive/削除は
--     docs/local/analytics-queries.sql の保守節を参照（月次で手動実行）。
--
-- rollback（適用を取り消す場合）:
--   drop view if exists events_summary_daily;
--   drop table if exists events;
--   drop table if exists admin_users;
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1) admin_users: 集計 view を閲覧できる運営者の allowlist
--    行の追加・削除は Supabase SQL Editor（service role）でのみ行う。
-- ---------------------------------------------------------------------
create table if not exists admin_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  note text,
  created_at timestamptz not null default now()
);

alter table admin_users enable row level security;

-- 自分が admin かどうかの確認のみ許可（他人の行は見えない）。
-- INSERT / UPDATE / DELETE のポリシーは作らない = クライアントからは変更不可。
drop policy if exists admin_users_select_self on admin_users;
create policy admin_users_select_self on admin_users
  for select to authenticated
  using (user_id = auth.uid());

revoke insert, update, delete on admin_users from anon, authenticated;

-- ---------------------------------------------------------------------
-- 2) events: KPI イベント raw ログ
-- ---------------------------------------------------------------------
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  user_id uuid references auth.users (id) on delete set null,
  school_id uuid,
  props jsonb not null default '{}'::jsonb,
  session_id text,
  created_at timestamptz not null default now(),
  -- 暴発防止（クライアント直 INSERT のため DB 側でも制約）
  constraint events_event_type_len check (char_length(event_type) between 1 and 64),
  constraint events_session_id_len check (session_id is null or char_length(session_id) <= 64),
  constraint events_props_size check (pg_column_size(props) <= 2048)
);

create index if not exists events_created_at_idx on events (created_at);
create index if not exists events_type_created_idx on events (event_type, created_at);

alter table events enable row level security;

-- INSERT のみ許可。user_id は「未指定 or 自分自身」に限定（他人への成りすまし記録を防ぐ）。
drop policy if exists events_insert on events;
create policy events_insert on events
  for insert to anon, authenticated
  with check (user_id is null or user_id = auth.uid());

-- SELECT / UPDATE / DELETE ポリシーは意図的に作らない（raw は誰も読めない）。
-- RLS で既に拒否されるが、権限レベルでも二重に閉じる。
revoke select, update, delete on events from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3) events_summary_daily: 日次集計 view（唯一の閲覧経路）
--    security definer（PostgreSQL view の既定動作）で events RLS を通過し、
--    WHERE 句の admin_users 判定で「admin 以外には常に 0 行」を保証する。
--    個別ユーザー ID・session_id・props は出力に含めない（集計値のみ）。
-- ---------------------------------------------------------------------
create or replace view events_summary_daily as
select
  (created_at at time zone 'Asia/Tokyo')::date as day,
  event_type,
  count(*)                                     as event_count,
  count(distinct session_id)                   as unique_sessions,
  count(distinct user_id)                      as unique_users
from events
where exists (
  select 1 from admin_users a where a.user_id = auth.uid()
)
group by 1, 2;

revoke all on events_summary_daily from anon;
grant select on events_summary_daily to authenticated;

commit;
