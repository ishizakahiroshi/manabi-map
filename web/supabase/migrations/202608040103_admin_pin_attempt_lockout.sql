-- F20: admin PIN の連続失敗を 5 回・15 分で一時ロックする。
-- correct_school_deviation は失敗時に 0 行を返すため、失敗記録を transaction 内で確実に残せる。
-- フロントは migration 適用時に 0 行レスポンスを失敗として扱う実装へ更新すること。

begin;

create table if not exists public.admin_pin_attempts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.admin_pin_attempts enable row level security;
revoke all on public.admin_pin_attempts from anon, authenticated;

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
  v_locked_until timestamptz;
  v_failed_attempts integer;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;

  select failed_attempts, locked_until
    into v_failed_attempts, v_locked_until
  from public.admin_pin_attempts
  where user_id = v_uid
  for update;

  if v_locked_until is not null and v_locked_until > now() then
    return;
  end if;

  select a.pin_hash into v_pin_hash
  from public.admin_users a
  where a.user_id = v_uid;

  if v_pin_hash is null or crypt(coalesce(p_pin, ''), v_pin_hash) <> v_pin_hash then
    insert into public.admin_pin_attempts (user_id, failed_attempts, locked_until, updated_at)
    values (v_uid, 1, null, now())
    on conflict (user_id) do update
    set failed_attempts = public.admin_pin_attempts.failed_attempts + 1,
        locked_until = case
          when public.admin_pin_attempts.failed_attempts + 1 >= 5 then now() + interval '15 minutes'
          else null
        end,
        updated_at = now();
    return;
  end if;

  delete from public.admin_pin_attempts where user_id = v_uid;

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

  select sdv.id, sdv.value into v_value_id, v_old_value
  from public.school_deviation_values sdv
  where sdv.department_id = p_department_id and sdv.is_active = true
  for update;

  if v_value_id is null then
    insert into public.school_deviation_values (
      school_id, department_id, value, year, source_type, estimate_method, note, is_active
    ) values (
      v_school_id, p_department_id, p_new_value, extract(year from now())::integer,
      'manabi_estimate', 'admin_override_v1', v_reason, true
    );
  else
    update public.school_deviation_values
    set value = p_new_value, note = v_reason, updated_at = now()
    where id = v_value_id;
  end if;

  insert into public.deviation_correction_logs (
    school_id, department_id, changed_by, old_value, new_value, reason
  ) values (v_school_id, p_department_id, v_uid, v_old_value, p_new_value, v_reason)
  returning id into v_log_id;

  return query select v_school_id, p_department_id, v_old_value, p_new_value, v_log_id;
end;
$$;

revoke all on function public.correct_school_deviation(uuid, integer, text, text) from public;
grant execute on function public.correct_school_deviation(uuid, integer, text, text) to authenticated;

do $$
begin
  if to_regclass('public.admin_pin_attempts') is null then
    raise exception 'F20 assert failed: admin_pin_attempts is missing';
  end if;
end;
$$;

commit;
