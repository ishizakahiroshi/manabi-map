-- =====================================================================
-- v0.3.1: school_deviation_values.estimate_basis — 根拠区分の恒久化
--
-- 旧段階②（志願倍率由来）の値を note の自由記述だけに頼らず隔離する。
-- application_ratio_legacy は履歴として保持するが、active 化を DB で拒否する。
-- 本 migration は SQL 作成・レビュー用。適用は人間が承認してから行う。
-- =====================================================================

begin;

alter table public.school_deviation_values
  add column estimate_basis text;

alter table public.school_deviation_values
  add constraint school_deviation_values_estimate_basis_check
  check (
    estimate_basis is null
    or estimate_basis in (
      'official_exam_distribution',
      'licensed_assessment',
      'human_anchor_review',
      'admin_override',
      'application_ratio_legacy'
    )
  );

comment on column public.school_deviation_values.estimate_basis is
  '偏差値値の根拠区分。NULL は既存値の承認フロー未確定を表す。application_ratio_legacy は履歴専用で active 不可。';

-- 旧暫定非表示 SQL と同じ条件で 451 件を履歴区分へ backfill する。
-- active 行が残っている場合は、後段の制約追加で transaction 全体を失敗させる。
update public.school_deviation_values
   set estimate_basis = 'application_ratio_legacy'
 where estimate_method like 'v1f_%'
   and note like '志願倍率%'
   and source_type = 'manabi_estimate';

-- 想定件数・active 混入を migration 時点で検査する。
do $$
declare
  legacy_count integer;
  active_legacy_count integer;
begin
  select count(*)
    into legacy_count
    from public.school_deviation_values
   where estimate_basis = 'application_ratio_legacy';

  if legacy_count <> 451 then
    raise exception
      'estimate_basis backfill expected 451 rows, got %', legacy_count;
  end if;

  select count(*)
    into active_legacy_count
    from public.school_deviation_values
   where estimate_basis = 'application_ratio_legacy'
     and is_active = true;

  if active_legacy_count <> 0 then
    raise exception
      'application_ratio_legacy active rows must be 0, got %', active_legacy_count;
  end if;
end;
$$;

alter table public.school_deviation_values
  add constraint school_deviation_values_legacy_basis_inactive_check
  check (not (estimate_basis = 'application_ratio_legacy' and is_active = true));

-- 既存 active 1,879 件（関東・群馬の v1h 系）は、承認フロー確定まで
-- estimate_basis = NULL のまま残す。ここで推測して埋めない。

-- 適用後の検証（期待値）:
--   select count(*)
--     from public.school_deviation_values
--    where estimate_basis = 'application_ratio_legacy'; -- 451
--
--   select count(*)
--     from public.school_deviation_values
--    where estimate_basis = 'application_ratio_legacy' and is_active; -- 0
--
-- 制約違反 INSERT の確認（実行時は transaction を rollback する）:
--   begin;
--   insert into public.school_deviation_values
--     (school_id, department_id, value, year, source_type,
--      estimate_method, is_active, estimate_basis)
--   select school_id, department_id, value, year, source_type,
--          estimate_method, true, 'application_ratio_legacy'
--     from public.school_deviation_values
--    where estimate_basis = 'application_ratio_legacy'
--    limit 1;
--   -- ERROR: new row for relation "school_deviation_values"
--   --        violates check constraint "school_deviation_values_legacy_basis_inactive_check"
--   rollback;

commit;
