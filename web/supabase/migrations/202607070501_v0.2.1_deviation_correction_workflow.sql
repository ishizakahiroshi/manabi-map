-- =====================================================================
-- v0.2.1: 偏差値データ修正ワークフロー
--
-- - admin_users に PIN hash を追加（平文 PIN は保存しない）
-- - 偏差値上書きは SECURITY DEFINER RPC に閉じ込める
-- - 変更ログを deviation_correction_logs に残す
-- - submit_to_manabi の個人記録はレビューキューとして集計するだけで、
--   公式値を自動更新しない
--
-- 初回 admin 登録手順（人間が SQL で実施）:
--   1) auth.identities で provider = 'line' に絞り、表示名・メール等で対象 user_id を確認する。
--      匿名ユーザー行や一覧の並び順だけで選ばないこと。
--   2) PIN はローカルの秘密保管ファイルから取得し、次の形で hash 化して保存する。
--        insert into public.admin_users (user_id, note, pin_hash)
--        values ('<confirmed-line-user-id>', 'owner', crypt('<PIN>', gen_salt('bf')))
--        on conflict (user_id) do update
--          set pin_hash = excluded.pin_hash,
--              note = excluded.note;
-- =====================================================================

begin;

create extension if not exists pgcrypto with schema extensions;

alter table public.admin_users
  add column if not exists pin_hash text;

revoke select on public.admin_users from anon, authenticated;
grant select (user_id, note, created_at) on public.admin_users to authenticated;
revoke select (pin_hash) on public.admin_users from anon, authenticated;
revoke insert, update, delete on public.admin_users from anon, authenticated;

create table if not exists public.deviation_correction_logs (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  department_id uuid not null references public.school_departments (id),
  changed_by uuid references auth.users (id) on delete set null,
  old_value integer,
  new_value integer not null,
  reason text not null,
  created_at timestamptz not null default now(),
  constraint deviation_correction_logs_new_value_range check (new_value between 20 and 80),
  constraint deviation_correction_logs_reason_len check (char_length(btrim(reason)) between 4 and 500)
);

create index if not exists deviation_correction_logs_dept_created_idx
  on public.deviation_correction_logs (department_id, created_at desc);

alter table public.deviation_correction_logs enable row level security;

drop policy if exists deviation_correction_logs_admin_select on public.deviation_correction_logs;
create policy deviation_correction_logs_admin_select on public.deviation_correction_logs
  for select to authenticated
  using (exists (select 1 from public.admin_users a where a.user_id = auth.uid()));

revoke insert, update, delete on public.deviation_correction_logs from anon, authenticated;
grant select on public.deviation_correction_logs to authenticated;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.admin_users
    where user_id = auth.uid()
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

create or replace function public.correct_school_deviation(
  p_department_id uuid,
  p_new_value integer,
  p_reason text,
  p_pin text
)
returns table (
  school_id uuid,
  department_id uuid,
  old_value integer,
  new_value integer,
  log_id uuid
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_pin_hash text;
  v_school_id uuid;
  v_old_value integer;
  v_value_id uuid;
  v_log_id uuid;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;

  select a.pin_hash into v_pin_hash
  from public.admin_users a
  where a.user_id = v_uid;

  if v_pin_hash is null or crypt(coalesce(p_pin, ''), v_pin_hash) <> v_pin_hash then
    raise exception 'admin pin verification failed';
  end if;

  if p_new_value is null or p_new_value < 20 or p_new_value > 80 then
    raise exception 'new deviation value must be between 20 and 80';
  end if;

  if char_length(v_reason) < 4 or char_length(v_reason) > 500 then
    raise exception 'reason must be between 4 and 500 characters';
  end if;

  select d.school_id into v_school_id
  from public.school_departments d
  where d.id = p_department_id;

  if v_school_id is null then
    raise exception 'department not found';
  end if;

  select sdv.id, sdv.value
    into v_value_id, v_old_value
  from public.school_deviation_values sdv
  where sdv.department_id = p_department_id
    and sdv.is_active = true
  for update;

  if v_value_id is null then
    insert into public.school_deviation_values (
      school_id, department_id, value, year, source_type, estimate_method, note, is_active
    )
    values (
      v_school_id, p_department_id, p_new_value, extract(year from now())::integer,
      'manabi_estimate', 'admin_override_v1', v_reason, true
    );
  else
    update public.school_deviation_values
    set value = p_new_value,
        note = v_reason,
        updated_at = now()
    where id = v_value_id;
  end if;

  insert into public.deviation_correction_logs (
    school_id, department_id, changed_by, old_value, new_value, reason
  )
  values (v_school_id, p_department_id, v_uid, v_old_value, p_new_value, v_reason)
  returning id into v_log_id;

  return query select v_school_id, p_department_id, v_old_value, p_new_value, v_log_id;
end;
$$;

revoke all on function public.correct_school_deviation(uuid, integer, text, text) from public;
grant execute on function public.correct_school_deviation(uuid, integer, text, text) to authenticated;

create or replace function public.get_deviation_review_queue(
  p_school_id uuid default null,
  p_threshold integer default 5
)
returns table (
  school_id uuid,
  school_name text,
  department_id uuid,
  department_name text,
  official_value integer,
  submission_count integer,
  avg_value numeric,
  median_value numeric,
  min_value integer,
  max_value integer,
  latest_submission_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_threshold integer := greatest(coalesce(p_threshold, 5), 1);
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;

  if not exists (select 1 from public.admin_users a where a.user_id = v_uid) then
    raise exception 'admin required';
  end if;

  return query
    select
      s.id as school_id,
      s.name as school_name,
      d.id as department_id,
      d.name as department_name,
      active_sdv.value as official_value,
      count(distinct usd.user_id)::integer as submission_count,
      round(avg(usd.value)::numeric, 1) as avg_value,
      percentile_cont(0.5) within group (order by usd.value)::numeric as median_value,
      min(usd.value)::integer as min_value,
      max(usd.value)::integer as max_value,
      max(usd.updated_at) as latest_submission_at
    from public.user_school_deviations usd
    join public.school_departments d on d.id = usd.department_id
    join public.schools s on s.id = d.school_id
    left join lateral (
      select sdv.value
      from public.school_deviation_values sdv
      where sdv.department_id = d.id
        and sdv.is_active = true
      limit 1
    ) active_sdv on true
    where usd.visibility = 'submit_to_manabi'
      and usd.department_id is not null
      and (p_school_id is null or s.id = p_school_id)
    group by s.id, s.name, d.id, d.name, active_sdv.value
    having count(distinct usd.user_id) >= v_threshold
    order by count(distinct usd.user_id) desc, max(usd.updated_at) desc;
end;
$$;

revoke all on function public.get_deviation_review_queue(uuid, integer) from public;
grant execute on function public.get_deviation_review_queue(uuid, integer) to authenticated;

commit;
