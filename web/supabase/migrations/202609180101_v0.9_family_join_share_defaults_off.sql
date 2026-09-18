-- C1: 家族招待を「開いただけで参加」から「名前を見て明示操作で参加」へ変え、
--     共有の既定を OFF にする。
--   1) family_members.share_favorites / share_notes の DEFAULT を false にする。
--      招待された人は共有オフから始まり、本人が set_family_share で ON にする。
--      **既存行は変更しない**（現在共有中の家族の設定を勝手に変えない）。
--      バックアップからの復元でも既定値が寛容側へ戻らなくなる。
--   2) preview_family_invite(): 受諾せずに参加先グループ名だけを返す読み取り専用 RPC。
--      受諾ページが「どの家族グループへの招待か」を表示してから確認を求めるために使う。
--      認可は accept_family_invite と同じ（実ログイン必須・匿名拒否・期限切れ拒否）。
-- 冪等性: alter ... set default / create or replace で再実行可能。
-- 適用前後の本番確認は supabase-migrate skill 経由で人間が実施すること。

begin;

alter table public.family_members
  alter column share_favorites set default false,
  alter column share_notes set default false;

create or replace function public.preview_family_invite(p_token uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_group_id uuid;
  v_name text;
  v_status text;
  v_expires_at timestamptz;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if coalesce(auth.jwt() ->> 'is_anonymous', 'false') = 'true' then
    raise exception 'anonymous users cannot accept family invitations';
  end if;

  select m.group_id, g.name, m.status, m.expires_at
    into v_group_id, v_name, v_status, v_expires_at
  from public.family_members m
  join public.family_groups g on g.id = m.group_id
  where m.invite_token = p_token;

  if v_group_id is null then
    raise exception 'invalid invitation';
  end if;

  if v_status = 'invited' then
    if v_expires_at is null or v_expires_at <= now() then
      raise exception 'invitation expired';
    end if;
  elsif not exists (
    -- 受諾済みの行でも、既にそのグループのメンバーなら accept は冪等に成功する。
    -- 確認画面もその場合だけは出せるようにする（それ以外は使用済み扱い）。
    select 1 from public.family_members
    where group_id = v_group_id and user_id = v_uid and status = 'active'
  ) then
    raise exception 'invitation already used';
  end if;

  return v_name;
end;
$$;

-- Supabase の function 作成 hook は PUBLIC だけでなく anon / authenticated にも
-- EXECUTE を直接付与するため、3 者を明示 revoke してから必要なロールだけ戻す。
revoke all on function public.preview_family_invite(uuid) from public, anon, authenticated;
grant execute on function public.preview_family_invite(uuid) to authenticated;

do $$
declare
  v_share_favorites text;
  v_share_notes text;
begin
  select column_default into v_share_favorites
  from information_schema.columns
  where table_schema = 'public' and table_name = 'family_members' and column_name = 'share_favorites';

  select column_default into v_share_notes
  from information_schema.columns
  where table_schema = 'public' and table_name = 'family_members' and column_name = 'share_notes';

  if v_share_favorites is distinct from 'false' then
    raise exception 'C1 assert failed: share_favorites default is %', coalesce(v_share_favorites, '(null)');
  end if;
  if v_share_notes is distinct from 'false' then
    raise exception 'C1 assert failed: share_notes default is %', coalesce(v_share_notes, '(null)');
  end if;
  if not has_function_privilege('authenticated', 'public.preview_family_invite(uuid)', 'execute') then
    raise exception 'C1 assert failed: authenticated cannot execute preview_family_invite';
  end if;
  if has_function_privilege('anon', 'public.preview_family_invite(uuid)', 'execute') then
    raise exception 'C1 assert failed: preview_family_invite is executable by anon';
  end if;
end;
$$;

commit;
