-- =====================================================================
-- data_reports: 学校情報の提供・訂正報告キュー
--
-- 公開データへの自動反映は行わない。報告は管理者が一次資料を確認し、
-- 別途 seed SQL / 管理者上書きで反映した後に status を更新する。
--
-- RLS:
--   - INSERT: 匿名認証を含む authenticated が自分の user_id でのみ可
--   - SELECT / UPDATE: admin_users に登録された管理者のみ可
--   - reporter_user_id は本人にも SELECT させず、個人情報の露出を抑える
--
-- rollback:
--   drop trigger if exists data_reports_rate_limit on public.data_reports;
--   drop function if exists public.enforce_data_reports_rate_limit();
--   drop table if exists public.data_reports;
-- =====================================================================

begin;

create table if not exists public.data_reports (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  department_id uuid references public.school_departments (id) on delete set null,
  field text not null,
  proposed_value text not null,
  source text not null,
  comment text,
  reporter_user_id uuid references auth.users (id) on delete set null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users (id) on delete set null,
  constraint data_reports_field_check
    check (field in ('capacity', 'total_students', 'male_ratio', 'deviation', 'other')),
  constraint data_reports_proposed_value_len
    check (char_length(btrim(proposed_value)) between 1 and 2000),
  constraint data_reports_source_len
    check (char_length(btrim(source)) between 1 and 2000),
  constraint data_reports_comment_len
    check (comment is null or char_length(comment) <= 2000),
  constraint data_reports_status_check
    check (status in ('pending', 'reviewed', 'applied', 'rejected')),
  constraint data_reports_review_metadata_check
    check (
      (status = 'pending' and reviewed_at is null and reviewed_by is null)
      or (status <> 'pending' and reviewed_at is not null)
    )
);

comment on table public.data_reports is
  '学校情報の提供・訂正報告。運営確認後にのみ公開データへ反映する';
comment on column public.data_reports.proposed_value is
  '利用者が提供した値。自動反映せず、運営が一次資料を確認する';
comment on column public.data_reports.reporter_user_id is
  '匿名認証を含む送信者 UUID。管理者以外には公開しない';

create index if not exists data_reports_status_created_idx
  on public.data_reports (status, created_at desc);
create index if not exists data_reports_school_created_idx
  on public.data_reports (school_id, created_at desc);
create index if not exists data_reports_reporter_created_idx
  on public.data_reports (reporter_user_id, created_at desc);

alter table public.data_reports enable row level security;

drop policy if exists data_reports_insert_own on public.data_reports;
create policy data_reports_insert_own on public.data_reports
  for insert to authenticated
  with check (auth.uid() is not null and reporter_user_id = auth.uid());

drop policy if exists data_reports_admin_select on public.data_reports;
create policy data_reports_admin_select on public.data_reports
  for select to authenticated
  using (exists (
    select 1 from public.admin_users a where a.user_id = auth.uid()
  ));

drop policy if exists data_reports_admin_update on public.data_reports;
create policy data_reports_admin_update on public.data_reports
  for update to authenticated
  using (exists (
    select 1 from public.admin_users a where a.user_id = auth.uid()
  ))
  with check (
    exists (select 1 from public.admin_users a where a.user_id = auth.uid())
    and status in ('reviewed', 'applied', 'rejected')
    and reviewed_at is not null
    and reviewed_by = auth.uid()
  );

-- Supabase の既定権限に依存せず、報告経路を列単位でも限定する。
revoke all privileges on public.data_reports from anon, authenticated;
grant insert (
  school_id, department_id, field, proposed_value, source, comment, reporter_user_id
) on public.data_reports to authenticated;
grant select on public.data_reports to authenticated;
grant update (status, reviewed_at, reviewed_by) on public.data_reports to authenticated;

-- RLS を迂回する SECURITY DEFINER トリガーで短時間の大量送信を拒否する。
-- 同一 user_id の同時送信は advisory lock で直列化し、競合時の抜け道も塞ぐ。
create or replace function public.enforce_data_reports_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_recent_count integer;
begin
  -- service_role 等が送信者なしで投入する将来の保守用途は許可する。
  if new.reporter_user_id is null then
    return new;
  end if;

  if v_uid is null or new.reporter_user_id <> v_uid then
    raise exception 'reporter user mismatch';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

  select count(*)::integer into v_recent_count
  from public.data_reports
  where reporter_user_id = v_uid
    and created_at > now() - interval '10 minutes';

  if v_recent_count >= 5 then
    raise exception using
      errcode = 'P0001',
      message = 'data report rate limit exceeded';
  end if;

  return new;
end;
$$;

drop trigger if exists data_reports_rate_limit on public.data_reports;
create trigger data_reports_rate_limit
  before insert on public.data_reports
  for each row execute function public.enforce_data_reports_rate_limit();

revoke all on function public.enforce_data_reports_rate_limit() from public, anon, authenticated;

commit;
