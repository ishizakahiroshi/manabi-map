-- home_locations の匿名書き込みを共有バケットで制限し、INSERT 可能列を絞る。
--
-- rollback（適用を取り消す場合）:
--   begin;
--   drop trigger if exists home_locations_rate_limit on public.home_locations;
--   drop function if exists public.enforce_home_locations_rate_limit();
--   grant insert on public.home_locations to anon, authenticated;
--   revoke insert (user_id, label, address, latitude, longitude, is_primary)
--     on public.home_locations from anon, authenticated;
--   commit;
--
-- テーブル権限を先に戻してから列 ACL を取り除き、rollback 中に INSERT 不可となる窓を作らない。

begin;

-- id / created_at / updated_at と未使用の住所分解列はクライアントに指定させない。
revoke insert on public.home_locations from anon, authenticated;
grant insert (user_id, label, address, latitude, longitude, is_primary)
  on public.home_locations to anon, authenticated;

-- 匿名アカウントを量産しても同じ時間窓の共有バケットで制限する。
-- 実ログイン利用者は user_id 単位で制限する。
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
  v_lock_key text;
begin
  if v_uid is null or new.user_id <> v_uid then
    raise exception 'home location user mismatch';
  end if;

  -- auth.users を引けない場合は匿名扱いに倒し、制限を迂回させない。
  v_is_anonymous := coalesce(
    (select u.is_anonymous from auth.users u where u.id = v_uid),
    true
  );
  v_lock_key := case when v_is_anonymous
    then 'home-locations:anonymous'
    else 'home-locations:' || v_uid::text
  end;
  perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));

  if v_is_anonymous then
    select count(*)::integer into v_recent_count
    from public.home_locations h
    where h.created_at > now() - interval '10 minutes'
      and exists (
        select 1 from auth.users u
        where u.id = h.user_id and u.is_anonymous = true
      );

    if v_recent_count >= 3 then
      raise exception using
        errcode = 'P0001',
        message = 'anonymous home location rate limit exceeded';
    end if;
  else
    select count(*)::integer into v_recent_count
    from public.home_locations h
    where h.user_id = v_uid
      and h.created_at > now() - interval '10 minutes';

    if v_recent_count >= 5 then
      raise exception using
        errcode = 'P0001',
        message = 'home location rate limit exceeded';
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

do $$
declare
  v_role text;
  v_insert_columns text;
  v_function_source text;
begin
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'home_locations'
      and t.tgname = 'home_locations_rate_limit'
      and not t.tgisinternal
  ) then
    raise exception 'assert failed: home_locations rate-limit trigger is missing';
  end if;

  select p.prosrc into v_function_source
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'enforce_home_locations_rate_limit';

  if v_function_source is null
     or position('home-locations:anonymous' in v_function_source) = 0
     or position('pg_advisory_xact_lock' in v_function_source) = 0
     or position('10 minutes' in v_function_source) = 0 then
    raise exception 'assert failed: home_locations rate-limit function is incomplete';
  end if;

  foreach v_role in array array['anon', 'authenticated'] loop
    select string_agg(column_name, ',' order by column_name)
      into v_insert_columns
    from information_schema.column_privileges
    where table_schema = 'public'
      and table_name = 'home_locations'
      and grantee = v_role
      and privilege_type = 'INSERT';

    if v_insert_columns is distinct from 'address,is_primary,label,latitude,longitude,user_id' then
      raise exception
        'assert failed: home_locations INSERT columns for % are not restricted: %',
        v_role,
        v_insert_columns;
    end if;
  end loop;
end;
$$;

commit;
