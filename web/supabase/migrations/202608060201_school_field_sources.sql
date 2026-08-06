-- =====================================================================
-- C2: 学校基本情報を項目単位で一次資料まで追跡する provenance schema
--
-- 値本体は schools / school_departments に残し、出典だけを本テーブルへ分離する。
-- 同じ学校・項目に複数資料がある場合を失わないため、URL までを主キーに含める。
-- 404 等も削除せず last_http_status と last_verified_at で到達状態を保持する。
--
-- rollback:
--   drop table if exists public.school_field_sources;
--   drop table if exists public.school_field_source_field_master;
-- =====================================================================

begin;

create table public.school_field_source_field_master (
  code text primary key,
  table_name text not null,
  column_name text not null,
  label_ja text not null,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  constraint school_field_source_master_code_format
    check (code ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint school_field_source_master_names_format
    check (
      table_name ~ '^[a-z][a-z0-9_]*$'
      and column_name ~ '^[a-z][a-z0-9_]*$'
    ),
  constraint school_field_source_master_label_nonempty
    check (btrim(label_ja) <> ''),
  constraint school_field_source_master_code_matches_columns
    check (code = table_name || '.' || column_name),
  unique (table_name, column_name)
);

insert into public.school_field_source_field_master
  (code, table_name, column_name, label_ja, sort_order, notes)
values
  ('schools.course_times', 'schools', 'course_times', '課程', 10, null),
  ('schools.campus_type', 'schools', 'campus_type', '校地種別', 20, null),
  ('schools.total_students', 'schools', 'total_students', '全校生徒数', 30, null),
  ('schools.enrollment_year', 'schools', 'enrollment_year', '在籍数の基準年度', 40, null),
  ('schools.male_ratio', 'schools', 'male_ratio', '男子比率', 50, null),
  ('schools.latitude', 'schools', 'latitude', '緯度', 60, null),
  ('schools.longitude', 'schools', 'longitude', '経度', 70, null),
  ('schools.official_url', 'schools', 'official_url', '学校公式サイト', 80,
   '教育委員会・私学協会・高専機構の学校一覧から取得した学校公式サイト URL'),
  ('school_departments.name', 'school_departments', 'name', '学科名', 90, null),
  ('school_departments.course_type', 'school_departments', 'course_type', '学科分類', 100, null);

comment on table public.school_field_source_field_master is
  '学校基本情報の出典を保持できる項目の正規辞書。未登録の table.column は FK で拒否する';
comment on column public.school_field_source_field_master.code is
  '対象を table.column 形式で表す安定 code';

create table public.school_field_sources (
  school_id uuid not null
    references public.schools (id) on delete cascade,
  field_name text not null
    references public.school_field_source_field_master (code)
    on update cascade on delete restrict,
  official_url text not null,
  doc_title text not null,
  published_at date,
  source_page_or_table text,
  last_verified_at timestamptz,
  last_http_status integer,
  is_official_source boolean not null,
  note text,
  created_at timestamptz not null default now(),
  primary key (school_id, field_name, official_url),
  constraint school_field_sources_official_url_http
    check (official_url ~* '^https?://[^[:space:]]+$'),
  constraint school_field_sources_doc_title_nonempty
    check (btrim(doc_title) <> ''),
  constraint school_field_sources_page_nonempty
    check (source_page_or_table is null or btrim(source_page_or_table) <> ''),
  constraint school_field_sources_note_nonempty
    check (note is null or btrim(note) <> ''),
  constraint school_field_sources_http_status_range
    check (last_http_status is null or last_http_status between 100 and 599),
  constraint school_field_sources_verification_pair
    check (
      (last_http_status is null and last_verified_at is null)
      or (last_http_status is not null and last_verified_at is not null)
    )
);

comment on table public.school_field_sources is
  '学校基本情報の項目ごとの出典。404も削除せず到達状態を保持する';
comment on column public.school_field_sources.field_name is
  'school_field_source_field_master.code。対象は table.column 単位';
comment on column public.school_field_sources.is_official_source is
  '学校・教育委員会・官公庁が発行した資料か。三次資料（Wikipedia 等）は false。公開 API は true のみを出す';
comment on column public.school_field_sources.note is
  'archive SQL からの復元経緯や同版の複数出典を残す。出典本文の推測には使わない';

create index school_field_sources_official_field_school_idx
  on public.school_field_sources (field_name, school_id)
  where is_official_source;

-- 公開 read。write policy は作らず、権限も service_role に限定する。
alter table public.school_field_source_field_master enable row level security;
alter table public.school_field_sources enable row level security;

create policy "Public read school_field_source_field_master"
  on public.school_field_source_field_master for select using (true);
create policy "Public read school_field_sources"
  on public.school_field_sources for select using (true);

revoke insert, update, delete, truncate
  on public.school_field_source_field_master from anon, authenticated;
revoke insert, update, delete, truncate
  on public.school_field_sources from anon, authenticated;
grant select on public.school_field_source_field_master to anon, authenticated;
grant select on public.school_field_sources to anon, authenticated;
grant all on public.school_field_source_field_master to service_role;
grant all on public.school_field_sources to service_role;

-- migration 自己検証。schema・seed・RLS・write 制限を commit 前に確認する。
do $$
declare
  v_missing text;
begin
  if to_regclass('public.school_field_source_field_master') is null
     or to_regclass('public.school_field_sources') is null then
    raise exception 'school field provenance tables are missing';
  end if;

  if (select count(*) from public.school_field_source_field_master) <> 10 then
    raise exception 'school field source master seed count mismatch';
  end if;

  select m.code into v_missing
    from public.school_field_source_field_master m
   where not exists (
     select 1
       from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = m.table_name
        and c.column_name = m.column_name
   )
   limit 1;
  if v_missing is not null then
    raise exception 'school field source master points to a missing column: %', v_missing;
  end if;

  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'school_field_source_field_master'
      and c.relrowsecurity
  ) or not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'school_field_sources'
      and c.relrowsecurity
  ) then
    raise exception 'school field provenance RLS is not enabled';
  end if;

  if has_table_privilege('anon', 'public.school_field_sources', 'INSERT')
     or has_table_privilege('anon', 'public.school_field_sources', 'UPDATE')
     or has_table_privilege('anon', 'public.school_field_sources', 'DELETE')
     or has_table_privilege('authenticated', 'public.school_field_sources', 'INSERT')
     or has_table_privilege('authenticated', 'public.school_field_sources', 'UPDATE')
     or has_table_privilege('authenticated', 'public.school_field_sources', 'DELETE') then
    raise exception 'school_field_sources write privilege leaked to an API role';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.school_field_sources'::regclass
       and conname = 'school_field_sources_official_url_http'
  ) then
    raise exception 'school_field_sources URL constraint is missing';
  end if;

  raise notice 'school field provenance schema verified: 2 tables, 9 field codes';
end $$;

commit;
