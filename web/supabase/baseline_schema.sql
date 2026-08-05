-- ============================================================================
-- baseline_schema.sql
--
-- 本番 Supabase（public スキーマ）の完全スナップショット。2026-08-05 に
-- pg_dump --schema-only --no-owner -n public で取得（データ・接続情報は含まない）。
--
-- 目的（監査 SEC-RLS-01 / MNT-RPLY-08 の是正）:
--   - RLS・SECURITY DEFINER 関数・制約・テーブル定義を repo でレビューできるようにする
--     （従来は本番 DB 内にしか無く、コードからは確認できなかった）。
--   - 災害復旧 / 検証環境を新規構築するときの土台にする。
--
-- 運用:
--   - これは参照・DR 用の宣言的スナップショットであり、`supabase db push` の対象外
--     （migrations/ の外に置く）。既存本番には適用しない（既に全て存在する）。
--   - fresh な Supabase を作るときは、これを最初に psql で適用してから、
--     以後の差分 migration（web/supabase/migrations/）を順に流す。既存 migration との
--     完全統合（squash）は別途 pending（docs/local）。
--   - DB を変更するときは従来どおり migrations/ に新規 SQL を足し、節目でこの
--     スナップショットを取り直す。
-- ============================================================================


--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: school_campus_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.school_campus_type AS ENUM (
    'main',
    'partner_school',
    'satellite_campus',
    'support_school'
);


--
-- Name: school_course_time; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.school_course_time AS ENUM (
    'fulltime',
    'parttime',
    'correspondence'
);


--
-- Name: accept_family_invite(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.accept_family_invite(p_token uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_uid uuid := auth.uid();
  v_group_id uuid;
  v_status text;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;

  select group_id, status into v_group_id, v_status
  from family_members
  where invite_token = p_token
  for update;

  if v_group_id is null then
    raise exception 'invalid invitation';
  end if;

  -- 既に同じグループのメンバーなら、余分な招待行は消して既存メンバーシップを返す
  if exists (
    select 1 from family_members
    where group_id = v_group_id and user_id = v_uid
  ) then
    delete from family_members
    where invite_token = p_token and status = 'invited' and user_id is null;
    return v_group_id;
  end if;

  if v_status <> 'invited' then
    raise exception 'invitation already used';
  end if;

  update family_members
  set user_id = v_uid,
      status = 'active',
      accepted_at = now()
  where invite_token = p_token;

  return v_group_id;
end;
$$;


--
-- Name: correct_school_deviation(uuid, integer, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.correct_school_deviation(p_department_id uuid, p_new_value integer, p_reason text, p_pin text) RETURNS TABLE(school_id uuid, department_id uuid, old_value integer, new_value integer, log_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
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


--
-- Name: create_family_group(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_family_group(p_name text DEFAULT '家族'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_uid uuid := auth.uid();
  v_group_id uuid;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;

  insert into family_groups (owner_id, name)
  values (v_uid, coalesce(nullif(btrim(p_name), ''), '家族'))
  returning id into v_group_id;

  insert into family_members (group_id, user_id, role, status, accepted_at)
  values (v_group_id, v_uid, 'owner', 'active', now());

  return v_group_id;
end;
$$;


--
-- Name: create_family_invite(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_family_invite(p_group_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_uid uuid := auth.uid();
  v_token uuid;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if not exists (
    select 1 from family_groups g where g.id = p_group_id and g.owner_id = v_uid
  ) then
    raise exception 'only the group owner can invite';
  end if;

  insert into family_members (group_id, role, status)
  values (p_group_id, 'member', 'invited')
  returning invite_token into v_token;

  return v_token;
end;
$$;


--
-- Name: dash_app_counts(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.dash_app_counts() RETURNS TABLE(users_total bigint, users_line bigint, users_anon bigint, favorites_total bigint, notes_total bigint, home_points_total bigint)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select
    (select count(*) from auth.users),
    (
      select count(distinct i.user_id)
      from auth.identities i
      where i.provider in ('line', 'custom:line')
    ),
    (select count(*) from auth.users where coalesce(is_anonymous, false)),
    (select count(*) from public.user_school_favorites),
    (select count(*) from public.user_school_notes),
    (select count(*) from public.home_locations);
$$;


--
-- Name: delete_family_group(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_family_group(p_group_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if not exists (
    select 1 from family_groups g where g.id = p_group_id and g.owner_id = v_uid
  ) then
    raise exception 'only the group owner can delete the group';
  end if;

  delete from family_groups where id = p_group_id;
end;
$$;


--
-- Name: enforce_data_reports_rate_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_data_reports_rate_limit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: get_deviation_review_queue(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_deviation_review_queue(p_school_id uuid DEFAULT NULL::uuid, p_threshold integer DEFAULT 5) RETURNS TABLE(school_id uuid, school_name text, department_id uuid, department_name text, official_value integer, submission_count integer, avg_value numeric, median_value numeric, min_value integer, max_value integer, latest_submission_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: get_family_shared_favorites(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_family_shared_favorites(p_group_id uuid) RETURNS TABLE(owner_id uuid, school_id uuid, priority integer, status text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if not exists (
    select 1 from family_members
    where group_id = p_group_id and user_id = v_uid and status = 'active'
  ) then
    raise exception 'not a member of this group';
  end if;

  return query
    select f.user_id, f.school_id, f.priority::int, f.status::text
    from user_school_favorites f
    join family_members m
      on m.user_id = f.user_id
     and m.group_id = p_group_id
     and m.status = 'active'
     and m.share_favorites = true
    where f.user_id <> v_uid;
end;
$$;


--
-- Name: get_family_shared_notes(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_family_shared_notes(p_group_id uuid) RETURNS TABLE(owner_id uuid, school_id uuid, note text, commute_note text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if not exists (
    select 1 from family_members
    where group_id = p_group_id and user_id = v_uid and status = 'active'
  ) then
    raise exception 'not a member of this group';
  end if;

  return query
    select n.user_id, n.school_id, n.note::text, n.commute_note::text
    from user_school_notes n
    join family_members m
      on m.user_id = n.user_id
     and m.group_id = p_group_id
     and m.status = 'active'
     and m.share_notes = true
    where n.user_id <> v_uid;
end;
$$;


--
-- Name: is_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select exists (
    select 1
    from public.admin_users
    where user_id = auth.uid()
  );
$$;


--
-- Name: leave_family_group(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.leave_family_group(p_group_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_uid uuid := auth.uid();
  v_role text;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;

  select role into v_role
  from family_members
  where group_id = p_group_id and user_id = v_uid;

  if v_role is null then
    raise exception 'not a member of this group';
  end if;
  if v_role = 'owner' then
    raise exception 'owner cannot leave; delete the group instead';
  end if;

  delete from family_members
  where group_id = p_group_id and user_id = v_uid;
end;
$$;


--
-- Name: remove_family_member(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remove_family_member(p_member_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_uid uuid := auth.uid();
  v_group_id uuid;
  v_role text;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;

  select group_id, role into v_group_id, v_role
  from family_members
  where id = p_member_id;

  if v_group_id is null then
    raise exception 'member not found';
  end if;
  if not exists (
    select 1 from family_groups g where g.id = v_group_id and g.owner_id = v_uid
  ) then
    raise exception 'only the group owner can remove members';
  end if;
  if v_role = 'owner' then
    raise exception 'cannot remove the group owner';
  end if;

  delete from family_members where id = p_member_id;
end;
$$;


--
-- Name: rls_auto_enable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


--
-- Name: set_family_share(uuid, boolean, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_family_share(p_group_id uuid, p_share_favorites boolean, p_share_notes boolean) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;

  update family_members
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


--
-- Name: sync_dept_ui_group(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_dept_ui_group() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  select ui_group into new.ui_group
    from course_type_master
   where code = new.course_type;
  return new;
end;
$$;


--
-- Name: sync_master_ui_group(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_master_ui_group() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  update school_departments
     set ui_group = new.ui_group
   where course_type = new.code
     and (ui_group is distinct from new.ui_group);
  return new;
end;
$$;


--
-- Name: sync_school_status_compatibility(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_school_status_compatibility() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare
  lifecycle_active boolean;
  lifecycle_forces_not_recruiting boolean;
  recruitment_active boolean;
begin
  select is_map_active, forces_not_recruiting
    into strict lifecycle_active, lifecycle_forces_not_recruiting
    from school_lifecycle_status_master
   where code = new.lifecycle_status_code;

  select is_recruiting_compat
    into strict recruitment_active
    from school_recruitment_status_master
   where code = new.recruitment_status_code;

  if lifecycle_forces_not_recruiting and recruitment_active then
    raise exception 'lifecycle status % cannot be recruiting', new.lifecycle_status_code;
  end if;
  if new.lifecycle_status_code = 'closing' and recruitment_active then
    raise exception 'closing school cannot have recruitment_status_code=recruiting';
  end if;

  new.is_active := lifecycle_active;
  new.is_recruiting := recruitment_active;
  return new;
end;
$$;


--
-- Name: user_group_ids(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_group_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select group_id
  from family_members
  where user_id = auth.uid()
    and status = 'active';
$$;


--
-- Name: validate_admission_recruitment_unit_department(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_admission_recruitment_unit_department() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_unit_school_id uuid;
  v_department_school_id uuid;
begin
  select school_id into v_unit_school_id
    from public.admission_recruitment_units
   where id = new.unit_id;
  select school_id into v_department_school_id
    from public.school_departments
   where id = new.department_id;

  if v_unit_school_id is null or v_department_school_id is null then
    return new; -- existence は直後の FK 検査に委ねる。
  end if;
  if v_unit_school_id <> v_department_school_id then
    raise exception 'admission recruitment unit and department must belong to the same school';
  end if;
  return new;
end;
$$;


--
-- Name: validate_admission_recruitment_unit_school(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_admission_recruitment_unit_school() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if new.school_id is distinct from old.school_id and exists (
    select 1
      from public.admission_recruitment_unit_departments m
      join public.school_departments d on d.id = m.department_id
     where m.unit_id = new.id
       and d.school_id <> new.school_id
  ) then
    raise exception 'admission recruitment unit school conflicts with department membership';
  end if;
  return new;
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_users (
    user_id uuid NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    pin_hash text
);


--
-- Name: admission_exam_component_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admission_exam_component_master (
    code text NOT NULL,
    label_ja text NOT NULL,
    label_en text NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admission_exam_component_master_code_format CHECK ((code ~ '^[a-z][a-z0-9_]*$'::text)),
    CONSTRAINT admission_exam_component_master_labels_nonempty CHECK (((btrim(label_ja) <> ''::text) AND (btrim(label_en) <> ''::text)))
);


--
-- Name: TABLE admission_exam_component_master; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.admission_exam_component_master IS '検査要素の正規辞書';


--
-- Name: admission_map_role_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admission_map_role_master (
    code text NOT NULL,
    label_ja text NOT NULL,
    label_en text NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admission_map_role_master_code_format CHECK ((code ~ '^[a-z][a-z0-9_]*$'::text)),
    CONSTRAINT admission_map_role_master_labels_nonempty CHECK (((btrim(label_ja) <> ''::text) AND (btrim(label_en) <> ''::text)))
);


--
-- Name: TABLE admission_map_role_master; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.admission_map_role_master IS '地図集計での役割の正規辞書';


--
-- Name: admission_quality_reason_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admission_quality_reason_master (
    code text NOT NULL,
    label_ja text NOT NULL,
    label_en text NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admission_quality_reason_master_code_format CHECK ((code ~ '^[a-z][a-z0-9_]*$'::text)),
    CONSTRAINT admission_quality_reason_master_labels_nonempty CHECK (((btrim(label_ja) <> ''::text) AND (btrim(label_en) <> ''::text)))
);


--
-- Name: TABLE admission_quality_reason_master; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.admission_quality_reason_master IS '比較不能・注意理由の正規辞書';


--
-- Name: admission_recruitment_unit_departments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admission_recruitment_unit_departments (
    unit_id uuid NOT NULL,
    department_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE admission_recruitment_unit_departments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.admission_recruitment_unit_departments IS 'くくり募集・学科群を重複統計行にせず表す学科 membership';


--
-- Name: admission_recruitment_unit_kind_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admission_recruitment_unit_kind_master (
    code text NOT NULL,
    label_ja text NOT NULL,
    label_en text NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admission_recruitment_unit_kind_master_code_format CHECK ((code ~ '^[a-z][a-z0-9_]*$'::text)),
    CONSTRAINT admission_recruitment_unit_kind_master_labels_nonempty CHECK (((btrim(label_ja) <> ''::text) AND (btrim(label_en) <> ''::text)))
);


--
-- Name: TABLE admission_recruitment_unit_kind_master; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.admission_recruitment_unit_kind_master IS '募集単位種別の正規辞書';


--
-- Name: admission_recruitment_units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admission_recruitment_units (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    unit_key text NOT NULL,
    unit_kind_code text NOT NULL,
    label text NOT NULL,
    course_time public.school_course_time,
    valid_from_year integer,
    valid_to_year integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admission_recruitment_units_label_nonempty CHECK ((btrim(label) <> ''::text)),
    CONSTRAINT admission_recruitment_units_unit_key_nonempty CHECK ((btrim(unit_key) <> ''::text)),
    CONSTRAINT admission_recruitment_units_year_range CHECK ((((valid_from_year IS NULL) OR ((valid_from_year >= 2000) AND (valid_from_year <= 2100))) AND ((valid_to_year IS NULL) OR ((valid_to_year >= 2000) AND (valid_to_year <= 2100))) AND ((valid_from_year IS NULL) OR (valid_to_year IS NULL) OR (valid_to_year >= valid_from_year))))
);


--
-- Name: TABLE admission_recruitment_units; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.admission_recruitment_units IS '年度をまたいで追跡する学校別募集単位。unit_key は学校内で一意';


--
-- Name: COLUMN admission_recruitment_units.label; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.admission_recruitment_units.label IS '利用者表示用の募集単位名。県資料の原文ラベルは選抜統計側に保持する';


--
-- Name: admission_selection_stage_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admission_selection_stage_master (
    code text NOT NULL,
    label_ja text NOT NULL,
    label_en text NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admission_selection_stage_master_code_format CHECK ((code ~ '^[a-z][a-z0-9_]*$'::text)),
    CONSTRAINT admission_selection_stage_master_labels_nonempty CHECK (((btrim(label_ja) <> ''::text) AND (btrim(label_en) <> ''::text)))
);


--
-- Name: TABLE admission_selection_stage_master; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.admission_selection_stage_master IS '募集段階の正規辞書';


--
-- Name: admission_selection_track_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admission_selection_track_master (
    code text NOT NULL,
    label_ja text NOT NULL,
    label_en text NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admission_selection_track_master_code_format CHECK ((code ~ '^[a-z][a-z0-9_]*$'::text)),
    CONSTRAINT admission_selection_track_master_labels_nonempty CHECK (((btrim(label_ja) <> ''::text) AND (btrim(label_en) <> ''::text)))
);


--
-- Name: TABLE admission_selection_track_master; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.admission_selection_track_master IS '選抜区分の正規辞書';


--
-- Name: app_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_config (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);


--
-- Name: course_type_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.course_type_master (
    code text NOT NULL,
    label_ja text NOT NULL,
    label_en text NOT NULL,
    ui_group text,
    sort_order integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    mext_category text NOT NULL,
    mext_category_detail text,
    classification_source text DEFAULT 'MEXT学校基本調査 R6'::text,
    notes text,
    CONSTRAINT course_type_master_mext_category_check CHECK ((mext_category = ANY (ARRAY['普通'::text, '総合'::text, '農業'::text, '工業'::text, '商業'::text, '水産'::text, '家庭'::text, '看護'::text, '情報'::text, '福祉'::text, '理数'::text, '体育'::text, '音楽'::text, '美術'::text, '外国語'::text, '国際関係'::text, 'その他'::text]))),
    CONSTRAINT course_type_master_ui_group_check_v2 CHECK ((ui_group = ANY (ARRAY['general'::text, 'comprehensive'::text, 'sciences_langs'::text, 'arts_sports'::text, 'industrial'::text, 'informatics'::text, 'commercial'::text, 'agriculture_marine'::text, 'home_welfare_nursing'::text, 'other'::text])))
);


--
-- Name: TABLE course_type_master; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.course_type_master IS 'department course_type の正規辞書。ui_group は UI 6 カテゴリ絞込に使う。null = その他（UI 全選択時のみ表示）';


--
-- Name: dash_cf_dims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dash_cf_dims (
    snapshot_date date NOT NULL,
    dim_type text NOT NULL,
    dim_value text NOT NULL,
    visits integer NOT NULL
);


--
-- Name: dash_cf_referers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dash_cf_referers (
    snapshot_date date NOT NULL,
    referer text NOT NULL,
    visits integer NOT NULL
);


--
-- Name: dash_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dash_daily (
    snapshot_date date NOT NULL,
    gsc_clicks integer,
    gsc_impressions integer,
    gsc_avg_position numeric(6,2),
    sitemap_page_count integer,
    cf_visits integer,
    cf_pageviews integer,
    app_users_total integer,
    app_users_line integer,
    app_users_anon integer,
    favorites_total integer,
    notes_total integer,
    home_points_total integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dash_gsc_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dash_gsc_pages (
    snapshot_date date NOT NULL,
    page text NOT NULL,
    clicks integer NOT NULL,
    impressions integer NOT NULL,
    ctr numeric(6,4),
    "position" numeric(6,2)
);


--
-- Name: dash_gsc_queries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dash_gsc_queries (
    snapshot_date date NOT NULL,
    query text NOT NULL,
    clicks integer NOT NULL,
    impressions integer NOT NULL,
    ctr numeric(6,4),
    "position" numeric(6,2)
);


--
-- Name: data_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.data_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    department_id uuid,
    field text NOT NULL,
    proposed_value text NOT NULL,
    source text NOT NULL,
    comment text,
    reporter_user_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    reviewed_by uuid,
    CONSTRAINT data_reports_comment_len CHECK (((comment IS NULL) OR (char_length(comment) <= 2000))),
    CONSTRAINT data_reports_field_check CHECK ((field = ANY (ARRAY['capacity'::text, 'total_students'::text, 'male_ratio'::text, 'deviation'::text, 'other'::text]))),
    CONSTRAINT data_reports_proposed_value_len CHECK (((char_length(btrim(proposed_value)) >= 1) AND (char_length(btrim(proposed_value)) <= 2000))),
    CONSTRAINT data_reports_review_metadata_check CHECK ((((status = 'pending'::text) AND (reviewed_at IS NULL) AND (reviewed_by IS NULL)) OR ((status <> 'pending'::text) AND (reviewed_at IS NOT NULL)))),
    CONSTRAINT data_reports_source_len CHECK (((char_length(btrim(source)) >= 1) AND (char_length(btrim(source)) <= 2000))),
    CONSTRAINT data_reports_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'reviewed'::text, 'applied'::text, 'rejected'::text])))
);


--
-- Name: TABLE data_reports; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.data_reports IS '学校情報の提供・訂正報告。運営確認後にのみ公開データへ反映する';


--
-- Name: COLUMN data_reports.proposed_value; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.data_reports.proposed_value IS '利用者が提供した値。自動反映せず、運営が一次資料を確認する';


--
-- Name: COLUMN data_reports.reporter_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.data_reports.reporter_user_id IS '匿名認証を含む送信者 UUID。管理者以外には公開しない';


--
-- Name: deviation_correction_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deviation_correction_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    department_id uuid NOT NULL,
    changed_by uuid,
    old_value integer,
    new_value integer NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deviation_correction_logs_new_value_range CHECK (((new_value >= 20) AND (new_value <= 80))),
    CONSTRAINT deviation_correction_logs_reason_len CHECK (((char_length(btrim(reason)) >= 4) AND (char_length(btrim(reason)) <= 500)))
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_type text NOT NULL,
    user_id uuid,
    school_id uuid,
    props jsonb DEFAULT '{}'::jsonb NOT NULL,
    session_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT events_event_type_len CHECK (((char_length(event_type) >= 1) AND (char_length(event_type) <= 64))),
    CONSTRAINT events_props_size CHECK ((pg_column_size(props) <= 2048)),
    CONSTRAINT events_session_id_len CHECK (((session_id IS NULL) OR (char_length(session_id) <= 64)))
);


--
-- Name: events_summary_daily; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.events_summary_daily AS
 SELECT ((created_at AT TIME ZONE 'Asia/Tokyo'::text))::date AS day,
    event_type,
    count(*) AS event_count,
    count(DISTINCT session_id) AS unique_sessions,
    count(DISTINCT user_id) AS unique_users
   FROM public.events
  WHERE (EXISTS ( SELECT 1
           FROM public.admin_users a
          WHERE (a.user_id = auth.uid())))
  GROUP BY (((created_at AT TIME ZONE 'Asia/Tokyo'::text))::date), event_type;


--
-- Name: family_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.family_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    name text DEFAULT '家族'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT family_groups_name_len CHECK (((char_length(name) >= 1) AND (char_length(name) <= 40)))
);


--
-- Name: family_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.family_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    user_id uuid,
    role text DEFAULT 'member'::text NOT NULL,
    status text DEFAULT 'invited'::text NOT NULL,
    invite_token uuid DEFAULT gen_random_uuid() NOT NULL,
    share_favorites boolean DEFAULT true NOT NULL,
    share_notes boolean DEFAULT true NOT NULL,
    invited_at timestamp with time zone DEFAULT now() NOT NULL,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT family_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'member'::text]))),
    CONSTRAINT family_members_status_check CHECK ((status = ANY (ARRAY['invited'::text, 'active'::text])))
);


--
-- Name: home_locations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.home_locations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    label text DEFAULT '自宅'::text NOT NULL,
    address text NOT NULL,
    postal_code text,
    prefecture text,
    city text,
    latitude numeric(10,7) NOT NULL,
    longitude numeric(10,7) NOT NULL,
    is_primary boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: school_admission_selection_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_admission_selection_stats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recruitment_unit_id uuid NOT NULL,
    year integer NOT NULL,
    selection_stage_code text NOT NULL,
    selection_track_code text NOT NULL,
    stage_label_raw text NOT NULL,
    track_label_raw text NOT NULL,
    selection_scope_raw text NOT NULL,
    population_scope_raw text,
    scope_key text NOT NULL,
    map_role_code text NOT NULL,
    is_ratio_comparable boolean DEFAULT false NOT NULL,
    capacity integer,
    applicants integer,
    examinees integer,
    admitted integer,
    exam_scope_raw text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT school_admission_selection_stats_comparable_requires_counts CHECK (((NOT is_ratio_comparable) OR ((capacity > 0) AND (applicants IS NOT NULL)))),
    CONSTRAINT school_admission_selection_stats_counts_nonnegative CHECK ((((capacity IS NULL) OR (capacity >= 0)) AND ((applicants IS NULL) OR (applicants >= 0)) AND ((examinees IS NULL) OR (examinees >= 0)) AND ((admitted IS NULL) OR (admitted >= 0)))),
    CONSTRAINT school_admission_selection_stats_primary_total_valid CHECK (((map_role_code <> 'primary_total'::text) OR ((selection_stage_code = 'primary'::text) AND is_ratio_comparable))),
    CONSTRAINT school_admission_selection_stats_raw_labels_nonempty CHECK (((btrim(stage_label_raw) <> ''::text) AND (btrim(track_label_raw) <> ''::text) AND (btrim(selection_scope_raw) <> ''::text))),
    CONSTRAINT school_admission_selection_stats_scope_key_nonempty CHECK ((btrim(scope_key) <> ''::text)),
    CONSTRAINT school_admission_selection_stats_year_range CHECK (((year >= 2000) AND (year <= 2100)))
);


--
-- Name: TABLE school_admission_selection_stats; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.school_admission_selection_stats IS '募集単位・年度・段階・区分・scope別の公式選抜統計。倍率は保存せず capacity/applicants から表示時に算出する';


--
-- Name: COLUMN school_admission_selection_stats.stage_label_raw; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.school_admission_selection_stats.stage_label_raw IS '県公表資料に記載された募集段階の原文。正規分類は selection_stage_code';


--
-- Name: COLUMN school_admission_selection_stats.track_label_raw; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.school_admission_selection_stats.track_label_raw IS '県公表資料に記載された選抜区分の原文。正規分類は selection_track_code';


--
-- Name: COLUMN school_admission_selection_stats.is_ratio_comparable; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.school_admission_selection_stats.is_ratio_comparable IS '募集人数と志願者数の母集団・募集単位が一致し、倍率比較に使える場合のみ true';


--
-- Name: school_admission_stat_exam_components; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_admission_stat_exam_components (
    stat_id uuid NOT NULL,
    component_code text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE school_admission_stat_exam_components; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.school_admission_stat_exam_components IS '選抜統計に紐づく学力検査・面接等の検査要素';


--
-- Name: school_admission_stat_legacy_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_admission_stat_legacy_links (
    stat_id uuid NOT NULL,
    legacy_stat_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE school_admission_stat_legacy_links; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.school_admission_stat_legacy_links IS '旧 school_admission_stats と新統計の多対多対応。旧表自体は変更しない';


--
-- Name: school_admission_stat_quality_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_admission_stat_quality_flags (
    stat_id uuid NOT NULL,
    metric_code text,
    reason_code text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT school_admission_stat_quality_flags_metric_code CHECK (((metric_code IS NULL) OR (metric_code = ANY (ARRAY['capacity'::text, 'applicants'::text, 'examinees'::text, 'admitted'::text, 'selection_rule'::text, 'exam_method'::text])))),
    CONSTRAINT school_admission_stat_quality_flags_note_nonempty CHECK (((note IS NULL) OR (btrim(note) <> ''::text)))
);


--
-- Name: TABLE school_admission_stat_quality_flags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.school_admission_stat_quality_flags IS '比較不能・要注意理由。metric_code=null は行全体へのフラグ';


--
-- Name: school_admission_stat_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_admission_stat_sources (
    stat_id uuid NOT NULL,
    fact_kind_code text NOT NULL,
    official_url text NOT NULL,
    doc_title text NOT NULL,
    published_at date,
    source_page_or_table text,
    quoted_evidence text,
    last_verified_at timestamp with time zone,
    last_http_status integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT school_admission_stat_sources_doc_title_nonempty CHECK ((btrim(doc_title) <> ''::text)),
    CONSTRAINT school_admission_stat_sources_evidence_length CHECK (((quoted_evidence IS NULL) OR (char_length(quoted_evidence) <= 80))),
    CONSTRAINT school_admission_stat_sources_evidence_nonempty CHECK (((quoted_evidence IS NULL) OR (btrim(quoted_evidence) <> ''::text))),
    CONSTRAINT school_admission_stat_sources_fact_kind_code CHECK ((fact_kind_code = ANY (ARRAY['capacity'::text, 'applicants'::text, 'examinees'::text, 'admitted'::text, 'selection_rule'::text, 'exam_method'::text]))),
    CONSTRAINT school_admission_stat_sources_http_status_range CHECK (((last_http_status IS NULL) OR ((last_http_status >= 100) AND (last_http_status <= 599)))),
    CONSTRAINT school_admission_stat_sources_official_url_http CHECK ((official_url ~* '^https?://[^[:space:]]+$'::text)),
    CONSTRAINT school_admission_stat_sources_page_nonempty CHECK (((source_page_or_table IS NULL) OR (btrim(source_page_or_table) <> ''::text))),
    CONSTRAINT school_admission_stat_sources_verification_pair CHECK ((((last_http_status IS NULL) AND (last_verified_at IS NULL)) OR ((last_http_status IS NOT NULL) AND (last_verified_at IS NOT NULL))))
);


--
-- Name: TABLE school_admission_stat_sources; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.school_admission_stat_sources IS 'capacity等の指標ごとの公式出典。404も削除せず到達状態を保持する';


--
-- Name: school_admission_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_admission_stats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    department_id uuid,
    year integer NOT NULL,
    capacity integer,
    applicants integer,
    examinees integer,
    admitted integer,
    note text,
    source_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT school_admission_stats_admitted_check CHECK ((admitted >= 0)),
    CONSTRAINT school_admission_stats_applicants_check CHECK ((applicants >= 0)),
    CONSTRAINT school_admission_stats_capacity_check CHECK ((capacity >= 0)),
    CONSTRAINT school_admission_stats_examinees_check CHECK ((examinees >= 0)),
    CONSTRAINT school_admission_stats_year_check CHECK (((year >= 2000) AND (year <= 2100)))
);


--
-- Name: TABLE school_admission_stats; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.school_admission_stats IS '学校・学科・年度別の入試実績（募集/志願/受検/合格）。公的資料の転記のみ・推計値や商用サイト由来の数値は入れない';


--
-- Name: school_departments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_departments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    name text NOT NULL,
    course_type text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ui_group text,
    record_key text DEFAULT ('department-'::text || (gen_random_uuid())::text) NOT NULL,
    CONSTRAINT school_departments_ui_group_check CHECK (((ui_group IS NULL) OR (ui_group = ANY (ARRAY['general'::text, 'comprehensive'::text, 'sciences_langs'::text, 'arts_sports'::text, 'industrial'::text, 'informatics'::text, 'commercial'::text, 'agriculture_marine'::text, 'home_welfare_nursing'::text, 'other'::text]))))
);


--
-- Name: COLUMN school_departments.record_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.school_departments.record_key IS 'Stable name-independent department identity used by audited import bundles.';


--
-- Name: school_deviation_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_deviation_values (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    department_id uuid,
    value integer NOT NULL,
    year integer NOT NULL,
    source_type text DEFAULT 'manabi_estimate'::text NOT NULL,
    estimate_method text,
    note text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    estimate_basis text,
    CONSTRAINT school_deviation_values_estimate_basis_check CHECK (((estimate_basis IS NULL) OR (estimate_basis = ANY (ARRAY['official_exam_distribution'::text, 'licensed_assessment'::text, 'human_anchor_review'::text, 'admin_override'::text, 'application_ratio_legacy'::text, 'editorial_unverified'::text])))),
    CONSTRAINT school_deviation_values_legacy_basis_inactive_check CHECK ((NOT ((estimate_basis = 'application_ratio_legacy'::text) AND (is_active = true)))),
    CONSTRAINT school_deviation_values_source_type_check CHECK ((source_type = ANY (ARRAY['manabi_estimate'::text, 'official'::text, 'user_estimate'::text])))
);


--
-- Name: COLUMN school_deviation_values.estimate_basis; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.school_deviation_values.estimate_basis IS '偏差値値の根拠区分。editorial_unverified は未検証の編集推計、application_ratio_legacy は履歴専用で active 不可。NULL は分類未完了の既存値を表す。';


--
-- Name: school_lifecycle_status_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_lifecycle_status_master (
    code text NOT NULL,
    label_ja text NOT NULL,
    label_en text NOT NULL,
    is_map_active boolean NOT NULL,
    forces_not_recruiting boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT school_lifecycle_status_master_code_nonempty CHECK ((btrim(code) <> ''::text))
);


--
-- Name: school_name_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_name_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    school_id uuid NOT NULL,
    name text NOT NULL,
    name_kana text,
    valid_from date,
    valid_to date,
    official_url text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT school_name_history_date_order CHECK (((valid_from IS NULL) OR (valid_to IS NULL) OR (valid_to >= valid_from))),
    CONSTRAINT school_name_history_name_nonempty CHECK ((btrim(name) <> ''::text)),
    CONSTRAINT school_name_history_official_url_http CHECK ((official_url ~ '^https?://'::text))
);


--
-- Name: TABLE school_name_history; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.school_name_history IS 'Name history for the same legal school identity; not a substitute for succession.';


--
-- Name: school_recruitment_status_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_recruitment_status_master (
    code text NOT NULL,
    label_ja text NOT NULL,
    label_en text NOT NULL,
    is_recruiting_compat boolean NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT school_recruitment_status_master_code_nonempty CHECK ((btrim(code) <> ''::text))
);


--
-- Name: school_relationship_type_master; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_relationship_type_master (
    code text NOT NULL,
    label_ja text NOT NULL,
    label_en text NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT school_relationship_type_master_code_nonempty CHECK ((btrim(code) <> ''::text))
);


--
-- Name: school_relationships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.school_relationships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    predecessor_school_id uuid NOT NULL,
    successor_school_id uuid NOT NULL,
    relationship_type_code text NOT NULL,
    effective_on date,
    official_url text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    effective_admission_year integer,
    evidence_status text NOT NULL,
    CONSTRAINT school_relationships_effective_admission_year_range CHECK (((effective_admission_year IS NULL) OR ((effective_admission_year >= 1900) AND (effective_admission_year <= 2100)))),
    CONSTRAINT school_relationships_effective_boundary_required CHECK (((effective_on IS NOT NULL) OR (effective_admission_year IS NOT NULL))),
    CONSTRAINT school_relationships_evidence_status_check CHECK ((evidence_status = ANY (ARRAY['official_confirmed'::text, 'official_partial'::text, 'unresolved'::text]))),
    CONSTRAINT school_relationships_no_self_link CHECK ((predecessor_school_id <> successor_school_id)),
    CONSTRAINT school_relationships_official_url_http CHECK ((official_url ~ '^https?://'::text))
);


--
-- Name: TABLE school_relationships; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.school_relationships IS 'Directed legal-school predecessor/successor relationships.';


--
-- Name: COLUMN school_relationships.effective_admission_year; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.school_relationships.effective_admission_year IS 'Admission-year boundary used to assign historical facts to legal school identities.';


--
-- Name: COLUMN school_relationships.evidence_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.school_relationships.evidence_status IS 'Official evidence completeness: official_confirmed, official_partial, or unresolved.';


--
-- Name: schools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schools (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    name_kana text,
    type text DEFAULT 'high_school'::text NOT NULL,
    ownership text NOT NULL,
    gender_type text DEFAULT 'coed'::text NOT NULL,
    is_integrated boolean DEFAULT false NOT NULL,
    postal_code text,
    prefecture text NOT NULL,
    city text,
    address text NOT NULL,
    latitude numeric(10,7),
    longitude numeric(10,7),
    official_url text,
    is_active boolean DEFAULT true NOT NULL,
    is_recruiting boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    course_times public.school_course_time[] DEFAULT ARRAY['fulltime'::public.school_course_time] NOT NULL,
    main_school_name text,
    campus_type public.school_campus_type DEFAULT 'main'::public.school_campus_type NOT NULL,
    total_students integer,
    enrollment_year integer,
    male_ratio integer,
    record_key text DEFAULT ('school-'::text || (gen_random_uuid())::text) NOT NULL,
    lifecycle_status_code text DEFAULT 'active'::text NOT NULL,
    recruitment_status_code text DEFAULT 'recruiting'::text NOT NULL,
    legally_established_on date,
    opened_on date,
    recruitment_ended_on date,
    closed_on date,
    status_official_url text,
    status_note text,
    recruitment_ended_year integer,
    CONSTRAINT schools_course_times_nonempty CHECK ((cardinality(course_times) > 0)),
    CONSTRAINT schools_enrollment_year_reasonable CHECK (((enrollment_year IS NULL) OR ((enrollment_year >= 2000) AND (enrollment_year <= 2100)))),
    CONSTRAINT schools_gender_type_check CHECK ((gender_type = ANY (ARRAY['coed'::text, 'boys'::text, 'girls'::text]))),
    CONSTRAINT schools_lifecycle_date_order CHECK ((((legally_established_on IS NULL) OR (opened_on IS NULL) OR (opened_on >= legally_established_on)) AND ((opened_on IS NULL) OR (closed_on IS NULL) OR (closed_on >= opened_on)) AND ((recruitment_ended_on IS NULL) OR (closed_on IS NULL) OR (closed_on >= recruitment_ended_on)))),
    CONSTRAINT schools_male_ratio_percent CHECK (((male_ratio IS NULL) OR ((male_ratio >= 0) AND (male_ratio <= 100)))),
    CONSTRAINT schools_ownership_check CHECK ((ownership = ANY (ARRAY['prefectural'::text, 'municipal'::text, 'national'::text, 'private'::text, 'union'::text]))),
    CONSTRAINT schools_recruitment_ended_year_range CHECK (((recruitment_ended_year IS NULL) OR ((recruitment_ended_year >= 1900) AND (recruitment_ended_year <= 2100)))),
    CONSTRAINT schools_total_students_nonnegative CHECK (((total_students IS NULL) OR (total_students >= 0))),
    CONSTRAINT schools_type_check CHECK ((type = ANY (ARRAY['high_school'::text, 'kosen'::text])))
);


--
-- Name: COLUMN schools.record_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.schools.record_key IS 'Stable, name-independent identifier used by data bundles and imports.';


--
-- Name: COLUMN schools.lifecycle_status_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.schools.lifecycle_status_code IS 'Legal/operational existence state; orthogonal to recruitment state.';


--
-- Name: COLUMN schools.recruitment_status_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.schools.recruitment_status_code IS 'Upper-secondary recruitment state; orthogonal to lifecycle state.';


--
-- Name: COLUMN schools.recruitment_ended_year; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.schools.recruitment_ended_year IS 'Admission year in which recruitment ended when an exact date is not official.';


--
-- Name: user_school_deviations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_school_deviations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    school_id uuid NOT NULL,
    department_id uuid,
    value integer NOT NULL,
    note text,
    visibility text DEFAULT 'private'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_school_deviations_visibility_check CHECK ((visibility = ANY (ARRAY['private'::text, 'submit_to_manabi'::text])))
);


--
-- Name: user_school_favorites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_school_favorites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    school_id uuid NOT NULL,
    priority integer,
    status text DEFAULT 'interested'::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_school_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_school_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    school_id uuid NOT NULL,
    note text,
    interest_level integer,
    commute_note text,
    club_note text,
    event_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_school_notes_interest_level_check CHECK (((interest_level >= 1) AND (interest_level <= 5)))
);


--
-- Name: admin_users admin_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_pkey PRIMARY KEY (user_id);


--
-- Name: admission_exam_component_master admission_exam_component_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admission_exam_component_master
    ADD CONSTRAINT admission_exam_component_master_pkey PRIMARY KEY (code);


--
-- Name: admission_map_role_master admission_map_role_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admission_map_role_master
    ADD CONSTRAINT admission_map_role_master_pkey PRIMARY KEY (code);


--
-- Name: admission_quality_reason_master admission_quality_reason_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admission_quality_reason_master
    ADD CONSTRAINT admission_quality_reason_master_pkey PRIMARY KEY (code);


--
-- Name: admission_recruitment_unit_departments admission_recruitment_unit_departments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admission_recruitment_unit_departments
    ADD CONSTRAINT admission_recruitment_unit_departments_pkey PRIMARY KEY (unit_id, department_id);


--
-- Name: admission_recruitment_unit_kind_master admission_recruitment_unit_kind_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admission_recruitment_unit_kind_master
    ADD CONSTRAINT admission_recruitment_unit_kind_master_pkey PRIMARY KEY (code);


--
-- Name: admission_recruitment_units admission_recruitment_units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admission_recruitment_units
    ADD CONSTRAINT admission_recruitment_units_pkey PRIMARY KEY (id);


--
-- Name: admission_recruitment_units admission_recruitment_units_school_id_unit_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admission_recruitment_units
    ADD CONSTRAINT admission_recruitment_units_school_id_unit_key_key UNIQUE (school_id, unit_key);


--
-- Name: admission_selection_stage_master admission_selection_stage_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admission_selection_stage_master
    ADD CONSTRAINT admission_selection_stage_master_pkey PRIMARY KEY (code);


--
-- Name: admission_selection_track_master admission_selection_track_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admission_selection_track_master
    ADD CONSTRAINT admission_selection_track_master_pkey PRIMARY KEY (code);


--
-- Name: app_config app_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_config
    ADD CONSTRAINT app_config_pkey PRIMARY KEY (key);


--
-- Name: course_type_master course_type_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.course_type_master
    ADD CONSTRAINT course_type_master_pkey PRIMARY KEY (code);


--
-- Name: dash_cf_dims dash_cf_dims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dash_cf_dims
    ADD CONSTRAINT dash_cf_dims_pkey PRIMARY KEY (snapshot_date, dim_type, dim_value);


--
-- Name: dash_cf_referers dash_cf_referers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dash_cf_referers
    ADD CONSTRAINT dash_cf_referers_pkey PRIMARY KEY (snapshot_date, referer);


--
-- Name: dash_daily dash_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dash_daily
    ADD CONSTRAINT dash_daily_pkey PRIMARY KEY (snapshot_date);


--
-- Name: dash_gsc_pages dash_gsc_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dash_gsc_pages
    ADD CONSTRAINT dash_gsc_pages_pkey PRIMARY KEY (snapshot_date, page);


--
-- Name: dash_gsc_queries dash_gsc_queries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dash_gsc_queries
    ADD CONSTRAINT dash_gsc_queries_pkey PRIMARY KEY (snapshot_date, query);


--
-- Name: data_reports data_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_reports
    ADD CONSTRAINT data_reports_pkey PRIMARY KEY (id);


--
-- Name: deviation_correction_logs deviation_correction_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deviation_correction_logs
    ADD CONSTRAINT deviation_correction_logs_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: family_groups family_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_groups
    ADD CONSTRAINT family_groups_pkey PRIMARY KEY (id);


--
-- Name: family_members family_members_group_user_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_members
    ADD CONSTRAINT family_members_group_user_key UNIQUE (group_id, user_id);


--
-- Name: family_members family_members_invite_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_members
    ADD CONSTRAINT family_members_invite_token_key UNIQUE (invite_token);


--
-- Name: family_members family_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_members
    ADD CONSTRAINT family_members_pkey PRIMARY KEY (id);


--
-- Name: home_locations home_locations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.home_locations
    ADD CONSTRAINT home_locations_pkey PRIMARY KEY (id);


--
-- Name: school_admission_selection_stats school_admission_selection_st_recruitment_unit_id_year_sele_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admission_selection_stats
    ADD CONSTRAINT school_admission_selection_st_recruitment_unit_id_year_sele_key UNIQUE (recruitment_unit_id, year, selection_stage_code, selection_track_code, scope_key);


--
-- Name: school_admission_selection_stats school_admission_selection_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admission_selection_stats
    ADD CONSTRAINT school_admission_selection_stats_pkey PRIMARY KEY (id);


--
-- Name: school_admission_stat_exam_components school_admission_stat_exam_components_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admission_stat_exam_components
    ADD CONSTRAINT school_admission_stat_exam_components_pkey PRIMARY KEY (stat_id, component_code);


--
-- Name: school_admission_stat_legacy_links school_admission_stat_legacy_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admission_stat_legacy_links
    ADD CONSTRAINT school_admission_stat_legacy_links_pkey PRIMARY KEY (stat_id, legacy_stat_id);


--
-- Name: school_admission_stat_quality_flags school_admission_stat_quality_stat_id_metric_code_reason_co_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admission_stat_quality_flags
    ADD CONSTRAINT school_admission_stat_quality_stat_id_metric_code_reason_co_key UNIQUE NULLS NOT DISTINCT (stat_id, metric_code, reason_code);


--
-- Name: school_admission_stat_sources school_admission_stat_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admission_stat_sources
    ADD CONSTRAINT school_admission_stat_sources_pkey PRIMARY KEY (stat_id, fact_kind_code);


--
-- Name: school_admission_stats school_admission_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admission_stats
    ADD CONSTRAINT school_admission_stats_pkey PRIMARY KEY (id);


--
-- Name: school_admission_stats school_admission_stats_school_id_department_id_year_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admission_stats
    ADD CONSTRAINT school_admission_stats_school_id_department_id_year_key UNIQUE NULLS NOT DISTINCT (school_id, department_id, year);


--
-- Name: school_departments school_departments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_departments
    ADD CONSTRAINT school_departments_pkey PRIMARY KEY (id);


--
-- Name: school_deviation_values school_deviation_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_deviation_values
    ADD CONSTRAINT school_deviation_values_pkey PRIMARY KEY (id);


--
-- Name: school_lifecycle_status_master school_lifecycle_status_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_lifecycle_status_master
    ADD CONSTRAINT school_lifecycle_status_master_pkey PRIMARY KEY (code);


--
-- Name: school_name_history school_name_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_name_history
    ADD CONSTRAINT school_name_history_pkey PRIMARY KEY (id);


--
-- Name: school_recruitment_status_master school_recruitment_status_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_recruitment_status_master
    ADD CONSTRAINT school_recruitment_status_master_pkey PRIMARY KEY (code);


--
-- Name: school_relationship_type_master school_relationship_type_master_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_relationship_type_master
    ADD CONSTRAINT school_relationship_type_master_pkey PRIMARY KEY (code);


--
-- Name: school_relationships school_relationships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_relationships
    ADD CONSTRAINT school_relationships_pkey PRIMARY KEY (id);


--
-- Name: schools schools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schools
    ADD CONSTRAINT schools_pkey PRIMARY KEY (id);


--
-- Name: user_school_deviations user_school_deviations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_school_deviations
    ADD CONSTRAINT user_school_deviations_pkey PRIMARY KEY (id);


--
-- Name: user_school_deviations user_school_deviations_user_school_dept_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_school_deviations
    ADD CONSTRAINT user_school_deviations_user_school_dept_key UNIQUE NULLS NOT DISTINCT (user_id, school_id, department_id);


--
-- Name: user_school_favorites user_school_favorites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_school_favorites
    ADD CONSTRAINT user_school_favorites_pkey PRIMARY KEY (id);


--
-- Name: user_school_favorites user_school_favorites_user_id_school_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_school_favorites
    ADD CONSTRAINT user_school_favorites_user_id_school_id_key UNIQUE (user_id, school_id);


--
-- Name: user_school_notes user_school_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_school_notes
    ADD CONSTRAINT user_school_notes_pkey PRIMARY KEY (id);


--
-- Name: user_school_notes user_school_notes_user_id_school_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_school_notes
    ADD CONSTRAINT user_school_notes_user_id_school_id_key UNIQUE (user_id, school_id);


--
-- Name: admission_recruitment_unit_departments_department_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admission_recruitment_unit_departments_department_idx ON public.admission_recruitment_unit_departments USING btree (department_id);


--
-- Name: admission_recruitment_units_school_year_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admission_recruitment_units_school_year_idx ON public.admission_recruitment_units USING btree (school_id, valid_from_year, valid_to_year);


--
-- Name: data_reports_reporter_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX data_reports_reporter_created_idx ON public.data_reports USING btree (reporter_user_id, created_at DESC);


--
-- Name: data_reports_school_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX data_reports_school_created_idx ON public.data_reports USING btree (school_id, created_at DESC);


--
-- Name: data_reports_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX data_reports_status_created_idx ON public.data_reports USING btree (status, created_at DESC);


--
-- Name: deviation_correction_logs_dept_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deviation_correction_logs_dept_created_idx ON public.deviation_correction_logs USING btree (department_id, created_at DESC);


--
-- Name: events_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_created_at_idx ON public.events USING btree (created_at);


--
-- Name: events_type_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_type_created_idx ON public.events USING btree (event_type, created_at);


--
-- Name: family_groups_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX family_groups_owner_idx ON public.family_groups USING btree (owner_id);


--
-- Name: family_members_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX family_members_group_idx ON public.family_members USING btree (group_id);


--
-- Name: family_members_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX family_members_user_idx ON public.family_members USING btree (user_id);


--
-- Name: home_locations_one_primary_per_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX home_locations_one_primary_per_user ON public.home_locations USING btree (user_id) WHERE (is_primary = true);


--
-- Name: idx_admission_stats_school; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admission_stats_school ON public.school_admission_stats USING btree (school_id, year DESC);


--
-- Name: school_admission_selection_stats_map_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX school_admission_selection_stats_map_idx ON public.school_admission_selection_stats USING btree (year DESC, map_role_code, selection_stage_code) WHERE is_ratio_comparable;


--
-- Name: school_admission_selection_stats_unit_year_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX school_admission_selection_stats_unit_year_idx ON public.school_admission_selection_stats USING btree (recruitment_unit_id, year DESC);


--
-- Name: school_admission_stat_legacy_links_legacy_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX school_admission_stat_legacy_links_legacy_idx ON public.school_admission_stat_legacy_links USING btree (legacy_stat_id);


--
-- Name: school_admission_stat_quality_flags_reason_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX school_admission_stat_quality_flags_reason_idx ON public.school_admission_stat_quality_flags USING btree (reason_code);


--
-- Name: school_departments_record_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX school_departments_record_key_key ON public.school_departments USING btree (record_key);


--
-- Name: school_departments_school_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX school_departments_school_id_idx ON public.school_departments USING btree (school_id);


--
-- Name: school_name_history_school_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX school_name_history_school_idx ON public.school_name_history USING btree (school_id, valid_from DESC NULLS LAST);


--
-- Name: school_name_history_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX school_name_history_unique ON public.school_name_history USING btree (school_id, name, COALESCE(valid_from, '0001-01-01'::date));


--
-- Name: school_relationships_predecessor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX school_relationships_predecessor_idx ON public.school_relationships USING btree (predecessor_school_id, effective_on DESC);


--
-- Name: school_relationships_successor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX school_relationships_successor_idx ON public.school_relationships USING btree (successor_school_id, effective_on DESC);


--
-- Name: school_relationships_unique_null_safe; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX school_relationships_unique_null_safe ON public.school_relationships USING btree (predecessor_school_id, successor_school_id, relationship_type_code, COALESCE(effective_on, '0001-01-01'::date), COALESCE(effective_admission_year, '-1'::integer));


--
-- Name: schools_record_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX schools_record_key_key ON public.schools USING btree (record_key);


--
-- Name: sdv_active_per_dept; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sdv_active_per_dept ON public.school_deviation_values USING btree (school_id, department_id) WHERE (is_active = true);


--
-- Name: usd_school_dept_submit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX usd_school_dept_submit ON public.user_school_deviations USING btree (school_id, department_id) WHERE (visibility = 'submit_to_manabi'::text);


--
-- Name: admission_recruitment_unit_departments admission_unit_department_consistency; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER admission_unit_department_consistency BEFORE INSERT OR UPDATE OF unit_id, department_id ON public.admission_recruitment_unit_departments FOR EACH ROW EXECUTE FUNCTION public.validate_admission_recruitment_unit_department();


--
-- Name: admission_recruitment_units admission_unit_school_consistency; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER admission_unit_school_consistency BEFORE UPDATE OF school_id ON public.admission_recruitment_units FOR EACH ROW EXECUTE FUNCTION public.validate_admission_recruitment_unit_school();


--
-- Name: data_reports data_reports_rate_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER data_reports_rate_limit BEFORE INSERT ON public.data_reports FOR EACH ROW EXECUTE FUNCTION public.enforce_data_reports_rate_limit();


--
-- Name: school_departments dept_ui_group_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER dept_ui_group_sync BEFORE INSERT OR UPDATE OF course_type ON public.school_departments FOR EACH ROW EXECUTE FUNCTION public.sync_dept_ui_group();


--
-- Name: course_type_master master_ui_group_propagate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER master_ui_group_propagate AFTER UPDATE OF ui_group ON public.course_type_master FOR EACH ROW EXECUTE FUNCTION public.sync_master_ui_group();


--
-- Name: schools schools_status_compatibility_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER schools_status_compatibility_sync BEFORE INSERT OR UPDATE OF lifecycle_status_code, recruitment_status_code ON public.schools FOR EACH ROW EXECUTE FUNCTION public.sync_school_status_compatibility();


--
-- Name: admission_recruitment_units set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.admission_recruitment_units FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime('updated_at');


--
-- Name: home_locations set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.home_locations FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime('updated_at');


--
-- Name: school_admission_selection_stats set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.school_admission_selection_stats FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime('updated_at');


--
-- Name: user_school_deviations set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.user_school_deviations FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime('updated_at');


--
-- Name: user_school_notes set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.user_school_notes FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime('updated_at');


--
-- Name: admin_users admin_users_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: admission_recruitment_unit_departments admission_recruitment_unit_departments_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admission_recruitment_unit_departments
    ADD CONSTRAINT admission_recruitment_unit_departments_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.school_departments(id) ON DELETE CASCADE;


--
-- Name: admission_recruitment_unit_departments admission_recruitment_unit_departments_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admission_recruitment_unit_departments
    ADD CONSTRAINT admission_recruitment_unit_departments_unit_id_fkey FOREIGN KEY (unit_id) REFERENCES public.admission_recruitment_units(id) ON DELETE CASCADE;


--
-- Name: admission_recruitment_units admission_recruitment_units_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admission_recruitment_units
    ADD CONSTRAINT admission_recruitment_units_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: admission_recruitment_units admission_recruitment_units_unit_kind_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admission_recruitment_units
    ADD CONSTRAINT admission_recruitment_units_unit_kind_code_fkey FOREIGN KEY (unit_kind_code) REFERENCES public.admission_recruitment_unit_kind_master(code) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: app_config app_config_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_config
    ADD CONSTRAINT app_config_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);


--
-- Name: data_reports data_reports_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_reports
    ADD CONSTRAINT data_reports_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.school_departments(id) ON DELETE SET NULL;


--
-- Name: data_reports data_reports_reporter_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_reports
    ADD CONSTRAINT data_reports_reporter_user_id_fkey FOREIGN KEY (reporter_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: data_reports data_reports_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_reports
    ADD CONSTRAINT data_reports_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: data_reports data_reports_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_reports
    ADD CONSTRAINT data_reports_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: deviation_correction_logs deviation_correction_logs_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deviation_correction_logs
    ADD CONSTRAINT deviation_correction_logs_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: deviation_correction_logs deviation_correction_logs_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deviation_correction_logs
    ADD CONSTRAINT deviation_correction_logs_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.school_departments(id);


--
-- Name: deviation_correction_logs deviation_correction_logs_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deviation_correction_logs
    ADD CONSTRAINT deviation_correction_logs_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: events events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: family_groups family_groups_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_groups
    ADD CONSTRAINT family_groups_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: family_members family_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_members
    ADD CONSTRAINT family_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.family_groups(id) ON DELETE CASCADE;


--
-- Name: family_members family_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_members
    ADD CONSTRAINT family_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: home_locations home_locations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.home_locations
    ADD CONSTRAINT home_locations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: school_admission_selection_stats school_admission_selection_stats_map_role_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admission_selection_stats
    ADD CONSTRAINT school_admission_selection_stats_map_role_code_fkey FOREIGN KEY (map_role_code) REFERENCES public.admission_map_role_master(code) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: school_admission_selection_stats school_admission_selection_stats_recruitment_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admission_selection_stats
    ADD CONSTRAINT school_admission_selection_stats_recruitment_unit_id_fkey FOREIGN KEY (recruitment_unit_id) REFERENCES public.admission_recruitment_units(id) ON DELETE CASCADE;


--
-- Name: school_admission_selection_stats school_admission_selection_stats_selection_stage_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admission_selection_stats
    ADD CONSTRAINT school_admission_selection_stats_selection_stage_code_fkey FOREIGN KEY (selection_stage_code) REFERENCES public.admission_selection_stage_master(code) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: school_admission_selection_stats school_admission_selection_stats_selection_track_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admission_selection_stats
    ADD CONSTRAINT school_admission_selection_stats_selection_track_code_fkey FOREIGN KEY (selection_track_code) REFERENCES public.admission_selection_track_master(code) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: school_admission_stat_exam_components school_admission_stat_exam_components_component_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admission_stat_exam_components
    ADD CONSTRAINT school_admission_stat_exam_components_component_code_fkey FOREIGN KEY (component_code) REFERENCES public.admission_exam_component_master(code) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: school_admission_stat_exam_components school_admission_stat_exam_components_stat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admission_stat_exam_components
    ADD CONSTRAINT school_admission_stat_exam_components_stat_id_fkey FOREIGN KEY (stat_id) REFERENCES public.school_admission_selection_stats(id) ON DELETE CASCADE;


--
-- Name: school_admission_stat_legacy_links school_admission_stat_legacy_links_legacy_stat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admission_stat_legacy_links
    ADD CONSTRAINT school_admission_stat_legacy_links_legacy_stat_id_fkey FOREIGN KEY (legacy_stat_id) REFERENCES public.school_admission_stats(id) ON DELETE CASCADE;


--
-- Name: school_admission_stat_legacy_links school_admission_stat_legacy_links_stat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admission_stat_legacy_links
    ADD CONSTRAINT school_admission_stat_legacy_links_stat_id_fkey FOREIGN KEY (stat_id) REFERENCES public.school_admission_selection_stats(id) ON DELETE CASCADE;


--
-- Name: school_admission_stat_quality_flags school_admission_stat_quality_flags_reason_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admission_stat_quality_flags
    ADD CONSTRAINT school_admission_stat_quality_flags_reason_code_fkey FOREIGN KEY (reason_code) REFERENCES public.admission_quality_reason_master(code) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: school_admission_stat_quality_flags school_admission_stat_quality_flags_stat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admission_stat_quality_flags
    ADD CONSTRAINT school_admission_stat_quality_flags_stat_id_fkey FOREIGN KEY (stat_id) REFERENCES public.school_admission_selection_stats(id) ON DELETE CASCADE;


--
-- Name: school_admission_stat_sources school_admission_stat_sources_stat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admission_stat_sources
    ADD CONSTRAINT school_admission_stat_sources_stat_id_fkey FOREIGN KEY (stat_id) REFERENCES public.school_admission_selection_stats(id) ON DELETE CASCADE;


--
-- Name: school_admission_stats school_admission_stats_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admission_stats
    ADD CONSTRAINT school_admission_stats_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.school_departments(id) ON DELETE CASCADE;


--
-- Name: school_admission_stats school_admission_stats_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_admission_stats
    ADD CONSTRAINT school_admission_stats_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: school_departments school_departments_course_type_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_departments
    ADD CONSTRAINT school_departments_course_type_fkey FOREIGN KEY (course_type) REFERENCES public.course_type_master(code) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: school_departments school_departments_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_departments
    ADD CONSTRAINT school_departments_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: school_deviation_values school_deviation_values_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_deviation_values
    ADD CONSTRAINT school_deviation_values_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.school_departments(id);


--
-- Name: school_deviation_values school_deviation_values_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_deviation_values
    ADD CONSTRAINT school_deviation_values_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: school_name_history school_name_history_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_name_history
    ADD CONSTRAINT school_name_history_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE RESTRICT;


--
-- Name: school_relationships school_relationships_predecessor_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_relationships
    ADD CONSTRAINT school_relationships_predecessor_school_id_fkey FOREIGN KEY (predecessor_school_id) REFERENCES public.schools(id) ON DELETE RESTRICT;


--
-- Name: school_relationships school_relationships_relationship_type_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_relationships
    ADD CONSTRAINT school_relationships_relationship_type_code_fkey FOREIGN KEY (relationship_type_code) REFERENCES public.school_relationship_type_master(code) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: school_relationships school_relationships_successor_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.school_relationships
    ADD CONSTRAINT school_relationships_successor_school_id_fkey FOREIGN KEY (successor_school_id) REFERENCES public.schools(id) ON DELETE RESTRICT;


--
-- Name: schools schools_lifecycle_status_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schools
    ADD CONSTRAINT schools_lifecycle_status_code_fkey FOREIGN KEY (lifecycle_status_code) REFERENCES public.school_lifecycle_status_master(code) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: schools schools_recruitment_status_code_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schools
    ADD CONSTRAINT schools_recruitment_status_code_fkey FOREIGN KEY (recruitment_status_code) REFERENCES public.school_recruitment_status_master(code) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: user_school_deviations user_school_deviations_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_school_deviations
    ADD CONSTRAINT user_school_deviations_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.school_departments(id);


--
-- Name: user_school_deviations user_school_deviations_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_school_deviations
    ADD CONSTRAINT user_school_deviations_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: user_school_deviations user_school_deviations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_school_deviations
    ADD CONSTRAINT user_school_deviations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_school_favorites user_school_favorites_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_school_favorites
    ADD CONSTRAINT user_school_favorites_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: user_school_favorites user_school_favorites_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_school_favorites
    ADD CONSTRAINT user_school_favorites_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_school_notes user_school_notes_school_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_school_notes
    ADD CONSTRAINT user_school_notes_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id) ON DELETE CASCADE;


--
-- Name: user_school_notes user_school_notes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_school_notes
    ADD CONSTRAINT user_school_notes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: admission_exam_component_master Public read admission_exam_component_master; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read admission_exam_component_master" ON public.admission_exam_component_master FOR SELECT USING (true);


--
-- Name: admission_map_role_master Public read admission_map_role_master; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read admission_map_role_master" ON public.admission_map_role_master FOR SELECT USING (true);


--
-- Name: admission_quality_reason_master Public read admission_quality_reason_master; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read admission_quality_reason_master" ON public.admission_quality_reason_master FOR SELECT USING (true);


--
-- Name: admission_recruitment_unit_departments Public read admission_recruitment_unit_departments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read admission_recruitment_unit_departments" ON public.admission_recruitment_unit_departments FOR SELECT USING (true);


--
-- Name: admission_recruitment_unit_kind_master Public read admission_recruitment_unit_kind_master; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read admission_recruitment_unit_kind_master" ON public.admission_recruitment_unit_kind_master FOR SELECT USING (true);


--
-- Name: admission_recruitment_units Public read admission_recruitment_units; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read admission_recruitment_units" ON public.admission_recruitment_units FOR SELECT USING (true);


--
-- Name: admission_selection_stage_master Public read admission_selection_stage_master; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read admission_selection_stage_master" ON public.admission_selection_stage_master FOR SELECT USING (true);


--
-- Name: admission_selection_track_master Public read admission_selection_track_master; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read admission_selection_track_master" ON public.admission_selection_track_master FOR SELECT USING (true);


--
-- Name: course_type_master Public read course_type_master; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read course_type_master" ON public.course_type_master FOR SELECT USING (true);


--
-- Name: school_lifecycle_status_master Public read school lifecycle statuses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read school lifecycle statuses" ON public.school_lifecycle_status_master FOR SELECT TO authenticated, anon USING (true);


--
-- Name: school_name_history Public read school name history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read school name history" ON public.school_name_history FOR SELECT TO authenticated, anon USING (true);


--
-- Name: school_recruitment_status_master Public read school recruitment statuses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read school recruitment statuses" ON public.school_recruitment_status_master FOR SELECT TO authenticated, anon USING (true);


--
-- Name: school_relationship_type_master Public read school relationship types; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read school relationship types" ON public.school_relationship_type_master FOR SELECT TO authenticated, anon USING (true);


--
-- Name: school_relationships Public read school relationships; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read school relationships" ON public.school_relationships FOR SELECT TO authenticated, anon USING (true);


--
-- Name: school_admission_selection_stats Public read school_admission_selection_stats; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read school_admission_selection_stats" ON public.school_admission_selection_stats FOR SELECT USING (true);


--
-- Name: school_admission_stat_exam_components Public read school_admission_stat_exam_components; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read school_admission_stat_exam_components" ON public.school_admission_stat_exam_components FOR SELECT USING (true);


--
-- Name: school_admission_stat_legacy_links Public read school_admission_stat_legacy_links; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read school_admission_stat_legacy_links" ON public.school_admission_stat_legacy_links FOR SELECT USING (true);


--
-- Name: school_admission_stat_quality_flags Public read school_admission_stat_quality_flags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read school_admission_stat_quality_flags" ON public.school_admission_stat_quality_flags FOR SELECT USING (true);


--
-- Name: school_admission_stat_sources Public read school_admission_stat_sources; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read school_admission_stat_sources" ON public.school_admission_stat_sources FOR SELECT USING (true);


--
-- Name: school_admission_stats Public read school_admission_stats; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read school_admission_stats" ON public.school_admission_stats FOR SELECT USING (true);


--
-- Name: school_departments Public read school_departments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read school_departments" ON public.school_departments FOR SELECT USING (true);


--
-- Name: school_deviation_values Public read school_deviation_values; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read school_deviation_values" ON public.school_deviation_values FOR SELECT USING (true);


--
-- Name: schools Public read schools; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read schools" ON public.schools FOR SELECT USING (true);


--
-- Name: user_school_deviations Users can delete own deviation records; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own deviation records" ON public.user_school_deviations FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: user_school_favorites Users can delete own favorites; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own favorites" ON public.user_school_favorites FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: home_locations Users can delete own home locations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own home locations" ON public.home_locations FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: user_school_notes Users can delete own notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own notes" ON public.user_school_notes FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: user_school_deviations Users can insert own deviation records; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own deviation records" ON public.user_school_deviations FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: user_school_favorites Users can insert own favorites; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own favorites" ON public.user_school_favorites FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: home_locations Users can insert own home locations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own home locations" ON public.home_locations FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: user_school_notes Users can insert own notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own notes" ON public.user_school_notes FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: user_school_deviations Users can read own deviation records; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can read own deviation records" ON public.user_school_deviations FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: user_school_favorites Users can read own favorites; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can read own favorites" ON public.user_school_favorites FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: home_locations Users can read own home locations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can read own home locations" ON public.home_locations FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: user_school_notes Users can read own notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can read own notes" ON public.user_school_notes FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: user_school_deviations Users can update own deviation records; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own deviation records" ON public.user_school_deviations FOR UPDATE USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: user_school_favorites Users can update own favorites; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own favorites" ON public.user_school_favorites FOR UPDATE USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: home_locations Users can update own home locations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own home locations" ON public.home_locations FOR UPDATE USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: user_school_notes Users can update own notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own notes" ON public.user_school_notes FOR UPDATE USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: admin_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_users admin_users_select_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_users_select_self ON public.admin_users FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: admission_exam_component_master; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admission_exam_component_master ENABLE ROW LEVEL SECURITY;

--
-- Name: admission_map_role_master; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admission_map_role_master ENABLE ROW LEVEL SECURITY;

--
-- Name: admission_quality_reason_master; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admission_quality_reason_master ENABLE ROW LEVEL SECURITY;

--
-- Name: admission_recruitment_unit_departments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admission_recruitment_unit_departments ENABLE ROW LEVEL SECURITY;

--
-- Name: admission_recruitment_unit_kind_master; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admission_recruitment_unit_kind_master ENABLE ROW LEVEL SECURITY;

--
-- Name: admission_recruitment_units; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admission_recruitment_units ENABLE ROW LEVEL SECURITY;

--
-- Name: admission_selection_stage_master; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admission_selection_stage_master ENABLE ROW LEVEL SECURITY;

--
-- Name: admission_selection_track_master; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admission_selection_track_master ENABLE ROW LEVEL SECURITY;

--
-- Name: app_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;

--
-- Name: app_config app_config_public_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY app_config_public_select ON public.app_config FOR SELECT USING (true);


--
-- Name: course_type_master; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.course_type_master ENABLE ROW LEVEL SECURITY;

--
-- Name: dash_cf_dims; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dash_cf_dims ENABLE ROW LEVEL SECURITY;

--
-- Name: dash_cf_referers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dash_cf_referers ENABLE ROW LEVEL SECURITY;

--
-- Name: dash_daily; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dash_daily ENABLE ROW LEVEL SECURITY;

--
-- Name: dash_gsc_pages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dash_gsc_pages ENABLE ROW LEVEL SECURITY;

--
-- Name: dash_gsc_queries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dash_gsc_queries ENABLE ROW LEVEL SECURITY;

--
-- Name: data_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.data_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: data_reports data_reports_admin_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY data_reports_admin_select ON public.data_reports FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.admin_users a
  WHERE (a.user_id = auth.uid()))));


--
-- Name: data_reports data_reports_admin_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY data_reports_admin_update ON public.data_reports FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.admin_users a
  WHERE (a.user_id = auth.uid())))) WITH CHECK (((EXISTS ( SELECT 1
   FROM public.admin_users a
  WHERE (a.user_id = auth.uid()))) AND (status = ANY (ARRAY['reviewed'::text, 'applied'::text, 'rejected'::text])) AND (reviewed_at IS NOT NULL) AND (reviewed_by = auth.uid())));


--
-- Name: data_reports data_reports_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY data_reports_insert_own ON public.data_reports FOR INSERT TO authenticated WITH CHECK (((auth.uid() IS NOT NULL) AND (reporter_user_id = auth.uid())));


--
-- Name: deviation_correction_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.deviation_correction_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: deviation_correction_logs deviation_correction_logs_admin_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY deviation_correction_logs_admin_select ON public.deviation_correction_logs FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.admin_users a
  WHERE (a.user_id = auth.uid()))));


--
-- Name: events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

--
-- Name: events events_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY events_insert ON public.events FOR INSERT TO authenticated, anon WITH CHECK (((user_id IS NULL) OR (user_id = auth.uid())));


--
-- Name: family_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.family_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: family_groups family_groups_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY family_groups_select ON public.family_groups FOR SELECT TO authenticated USING ((id IN ( SELECT public.user_group_ids() AS user_group_ids)));


--
-- Name: family_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.family_members ENABLE ROW LEVEL SECURITY;

--
-- Name: family_members family_members_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY family_members_select ON public.family_members FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR (group_id IN ( SELECT public.user_group_ids() AS user_group_ids))));


--
-- Name: home_locations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.home_locations ENABLE ROW LEVEL SECURITY;

--
-- Name: school_admission_selection_stats; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_admission_selection_stats ENABLE ROW LEVEL SECURITY;

--
-- Name: school_admission_stat_exam_components; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_admission_stat_exam_components ENABLE ROW LEVEL SECURITY;

--
-- Name: school_admission_stat_legacy_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_admission_stat_legacy_links ENABLE ROW LEVEL SECURITY;

--
-- Name: school_admission_stat_quality_flags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_admission_stat_quality_flags ENABLE ROW LEVEL SECURITY;

--
-- Name: school_admission_stat_sources; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_admission_stat_sources ENABLE ROW LEVEL SECURITY;

--
-- Name: school_admission_stats; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_admission_stats ENABLE ROW LEVEL SECURITY;

--
-- Name: school_departments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_departments ENABLE ROW LEVEL SECURITY;

--
-- Name: school_deviation_values; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_deviation_values ENABLE ROW LEVEL SECURITY;

--
-- Name: school_lifecycle_status_master; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_lifecycle_status_master ENABLE ROW LEVEL SECURITY;

--
-- Name: school_name_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_name_history ENABLE ROW LEVEL SECURITY;

--
-- Name: school_recruitment_status_master; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_recruitment_status_master ENABLE ROW LEVEL SECURITY;

--
-- Name: school_relationship_type_master; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_relationship_type_master ENABLE ROW LEVEL SECURITY;

--
-- Name: school_relationships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.school_relationships ENABLE ROW LEVEL SECURITY;

--
-- Name: schools; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schools ENABLE ROW LEVEL SECURITY;

--
-- Name: user_school_deviations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_school_deviations ENABLE ROW LEVEL SECURITY;

--
-- Name: user_school_favorites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_school_favorites ENABLE ROW LEVEL SECURITY;

--
-- Name: user_school_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_school_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION accept_family_invite(p_token uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.accept_family_invite(p_token uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.accept_family_invite(p_token uuid) TO anon;
GRANT ALL ON FUNCTION public.accept_family_invite(p_token uuid) TO authenticated;
GRANT ALL ON FUNCTION public.accept_family_invite(p_token uuid) TO service_role;


--
-- Name: FUNCTION correct_school_deviation(p_department_id uuid, p_new_value integer, p_reason text, p_pin text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.correct_school_deviation(p_department_id uuid, p_new_value integer, p_reason text, p_pin text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.correct_school_deviation(p_department_id uuid, p_new_value integer, p_reason text, p_pin text) TO service_role;
GRANT ALL ON FUNCTION public.correct_school_deviation(p_department_id uuid, p_new_value integer, p_reason text, p_pin text) TO authenticated;


--
-- Name: FUNCTION create_family_group(p_name text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_family_group(p_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_family_group(p_name text) TO anon;
GRANT ALL ON FUNCTION public.create_family_group(p_name text) TO authenticated;
GRANT ALL ON FUNCTION public.create_family_group(p_name text) TO service_role;


--
-- Name: FUNCTION create_family_invite(p_group_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_family_invite(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_family_invite(p_group_id uuid) TO anon;
GRANT ALL ON FUNCTION public.create_family_invite(p_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.create_family_invite(p_group_id uuid) TO service_role;


--
-- Name: FUNCTION dash_app_counts(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.dash_app_counts() FROM PUBLIC;
GRANT ALL ON FUNCTION public.dash_app_counts() TO service_role;


--
-- Name: FUNCTION delete_family_group(p_group_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.delete_family_group(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.delete_family_group(p_group_id uuid) TO anon;
GRANT ALL ON FUNCTION public.delete_family_group(p_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.delete_family_group(p_group_id uuid) TO service_role;


--
-- Name: FUNCTION enforce_data_reports_rate_limit(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enforce_data_reports_rate_limit() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_data_reports_rate_limit() TO service_role;


--
-- Name: FUNCTION get_deviation_review_queue(p_school_id uuid, p_threshold integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_deviation_review_queue(p_school_id uuid, p_threshold integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_deviation_review_queue(p_school_id uuid, p_threshold integer) TO service_role;
GRANT ALL ON FUNCTION public.get_deviation_review_queue(p_school_id uuid, p_threshold integer) TO authenticated;


--
-- Name: FUNCTION get_family_shared_favorites(p_group_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_family_shared_favorites(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_family_shared_favorites(p_group_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_family_shared_favorites(p_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_family_shared_favorites(p_group_id uuid) TO service_role;


--
-- Name: FUNCTION get_family_shared_notes(p_group_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_family_shared_notes(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_family_shared_notes(p_group_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_family_shared_notes(p_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_family_shared_notes(p_group_id uuid) TO service_role;


--
-- Name: FUNCTION is_admin(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_admin() TO service_role;
GRANT ALL ON FUNCTION public.is_admin() TO authenticated;


--
-- Name: FUNCTION leave_family_group(p_group_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.leave_family_group(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.leave_family_group(p_group_id uuid) TO anon;
GRANT ALL ON FUNCTION public.leave_family_group(p_group_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.leave_family_group(p_group_id uuid) TO service_role;


--
-- Name: FUNCTION remove_family_member(p_member_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.remove_family_member(p_member_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.remove_family_member(p_member_id uuid) TO anon;
GRANT ALL ON FUNCTION public.remove_family_member(p_member_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.remove_family_member(p_member_id uuid) TO service_role;


--
-- Name: FUNCTION rls_auto_enable(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.rls_auto_enable() TO anon;
GRANT ALL ON FUNCTION public.rls_auto_enable() TO authenticated;
GRANT ALL ON FUNCTION public.rls_auto_enable() TO service_role;


--
-- Name: FUNCTION set_family_share(p_group_id uuid, p_share_favorites boolean, p_share_notes boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_family_share(p_group_id uuid, p_share_favorites boolean, p_share_notes boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_family_share(p_group_id uuid, p_share_favorites boolean, p_share_notes boolean) TO anon;
GRANT ALL ON FUNCTION public.set_family_share(p_group_id uuid, p_share_favorites boolean, p_share_notes boolean) TO authenticated;
GRANT ALL ON FUNCTION public.set_family_share(p_group_id uuid, p_share_favorites boolean, p_share_notes boolean) TO service_role;


--
-- Name: FUNCTION sync_dept_ui_group(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.sync_dept_ui_group() TO anon;
GRANT ALL ON FUNCTION public.sync_dept_ui_group() TO authenticated;
GRANT ALL ON FUNCTION public.sync_dept_ui_group() TO service_role;


--
-- Name: FUNCTION sync_master_ui_group(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.sync_master_ui_group() TO anon;
GRANT ALL ON FUNCTION public.sync_master_ui_group() TO authenticated;
GRANT ALL ON FUNCTION public.sync_master_ui_group() TO service_role;


--
-- Name: FUNCTION sync_school_status_compatibility(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.sync_school_status_compatibility() TO anon;
GRANT ALL ON FUNCTION public.sync_school_status_compatibility() TO authenticated;
GRANT ALL ON FUNCTION public.sync_school_status_compatibility() TO service_role;


--
-- Name: FUNCTION user_group_ids(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.user_group_ids() FROM PUBLIC;
GRANT ALL ON FUNCTION public.user_group_ids() TO anon;
GRANT ALL ON FUNCTION public.user_group_ids() TO authenticated;
GRANT ALL ON FUNCTION public.user_group_ids() TO service_role;


--
-- Name: FUNCTION validate_admission_recruitment_unit_department(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.validate_admission_recruitment_unit_department() TO anon;
GRANT ALL ON FUNCTION public.validate_admission_recruitment_unit_department() TO authenticated;
GRANT ALL ON FUNCTION public.validate_admission_recruitment_unit_department() TO service_role;


--
-- Name: FUNCTION validate_admission_recruitment_unit_school(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.validate_admission_recruitment_unit_school() TO anon;
GRANT ALL ON FUNCTION public.validate_admission_recruitment_unit_school() TO authenticated;
GRANT ALL ON FUNCTION public.validate_admission_recruitment_unit_school() TO service_role;


--
-- Name: TABLE admin_users; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admin_users TO service_role;


--
-- Name: COLUMN admin_users.user_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(user_id) ON TABLE public.admin_users TO authenticated;


--
-- Name: COLUMN admin_users.note; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(note) ON TABLE public.admin_users TO authenticated;


--
-- Name: COLUMN admin_users.created_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(created_at) ON TABLE public.admin_users TO authenticated;


--
-- Name: TABLE admission_exam_component_master; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admission_exam_component_master TO anon;
GRANT ALL ON TABLE public.admission_exam_component_master TO authenticated;
GRANT ALL ON TABLE public.admission_exam_component_master TO service_role;


--
-- Name: TABLE admission_map_role_master; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admission_map_role_master TO anon;
GRANT ALL ON TABLE public.admission_map_role_master TO authenticated;
GRANT ALL ON TABLE public.admission_map_role_master TO service_role;


--
-- Name: TABLE admission_quality_reason_master; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admission_quality_reason_master TO anon;
GRANT ALL ON TABLE public.admission_quality_reason_master TO authenticated;
GRANT ALL ON TABLE public.admission_quality_reason_master TO service_role;


--
-- Name: TABLE admission_recruitment_unit_departments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admission_recruitment_unit_departments TO anon;
GRANT ALL ON TABLE public.admission_recruitment_unit_departments TO authenticated;
GRANT ALL ON TABLE public.admission_recruitment_unit_departments TO service_role;


--
-- Name: TABLE admission_recruitment_unit_kind_master; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admission_recruitment_unit_kind_master TO anon;
GRANT ALL ON TABLE public.admission_recruitment_unit_kind_master TO authenticated;
GRANT ALL ON TABLE public.admission_recruitment_unit_kind_master TO service_role;


--
-- Name: TABLE admission_recruitment_units; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admission_recruitment_units TO anon;
GRANT ALL ON TABLE public.admission_recruitment_units TO authenticated;
GRANT ALL ON TABLE public.admission_recruitment_units TO service_role;


--
-- Name: TABLE admission_selection_stage_master; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admission_selection_stage_master TO anon;
GRANT ALL ON TABLE public.admission_selection_stage_master TO authenticated;
GRANT ALL ON TABLE public.admission_selection_stage_master TO service_role;


--
-- Name: TABLE admission_selection_track_master; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admission_selection_track_master TO anon;
GRANT ALL ON TABLE public.admission_selection_track_master TO authenticated;
GRANT ALL ON TABLE public.admission_selection_track_master TO service_role;


--
-- Name: TABLE app_config; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.app_config TO anon;
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.app_config TO authenticated;
GRANT ALL ON TABLE public.app_config TO service_role;


--
-- Name: TABLE course_type_master; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.course_type_master TO anon;
GRANT ALL ON TABLE public.course_type_master TO authenticated;
GRANT ALL ON TABLE public.course_type_master TO service_role;


--
-- Name: TABLE dash_cf_dims; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.dash_cf_dims TO anon;
GRANT ALL ON TABLE public.dash_cf_dims TO authenticated;
GRANT ALL ON TABLE public.dash_cf_dims TO service_role;


--
-- Name: TABLE dash_cf_referers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.dash_cf_referers TO anon;
GRANT ALL ON TABLE public.dash_cf_referers TO authenticated;
GRANT ALL ON TABLE public.dash_cf_referers TO service_role;


--
-- Name: TABLE dash_daily; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.dash_daily TO anon;
GRANT ALL ON TABLE public.dash_daily TO authenticated;
GRANT ALL ON TABLE public.dash_daily TO service_role;


--
-- Name: TABLE dash_gsc_pages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.dash_gsc_pages TO anon;
GRANT ALL ON TABLE public.dash_gsc_pages TO authenticated;
GRANT ALL ON TABLE public.dash_gsc_pages TO service_role;


--
-- Name: TABLE dash_gsc_queries; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.dash_gsc_queries TO anon;
GRANT ALL ON TABLE public.dash_gsc_queries TO authenticated;
GRANT ALL ON TABLE public.dash_gsc_queries TO service_role;


--
-- Name: TABLE data_reports; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.data_reports TO service_role;
GRANT SELECT ON TABLE public.data_reports TO authenticated;


--
-- Name: COLUMN data_reports.school_id; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(school_id) ON TABLE public.data_reports TO authenticated;


--
-- Name: COLUMN data_reports.department_id; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(department_id) ON TABLE public.data_reports TO authenticated;


--
-- Name: COLUMN data_reports.field; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(field) ON TABLE public.data_reports TO authenticated;


--
-- Name: COLUMN data_reports.proposed_value; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(proposed_value) ON TABLE public.data_reports TO authenticated;


--
-- Name: COLUMN data_reports.source; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(source) ON TABLE public.data_reports TO authenticated;


--
-- Name: COLUMN data_reports.comment; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(comment) ON TABLE public.data_reports TO authenticated;


--
-- Name: COLUMN data_reports.reporter_user_id; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(reporter_user_id) ON TABLE public.data_reports TO authenticated;


--
-- Name: COLUMN data_reports.status; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(status) ON TABLE public.data_reports TO authenticated;


--
-- Name: COLUMN data_reports.reviewed_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(reviewed_at) ON TABLE public.data_reports TO authenticated;


--
-- Name: COLUMN data_reports.reviewed_by; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(reviewed_by) ON TABLE public.data_reports TO authenticated;


--
-- Name: TABLE deviation_correction_logs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.deviation_correction_logs TO anon;
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.deviation_correction_logs TO authenticated;
GRANT ALL ON TABLE public.deviation_correction_logs TO service_role;


--
-- Name: TABLE events; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.events TO anon;
GRANT INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.events TO authenticated;
GRANT ALL ON TABLE public.events TO service_role;


--
-- Name: TABLE events_summary_daily; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.events_summary_daily TO authenticated;
GRANT ALL ON TABLE public.events_summary_daily TO service_role;


--
-- Name: TABLE family_groups; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.family_groups TO anon;
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.family_groups TO authenticated;
GRANT ALL ON TABLE public.family_groups TO service_role;


--
-- Name: TABLE family_members; Type: ACL; Schema: public; Owner: -
--

GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.family_members TO anon;
GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.family_members TO authenticated;
GRANT ALL ON TABLE public.family_members TO service_role;


--
-- Name: COLUMN family_members.id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(id) ON TABLE public.family_members TO authenticated;


--
-- Name: COLUMN family_members.group_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(group_id) ON TABLE public.family_members TO authenticated;


--
-- Name: COLUMN family_members.user_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(user_id) ON TABLE public.family_members TO authenticated;


--
-- Name: COLUMN family_members.role; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(role) ON TABLE public.family_members TO authenticated;


--
-- Name: COLUMN family_members.status; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(status) ON TABLE public.family_members TO authenticated;


--
-- Name: COLUMN family_members.share_favorites; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(share_favorites) ON TABLE public.family_members TO authenticated;


--
-- Name: COLUMN family_members.share_notes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(share_notes) ON TABLE public.family_members TO authenticated;


--
-- Name: COLUMN family_members.invited_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(invited_at) ON TABLE public.family_members TO authenticated;


--
-- Name: COLUMN family_members.accepted_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(accepted_at) ON TABLE public.family_members TO authenticated;


--
-- Name: COLUMN family_members.created_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(created_at) ON TABLE public.family_members TO authenticated;


--
-- Name: TABLE home_locations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.home_locations TO anon;
GRANT ALL ON TABLE public.home_locations TO authenticated;
GRANT ALL ON TABLE public.home_locations TO service_role;


--
-- Name: TABLE school_admission_selection_stats; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.school_admission_selection_stats TO anon;
GRANT ALL ON TABLE public.school_admission_selection_stats TO authenticated;
GRANT ALL ON TABLE public.school_admission_selection_stats TO service_role;


--
-- Name: TABLE school_admission_stat_exam_components; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.school_admission_stat_exam_components TO anon;
GRANT ALL ON TABLE public.school_admission_stat_exam_components TO authenticated;
GRANT ALL ON TABLE public.school_admission_stat_exam_components TO service_role;


--
-- Name: TABLE school_admission_stat_legacy_links; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.school_admission_stat_legacy_links TO anon;
GRANT ALL ON TABLE public.school_admission_stat_legacy_links TO authenticated;
GRANT ALL ON TABLE public.school_admission_stat_legacy_links TO service_role;


--
-- Name: TABLE school_admission_stat_quality_flags; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.school_admission_stat_quality_flags TO anon;
GRANT ALL ON TABLE public.school_admission_stat_quality_flags TO authenticated;
GRANT ALL ON TABLE public.school_admission_stat_quality_flags TO service_role;


--
-- Name: TABLE school_admission_stat_sources; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.school_admission_stat_sources TO anon;
GRANT ALL ON TABLE public.school_admission_stat_sources TO authenticated;
GRANT ALL ON TABLE public.school_admission_stat_sources TO service_role;


--
-- Name: TABLE school_admission_stats; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.school_admission_stats TO anon;
GRANT ALL ON TABLE public.school_admission_stats TO authenticated;
GRANT ALL ON TABLE public.school_admission_stats TO service_role;


--
-- Name: TABLE school_departments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.school_departments TO anon;
GRANT ALL ON TABLE public.school_departments TO authenticated;
GRANT ALL ON TABLE public.school_departments TO service_role;


--
-- Name: TABLE school_deviation_values; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,MAINTAIN ON TABLE public.school_deviation_values TO anon;
GRANT SELECT,MAINTAIN ON TABLE public.school_deviation_values TO authenticated;
GRANT ALL ON TABLE public.school_deviation_values TO service_role;


--
-- Name: TABLE school_lifecycle_status_master; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.school_lifecycle_status_master TO anon;
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.school_lifecycle_status_master TO authenticated;
GRANT ALL ON TABLE public.school_lifecycle_status_master TO service_role;


--
-- Name: TABLE school_name_history; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.school_name_history TO anon;
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.school_name_history TO authenticated;
GRANT ALL ON TABLE public.school_name_history TO service_role;


--
-- Name: TABLE school_recruitment_status_master; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.school_recruitment_status_master TO anon;
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.school_recruitment_status_master TO authenticated;
GRANT ALL ON TABLE public.school_recruitment_status_master TO service_role;


--
-- Name: TABLE school_relationship_type_master; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.school_relationship_type_master TO anon;
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.school_relationship_type_master TO authenticated;
GRANT ALL ON TABLE public.school_relationship_type_master TO service_role;


--
-- Name: TABLE school_relationships; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.school_relationships TO anon;
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.school_relationships TO authenticated;
GRANT ALL ON TABLE public.school_relationships TO service_role;


--
-- Name: TABLE schools; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.schools TO anon;
GRANT ALL ON TABLE public.schools TO authenticated;
GRANT ALL ON TABLE public.schools TO service_role;


--
-- Name: TABLE user_school_deviations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_school_deviations TO anon;
GRANT ALL ON TABLE public.user_school_deviations TO authenticated;
GRANT ALL ON TABLE public.user_school_deviations TO service_role;


--
-- Name: TABLE user_school_favorites; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_school_favorites TO anon;
GRANT ALL ON TABLE public.user_school_favorites TO authenticated;
GRANT ALL ON TABLE public.user_school_favorites TO service_role;


--
-- Name: TABLE user_school_notes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_school_notes TO anon;
GRANT ALL ON TABLE public.user_school_notes TO authenticated;
GRANT ALL ON TABLE public.user_school_notes TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--


