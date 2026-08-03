-- =====================================================================
-- v0.4.1: 関東の既存 active 偏差値に editorial_unverified を明示する
--
-- 対象は v0.3.1 で NULL のまま残した active 1,879 行だけである。
-- 群馬分を human_anchor_review へ一括昇格させない。群馬を含む全行が、
-- 個別の品質監査までは「未検証の編集推計」であることを正直に示す。
--
-- 冪等性: Supabase migration history により一度だけ適用する前提。手動で
-- 再実行した場合も、既に 1,879 行が backfill 済みなら検証だけで成功する。
-- 想定外の件数では止め、別環境への誤適用を防ぐ。
-- 本 migration は作成・レビュー用。適用は人間の承認後に行う。
-- =====================================================================

begin;

alter table public.school_deviation_values
  drop constraint if exists school_deviation_values_estimate_basis_check;

alter table public.school_deviation_values
  add constraint school_deviation_values_estimate_basis_check
  check (
    estimate_basis is null
    or estimate_basis in (
      'official_exam_distribution',
      'licensed_assessment',
      'human_anchor_review',
      'admin_override',
      'application_ratio_legacy',
      'editorial_unverified'
    )
  );

comment on column public.school_deviation_values.estimate_basis is
  '偏差値値の根拠区分。editorial_unverified は未検証の編集推計、application_ratio_legacy は履歴専用で active 不可。NULL は分類未完了の既存値を表す。';

do $$
declare
  expected_count constant integer := 1879;
  target_null_count integer;
  already_backfilled_count integer;
  updated_count integer := 0;
  remaining_active_null_count integer;
begin
  select count(*)
    into target_null_count
    from public.school_deviation_values
   where is_active = true
     and estimate_basis is null;

  select count(*)
    into already_backfilled_count
    from public.school_deviation_values
   where is_active = true
     and estimate_basis = 'editorial_unverified';

  if target_null_count = expected_count then
    update public.school_deviation_values
       set estimate_basis = 'editorial_unverified'
     where is_active = true
       and estimate_basis is null;

    get diagnostics updated_count = row_count;

    if updated_count <> target_null_count then
      raise exception
        'editorial_unverified backfill updated % rows; expected target count %',
        updated_count, target_null_count;
    end if;
  elsif target_null_count = 0 and already_backfilled_count = expected_count then
    raise notice 'editorial_unverified backfill already present (% rows); no rows updated', expected_count;
  else
    raise exception
      'editorial_unverified backfill expected % active NULL rows (or % already backfilled), got NULL=% / editorial_unverified=%',
      expected_count, expected_count, target_null_count, already_backfilled_count;
  end if;

  select count(*)
    into remaining_active_null_count
    from public.school_deviation_values
   where is_active = true
     and estimate_basis is null;

  if remaining_active_null_count <> 0 then
    raise exception
      'active rows with NULL estimate_basis remain after backfill: %',
      remaining_active_null_count;
  end if;

  select count(*)
    into already_backfilled_count
    from public.school_deviation_values
   where is_active = true
     and estimate_basis = 'editorial_unverified';

  if already_backfilled_count <> expected_count then
    raise exception
      'editorial_unverified backfill expected % active rows after update, got %',
      expected_count, already_backfilled_count;
  end if;
end;
$$;

commit;
