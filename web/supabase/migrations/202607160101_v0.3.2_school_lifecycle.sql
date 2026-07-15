-- v0.3.2: legal school lifecycle, recruitment state, succession, and name history.
--
-- Rollback (data-preserving order):
--   1. drop school relationship/name-history tables and their policies;
--   2. drop compatibility sync triggers/functions;
--   3. drop the lifecycle/recruitment FKs and added schools columns;
--   4. drop the three master tables.
-- Backfill rows that use these structures must be reversed before this schema rollback.

begin;

create table if not exists school_lifecycle_status_master (
  code text primary key,
  label_ja text not null,
  label_en text not null,
  is_map_active boolean not null,
  forces_not_recruiting boolean not null default false,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint school_lifecycle_status_master_code_nonempty check (btrim(code) <> '')
);

insert into school_lifecycle_status_master
  (code, label_ja, label_en, is_map_active, forces_not_recruiting, sort_order, notes)
values
  ('planned', '開校予定', 'Planned', false, false, 10, '法的設置または開校前。募集状態は別列で表す'),
  ('active', '在校', 'Active', true, false, 20, '通常の現存校'),
  ('closing', '在校生のみ', 'Closing', true, false, 30, '新規募集終了後も在校生がいる状態'),
  ('closed', '閉校', 'Closed', false, true, 40, '法的に閉校済み')
on conflict (code) do update set
  label_ja = excluded.label_ja,
  label_en = excluded.label_en,
  is_map_active = excluded.is_map_active,
  forces_not_recruiting = excluded.forces_not_recruiting,
  sort_order = excluded.sort_order,
  notes = excluded.notes,
  updated_at = now();

create table if not exists school_recruitment_status_master (
  code text primary key,
  label_ja text not null,
  label_en text not null,
  is_recruiting_compat boolean not null,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint school_recruitment_status_master_code_nonempty check (btrim(code) <> '')
);

insert into school_recruitment_status_master
  (code, label_ja, label_en, is_recruiting_compat, sort_order, notes)
values
  ('unknown', '募集状態未確認', 'Recruitment status unknown', false, 10, 'booleanだけから募集停止を推論しないための初期値'),
  ('not_started', '募集開始前', 'Recruitment not started', false, 20, '開校予定校等で募集開始前'),
  ('recruiting', '募集中', 'Recruiting', true, 30, '外部から高校段階へ入学できる'),
  ('no_external_high_school_intake', '高校段階の外部募集なし', 'No external upper-secondary intake', false, 40, '現存する中等教育学校等'),
  ('stopped', '募集終了', 'Recruitment stopped', false, 50, '学校再編等により新規募集を終了')
on conflict (code) do update set
  label_ja = excluded.label_ja,
  label_en = excluded.label_en,
  is_recruiting_compat = excluded.is_recruiting_compat,
  sort_order = excluded.sort_order,
  notes = excluded.notes,
  updated_at = now();

create table if not exists school_relationship_type_master (
  code text primary key,
  label_ja text not null,
  label_en text not null,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint school_relationship_type_master_code_nonempty check (btrim(code) <> '')
);

insert into school_relationship_type_master (code, label_ja, label_en, sort_order, notes)
values
  ('renamed_to', '改称', 'Renamed to', 10, '法的学校identityを維持する改称。通常はname historyを優先する'),
  ('merged_into', '統合', 'Merged into', 20, '複数校の統合による後継'),
  ('split_into', '分割', 'Split into', 30, '一校から複数校への分割'),
  ('reorganized_into', '再編', 'Reorganized into', 40, '統合以外の制度的な再編'),
  ('succeeded_by', '後継', 'Succeeded by', 50, '一般的な前身・後継関係')
on conflict (code) do update set
  label_ja = excluded.label_ja,
  label_en = excluded.label_en,
  sort_order = excluded.sort_order,
  notes = excluded.notes,
  updated_at = now();

alter table schools add column if not exists record_key text;
update schools set record_key = 'school-' || id::text where record_key is null;
alter table schools alter column record_key set default ('school-' || gen_random_uuid()::text);
alter table schools alter column record_key set not null;
create unique index if not exists schools_record_key_key on schools (record_key);

alter table schools add column if not exists lifecycle_status_code text;
alter table schools add column if not exists recruitment_status_code text;
alter table schools add column if not exists legally_established_on date;
alter table schools add column if not exists opened_on date;
alter table schools add column if not exists recruitment_ended_on date;
alter table schools add column if not exists closed_on date;
alter table schools add column if not exists status_official_url text;
alter table schools add column if not exists status_note text;

update schools
set lifecycle_status_code = case when is_active then 'active' else 'closed' end
where lifecycle_status_code is null;

update schools
set recruitment_status_code = case
  when is_recruiting then 'recruiting'
  when is_integrated then 'no_external_high_school_intake'
  else 'unknown'
end
where recruitment_status_code is null;

alter table schools alter column lifecycle_status_code set default 'active';
alter table schools alter column lifecycle_status_code set not null;
alter table schools alter column recruitment_status_code set default 'recruiting';
alter table schools alter column recruitment_status_code set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'schools_lifecycle_status_code_fkey') then
    alter table schools
      add constraint schools_lifecycle_status_code_fkey
      foreign key (lifecycle_status_code)
      references school_lifecycle_status_master(code)
      on update cascade on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'schools_recruitment_status_code_fkey') then
    alter table schools
      add constraint schools_recruitment_status_code_fkey
      foreign key (recruitment_status_code)
      references school_recruitment_status_master(code)
      on update cascade on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'schools_lifecycle_date_order') then
    alter table schools
      add constraint schools_lifecycle_date_order check (
        (legally_established_on is null or opened_on is null or opened_on >= legally_established_on)
        and (opened_on is null or closed_on is null or closed_on >= opened_on)
        and (recruitment_ended_on is null or closed_on is null or closed_on >= recruitment_ended_on)
      );
  end if;
end $$;

create or replace function sync_school_status_compatibility()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  lifecycle_active boolean;
  recruitment_active boolean;
begin
  select is_map_active into strict lifecycle_active
  from school_lifecycle_status_master where code = new.lifecycle_status_code;

  select is_recruiting_compat into strict recruitment_active
  from school_recruitment_status_master where code = new.recruitment_status_code;

  new.is_active := lifecycle_active;
  new.is_recruiting := recruitment_active;
  return new;
end;
$$;

drop trigger if exists schools_status_compatibility_sync on schools;
create trigger schools_status_compatibility_sync
before update of lifecycle_status_code, recruitment_status_code on schools
for each row execute function sync_school_status_compatibility();

create table if not exists school_relationships (
  id uuid primary key default gen_random_uuid(),
  predecessor_school_id uuid not null,
  successor_school_id uuid not null,
  relationship_type_code text not null,
  effective_on date not null,
  official_url text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint school_relationships_predecessor_school_id_fkey
    foreign key (predecessor_school_id) references schools(id) on delete restrict,
  constraint school_relationships_successor_school_id_fkey
    foreign key (successor_school_id) references schools(id) on delete restrict,
  constraint school_relationships_relationship_type_code_fkey
    foreign key (relationship_type_code) references school_relationship_type_master(code)
    on update cascade on delete restrict,
  constraint school_relationships_no_self_link check (predecessor_school_id <> successor_school_id),
  constraint school_relationships_official_url_http check (official_url ~ '^https?://'),
  constraint school_relationships_unique unique
    (predecessor_school_id, successor_school_id, relationship_type_code, effective_on)
);

create index if not exists school_relationships_predecessor_idx
  on school_relationships (predecessor_school_id, effective_on desc);
create index if not exists school_relationships_successor_idx
  on school_relationships (successor_school_id, effective_on desc);

create table if not exists school_name_history (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  name text not null,
  name_kana text,
  valid_from date,
  valid_to date,
  official_url text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint school_name_history_school_id_fkey
    foreign key (school_id) references schools(id) on delete restrict,
  constraint school_name_history_name_nonempty check (btrim(name) <> ''),
  constraint school_name_history_date_order check
    (valid_from is null or valid_to is null or valid_to >= valid_from),
  constraint school_name_history_official_url_http check (official_url ~ '^https?://')
);

create unique index if not exists school_name_history_unique
  on school_name_history (school_id, name, coalesce(valid_from, date '0001-01-01'));
create index if not exists school_name_history_school_idx
  on school_name_history (school_id, valid_from desc nulls last);

alter table school_lifecycle_status_master enable row level security;
alter table school_recruitment_status_master enable row level security;
alter table school_relationship_type_master enable row level security;
alter table school_relationships enable row level security;
alter table school_name_history enable row level security;

drop policy if exists "Public read school lifecycle statuses" on school_lifecycle_status_master;
create policy "Public read school lifecycle statuses"
  on school_lifecycle_status_master for select to anon, authenticated using (true);
drop policy if exists "Public read school recruitment statuses" on school_recruitment_status_master;
create policy "Public read school recruitment statuses"
  on school_recruitment_status_master for select to anon, authenticated using (true);
drop policy if exists "Public read school relationship types" on school_relationship_type_master;
create policy "Public read school relationship types"
  on school_relationship_type_master for select to anon, authenticated using (true);
drop policy if exists "Public read school relationships" on school_relationships;
create policy "Public read school relationships"
  on school_relationships for select to anon, authenticated using (true);
drop policy if exists "Public read school name history" on school_name_history;
create policy "Public read school name history"
  on school_name_history for select to anon, authenticated using (true);

grant select on school_lifecycle_status_master to anon, authenticated;
grant select on school_recruitment_status_master to anon, authenticated;
grant select on school_relationship_type_master to anon, authenticated;
grant select on school_relationships to anon, authenticated;
grant select on school_name_history to anon, authenticated;
revoke insert, update, delete on school_lifecycle_status_master from anon, authenticated;
revoke insert, update, delete on school_recruitment_status_master from anon, authenticated;
revoke insert, update, delete on school_relationship_type_master from anon, authenticated;
revoke insert, update, delete on school_relationships from anon, authenticated;
revoke insert, update, delete on school_name_history from anon, authenticated;

comment on column schools.record_key is 'Stable, name-independent identifier used by data bundles and imports.';
comment on column schools.lifecycle_status_code is 'Legal/operational existence state; orthogonal to recruitment state.';
comment on column schools.recruitment_status_code is 'Upper-secondary recruitment state; orthogonal to lifecycle state.';
comment on table school_relationships is 'Directed legal-school predecessor/successor relationships.';
comment on table school_name_history is 'Name history for the same legal school identity; not a substitute for succession.';

commit;
