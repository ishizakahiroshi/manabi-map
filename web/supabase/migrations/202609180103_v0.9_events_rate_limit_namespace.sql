-- Q1-5（plan_security-audit-remediation.md の C4）: events の流量制限を直す。
--
-- 1) ロックの鍵に名前空間が無く、hashtextextended(<呼び出し側の識別子>, 0) をそのまま使っていた。
--    呼び出し側が識別子を 'home-locations:anon-global' 等にすると、兄弟テーブルのロックを掴める。
--    兄弟（home_locations / data_reports・202608080101_v0.5_audit_rate_limit_family_authz.sql）と同じく
--    'events:' で名前空間を付ける。
-- 2) 未ログイン経路（auth.uid() が null）では、行の識別子は呼び出し側の申告でしかない。
--    申告値を数え方に使っている限り、値を振り直すだけで別のバケットになるので
--    「1 人あたり 1 分 30 件」は一度も効かない。1 人あたりの制限は、サーバーが確定した
--    auth.uid() がある経路にだけ適用する。未ログインは下の全体上限（匿名 1 分 2000 件）で受ける。
--
-- 全体上限（匿名 1 分あたり 2000 件）と created_at のサーバー確定は従来どおり維持する。
-- rollback: 202608080101_v0.5_audit_rate_limit_family_authz.sql の
-- enforce_events_rate_limit 本体を create or replace で流し直す（trigger / ACL は本 migration で変わらない）。

begin;

create or replace function public.enforce_events_rate_limit()
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
  -- auth.users を引けない場合は匿名扱いに倒し、全体上限を迂回させない。
  v_is_anonymous := coalesce(
    (select u.is_anonymous from auth.users u where u.id = v_uid),
    true
  );
  if v_uid is not null then
    new.user_id := v_uid;
  end if;

  -- 列権限だけでなく、保守経路や将来の権限変更があっても時刻をサーバー確定する。
  new.created_at := now();

  -- 1 人あたりの制限は、サーバーが確定した uid がある経路にだけ適用する。
  -- 未ログインの申告値（セッション識別子・行の利用者 ID）は数え方に使わない。
  -- 他人の uid を名乗った記録は events_insert の WITH CHECK
  -- （user_id is null or user_id = auth.uid()）が拒否するので、この数え方は成りすましで膨らまない。
  if v_uid is not null then
    perform pg_advisory_xact_lock(hashtextextended('events:' || v_uid::text, 0));

    select count(*)::integer into v_recent_count
    from public.events e
    where e.user_id = v_uid
      and e.created_at > now() - interval '1 minute';

    if v_recent_count >= 30 then
      raise exception using
        errcode = 'P0001',
        message = 'events rate limit exceeded';
    end if;
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

do $$
declare
  v_source text;
begin
  select p.prosrc into v_source
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'enforce_events_rate_limit';

  if v_source is null then
    raise exception 'Q1-5 assert failed: enforce_events_rate_limit is missing';
  end if;
  if position('''events:'' || v_uid::text' in v_source) = 0 then
    raise exception 'Q1-5 assert failed: the per-user advisory lock key is not namespaced per table';
  end if;
  if position('events:anon-global' in v_source) = 0
     or position('>= 2000' in v_source) = 0 then
    raise exception 'Q1-5 assert failed: the anonymous global ceiling is missing';
  end if;
  if position('new.session_id' in v_source) <> 0 then
    raise exception 'Q1-5 assert failed: the caller-supplied identifier is still used in the rate limit';
  end if;
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.events'::regclass
      and t.tgname = 'events_rate_limit'
      and not t.tgisinternal
  ) then
    raise exception 'Q1-5 assert failed: events_rate_limit trigger is missing';
  end if;
end;
$$;

commit;
