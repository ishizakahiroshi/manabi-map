-- Q1-2（plan_security-audit-remediation.md の C3）: app_config の匿名公開範囲を
-- 「公開キー 1 行 × 公開列 2 列」へ限定する。
--
-- 現状は表ごと公開で、key / value に加えて updated_at / updated_by（運用者の auth.users ID）まで
-- 匿名から読める。さらに方針が using (true) なので、今後このテーブルへ足すキーも自動的に公開になる。
-- 公開列の allowlist は schools と同じ書き方に揃える（202608090101_v0.7_public_schools_select_allowlist.sql）。
--
-- 公開キーの allowlist へ足さない限り、新しいキーは匿名・一般利用者から 1 行も見えない（既定で非公開）。
-- 管理経路（functions/api/admin/maintenance.ts / scripts/maintenance.mjs）は service_role で
-- 接続するため、本 migration の revoke / 方針のいずれからも影響を受けない。
-- Realtime（useMaintenanceMode.tsx の app_config_maintenance）は key / value の列権限と
-- maintenance_mode 行の方針が残るので従来どおり配信される。

begin;

revoke all privileges on table public.app_config from public, anon, authenticated;

grant select (key, value) on table public.app_config to anon, authenticated;

-- 公開キーの allowlist。ここへ足したキーだけが匿名・一般利用者に見える。
drop policy if exists app_config_public_select on public.app_config;
create policy app_config_public_select on public.app_config
  for select to anon, authenticated
  using (key = any (array['maintenance_mode']));

do $$
declare
  role_name text;
  column_name text;
  public_columns constant text[] := array['key', 'value'];
  internal_columns constant text[] := array['updated_at', 'updated_by'];
begin
  foreach role_name in array ARRAY['anon', 'authenticated'] loop
    if has_table_privilege(role_name, 'public.app_config', 'select') then
      raise exception 'Q1-2 assert failed: table-level SELECT remains for %', role_name;
    end if;
    foreach column_name in array internal_columns loop
      if has_column_privilege(role_name, 'public.app_config', column_name, 'select') then
        raise exception 'Q1-2 assert failed: internal SELECT remains for %.%', role_name, column_name;
      end if;
    end loop;
    foreach column_name in array public_columns loop
      if not has_column_privilege(role_name, 'public.app_config', column_name, 'select') then
        raise exception 'Q1-2 assert failed: public SELECT is missing for %.%', role_name, column_name;
      end if;
    end loop;
  end loop;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'app_config'
      and policyname = 'app_config_public_select'
      and qual like '%maintenance_mode%'
  ) then
    raise exception 'Q1-2 assert failed: the public policy is not limited to the published keys';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'app_config'
      and cmd in ('SELECT', 'ALL')
      and policyname <> 'app_config_public_select'
  ) then
    raise exception 'Q1-2 assert failed: another SELECT policy can widen the published keys';
  end if;
end $$;

commit;

-- 検証（適用後に SQL Editor / psql で確認）:
--   1. anon で GET /rest/v1/app_config?select=key,value&key=eq.maintenance_mode が 1 行返ること
--   2. anon で GET /rest/v1/app_config?select=updated_by が 42501 で拒否されること
--   3. 公開キー以外を 1 行足しても、anon からは 0 行に見えること
