-- =====================================================================
-- アプリ runtime 設定（管理者 UI / CLI から更新するメンテナンスフラグ）
--
-- app_config の値は公開読み取り可。書き込み経路は service_role のみ。
-- =====================================================================

begin;

create table public.app_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

insert into public.app_config (key, value)
values ('maintenance_mode', '{"on": false}'::jsonb)
on conflict (key) do nothing;

alter table public.app_config enable row level security;

-- 管理者 UI / CLI の更新を他のブラウザへ即時配信する。
alter publication supabase_realtime add table public.app_config;

create policy app_config_public_select on public.app_config
  for select to public
  using (true);

-- Supabase の公開ロールはフラグを読むだけ。INSERT / UPDATE / DELETE の
-- ポリシーは意図的に作らず、service_role（RLS bypass）のみ書き込める。
grant select on public.app_config to anon, authenticated;
revoke insert, update, delete on public.app_config from anon, authenticated;

commit;

-- 検証（適用後に SQL Editor / psql で確認）:
--   1. select count(*) from public.app_config where key = 'maintenance_mode'; -- 1
--   2. anon で SELECT できること（REST: GET /rest/v1/app_config?select=*&key=eq.maintenance_mode）
--   3. anon で UPDATE すると RLS により SQLSTATE 42501 で拒否されること
