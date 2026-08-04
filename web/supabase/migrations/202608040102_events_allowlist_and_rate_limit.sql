-- F19: events の種類をアプリの AnalyticsEventType に限定し、短時間の大量送信を拒否する。
-- 冪等性: constraint / function / trigger は再作成可能。既存 event_type は allowlist 内であることを検査する。

begin;

alter table public.events drop constraint if exists events_event_type_allowlist_check;
alter table public.events
  add constraint events_event_type_allowlist_check
  check (event_type in ('search', 'favorite_add', 'memo_save', 'detail_open', 'compare_view', 'ad_click')) not valid;
alter table public.events validate constraint events_event_type_allowlist_check;

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

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.events'::regclass and conname = 'events_event_type_allowlist_check'
  ) then
    raise exception 'F19 assert failed: event_type allowlist constraint is missing';
  end if;
end;
$$;

commit;
