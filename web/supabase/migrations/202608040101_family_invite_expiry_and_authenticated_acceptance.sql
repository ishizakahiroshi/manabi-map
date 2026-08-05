-- F17/F18: 家族招待を 7 日で失効させ、匿名ユーザーの受諾を拒否する。
-- 冪等性: 列・index・RPC は if not exists / create or replace で再実行可能。
-- 適用前後の本番確認は supabase-migrate skill 経由で人間が実施すること。

begin;

alter table public.family_members
  add column if not exists expires_at timestamptz;

-- 既存の未受諾招待にも同じ TTL を適用する。active 行に期限は持たせない。
update public.family_members
set expires_at = invited_at + interval '7 days'
where status = 'invited'
  and expires_at is null;

create index if not exists family_members_open_invite_expiry_idx
  on public.family_members (expires_at)
  where status = 'invited';

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
    select 1 from public.family_groups g where g.id = p_group_id and g.owner_id = v_uid
  ) then
    raise exception 'only the group owner can invite';
  end if;

  -- 期限切れ招待は新しい URL を作る前に掃除する。
  delete from public.family_members
  where group_id = p_group_id
    and status = 'invited'
    and expires_at <= now();

  insert into public.family_members (group_id, role, status, expires_at)
  values (p_group_id, 'member', 'invited', now() + interval '7 days')
  returning invite_token into v_token;

  return v_token;
end;
$$;

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
  v_expires_at timestamptz;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if coalesce(auth.jwt() ->> 'is_anonymous', 'false') = 'true' then
    raise exception 'anonymous users cannot accept family invitations';
  end if;

  select group_id, status, expires_at
    into v_group_id, v_status, v_expires_at
  from public.family_members
  where invite_token = p_token
  for update;

  if v_group_id is null then
    raise exception 'invalid invitation';
  end if;
  if v_status <> 'invited' then
    raise exception 'invitation already used';
  end if;
  if v_expires_at is null or v_expires_at <= now() then
    raise exception 'invitation expired';
  end if;

  if exists (
    select 1 from public.family_members
    where group_id = v_group_id and user_id = v_uid
  ) then
    delete from public.family_members
    where invite_token = p_token and status = 'invited' and user_id is null;
    return v_group_id;
  end if;

  update public.family_members
  set user_id = v_uid,
      status = 'active',
      accepted_at = now(),
      expires_at = null
  where invite_token = p_token;

  return v_group_id;
end;
$$;

create or replace function public.revoke_family_invite(p_token uuid)
returns void
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

  select group_id into v_group_id
  from public.family_members
  where invite_token = p_token and status = 'invited';

  if v_group_id is null then
    raise exception 'invitation not found';
  end if;
  if not exists (
    select 1 from public.family_groups g where g.id = v_group_id and g.owner_id = v_uid
  ) then
    raise exception 'only the group owner can revoke invitations';
  end if;

  delete from public.family_members
  where invite_token = p_token and status = 'invited';
end;
$$;

revoke all on function public.create_family_invite(uuid) from public;
grant execute on function public.create_family_invite(uuid) to authenticated;
revoke all on function public.accept_family_invite(uuid) from public;
grant execute on function public.accept_family_invite(uuid) to authenticated;
revoke all on function public.revoke_family_invite(uuid) from public;
grant execute on function public.revoke_family_invite(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'family_members' and column_name = 'expires_at'
  ) then
    raise exception 'F17 assert failed: family_members.expires_at is missing';
  end if;
end;
$$;

commit;
