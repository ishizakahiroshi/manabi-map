-- v0.5 audit C3: events/data_reports の列権限と匿名レート制限を強化する。
-- 本番適用前に、親 bugfix の安全ガードレールと data_reports の既存件数を確認すること。
--
-- rollback（適用を取り消す場合）:
--   create or replace function public.enforce_data_reports_rate_limit()
--   returns trigger
--   language plpgsql
--   security definer
--   set search_path = public, pg_temp
--   as $$
--   declare
--     v_uid uuid := auth.uid();
--     v_recent_count integer;
--   begin
--     -- service_role 等が送信者なしで投入する将来の保守用途は許可する。
--     if new.reporter_user_id is null then
--       return new;
--     end if;
--
--     if v_uid is null or new.reporter_user_id <> v_uid then
--       raise exception 'reporter user mismatch';
--     end if;
--
--     perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
--
--     select count(*)::integer into v_recent_count
--     from public.data_reports
--     where reporter_user_id = v_uid
--       and created_at > now() - interval '10 minutes';
--
--     if v_recent_count >= 5 then
--       raise exception using
--         errcode = 'P0001',
--         message = 'data report rate limit exceeded';
--     end if;
--
--     return new;
--   end;
--   $$;
--
--   create or replace function public.enforce_events_rate_limit()
--   returns trigger
--   language plpgsql
--   security definer
--   set search_path = public, pg_temp
--   as $$
--   declare
--     v_identity text := coalesce(new.user_id::text, nullif(new.session_id, ''), 'anonymous-no-session');
--     v_recent_count integer;
--   begin
--     -- UUID を偽装した同一セッションの並列送信を直列化する。session_id はイベント送信時の既存キー。
--     perform pg_advisory_xact_lock(hashtextextended(v_identity, 0));
--
--     select count(*)::integer into v_recent_count
--     from public.events
--     where coalesce(user_id::text, nullif(session_id, ''), 'anonymous-no-session') = v_identity
--       and created_at > now() - interval '1 minute';
--
--     if v_recent_count >= 30 then
--       raise exception using
--         errcode = 'P0001',
--         message = 'events rate limit exceeded';
--     end if;
--     return new;
--   end;
--   $$;
--
--   grant insert on public.events to anon, authenticated;
--   revoke insert (event_type, user_id, school_id, props, session_id) on public.events from anon, authenticated;
--   （テーブル権限を先に戻すこと。列権限を先に落とすと戻すまでの間 anon / authenticated が events に一切 insert できない窓ができる）
--   （列 ACL は pg_attribute.attacl にテーブル ACL と独立に保持されるため、テーブル権限を持ったままでも列 revoke は正しく効く）
--   （trigger events_rate_limit / data_reports_rate_limit と両 function の ACL は本 migration で定義が変わらないため戻さない）
--   （enforce_events_rate_limit の戻し先は 202608040102 の本体。baseline_schema.sql の時点まで戻すなら 202608040102 も取り消し、drop trigger if exists events_rate_limit on public.events; と drop function if exists public.enforce_events_rate_limit(); を足す）
--   （本 migration は begin / commit で原子適用されるため部分適用は起きない。取り消しは全 4 文をまとめて実行する）
--   （既に挿入された events.created_at はサーバー時刻で確定済みで、クライアント送信値には戻せない）

begin;

-- id / created_at は default と trigger に任せ、クライアントの mass assignment を拒否する。
revoke insert on public.events from anon, authenticated;
grant insert (event_type, user_id, school_id, props, session_id)
  on public.events to anon, authenticated;

create or replace function public.enforce_events_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_identity text := coalesce(new.user_id::text, nullif(new.session_id, ''), 'anonymous-no-session');
  v_recent_count integer;
begin
  -- 列権限だけでなく、保守経路や将来の権限変更があっても時刻をサーバー確定する。
  new.created_at := now();

  -- UUID を偽装した同一セッションの並列送信を直列化する。session_id はイベント送信時の既存キー。
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
  return new;
end;
$$;

drop trigger if exists events_rate_limit on public.events;
create trigger events_rate_limit
  before insert on public.events
  for each row execute function public.enforce_events_rate_limit();

revoke all on function public.enforce_events_rate_limit() from public, anon, authenticated;

-- 匿名アカウントを量産しても同じ時間窓の共有バケットで制限する。
-- 実ログイン利用者は従来どおり user_id 単位の制限を維持する。
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
  v_lock_key text;
begin
  -- service_role 等が送信者なしで投入する将来の保守用途は許可する。
  if new.reporter_user_id is null then
    return new;
  end if;

  if v_uid is null or new.reporter_user_id <> v_uid then
    raise exception 'reporter user mismatch';
  end if;

  -- auth.users を引けない場合は匿名扱いに倒し、制限を迂回させない。
  v_is_anonymous := coalesce(
    (select u.is_anonymous from auth.users u where u.id = v_uid),
    true
  );
  v_lock_key := case when v_is_anonymous
    then 'data-reports:anonymous'
    else 'data-reports:' || v_uid::text
  end;
  perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));

  if v_is_anonymous then
    select count(*)::integer into v_recent_count
    from public.data_reports r
    where r.created_at > now() - interval '10 minutes'
      and exists (
        select 1 from auth.users u
        where u.id = r.reporter_user_id and u.is_anonymous = true
      );

    if v_recent_count >= 3 then
      raise exception using
        errcode = 'P0001',
        message = 'anonymous data report rate limit exceeded';
    end if;
  else
    select count(*)::integer into v_recent_count
    from public.data_reports r
    where r.reporter_user_id = v_uid
      and r.created_at > now() - interval '10 minutes';

    if v_recent_count >= 5 then
      raise exception using
        errcode = 'P0001',
        message = 'data report rate limit exceeded';
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

do $$
declare
  v_events_insert text;
  v_events_source text;
  v_reports_source text;
begin
  select string_agg(column_name, ',' order by column_name)
    into v_events_insert
  from information_schema.column_privileges
  where table_schema = 'public'
    and table_name = 'events'
    and grantee = 'authenticated'
    and privilege_type = 'INSERT';

  select p.prosrc into v_events_source
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'enforce_events_rate_limit';

  select p.prosrc into v_reports_source
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'enforce_data_reports_rate_limit';

  if v_events_insert <> 'event_type,props,school_id,session_id,user_id' then
    raise exception 'C3 assert failed: events INSERT columns are not restricted: %', v_events_insert;
  end if;
  if v_events_source is null or position('new.created_at := now()' in v_events_source) = 0 then
    raise exception 'C3 assert failed: events created_at is not server enforced';
  end if;
  if v_reports_source is null
     or position('data-reports:anonymous' in v_reports_source) = 0
     or position('10 minutes' in v_reports_source) = 0 then
    raise exception 'C3 assert failed: anonymous data_reports rate limit is missing';
  end if;
end;
$$;

commit;
