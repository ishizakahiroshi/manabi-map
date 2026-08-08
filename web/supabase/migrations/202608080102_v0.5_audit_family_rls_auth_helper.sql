-- Corrective migration for 202608080101.
-- RLS policies cannot read auth.users directly as anon/authenticated. Keep the
-- authoritative lookup behind a SECURITY DEFINER helper and reuse it in the
-- family policies and user_group_ids().

begin;

create or replace function public.is_human_user()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    not (select u.is_anonymous from auth.users u where u.id = auth.uid()),
    false
  );
$$;

revoke all on function public.is_human_user() from public, anon, authenticated;
grant execute on function public.is_human_user() to authenticated;

create or replace function public.user_group_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select group_id
  from public.family_members
  where user_id = auth.uid()
    and status = 'active'
    and public.is_human_user();
$$;

drop policy if exists family_groups_select on public.family_groups;
create policy family_groups_select on public.family_groups
  for select to authenticated
  using (
    public.is_human_user()
    and id in (select public.user_group_ids())
  );

drop policy if exists family_members_select on public.family_members;
create policy family_members_select on public.family_members
  for select to authenticated
  using (
    public.is_human_user()
    and (
      user_id = auth.uid()
      or group_id in (select public.user_group_ids())
    )
  );

do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'is_human_user'
      and p.prosrc like '%auth.users%'
  ) then
    raise exception 'P-2 corrective assert failed: human-user helper is missing';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'family_groups'
      and policyname = 'family_groups_select'
      and qual like '%is_human_user%'
  ) or not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'family_members'
      and policyname = 'family_members_select'
      and qual like '%is_human_user%'
  ) then
    raise exception 'P-2 corrective assert failed: family RLS helper is missing';
  end if;
end;
$$;

commit;
