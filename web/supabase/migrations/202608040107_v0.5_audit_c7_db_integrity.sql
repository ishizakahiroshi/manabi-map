-- v0.5 audit C7: DB 制約・status trigger・管理者補正・seed 再投入を是正する。
-- 本番適用前に、下記の重複/保護対象確認クエリを作者が実行すること。
--
-- rollback（適用を取り消す場合・適用と逆順に 1 transaction で実行）:
--   -- 0. 事前確認: C7 直前の状態を決める（202608040103 の適用有無）
--   --    select to_regclass('public.admin_pin_attempts');
--   --    非 NULL（= 103 適用済み）: 手順 1 をそのまま使う。
--   --    NULL（= 103 未適用）: 手順 1 の本体だけを baseline_schema.sql:135-207 の
--   --    （admin_pin_attempts を参照しない）本体に差し替える。そのまま流すと実行時に
--   --    relation "admin_pin_attempts" does not exist で RPC が壊れる。
--   begin;
--   -- 1. correct_school_deviation を C7 直前＝202608040103（F20 ロックアウト版）の本体へ戻す
--   --    ※ baseline_schema.sql の本体を使ってはいけない。F20 の PIN ロックアウトまで巻き戻る。
--   create or replace function public.correct_school_deviation(
--     p_department_id uuid,
--     p_new_value integer,
--     p_reason text,
--     p_pin text
--   )
--   returns table (
--     school_id uuid,
--     department_id uuid,
--     old_value integer,
--     new_value integer,
--     log_id uuid
--   )
--   language plpgsql
--   security definer
--   set search_path = public, extensions, pg_temp
--   as $$
--   declare
--     v_uid uuid := auth.uid();
--     v_pin_hash text;
--     v_school_id uuid;
--     v_old_value integer;
--     v_value_id uuid;
--     v_log_id uuid;
--     v_reason text := btrim(coalesce(p_reason, ''));
--     v_locked_until timestamptz;
--     v_failed_attempts integer;
--   begin
--     if v_uid is null then
--       raise exception 'authentication required';
--     end if;
--
--     select failed_attempts, locked_until
--       into v_failed_attempts, v_locked_until
--     from public.admin_pin_attempts
--     where user_id = v_uid
--     for update;
--
--     if v_locked_until is not null and v_locked_until > now() then
--       return;
--     end if;
--
--     select a.pin_hash into v_pin_hash
--     from public.admin_users a
--     where a.user_id = v_uid;
--
--     if v_pin_hash is null or crypt(coalesce(p_pin, ''), v_pin_hash) <> v_pin_hash then
--       insert into public.admin_pin_attempts (user_id, failed_attempts, locked_until, updated_at)
--       values (v_uid, 1, null, now())
--       on conflict (user_id) do update
--       set failed_attempts = public.admin_pin_attempts.failed_attempts + 1,
--           locked_until = case
--             when public.admin_pin_attempts.failed_attempts + 1 >= 5 then now() + interval '15 minutes'
--             else null
--           end,
--           updated_at = now();
--       return;
--     end if;
--
--     delete from public.admin_pin_attempts where user_id = v_uid;
--
--     if p_new_value is null or p_new_value < 20 or p_new_value > 80 then
--       raise exception 'new deviation value must be between 20 and 80';
--     end if;
--     if char_length(v_reason) < 4 or char_length(v_reason) > 500 then
--       raise exception 'reason must be between 4 and 500 characters';
--     end if;
--
--     select d.school_id into v_school_id
--     from public.school_departments d
--     where d.id = p_department_id;
--     if v_school_id is null then
--       raise exception 'department not found';
--     end if;
--
--     select sdv.id, sdv.value into v_value_id, v_old_value
--     from public.school_deviation_values sdv
--     where sdv.department_id = p_department_id and sdv.is_active = true
--     for update;
--
--     if v_value_id is null then
--       insert into public.school_deviation_values (
--         school_id, department_id, value, year, source_type, estimate_method, note, is_active
--       ) values (
--         v_school_id, p_department_id, p_new_value, extract(year from now())::integer,
--         'manabi_estimate', 'admin_override_v1', v_reason, true
--       );
--     else
--       update public.school_deviation_values
--       set value = p_new_value, note = v_reason, updated_at = now()
--       where id = v_value_id;
--     end if;
--
--     insert into public.deviation_correction_logs (
--       school_id, department_id, changed_by, old_value, new_value, reason
--     ) values (v_school_id, p_department_id, v_uid, v_old_value, p_new_value, v_reason)
--     returning id into v_log_id;
--
--     return query select v_school_id, p_department_id, v_old_value, p_new_value, v_log_id;
--   end;
--   $$;
--   -- 2. sync_school_status_compatibility を baseline_schema.sql:661-691 の本体へ戻す
--   --    （101〜106 はこの関数を触っていないため baseline = C7 直前の状態）
--   create or replace function public.sync_school_status_compatibility()
--   returns trigger
--   language plpgsql
--   set search_path = public
--   as $$
--   declare
--     lifecycle_active boolean;
--     lifecycle_forces_not_recruiting boolean;
--     recruitment_active boolean;
--   begin
--     select is_map_active, forces_not_recruiting
--       into strict lifecycle_active, lifecycle_forces_not_recruiting
--       from school_lifecycle_status_master
--      where code = new.lifecycle_status_code;
--
--     select is_recruiting_compat
--       into strict recruitment_active
--       from school_recruitment_status_master
--      where code = new.recruitment_status_code;
--
--     if lifecycle_forces_not_recruiting and recruitment_active then
--       raise exception 'lifecycle status % cannot be recruiting', new.lifecycle_status_code;
--     end if;
--     if new.lifecycle_status_code = 'closing' and recruitment_active then
--       raise exception 'closing school cannot have recruitment_status_code=recruiting';
--     end if;
--
--     new.is_active := lifecycle_active;
--     new.is_recruiting := recruitment_active;
--     return new;
--   end;
--   $$;
--   -- 3. capacity 非 NULL を明示する前の CHECK 定義へ戻す
--   --    （行数が多くロック時間を切りたい場合は not valid 付きで add → 別途 validate に分割してよい。
--   --      新定義を満たす既存行は旧定義も必ず満たすので validate は確実に通る）
--   alter table public.school_admission_selection_stats
--     drop constraint if exists school_admission_selection_stats_comparable_requires_counts;
--   alter table public.school_admission_selection_stats
--     add constraint school_admission_selection_stats_comparable_requires_counts
--     check (not is_ratio_comparable or (capacity > 0 and applicants is not null));
--   -- 4. 本 migration で新設した部分 unique index を drop（baseline の sdv_active_per_dept は残す）
--   drop index if exists public.school_deviation_values_one_active_per_dept;
--   commit;
--   （trigger schools_status_compatibility_sync は baseline と同一定義のため再作成不要。関数は create or replace で戻すので ACL も baseline のまま保持される。drop function 経由で作り直した場合のみ手動で戻すこと）
--   （手順 3 は制約の弱体化。capacity is null で is_ratio_comparable=true の行が再び挿入可能になる。既存データは失われない）
--   （手順 4 の後は「学科あたり active な偏差値行 1 本」の保証が消える。baseline の sdv_active_per_dept (school_id, department_id) は残るため、非正規化の school_id が department の実所属とずれて書かれた場合に限り重複 active 行が作れる）
--   （戻るのは定義のみでデータは戻らない。適用後に管理者補正で書き換えた school_deviation_values.value / note / estimate_method / estimate_basis='admin_override' と deviation_correction_logs の行はそのまま残る。旧値は logs.old_value に残るが自動復元 SQL は無いので、必要なら適用前 backup から戻すこと）
--   （rollback 後は本ファイル末尾の do $$ アサーションが必ず失敗する（意図どおり）。C7 を再適用するまでこのファイルを再実行しないこと）

begin;

-- 適用前確認（0 件であること）:
-- select department_id
--   from public.school_deviation_values
--  where is_active
--  group by department_id
-- having count(*) > 1;
create unique index if not exists school_deviation_values_one_active_per_dept
  on public.school_deviation_values (department_id)
  where is_active;

-- PostgreSQL の CHECK は NULL を合格させるため、capacity の非 NULL を明示する。
alter table public.school_admission_selection_stats
  drop constraint if exists school_admission_selection_stats_comparable_requires_counts;
alter table public.school_admission_selection_stats
  add constraint school_admission_selection_stats_comparable_requires_counts
  check (
    not is_ratio_comparable
    or (capacity is not null and capacity > 0 and applicants is not null)
  ) not valid;
alter table public.school_admission_selection_stats
  validate constraint school_admission_selection_stats_comparable_requires_counts;

-- INSERT 時に boolean を黙ってコード由来の値へ上書きしない。
create or replace function public.sync_school_status_compatibility()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  lifecycle_active boolean;
  lifecycle_forces_not_recruiting boolean;
  recruitment_active boolean;
begin
  select is_map_active, forces_not_recruiting
    into strict lifecycle_active, lifecycle_forces_not_recruiting
    from public.school_lifecycle_status_master
   where code = new.lifecycle_status_code;

  select is_recruiting_compat
    into strict recruitment_active
    from public.school_recruitment_status_master
   where code = new.recruitment_status_code;

  if lifecycle_forces_not_recruiting and recruitment_active then
    raise exception 'lifecycle status % cannot be recruiting', new.lifecycle_status_code;
  end if;
  if new.lifecycle_status_code = 'closing' and recruitment_active then
    raise exception 'closing school cannot have recruitment_status_code=recruiting';
  end if;

  if tg_op = 'INSERT'
     and (
       new.is_active is distinct from lifecycle_active
       or new.is_recruiting is distinct from recruitment_active
     )
     and (new.is_active is not null or new.is_recruiting is not null) then
    raise exception
      'is_active/is_recruiting が lifecycle/recruitment コードと矛盾 (school=%)',
      new.name;
  end if;

  new.is_active := lifecycle_active;
  new.is_recruiting := recruitment_active;
  return new;
end;
$$;

drop trigger if exists schools_status_compatibility_sync on public.schools;
create trigger schools_status_compatibility_sync
before insert or update of lifecycle_status_code, recruitment_status_code on public.schools
for each row execute function public.sync_school_status_compatibility();

-- C3 SEC-ADMIN-05 もここへ集約し、PIN 失敗記録より前に管理者所属を確認する。
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

  if not exists (select 1 from public.admin_users a where a.user_id = v_uid) then
    raise exception 'not authorized';
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

  select sdv.id, sdv.value
    into v_value_id, v_old_value
  from public.school_deviation_values sdv
  where sdv.department_id = p_department_id
    and sdv.is_active = true
  for update;

  if v_value_id is null then
    insert into public.school_deviation_values (
      school_id, department_id, value, year, source_type,
      estimate_method, estimate_basis, note, is_active
    ) values (
      v_school_id,
      p_department_id,
      p_new_value,
      extract(year from (now() at time zone 'Asia/Tokyo'))::integer,
      'manabi_estimate',
      'admin_override_v1',
      'admin_override',
      v_reason,
      true
    );
  else
    update public.school_deviation_values
    set value = p_new_value,
        note = v_reason,
        estimate_method = 'admin_override_v1',
        estimate_basis = 'admin_override',
        updated_at = now()
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
declare
  v_trigger_source text;
  v_rpc_source text;
begin
  select p.prosrc into v_trigger_source
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'sync_school_status_compatibility';
  select p.prosrc into v_rpc_source
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'correct_school_deviation';

  if v_trigger_source is null
     or position('tg_op = ''INSERT''' in v_trigger_source) = 0
     or position('is distinct from lifecycle_active' in v_trigger_source) = 0 then
    raise exception 'C7 assert failed: school status INSERT contradiction guard is missing';
  end if;
  if v_rpc_source is null
     or position('not authorized' in v_rpc_source) = 0
     or position('estimate_basis = ''admin_override''' in v_rpc_source) = 0
     or position('Asia/Tokyo' in v_rpc_source) = 0 then
    raise exception 'C7 assert failed: correct_school_deviation hardening is incomplete';
  end if;
  if not exists (
    select 1 from pg_index i
    join pg_class c on c.oid = i.indexrelid
    where c.relname = 'school_deviation_values_one_active_per_dept'
      and i.indpred is not null
  ) then
    raise exception 'C7 assert failed: active deviation uniqueness index is missing';
  end if;
end;
$$;

commit;
