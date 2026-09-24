-- 無料枠（DB 500MB・MAU 5 万人）までの距離を測るため、Supabase の利用量を毎日記録する。
--
-- 現状: scripts/dashboard-snapshot.mjs は REST（service role）で dash_daily を書いているが、
-- DB のサイズとログイン利用者数はどこにも記録していない。REST からは pg_database_size も
-- auth.users も直接は読めない。
--
-- 変更:
--   1. 記録先 public.dash_supabase_usage を足す（1 日 1 行・snapshot_date は dash_daily の
--      アプリ内件数と同じ日付）。dash_daily には足さない。dash_daily はサイトの伸び（GSC・
--      Cloudflare・アプリ内の件数）の記録で、こちらは無料枠の残りを見る記録のため。
--      転送量は Management API の鍵を置かないため月 1 回の手作業で記録する
--      （docs/local/manual_supabase-egress-monthly.md）。自動にするなら、この表へ列を 1 つ足す。
--   2. 2 つの数を返す public.dash_supabase_usage_metrics() を足す。dash_app_counts と同じく
--      service_role だけが実行できる RPC で、鍵は増やさない。
--
-- 数え方:
--   db_size_bytes: pg_database_size(current_database())。Supabase の請求画面の DB サイズと
--     同じ値になるかは未確認。
--   auth_users_signed_in_30d: auth.users のうち last_sign_in_at が実行時点から 30 日以内の人数
--     （匿名ログインも含む）。Supabase が請求で数える MAU と同じ数え方かは未確認で、近似値として扱う。
--
-- 権限: 2026-10-30 以降は public の新しいテーブルへ Data API 用の権限が自動では付かないため、
-- テーブルと関数の権限をこのファイルで明示する（docs/local/plan_supabase-explicit-grants.md）。
-- 適用日によって既定の権限（ALTER DEFAULT PRIVILEGES の GRANT ALL）が付くかどうかが変わるので、
-- service_role も含めて一度 revoke してから、service_role にだけ要る分を戻す。
-- どちらの日に適用しても同じ権限になる。
-- RLS は有効にし、方針（policy）は作らない（dash_* と同じく service role 専用）。
--
-- 冪等性: create table を含むので 2 回目はエラーで止まる（トランザクションなので部分適用は起きない）。
-- rollback:
--   begin;
--   drop function if exists public.dash_supabase_usage_metrics();
--   drop table if exists public.dash_supabase_usage;
--   commit;
--   （併せて scripts/dashboard-snapshot.mjs の dash_supabase_usage の取得と保存を外すこと）

begin;

-- 取れない値があった日も、取れた値だけで行を残せるよう、指標の列は null を許す。
create table public.dash_supabase_usage (
  snapshot_date date primary key,
  db_size_bytes bigint,
  auth_users_signed_in_30d integer,
  created_at timestamptz not null default now()
);

alter table public.dash_supabase_usage enable row level security;

revoke all on table public.dash_supabase_usage from public, anon, authenticated, service_role;
-- snapshot の upsert（insert ... on conflict do update）に要る分だけ。
-- excluded の値を読む列には select 権限も要る（PostgreSQL の INSERT の仕様）。delete は渡さない。
grant select, insert, update on table public.dash_supabase_usage to service_role;

-- auth.users と pg_database_size を読むため security definer を使う。
-- search_path は空に固定し、参照はすべてスキーマ付きで書く。
create or replace function public.dash_supabase_usage_metrics()
returns table (
  db_size_bytes bigint,
  auth_users_signed_in_30d bigint
)
language sql
security definer
set search_path = ''
as $$
  select
    pg_catalog.pg_database_size(pg_catalog.current_database()),
    (
      select count(*)
      from auth.users u
      where u.last_sign_in_at >= pg_catalog.now() - interval '30 days'
    );
$$;

-- Supabase の function 作成 hook と既定の権限は anon / authenticated にも EXECUTE を付けるため、
-- すべて revoke してから service_role にだけ戻す。
revoke all on function public.dash_supabase_usage_metrics() from public, anon, authenticated, service_role;
grant execute on function public.dash_supabase_usage_metrics() to service_role;

do $$
declare
  v_secdef boolean;
  v_config text[];
  v_rls boolean;
  v_role text;
  v_privilege text;
begin
  select p.prosecdef, p.proconfig
    into v_secdef, v_config
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'dash_supabase_usage_metrics'
    and p.pronargs = 0;

  if v_secdef is null then
    raise exception 'assert failed: dash_supabase_usage_metrics is missing';
  end if;
  if not v_secdef then
    raise exception 'assert failed: dash_supabase_usage_metrics is not security definer';
  end if;
  if v_config is null or not exists (
    select 1 from unnest(v_config) as c where c like 'search_path=%'
  ) then
    raise exception 'assert failed: dash_supabase_usage_metrics does not pin search_path';
  end if;
  if not has_function_privilege('service_role', 'public.dash_supabase_usage_metrics()', 'execute') then
    raise exception 'assert failed: service_role cannot execute dash_supabase_usage_metrics';
  end if;

  select c.relrowsecurity
    into v_rls
  from pg_class c
  where c.oid = 'public.dash_supabase_usage'::regclass;

  if not coalesce(v_rls, false) then
    raise exception 'assert failed: dash_supabase_usage does not have RLS enabled';
  end if;
  foreach v_privilege in array array['select', 'insert', 'update'] loop
    if not has_table_privilege('service_role', 'public.dash_supabase_usage', v_privilege) then
      raise exception 'assert failed: service_role lacks % on dash_supabase_usage', v_privilege;
    end if;
  end loop;

  foreach v_role in array array['anon', 'authenticated'] loop
    if has_function_privilege(v_role, 'public.dash_supabase_usage_metrics()', 'execute') then
      raise exception 'assert failed: dash_supabase_usage_metrics is executable by %', v_role;
    end if;
    if has_table_privilege(v_role, 'public.dash_supabase_usage',
                           'select,insert,update,delete,truncate,references,trigger') then
      raise exception 'assert failed: % has privileges on dash_supabase_usage', v_role;
    end if;
  end loop;
end;
$$;

commit;

-- 検証（適用後に SQL Editor / psql で確認）:
--   1. select * from public.dash_supabase_usage_metrics();
--      1 行・2 列（db_size_bytes / auth_users_signed_in_30d）が返ること
--   2. 次の dashboard-snapshot の実行後:
--      select * from public.dash_supabase_usage order by snapshot_date desc limit 1;
--      2 つの列に値が入っていること
