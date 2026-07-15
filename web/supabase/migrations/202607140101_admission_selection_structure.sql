-- =====================================================================
-- C3: 入学者選抜の募集単位・選抜段階・指標別出典を保持する新構造
--
-- 現行 public.school_admission_stats は変更・削除・backfill しない。
-- パイロット3県は検収済みの v2 bundle から本テーブル群へ別途投入する。
-- raw label は県公表資料の原文、*_code は master 管理の正規分類として分離する。
--
-- rollback（データ投入後は pg_dump を確認し、依存順に実行）:
--   drop trigger if exists admission_unit_school_consistency
--     on public.admission_recruitment_units;
--   drop function if exists public.validate_admission_recruitment_unit_school();
--   drop trigger if exists admission_unit_department_consistency
--     on public.admission_recruitment_unit_departments;
--   drop function if exists public.validate_admission_recruitment_unit_department();
--   drop trigger if exists set_updated_at on public.school_admission_selection_stats;
--   drop trigger if exists set_updated_at on public.admission_recruitment_units;
--   drop table if exists public.school_admission_stat_legacy_links;
--   drop table if exists public.school_admission_stat_sources;
--   drop table if exists public.school_admission_stat_quality_flags;
--   drop table if exists public.school_admission_stat_exam_components;
--   drop table if exists public.school_admission_selection_stats;
--   drop table if exists public.admission_recruitment_unit_departments;
--   drop table if exists public.admission_recruitment_units;
--   drop table if exists public.admission_exam_component_master;
--   drop table if exists public.admission_quality_reason_master;
--   drop table if exists public.admission_map_role_master;
--   drop table if exists public.admission_recruitment_unit_kind_master;
--   drop table if exists public.admission_selection_track_master;
--   drop table if exists public.admission_selection_stage_master;
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1) 正規分類 master（未登録 code は FK で拒否する）
-- ---------------------------------------------------------------------
create table public.admission_selection_stage_master (
  code text primary key,
  label_ja text not null,
  label_en text not null,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  constraint admission_selection_stage_master_code_format
    check (code ~ '^[a-z][a-z0-9_]*$'),
  constraint admission_selection_stage_master_labels_nonempty
    check (btrim(label_ja) <> '' and btrim(label_en) <> '')
);

create table public.admission_selection_track_master (
  code text primary key,
  label_ja text not null,
  label_en text not null,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  constraint admission_selection_track_master_code_format
    check (code ~ '^[a-z][a-z0-9_]*$'),
  constraint admission_selection_track_master_labels_nonempty
    check (btrim(label_ja) <> '' and btrim(label_en) <> '')
);

create table public.admission_recruitment_unit_kind_master (
  code text primary key,
  label_ja text not null,
  label_en text not null,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  constraint admission_recruitment_unit_kind_master_code_format
    check (code ~ '^[a-z][a-z0-9_]*$'),
  constraint admission_recruitment_unit_kind_master_labels_nonempty
    check (btrim(label_ja) <> '' and btrim(label_en) <> '')
);

create table public.admission_map_role_master (
  code text primary key,
  label_ja text not null,
  label_en text not null,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  constraint admission_map_role_master_code_format
    check (code ~ '^[a-z][a-z0-9_]*$'),
  constraint admission_map_role_master_labels_nonempty
    check (btrim(label_ja) <> '' and btrim(label_en) <> '')
);

create table public.admission_quality_reason_master (
  code text primary key,
  label_ja text not null,
  label_en text not null,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  constraint admission_quality_reason_master_code_format
    check (code ~ '^[a-z][a-z0-9_]*$'),
  constraint admission_quality_reason_master_labels_nonempty
    check (btrim(label_ja) <> '' and btrim(label_en) <> '')
);

create table public.admission_exam_component_master (
  code text primary key,
  label_ja text not null,
  label_en text not null,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  constraint admission_exam_component_master_code_format
    check (code ~ '^[a-z][a-z0-9_]*$'),
  constraint admission_exam_component_master_labels_nonempty
    check (btrim(label_ja) <> '' and btrim(label_en) <> '')
);

insert into public.admission_selection_stage_master
  (code, label_ja, label_en, sort_order, notes)
values
  ('primary',      '一次募集',   'Primary',      10, '第一次・通常選抜を含む一次段階'),
  ('secondary',    '二次募集',   'Secondary',    20, '第二次選抜'),
  ('supplemental', '再募集',     'Supplemental', 30, '欠員補充等の再募集'),
  ('unknown',      '不明',       'Unknown',      99, '資料から段階を確定できない');

insert into public.admission_selection_track_master
  (code, label_ja, label_en, sort_order, notes)
values
  ('general',        '一般',       'General',        10, null),
  ('recommendation', '推薦',       'Recommendation', 20, null),
  ('special',        '特色',       'Special',        30, '特色選抜・特色枠'),
  ('combined',       '複合',       'Combined',       40, '公式に一体で公表された一般＋特色等'),
  ('other',          'その他',     'Other',          90, null),
  ('unknown',        '不明',       'Unknown',        99, '資料から区分を確定できない');

insert into public.admission_recruitment_unit_kind_master
  (code, label_ja, label_en, sort_order, notes)
values
  ('department',       '学科',         'Department',       10, null),
  ('department_group', '学科群',       'Department group', 20, 'くくり募集を含む'),
  ('school',           '学校全体',     'School',           30, null),
  ('course_group',     'コース群',     'Course group',     40, null),
  ('time_division',    '課程・部',     'Time division',    50, '定時制の部等'),
  ('other',            'その他',       'Other',            90, null),
  ('unknown',          '不明',         'Unknown',          99, '募集単位を確定できない');

insert into public.admission_map_role_master
  (code, label_ja, label_en, sort_order, notes)
values
  ('primary_total',   '一次募集全体', 'Primary total',   10, '条件を満たす地図表示対象'),
  ('component_only',  '内数',         'Component only',  20, '一次総数へ重ねて集計しない'),
  ('additional_stage','追加段階',     'Additional stage',30, '二次・再募集等'),
  ('detail_only',     '詳細のみ',     'Detail only',     40, '比較せず詳細画面のみ'),
  ('unknown',         '不明',         'Unknown',         99, null);

insert into public.admission_quality_reason_master
  (code, label_ja, label_en, sort_order, notes)
values
  ('missing_capacity',          '募集人数なし',       'Missing capacity',          10, null),
  ('missing_applicants',        '志願者数なし',       'Missing applicants',        20, null),
  ('stage_unknown',             '募集段階不明',       'Stage unknown',             30, null),
  ('track_scope_mismatch',      '選抜区分の範囲不一致','Track scope mismatch',      40, null),
  ('metric_scope_mismatch',     '指標の範囲不一致',   'Metric scope mismatch',     50, null),
  ('recruitment_unit_mismatch', '募集単位不一致',     'Recruitment unit mismatch', 60, null),
  ('overlapping_unit',          '募集単位重複',       'Overlapping unit',          70, null),
  ('mixed_population',          '対象者混在',         'Mixed population',          80, '併設中希望者・特例措置等を含む'),
  ('source_conflict',           '出典間矛盾',         'Source conflict',           90, null),
  ('source_unreachable',        '出典到達不能',       'Source unreachable',       100, '404等。これ単独で比較可否を決めない'),
  ('scheme_changed',            '制度変更',           'Scheme changed',           110, null);

insert into public.admission_exam_component_master
  (code, label_ja, label_en, sort_order, notes)
values
  ('academic_test',   '学力検査',       'Academic test',        10, null),
  ('transcript',      '調査書',         'Transcript',           20, null),
  ('interview',       '面接',           'Interview',            30, null),
  ('essay',           '小論文',         'Essay',                40, null),
  ('composition',     '作文',           'Composition',          50, null),
  ('practical',       '実技',           'Practical test',       60, null),
  ('school_specific', '学校独自検査',   'School-specific test', 70, null),
  ('other',           'その他',         'Other',                90, null),
  ('unknown',         '不明',           'Unknown',              99, null);

comment on table public.admission_selection_stage_master is '募集段階の正規辞書';
comment on table public.admission_selection_track_master is '選抜区分の正規辞書';
comment on table public.admission_recruitment_unit_kind_master is '募集単位種別の正規辞書';
comment on table public.admission_map_role_master is '地図集計での役割の正規辞書';
comment on table public.admission_quality_reason_master is '比較不能・注意理由の正規辞書';
comment on table public.admission_exam_component_master is '検査要素の正規辞書';

-- ---------------------------------------------------------------------
-- 2) 学校ごとの募集単位と学科 membership
-- ---------------------------------------------------------------------
create table public.admission_recruitment_units (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools (id) on delete cascade,
  unit_key text not null,
  unit_kind_code text not null
    references public.admission_recruitment_unit_kind_master (code)
    on update cascade on delete restrict,
  label text not null,
  course_time public.school_course_time,
  valid_from_year integer,
  valid_to_year integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint admission_recruitment_units_unit_key_nonempty
    check (btrim(unit_key) <> ''),
  constraint admission_recruitment_units_label_nonempty
    check (btrim(label) <> ''),
  constraint admission_recruitment_units_year_range
    check (
      (valid_from_year is null or valid_from_year between 2000 and 2100)
      and (valid_to_year is null or valid_to_year between 2000 and 2100)
      and (valid_from_year is null or valid_to_year is null or valid_to_year >= valid_from_year)
    ),
  unique (school_id, unit_key)
);

create table public.admission_recruitment_unit_departments (
  unit_id uuid not null
    references public.admission_recruitment_units (id) on delete cascade,
  department_id uuid not null
    references public.school_departments (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (unit_id, department_id)
);

comment on table public.admission_recruitment_units is
  '年度をまたいで追跡する学校別募集単位。unit_key は学校内で一意';
comment on column public.admission_recruitment_units.label is
  '利用者表示用の募集単位名。県資料の原文ラベルは選抜統計側に保持する';
comment on table public.admission_recruitment_unit_departments is
  'くくり募集・学科群を重複統計行にせず表す学科 membership';

create index admission_recruitment_units_school_year_idx
  on public.admission_recruitment_units (school_id, valid_from_year, valid_to_year);
create index admission_recruitment_unit_departments_department_idx
  on public.admission_recruitment_unit_departments (department_id);

-- unit と department が別学校に属する membership を拒否する。
create function public.validate_admission_recruitment_unit_department()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
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

create trigger admission_unit_department_consistency
  before insert or update of unit_id, department_id
  on public.admission_recruitment_unit_departments
  for each row execute function public.validate_admission_recruitment_unit_department();

-- membership 作成後に unit.school_id だけを別学校へ変更する経路も拒否する。
create function public.validate_admission_recruitment_unit_school()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
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

create trigger admission_unit_school_consistency
  before update of school_id on public.admission_recruitment_units
  for each row execute function public.validate_admission_recruitment_unit_school();

-- ---------------------------------------------------------------------
-- 3) 選抜統計
-- ---------------------------------------------------------------------
create table public.school_admission_selection_stats (
  id uuid primary key default gen_random_uuid(),
  recruitment_unit_id uuid not null
    references public.admission_recruitment_units (id) on delete cascade,
  year integer not null,
  selection_stage_code text not null
    references public.admission_selection_stage_master (code)
    on update cascade on delete restrict,
  selection_track_code text not null
    references public.admission_selection_track_master (code)
    on update cascade on delete restrict,
  stage_label_raw text not null,
  track_label_raw text not null,
  selection_scope_raw text not null,
  population_scope_raw text,
  scope_key text not null,
  map_role_code text not null
    references public.admission_map_role_master (code)
    on update cascade on delete restrict,
  is_ratio_comparable boolean not null default false,
  capacity integer,
  applicants integer,
  examinees integer,
  admitted integer,
  exam_scope_raw text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint school_admission_selection_stats_year_range
    check (year between 2000 and 2100),
  constraint school_admission_selection_stats_scope_key_nonempty
    check (btrim(scope_key) <> ''),
  constraint school_admission_selection_stats_raw_labels_nonempty
    check (
      btrim(stage_label_raw) <> ''
      and btrim(track_label_raw) <> ''
      and btrim(selection_scope_raw) <> ''
    ),
  constraint school_admission_selection_stats_counts_nonnegative
    check (
      (capacity is null or capacity >= 0)
      and (applicants is null or applicants >= 0)
      and (examinees is null or examinees >= 0)
      and (admitted is null or admitted >= 0)
    ),
  constraint school_admission_selection_stats_comparable_requires_counts
    check (not is_ratio_comparable or (capacity > 0 and applicants is not null)),
  constraint school_admission_selection_stats_primary_total_valid
    check (
      map_role_code <> 'primary_total'
      or (selection_stage_code = 'primary' and is_ratio_comparable)
    ),
  unique (
    recruitment_unit_id,
    year,
    selection_stage_code,
    selection_track_code,
    scope_key
  )
);

comment on table public.school_admission_selection_stats is
  '募集単位・年度・段階・区分・scope別の公式選抜統計。倍率は保存せず capacity/applicants から表示時に算出する';
comment on column public.school_admission_selection_stats.stage_label_raw is
  '県公表資料に記載された募集段階の原文。正規分類は selection_stage_code';
comment on column public.school_admission_selection_stats.track_label_raw is
  '県公表資料に記載された選抜区分の原文。正規分類は selection_track_code';
comment on column public.school_admission_selection_stats.is_ratio_comparable is
  '募集人数と志願者数の母集団・募集単位が一致し、倍率比較に使える場合のみ true';

create index school_admission_selection_stats_unit_year_idx
  on public.school_admission_selection_stats (recruitment_unit_id, year desc);
create index school_admission_selection_stats_map_idx
  on public.school_admission_selection_stats (year desc, map_role_code, selection_stage_code)
  where is_ratio_comparable;

create table public.school_admission_stat_exam_components (
  stat_id uuid not null
    references public.school_admission_selection_stats (id) on delete cascade,
  component_code text not null
    references public.admission_exam_component_master (code)
    on update cascade on delete restrict,
  created_at timestamptz not null default now(),
  primary key (stat_id, component_code)
);

create table public.school_admission_stat_quality_flags (
  stat_id uuid not null
    references public.school_admission_selection_stats (id) on delete cascade,
  metric_code text,
  reason_code text not null
    references public.admission_quality_reason_master (code)
    on update cascade on delete restrict,
  note text,
  created_at timestamptz not null default now(),
  constraint school_admission_stat_quality_flags_metric_code
    check (metric_code is null or metric_code in (
      'capacity', 'applicants', 'examinees', 'admitted', 'selection_rule', 'exam_method'
    )),
  constraint school_admission_stat_quality_flags_note_nonempty
    check (note is null or btrim(note) <> ''),
  unique nulls not distinct (stat_id, metric_code, reason_code)
);

comment on table public.school_admission_stat_exam_components is
  '選抜統計に紐づく学力検査・面接等の検査要素';
comment on table public.school_admission_stat_quality_flags is
  '比較不能・要注意理由。metric_code=null は行全体へのフラグ';

create index school_admission_stat_quality_flags_reason_idx
  on public.school_admission_stat_quality_flags (reason_code);

-- ---------------------------------------------------------------------
-- 4) 指標別出典と旧行対応
-- ---------------------------------------------------------------------
create table public.school_admission_stat_sources (
  stat_id uuid not null
    references public.school_admission_selection_stats (id) on delete cascade,
  fact_kind_code text not null,
  official_url text not null,
  doc_title text not null,
  published_at date,
  source_page_or_table text,
  quoted_evidence text,
  last_verified_at timestamptz,
  last_http_status integer,
  created_at timestamptz not null default now(),
  primary key (stat_id, fact_kind_code),
  constraint school_admission_stat_sources_fact_kind_code
    check (fact_kind_code in (
      'capacity', 'applicants', 'examinees', 'admitted', 'selection_rule', 'exam_method'
    )),
  constraint school_admission_stat_sources_official_url_http
    check (official_url ~* '^https?://[^[:space:]]+$'),
  constraint school_admission_stat_sources_doc_title_nonempty
    check (btrim(doc_title) <> ''),
  constraint school_admission_stat_sources_page_nonempty
    check (source_page_or_table is null or btrim(source_page_or_table) <> ''),
  constraint school_admission_stat_sources_evidence_nonempty
    check (quoted_evidence is null or btrim(quoted_evidence) <> ''),
  constraint school_admission_stat_sources_evidence_length
    check (quoted_evidence is null or char_length(quoted_evidence) <= 80),
  constraint school_admission_stat_sources_http_status_range
    check (last_http_status is null or last_http_status between 100 and 599),
  constraint school_admission_stat_sources_verification_pair
    check (
      (last_http_status is null and last_verified_at is null)
      or (last_http_status is not null and last_verified_at is not null)
    )
);

create table public.school_admission_stat_legacy_links (
  stat_id uuid not null
    references public.school_admission_selection_stats (id) on delete cascade,
  legacy_stat_id uuid not null
    references public.school_admission_stats (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (stat_id, legacy_stat_id)
);

comment on table public.school_admission_stat_sources is
  'capacity等の指標ごとの公式出典。404も削除せず到達状態を保持する';
comment on table public.school_admission_stat_legacy_links is
  '旧 school_admission_stats と新統計の多対多対応。旧表自体は変更しない';

create index school_admission_stat_legacy_links_legacy_idx
  on public.school_admission_stat_legacy_links (legacy_stat_id);

-- updated_at をアプリ任せにしない。
create trigger set_updated_at
  before update on public.admission_recruitment_units
  for each row execute procedure extensions.moddatetime(updated_at);

create trigger set_updated_at
  before update on public.school_admission_selection_stats
  for each row execute procedure extensions.moddatetime(updated_at);

-- ---------------------------------------------------------------------
-- 5) 公開 read RLS。書き込み policy は作らず service role / migration に限定。
-- ---------------------------------------------------------------------
alter table public.admission_selection_stage_master enable row level security;
alter table public.admission_selection_track_master enable row level security;
alter table public.admission_recruitment_unit_kind_master enable row level security;
alter table public.admission_map_role_master enable row level security;
alter table public.admission_quality_reason_master enable row level security;
alter table public.admission_exam_component_master enable row level security;
alter table public.admission_recruitment_units enable row level security;
alter table public.admission_recruitment_unit_departments enable row level security;
alter table public.school_admission_selection_stats enable row level security;
alter table public.school_admission_stat_exam_components enable row level security;
alter table public.school_admission_stat_quality_flags enable row level security;
alter table public.school_admission_stat_sources enable row level security;
alter table public.school_admission_stat_legacy_links enable row level security;

create policy "Public read admission_selection_stage_master"
  on public.admission_selection_stage_master for select using (true);
create policy "Public read admission_selection_track_master"
  on public.admission_selection_track_master for select using (true);
create policy "Public read admission_recruitment_unit_kind_master"
  on public.admission_recruitment_unit_kind_master for select using (true);
create policy "Public read admission_map_role_master"
  on public.admission_map_role_master for select using (true);
create policy "Public read admission_quality_reason_master"
  on public.admission_quality_reason_master for select using (true);
create policy "Public read admission_exam_component_master"
  on public.admission_exam_component_master for select using (true);
create policy "Public read admission_recruitment_units"
  on public.admission_recruitment_units for select using (true);
create policy "Public read admission_recruitment_unit_departments"
  on public.admission_recruitment_unit_departments for select using (true);
create policy "Public read school_admission_selection_stats"
  on public.school_admission_selection_stats for select using (true);
create policy "Public read school_admission_stat_exam_components"
  on public.school_admission_stat_exam_components for select using (true);
create policy "Public read school_admission_stat_quality_flags"
  on public.school_admission_stat_quality_flags for select using (true);
create policy "Public read school_admission_stat_sources"
  on public.school_admission_stat_sources for select using (true);
create policy "Public read school_admission_stat_legacy_links"
  on public.school_admission_stat_legacy_links for select using (true);

-- ---------------------------------------------------------------------
-- 6) migration 自己検証。途中差分・seed 欠落は commit 前に停止する。
-- ---------------------------------------------------------------------
do $$
declare
  v_table text;
  v_expected_count integer;
  v_actual_count integer;
begin
  for v_table in select unnest(array[
    'admission_selection_stage_master',
    'admission_selection_track_master',
    'admission_recruitment_unit_kind_master',
    'admission_map_role_master',
    'admission_quality_reason_master',
    'admission_exam_component_master',
    'admission_recruitment_units',
    'admission_recruitment_unit_departments',
    'school_admission_selection_stats',
    'school_admission_stat_exam_components',
    'school_admission_stat_quality_flags',
    'school_admission_stat_sources',
    'school_admission_stat_legacy_links'
  ]) loop
    if to_regclass('public.' || v_table) is null then
      raise exception 'required admission table missing: %', v_table;
    end if;
    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_table and c.relrowsecurity
    ) then
      raise exception 'RLS is not enabled: %', v_table;
    end if;
  end loop;

  for v_table, v_expected_count in
    select * from (values
      ('admission_selection_stage_master', 4),
      ('admission_selection_track_master', 6),
      ('admission_recruitment_unit_kind_master', 7),
      ('admission_map_role_master', 5),
      ('admission_quality_reason_master', 11),
      ('admission_exam_component_master', 9)
    ) as expected(table_name, code_count)
  loop
    execute format('select count(*) from public.%I', v_table) into v_actual_count;
    if v_actual_count <> v_expected_count then
      raise exception 'master seed count mismatch: % expected %, actual %',
        v_table, v_expected_count, v_actual_count;
    end if;
  end loop;

  if not exists (
    select 1 from pg_constraint
     where conname = 'school_admission_selection_stats_comparable_requires_counts'
  ) or not exists (
    select 1 from pg_constraint
     where conname = 'school_admission_selection_stats_primary_total_valid'
  ) or not exists (
    select 1 from pg_constraint
     where conname = 'school_admission_selection_stats_raw_labels_nonempty'
  ) or not exists (
    select 1 from pg_constraint
     where conname = 'school_admission_stat_quality_flags_metric_code'
  ) or not exists (
    select 1 from pg_constraint
     where conname = 'school_admission_stat_sources_official_url_http'
  ) or not exists (
    select 1 from pg_constraint
     where conname = 'school_admission_stat_sources_evidence_length'
  ) then
    raise exception 'required admission integrity constraint missing';
  end if;

  raise notice 'admission selection schema verified: 13 tables, 42 master codes';
end $$;

commit;
