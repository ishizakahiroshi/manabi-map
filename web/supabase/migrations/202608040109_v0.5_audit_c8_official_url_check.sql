-- v0.5 audit C8: schools.official_url を http(s) に限定する。
-- validate 前に作者が不正値件数を確認し、既存データを修正してから適用する。
--
-- rollback: alter table public.schools drop constraint if exists schools_official_url_scheme;
--   （制約の削除のみ。baseline に同名制約は無いため drop で完全に元へ戻る。データには影響しない）
--   （適用前に手作業で直した official_url の値は戻らない。必要なら別途データを復元する）

begin;

-- 適用前確認:
-- select count(*)
--   from public.schools
--  where official_url is not null
--    and official_url !~* '^https?://[^[:space:]]+$';
alter table public.schools
  drop constraint if exists schools_official_url_scheme;
alter table public.schools
  add constraint schools_official_url_scheme
  check (official_url is null or official_url ~* '^https?://[^[:space:]]+$')
  not valid;
alter table public.schools
  validate constraint schools_official_url_scheme;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.schools'::regclass
      and conname = 'schools_official_url_scheme'
  ) then
    raise exception 'C8 assert failed: schools official_url scheme constraint is missing';
  end if;
end;
$$;

commit;
