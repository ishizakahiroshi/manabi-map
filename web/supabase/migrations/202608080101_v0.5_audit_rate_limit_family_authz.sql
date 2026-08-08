-- v0.5 audit: server-side rate-limit identity and family authorization hardening.
-- This migration does not delete existing family membership rows. Inventory them
-- first with the read-only query in the audit report, then decide on cleanup.
--
-- Rollback requires restoring the function bodies from the preceding migrations:
--   202608040106_v0.5_audit_c3_rate_limit_columns.sql
--   202608060101_home_locations_rate_limit.sql
--   202608040105_v0.5_audit_c2_family_authz.sql
--   202608040101_family_invite_expiry_and_authenticated_acceptance.sql

begin;

-- F-07: auth.uid() is the primary identity. Anonymous traffic also has a
-- server-side circuit breaker so rotating session_id or anonymous accounts
-- cannot create an unlimited number of buckets.
create or replace function public.enforce_events_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_is_anonymous boolean;
  v_identity text;
  v_recent_count integer;
begin
  v_is_anonymous := coalesce(
    (select u.is_anonymous from auth.users u where u.id = v_uid),
    true
  );
  if v_uid is not null then
    new.user_id := v_uid;
  end if;
  v_identity := coalesce(
    v_uid::text,
    nullif(new.user_id::text, ''),
    nullif(new.session_id, ''),
    'anonymous-no-session'
  );

  new.created_at := now();
  perform pg_advisory_xact_lock(hashtextextended(v_identity, 0));

  select count(*)::integer into v_recent_count
  from public.events
  where coalesce(user_id::text, nullif(session_id, ''), 'anonymous-no-session') = v_identity
    and created_at > now() - interval '1 minute';

  if v_recent_count >= 30 then
    raise exception using
      errcode = 'P0001',
      message = 'events rate limit exceeded';
  end if;

  if v_is_anonymous then
    perform pg_advisory_xact_lock(hashtextextended('events:anon-global', 0));

    select count(*)::integer into v_recent_count
    from public.events e
    where e.created_at > now() - interval '1 minute'
      and (
        e.user_id is null
        or exists (
          select 1 from auth.users u
          where u.id = e.user_id and u.is_anonymous = true
        )
      );

    if v_recent_count >= 2000 then
      raise exception using
        errcode = 'P0001',
        message = 'anonymous events global rate limit exceeded';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists events_rate_limit on public.events;
create trigger events_rate_limit
  before insert on public.events
  for each row execute function public.enforce_events_rate_limit();

revoke all on function public.enforce_events_rate_limit() from public, anon, authenticated;

-- F-08: use a per-user bucket first. The global ceiling remains only as a
-- circuit breaker against mass-created anonymous accounts.
create or replace function public.enforce_home_locations_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_is_anonymous boolean;
  v_recent_count integer;
begin
  if v_uid is null or new.user_id <> v_uid then
    raise exception 'home location user mismatch';
  end if;

  v_is_anonymous := coalesce(
    (select u.is_anonymous from auth.users u where u.id = v_uid),
    true
  );

  perform pg_advisory_xact_lock(hashtextextended('home-locations:' || v_uid::text, 0));

  select count(*)::integer into v_recent_count
  from public.home_locations h
  where h.user_id = v_uid
    and h.created_at > now() - interval '10 minutes';

  if v_recent_count >= (case when v_is_anonymous then 2 else 5 end) then
    raise exception using
      errcode = 'P0001',
      message = 'home location rate limit exceeded';
  end if;

  if v_is_anonymous then
    perform pg_advisory_xact_lock(hashtextextended('home-locations:anon-global', 0));

    select count(*)::integer into v_recent_count
    from public.home_locations h
    where h.created_at > now() - interval '10 minutes'
      and exists (
        select 1 from auth.users u
        where u.id = h.user_id and u.is_anonymous = true
      );

    if v_recent_count >= 300 then
      raise exception using
        errcode = 'P0001',
        message = 'anonymous home location global rate limit exceeded';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists home_locations_rate_limit on public.home_locations;
create trigger home_locations_rate_limit
  before insert on public.home_locations
  for each row execute function public.enforce_home_locations_rate_limit();

revoke all on function public.enforce_home_locations_rate_limit() from public, anon, authenticated;

create or replace function public.enforce_data_reports_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_is_anonymous boolean;
  v_recent_count integer;
begin
  if new.reporter_user_id is null then
    return new;
  end if;

  if v_uid is null or new.reporter_user_id <> v_uid then
    raise exception 'reporter user mismatch';
  end if;

  v_is_anonymous := coalesce(
    (select u.is_anonymous from auth.users u where u.id = v_uid),
    true
  );

  perform pg_advisory_xact_lock(hashtextextended('data-reports:' || v_uid::text, 0));

  select count(*)::integer into v_recent_count
  from public.data_reports r
  where r.reporter_user_id = v_uid
    and r.created_at > now() - interval '10 minutes';

  if v_recent_count >= (case when v_is_anonymous then 2 else 5 end) then
    raise exception using
      errcode = 'P0001',
      message = 'data report rate limit exceeded';
  end if;

  if v_is_anonymous then
    perform pg_advisory_xact_lock(hashtextextended('data-reports:anon-global', 0));

    select count(*)::integer into v_recent_count
    from public.data_reports r
    where r.created_at > now() - interval '10 minutes'
      and exists (
        select 1 from auth.users u
        where u.id = r.reporter_user_id and u.is_anonymous = true
      );

    if v_recent_count >= 300 then
      raise exception using
        errcode = 'P0001',
        message = 'anonymous data report global rate limit exceeded';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists data_reports_rate_limit on public.data_reports;
create trigger data_reports_rate_limit
  before insert on public.data_reports
  for each row execute function public.enforce_data_reports_rate_limit();

revoke all on function public.enforce_data_reports_rate_limit() from public, anon, authenticated;

-- P-2: make the anonymous-user policy explicit as well as guarding the RPCs.
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
    and coalesce(
      (select u.is_anonymous from auth.users u where u.id = auth.uid()),
      true
    ) = false;
$$;

drop policy if exists family_groups_select on public.family_groups;
create policy family_groups_select on public.family_groups
  for select to authenticated
  using (
    coalesce(
      (select u.is_anonymous from auth.users u where u.id = auth.uid()),
      true
    ) = false
    and id in (select public.user_group_ids())
  );

drop policy if exists family_members_select on public.family_members;
create policy family_members_select on public.family_members
  for select to authenticated
  using (
    coalesce(
      (select u.is_anonymous from auth.users u where u.id = auth.uid()),
      true
    ) = false
    and (
      user_id = auth.uid()
      or group_id in (select public.user_group_ids())
    )
  );

-- The five write RPCs that predate C2 also need the same fail-closed guard.
create or replace function public.set_family_share(
  p_group_id uuid,
  p_share_favorites boolean,
  p_share_notes boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if coalesce((select u.is_anonymous from auth.users u where u.id = v_uid), true) then
    raise exception 'anonymous users cannot use family sharing';
  end if;

  update public.family_members
  set share_favorites = coalesce(p_share_favorites, share_favorites),
      share_notes = coalesce(p_share_notes, share_notes)
  where group_id = p_group_id
    and user_id = v_uid
    and status = 'active';

  if not found then
    raise exception 'not a member of this group';
  end if;
end;
$$;

create or replace function public.leave_family_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if coalesce((select u.is_anonymous from auth.users u where u.id = v_uid), true) then
    raise exception 'anonymous users cannot use family sharing';
  end if;

  select role into v_role
  from public.family_members
  where group_id = p_group_id and user_id = v_uid;

  if v_role is null then
    raise exception 'not a member of this group';
  end if;
  if v_role = 'owner' then
    raise exception 'owner cannot leave; delete the group instead';
  end if;

  delete from public.family_members
  where group_id = p_group_id and user_id = v_uid;
end;
$$;

create or replace function public.remove_family_member(p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_group_id uuid;
  v_role text;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if coalesce((select u.is_anonymous from auth.users u where u.id = v_uid), true) then
    raise exception 'anonymous users cannot use family sharing';
  end if;

  select group_id, role into v_group_id, v_role
  from public.family_members
  where id = p_member_id;

  if v_group_id is null then
    raise exception 'member not found';
  end if;
  if not exists (
    select 1 from public.family_groups g where g.id = v_group_id and g.owner_id = v_uid
  ) then
    raise exception 'only the group owner can remove members';
  end if;
  if v_role = 'owner' then
    raise exception 'cannot remove the group owner';
  end if;

  delete from public.family_members where id = p_member_id;
end;
$$;

create or replace function public.delete_family_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if coalesce((select u.is_anonymous from auth.users u where u.id = v_uid), true) then
    raise exception 'anonymous users cannot use family sharing';
  end if;
  if not exists (
    select 1 from public.family_groups g where g.id = p_group_id and g.owner_id = v_uid
  ) then
    raise exception 'only the group owner can delete the group';
  end if;

  delete from public.family_groups where id = p_group_id;
end;
$$;

create or replace function public.revoke_family_invite(p_token uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_group_id uuid;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if coalesce((select u.is_anonymous from auth.users u where u.id = v_uid), true) then
    raise exception 'anonymous users cannot use family sharing';
  end if;

  select group_id into v_group_id
  from public.family_members
  where invite_token = p_token and status = 'invited';

  if v_group_id is null then
    raise exception 'invitation not found';
  end if;
  if not exists (
    select 1 from public.family_groups g where g.id = v_group_id and g.owner_id = v_uid
  ) then
    raise exception 'only the group owner can revoke invitations';
  end if;

  delete from public.family_members
  where invite_token = p_token and status = 'invited';
end;
$$;

revoke all on function public.set_family_share(uuid, boolean, boolean) from public;
grant execute on function public.set_family_share(uuid, boolean, boolean) to authenticated;
revoke all on function public.leave_family_group(uuid) from public;
grant execute on function public.leave_family_group(uuid) to authenticated;
revoke all on function public.remove_family_member(uuid) from public;
grant execute on function public.remove_family_member(uuid) to authenticated;
revoke all on function public.delete_family_group(uuid) from public;
grant execute on function public.delete_family_group(uuid) to authenticated;
revoke all on function public.revoke_family_invite(uuid) from public;
grant execute on function public.revoke_family_invite(uuid) to authenticated;

do $$
declare
  v_rate_source text;
  v_home_source text;
  v_report_source text;
  v_family_count integer;
  v_family_guarded integer;
begin
  select p.prosrc into v_rate_source
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'enforce_events_rate_limit';
  if v_rate_source is null
     or position('events:anon-global' in v_rate_source) = 0
     or position('auth.uid()' in v_rate_source) = 0 then
    raise exception 'F-07 assert failed: events server-side identity guard is missing';
  end if;

  select p.prosrc into v_home_source
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'enforce_home_locations_rate_limit';
  select p.prosrc into v_report_source
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'enforce_data_reports_rate_limit';
  if v_home_source is null
     or position('home-locations:' in v_home_source) = 0
     or position('anon-global' in v_home_source) = 0
     or v_report_source is null
     or position('data-reports:' in v_report_source) = 0
     or position('anon-global' in v_report_source) = 0 then
    raise exception 'F-08 assert failed: rate-limit buckets are not per user plus global';
  end if;

  select count(*), count(*) filter (where p.prosrc like '%auth.users%')
    into v_family_count, v_family_guarded
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'set_family_share', 'leave_family_group', 'remove_family_member',
      'delete_family_group', 'revoke_family_invite'
    )
    and p.pronargs = case when p.proname = 'set_family_share' then 3 else 1 end;
  if v_family_count <> 5 or v_family_guarded <> 5 then
    raise exception 'P-2 assert failed: legacy family RPC anonymous guards are incomplete';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'family_groups'
      and policyname = 'family_groups_select'
      and qual like '%is_anonymous%'
  ) or not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'family_members'
      and policyname = 'family_members_select'
      and qual like '%is_anonymous%'
  ) then
    raise exception 'P-2 assert failed: family RLS policies do not reject anonymous users';
  end if;
end;
$$;

commit;
