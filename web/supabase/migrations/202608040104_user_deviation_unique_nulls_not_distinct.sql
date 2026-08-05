-- F21/F24: NULL の department_id を含む重複を掃除し、unique nulls not distinct を適用する。
-- 冪等性: 旧制約名はカタログから特定するため、歴史 migration のプレースホルダに依存しない。

begin;

with ranked as (
  select ctid,
         row_number() over (
           partition by user_id, school_id, department_id
           order by updated_at desc nulls last, ctid desc
         ) as rn
  from public.user_school_deviations
)
delete from public.user_school_deviations d
using ranked r
where d.ctid = r.ctid and r.rn > 1;

do $$
declare
  v_constraint_name text;
begin
  select c.conname into v_constraint_name
  from pg_constraint c
  where c.conrelid = 'public.user_school_deviations'::regclass
    and c.contype = 'u'
    and pg_get_constraintdef(c.oid) like 'UNIQUE (user_id, school_id, department_id)%';

  if v_constraint_name is not null then
    execute format('alter table public.user_school_deviations drop constraint %I', v_constraint_name);
  end if;
end;
$$;

alter table public.user_school_deviations
  drop constraint if exists user_school_deviations_user_school_dept_key;
alter table public.user_school_deviations
  add constraint user_school_deviations_user_school_dept_key
  unique nulls not distinct (user_id, school_id, department_id);

do $$
begin
  if exists (
    select 1
    from public.user_school_deviations
    group by user_id, school_id, department_id
    having count(*) > 1
  ) then
    raise exception 'F21 assert failed: duplicate user_school_deviations remain';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_school_deviations'::regclass
      and conname = 'user_school_deviations_user_school_dept_key'
      and connullsnotdistinct
  ) then
    raise exception 'F21 assert failed: unique nulls not distinct constraint is missing';
  end if;
end;
$$;

commit;
