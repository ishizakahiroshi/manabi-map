-- v0.4 release-candidate contract for stable department identity and complete
-- school lifecycle evidence. This file is generated for review only in the
-- west-japan one-shot run; production application requires separate approval.
--
-- Rollback must be data-aware. New record keys and lifecycle evidence may be
-- referenced by release bundles, so do not drop these columns after data load
-- without first restoring the pre-v0.4 backup and verifying dependent rows.

begin;

alter table school_departments add column if not exists record_key text;
update school_departments
   set record_key = 'department-' || id::text
 where record_key is null;
alter table school_departments
  alter column record_key set default ('department-' || gen_random_uuid()::text),
  alter column record_key set not null;
create unique index if not exists school_departments_record_key_key
  on school_departments (record_key);

alter table schools add column if not exists recruitment_ended_year integer;
alter table schools drop constraint if exists schools_recruitment_ended_year_range;
alter table schools add constraint schools_recruitment_ended_year_range
  check (recruitment_ended_year is null or recruitment_ended_year between 1900 and 2100);

alter table school_relationships add column if not exists effective_admission_year integer;
alter table school_relationships add column if not exists evidence_status text;
update school_relationships
   set evidence_status = 'official_confirmed'
 where evidence_status is null;
alter table school_relationships alter column evidence_status set not null;
alter table school_relationships alter column effective_on drop not null;
alter table school_relationships drop constraint if exists school_relationships_effective_admission_year_range;
alter table school_relationships add constraint school_relationships_effective_admission_year_range
  check (effective_admission_year is null or effective_admission_year between 1900 and 2100);
alter table school_relationships drop constraint if exists school_relationships_evidence_status_check;
alter table school_relationships add constraint school_relationships_evidence_status_check
  check (evidence_status in ('official_confirmed', 'official_partial', 'unresolved'));
alter table school_relationships drop constraint if exists school_relationships_effective_boundary_required;
alter table school_relationships add constraint school_relationships_effective_boundary_required
  check (effective_on is not null or effective_admission_year is not null);
alter table school_relationships drop constraint if exists school_relationships_unique;
drop index if exists school_relationships_unique_null_safe;
create unique index school_relationships_unique_null_safe
  on school_relationships (
    predecessor_school_id,
    successor_school_id,
    relationship_type_code,
    coalesce(effective_on, date '0001-01-01'),
    coalesce(effective_admission_year, -1)
  );

create or replace function sync_school_status_compatibility()
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

drop trigger if exists schools_status_compatibility_sync on schools;
create trigger schools_status_compatibility_sync
before insert or update of lifecycle_status_code, recruitment_status_code on schools
for each row execute function sync_school_status_compatibility();

comment on column school_departments.record_key is
  'Stable name-independent department identity used by audited import bundles.';
comment on column schools.recruitment_ended_year is
  'Admission year in which recruitment ended when an exact date is not official.';
comment on column school_relationships.effective_admission_year is
  'Admission-year boundary used to assign historical facts to legal school identities.';
comment on column school_relationships.evidence_status is
  'Official evidence completeness: official_confirmed, official_partial, or unresolved.';

do $$
declare n integer;
begin
  select count(*) into n
    from school_departments
   where record_key is null or btrim(record_key) = '';
  if n <> 0 then raise exception 'department record_key backfill failed: %', n; end if;

  select count(*) - count(distinct record_key) into n from school_departments;
  if n <> 0 then raise exception 'duplicate department record_key: %', n; end if;

  select count(*) into n
    from school_relationships
   where effective_on is null and effective_admission_year is null;
  if n <> 0 then raise exception 'relationship effective boundary missing: %', n; end if;
end $$;

commit;
