-- =====================================================================
-- v0.2.0 C4: 家族共有（family_groups / family_members）
--
-- 設計方針（plan_v0.2.0-release_c10_app-features.md §C4）:
--   - 親子（家族グループ）で「お気に入り」「学校メモ」を共有する。
--     個人偏差値記録（user_school_deviations）は機微なので共有しない
--     （「より閉じる側」を選択）。
--   - 招待は「推測不能な招待トークン（gen_random_uuid）付き URL」で行い、
--     受諾は本人のログイン操作でのみ成立する（member 追加はセルフサービス）。
--   - RLS は「自分が属するグループのメンバーが共有 ON にしたデータだけ」を
--     SELECT 可能にする。他人のグループは一切見えない。
--   - **書き込みは全て SECURITY DEFINER の RPC 関数経由**にし、テーブルへの
--     直接 INSERT/UPDATE/DELETE はクライアントから revoke する。これにより
--     「role の昇格・他人の行の改変・トークン列の読み取り」を型・権限の両面で塞ぐ。
--   - invite_token 列はクライアントに SELECT させない（列単位 grant で除外）。
--     招待作成関数がその場で 1 度だけトークンを返す。
--
-- rollback（適用を取り消す場合・依存順に drop）:
--   drop function if exists public.get_family_shared_favorites(uuid);
--   drop function if exists public.get_family_shared_notes(uuid);
--   drop function if exists public.delete_family_group(uuid);
--   drop function if exists public.remove_family_member(uuid);
--   drop function if exists public.leave_family_group(uuid);
--   drop function if exists public.set_family_share(uuid, boolean, boolean);
--   drop function if exists public.accept_family_invite(uuid);
--   drop function if exists public.create_family_invite(uuid);
--   drop function if exists public.create_family_group(text);
--   drop table if exists family_members;
--   drop table if exists family_groups;
--   drop function if exists public.user_group_ids();
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1) family_groups: 家族グループ本体
-- ---------------------------------------------------------------------
create table if not exists family_groups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null default '家族',
  created_at timestamptz not null default now(),
  constraint family_groups_name_len check (char_length(name) between 1 and 40)
);

create index if not exists family_groups_owner_idx on family_groups (owner_id);

alter table family_groups enable row level security;

-- ---------------------------------------------------------------------
-- 2) family_members: メンバー / 招待 / 共有スコープ
--    - user_id NULL = 未受諾の招待。受諾で auth.uid() が入る。
--    - invite_token は推測不能な UUID。列単位 grant で外から読ませない。
--    - share_favorites / share_notes = そのメンバーが自分のデータを
--      このグループに見せるかの本人コントロール（グループ単位）。
-- ---------------------------------------------------------------------
create table if not exists family_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references family_groups (id) on delete cascade,
  user_id uuid references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  status text not null default 'invited' check (status in ('invited', 'active')),
  invite_token uuid not null default gen_random_uuid(),
  share_favorites boolean not null default true,
  share_notes boolean not null default true,
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  -- 同一グループに同一ユーザーが 2 行入らない（NULL=未受諾は複数可＝招待を複数出せる）
  constraint family_members_group_user_key unique (group_id, user_id),
  constraint family_members_invite_token_key unique (invite_token)
);

create index if not exists family_members_group_idx on family_members (group_id);
create index if not exists family_members_user_idx on family_members (user_id);

alter table family_members enable row level security;

-- ---------------------------------------------------------------------
-- 3) user_group_ids(): auth.uid() が active メンバーであるグループ id 集合。
--    SECURITY DEFINER で family_members の RLS を通過するため、
--    ポリシー内でこれを使っても再帰しない（RLS 自己参照の無限ループ回避）。
-- ---------------------------------------------------------------------
create or replace function public.user_group_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select group_id
  from family_members
  where user_id = auth.uid()
    and status = 'active';
$$;

revoke all on function public.user_group_ids() from public;
grant execute on function public.user_group_ids() to authenticated;

-- ---------------------------------------------------------------------
-- RLS ポリシー: SELECT のみ。書き込みは全て RPC 関数経由。
-- ---------------------------------------------------------------------

-- family_groups: 自分が active メンバーのグループだけ見える
drop policy if exists family_groups_select on family_groups;
create policy family_groups_select on family_groups
  for select to authenticated
  using (id in (select public.user_group_ids()));

-- family_members: 自分の行 or 自分が属するグループの他メンバーだけ見える
drop policy if exists family_members_select on family_members;
create policy family_members_select on family_members
  for select to authenticated
  using (
    user_id = auth.uid()
    or group_id in (select public.user_group_ids())
  );

-- クライアントからの直接書き込みを塞ぐ（全て RPC 経由）。
revoke insert, update, delete on family_groups from anon, authenticated;
revoke insert, update, delete on family_members from anon, authenticated;

-- 読み取り grant。family_members は invite_token を除いた列だけ許可する
-- （招待トークンはクライアントに読ませない。作成関数が 1 度だけ返す）。
grant select on family_groups to authenticated;
revoke select on family_members from anon, authenticated;
grant select
  (id, group_id, user_id, role, status, share_favorites, share_notes, invited_at, accepted_at, created_at)
  on family_members to authenticated;

-- ---------------------------------------------------------------------
-- 4) RPC 関数群（SECURITY DEFINER・認可チェックは関数内で行う）
-- ---------------------------------------------------------------------

-- 4-1) グループ作成 + 作成者を owner/active メンバーとして登録
create or replace function public.create_family_group(p_name text default '家族')
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_group_id uuid;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;

  insert into family_groups (owner_id, name)
  values (v_uid, coalesce(nullif(btrim(p_name), ''), '家族'))
  returning id into v_group_id;

  insert into family_members (group_id, user_id, role, status, accepted_at)
  values (v_group_id, v_uid, 'owner', 'active', now());

  return v_group_id;
end;
$$;

revoke all on function public.create_family_group(text) from public;
grant execute on function public.create_family_group(text) to authenticated;

-- 4-2) 招待作成（owner のみ）。招待行を作り、その招待トークンを返す。
create or replace function public.create_family_invite(p_group_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_token uuid;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if not exists (
    select 1 from family_groups g where g.id = p_group_id and g.owner_id = v_uid
  ) then
    raise exception 'only the group owner can invite';
  end if;

  insert into family_members (group_id, role, status)
  values (p_group_id, 'member', 'invited')
  returning invite_token into v_token;

  return v_token;
end;
$$;

revoke all on function public.create_family_invite(uuid) from public;
grant execute on function public.create_family_invite(uuid) to authenticated;

-- 4-3) 招待受諾。トークンが有効な招待行に auth.uid() を紐づけて active 化。
--      既にそのグループのメンバーなら受諾済み扱いでグループ id を返す。
create or replace function public.accept_family_invite(p_token uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_group_id uuid;
  v_status text;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;

  select group_id, status into v_group_id, v_status
  from family_members
  where invite_token = p_token
  for update;

  if v_group_id is null then
    raise exception 'invalid invitation';
  end if;

  -- 既に同じグループのメンバーなら、余分な招待行は消して既存メンバーシップを返す
  if exists (
    select 1 from family_members
    where group_id = v_group_id and user_id = v_uid
  ) then
    delete from family_members
    where invite_token = p_token and status = 'invited' and user_id is null;
    return v_group_id;
  end if;

  if v_status <> 'invited' then
    raise exception 'invitation already used';
  end if;

  update family_members
  set user_id = v_uid,
      status = 'active',
      accepted_at = now()
  where invite_token = p_token;

  return v_group_id;
end;
$$;

revoke all on function public.accept_family_invite(uuid) from public;
grant execute on function public.accept_family_invite(uuid) to authenticated;

-- 4-4) 共有スコープ変更（本人のメンバーシップのみ）
create or replace function public.set_family_share(
  p_group_id uuid,
  p_share_favorites boolean,
  p_share_notes boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;

  update family_members
  set share_favorites = coalesce(p_share_favorites, share_favorites),
      share_notes = coalesce(p_share_notes, share_notes)
  where group_id = p_group_id
    and user_id = v_uid
    and status = 'active';

  if not found then
    raise exception 'not a member of this group';
  end if;
end;
$$;

revoke all on function public.set_family_share(uuid, boolean, boolean) from public;
grant execute on function public.set_family_share(uuid, boolean, boolean) to authenticated;

-- 4-5) 退会（自分のメンバーシップを削除）。owner は退会不可（グループ削除で対応）。
create or replace function public.leave_family_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;

  select role into v_role
  from family_members
  where group_id = p_group_id and user_id = v_uid;

  if v_role is null then
    raise exception 'not a member of this group';
  end if;
  if v_role = 'owner' then
    raise exception 'owner cannot leave; delete the group instead';
  end if;

  delete from family_members
  where group_id = p_group_id and user_id = v_uid;
end;
$$;

revoke all on function public.leave_family_group(uuid) from public;
grant execute on function public.leave_family_group(uuid) to authenticated;

-- 4-6) メンバー / 招待の解除（owner のみ）。owner 自身の行は消せない。
create or replace function public.remove_family_member(p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_group_id uuid;
  v_role text;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;

  select group_id, role into v_group_id, v_role
  from family_members
  where id = p_member_id;

  if v_group_id is null then
    raise exception 'member not found';
  end if;
  if not exists (
    select 1 from family_groups g where g.id = v_group_id and g.owner_id = v_uid
  ) then
    raise exception 'only the group owner can remove members';
  end if;
  if v_role = 'owner' then
    raise exception 'cannot remove the group owner';
  end if;

  delete from family_members where id = p_member_id;
end;
$$;

revoke all on function public.remove_family_member(uuid) from public;
grant execute on function public.remove_family_member(uuid) to authenticated;

-- 4-7) グループ削除（owner のみ・メンバーは FK cascade で消える）
create or replace function public.delete_family_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if not exists (
    select 1 from family_groups g where g.id = p_group_id and g.owner_id = v_uid
  ) then
    raise exception 'only the group owner can delete the group';
  end if;

  delete from family_groups where id = p_group_id;
end;
$$;

revoke all on function public.delete_family_group(uuid) from public;
grant execute on function public.delete_family_group(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5) 共有データ読み取り RPC（SECURITY DEFINER）
--    既存の user_school_favorites / user_school_notes の RLS は **一切変更しない**。
--    理由: useUserData は user_id で絞らず RLS 頼みで「自分の行」を取得している。
--    そこへ family 用の permissive SELECT ポリシーを足すと、家族の行まで
--    自分のお気に入りマップに混入してしまう。よって共有データの取得は
--    「特定グループ・共有 ON の他メンバーの行だけ」を返す専用 RPC に閉じる。
--    関数内で「呼び出し元がそのグループの active メンバーか」を必ず検査する。
-- ---------------------------------------------------------------------

-- 5-1) 家族のお気に入り（share_favorites=true の他メンバー分）
create or replace function public.get_family_shared_favorites(p_group_id uuid)
returns table (owner_id uuid, school_id uuid, priority int, status text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if not exists (
    select 1 from family_members
    where group_id = p_group_id and user_id = v_uid and status = 'active'
  ) then
    raise exception 'not a member of this group';
  end if;

  return query
    select f.user_id, f.school_id, f.priority::int, f.status::text
    from user_school_favorites f
    join family_members m
      on m.user_id = f.user_id
     and m.group_id = p_group_id
     and m.status = 'active'
     and m.share_favorites = true
    where f.user_id <> v_uid;
end;
$$;

revoke all on function public.get_family_shared_favorites(uuid) from public;
grant execute on function public.get_family_shared_favorites(uuid) to authenticated;

-- 5-2) 家族のメモ（share_notes=true の他メンバー分）
create or replace function public.get_family_shared_notes(p_group_id uuid)
returns table (owner_id uuid, school_id uuid, note text, commute_note text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if not exists (
    select 1 from family_members
    where group_id = p_group_id and user_id = v_uid and status = 'active'
  ) then
    raise exception 'not a member of this group';
  end if;

  return query
    select n.user_id, n.school_id, n.note::text, n.commute_note::text
    from user_school_notes n
    join family_members m
      on m.user_id = n.user_id
     and m.group_id = p_group_id
     and m.status = 'active'
     and m.share_notes = true
    where n.user_id <> v_uid;
end;
$$;

revoke all on function public.get_family_shared_notes(uuid) from public;
grant execute on function public.get_family_shared_notes(uuid) to authenticated;

commit;
