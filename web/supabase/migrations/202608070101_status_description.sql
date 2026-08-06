-- =====================================================================
-- C3: 公開用の学校状態説明を status_note から分離する。
--
-- status_note は収集作業の内部記録として残し、status_description は
-- school_field_sources に一次資料が登録された値だけを公開 API に出す。
--
-- rollback:
--   delete from public.school_field_source_field_master
--    where code = 'schools.status_description';
--   alter table public.schools drop column if exists status_description;
-- =====================================================================

begin;

alter table public.schools
  add column if not exists status_description text;

comment on column public.schools.status_description is
  '一次資料で確認した学校状態の公開用説明。収集作業の内部記録は status_note に残す';

insert into public.school_field_source_field_master
  (code, table_name, column_name, label_ja, sort_order, notes)
values
  (
    'schools.status_description',
    'schools',
    'status_description',
    '学校状態の説明',
    110,
    '公開用。収集作業の記録である status_note とは別。一次資料の出典がある値だけを公開する'
  )
on conflict (code) do update
   set table_name = excluded.table_name,
       column_name = excluded.column_name,
       label_ja = excluded.label_ja,
       sort_order = excluded.sort_order,
       is_active = true,
       notes = excluded.notes;

do $$
begin
  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'schools'
       and column_name = 'status_description'
  ) then
    raise exception 'schools.status_description column is missing';
  end if;

  if not exists (
    select 1
      from public.school_field_source_field_master
     where code = 'schools.status_description'
       and table_name = 'schools'
       and column_name = 'status_description'
       and is_active
  ) then
    raise exception 'schools.status_description source field master row is missing';
  end if;
end $$;

commit;
