-- =====================================================================
-- v0.2.1: 偏差値修正ワークフローの権限 tightening
--
-- RLS では school_deviation_values は SELECT policy のみなので直接更新は拒否される。
-- ただし anon/authenticated に広い table privilege が残っていると監査時に危険に見えるため、
-- 権限レベルでも「公開読み取り + RPC 経由の管理者更新」だけに絞る。
-- =====================================================================

begin;

revoke insert, update, delete, truncate, references, trigger
  on public.school_deviation_values
  from anon, authenticated;

grant select on public.school_deviation_values to anon, authenticated;

revoke all privileges on public.admin_users from anon, authenticated;
grant select (user_id, note, created_at) on public.admin_users to authenticated;

revoke all on function public.is_admin() from public, anon, authenticated;
grant execute on function public.is_admin() to authenticated;

revoke all on function public.correct_school_deviation(uuid, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.correct_school_deviation(uuid, integer, text, text)
  to authenticated;

revoke all on function public.get_deviation_review_queue(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.get_deviation_review_queue(uuid, integer)
  to authenticated;

commit;
