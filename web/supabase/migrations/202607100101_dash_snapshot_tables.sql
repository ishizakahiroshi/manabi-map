-- =====================================================================
-- 管理者ダッシュボード: 日次スナップショット保存先とアプリ内指標集計
--
-- dash_* は GitHub Actions と Pages Functions の service role 専用データ。
-- RLS を有効にし、anon / authenticated 向けのポリシーは意図的に作らない。
-- =====================================================================

begin;

create table public.dash_daily (
  snapshot_date date primary key,
  gsc_clicks integer,
  gsc_impressions integer,
  gsc_avg_position numeric(6,2),
  sitemap_page_count integer,
  cf_visits integer,
  cf_pageviews integer,
  app_users_total integer,
  app_users_line integer,
  app_users_anon integer,
  favorites_total integer,
  notes_total integer,
  home_points_total integer,
  created_at timestamptz not null default now()
);

create table public.dash_gsc_queries (
  snapshot_date date not null,
  query text not null,
  clicks integer not null,
  impressions integer not null,
  ctr numeric(6,4),
  position numeric(6,2),
  primary key (snapshot_date, query)
);

create table public.dash_gsc_pages (
  snapshot_date date not null,
  page text not null,
  clicks integer not null,
  impressions integer not null,
  ctr numeric(6,4),
  position numeric(6,2),
  primary key (snapshot_date, page)
);

create table public.dash_cf_referers (
  snapshot_date date not null,
  referer text not null,
  visits integer not null,
  primary key (snapshot_date, referer)
);

-- dim_type: country | browser | os | device
create table public.dash_cf_dims (
  snapshot_date date not null,
  dim_type text not null,
  dim_value text not null,
  visits integer not null,
  primary key (snapshot_date, dim_type, dim_value)
);

-- service role 以外には read/write の経路を与えない。
alter table public.dash_daily enable row level security;
alter table public.dash_gsc_queries enable row level security;
alter table public.dash_gsc_pages enable row level security;
alter table public.dash_cf_referers enable row level security;
alter table public.dash_cf_dims enable row level security;

-- auth.users を直接集計するため security definer を使う。
-- app_users_line は auth.identities に LINE identity を持つアカウント数であり、
-- Google ログインは含めない。匿名ユーザーは auth.users.is_anonymous で数える。
create or replace function public.dash_app_counts()
returns table (
  users_total bigint,
  users_line bigint,
  users_anon bigint,
  favorites_total bigint,
  notes_total bigint,
  home_points_total bigint
)
language sql
security definer
set search_path = public
as $$
  select
    (select count(*) from auth.users),
    (
      select count(distinct i.user_id)
      from auth.identities i
      where i.provider in ('line', 'custom:line')
    ),
    (select count(*) from auth.users where coalesce(is_anonymous, false)),
    (select count(*) from public.user_school_favorites),
    (select count(*) from public.user_school_notes),
    (select count(*) from public.home_locations);
$$;

revoke all on function public.dash_app_counts() from public, anon, authenticated;
grant execute on function public.dash_app_counts() to service_role;

commit;
