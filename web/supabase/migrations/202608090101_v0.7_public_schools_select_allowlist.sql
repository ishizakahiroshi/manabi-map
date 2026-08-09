-- C3: schools の anon / authenticated SELECT を公開列へ限定する。
-- status_note は収集作業用の内部メモであり、公開 API・アプリ用 JSON と同じく
-- PostgREST の直接取得からも除外する。

begin;

revoke all privileges on table public.schools from public, anon, authenticated;

grant select (
  id,
  name,
  name_kana,
  type,
  ownership,
  gender_type,
  is_integrated,
  postal_code,
  prefecture,
  city,
  address,
  latitude,
  longitude,
  official_url,
  is_active,
  is_recruiting,
  updated_at,
  course_times,
  main_school_name,
  campus_type,
  total_students,
  enrollment_year,
  male_ratio,
  record_key,
  lifecycle_status_code,
  recruitment_status_code,
  legally_established_on,
  opened_on,
  recruitment_ended_on,
  closed_on,
  status_official_url,
  recruitment_ended_year,
  status_description
)
on table public.schools to anon, authenticated;

do $$
declare
  role_name text;
  column_name text;
  public_columns constant text[] := array[
    'id', 'name', 'name_kana', 'type', 'ownership', 'gender_type',
    'is_integrated', 'postal_code', 'prefecture', 'city', 'address',
    'latitude', 'longitude', 'official_url', 'is_active', 'is_recruiting',
    'updated_at', 'course_times', 'main_school_name', 'campus_type',
    'total_students', 'enrollment_year', 'male_ratio', 'record_key',
    'lifecycle_status_code', 'recruitment_status_code',
    'legally_established_on', 'opened_on', 'recruitment_ended_on',
    'closed_on', 'status_official_url', 'recruitment_ended_year',
    'status_description'
  ];
begin
  foreach role_name in array ARRAY['anon', 'authenticated'] loop
    if has_table_privilege(role_name, 'public.schools', 'select') then
      raise exception 'table-level SELECT remains for %', role_name;
    end if;
    if has_column_privilege(role_name, 'public.schools', 'status_note', 'select') then
      raise exception 'status_note SELECT remains for %', role_name;
    end if;
    foreach column_name in array public_columns loop
      if not has_column_privilege(role_name, 'public.schools', column_name, 'select') then
        raise exception 'public SELECT is missing for %.%', role_name, column_name;
      end if;
    end loop;
  end loop;
end $$;

commit;
