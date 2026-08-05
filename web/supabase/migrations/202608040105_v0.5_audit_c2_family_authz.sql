-- v0.5 audit C2: 家族共有 RPC の匿名拒否を全読取・作成経路へ横展開する。
-- 既存関数の本体は保持し、auth.users の権威データを使う fail-close ガードだけを追加。
-- 本番適用は backup 後に作者がレビューしてから行うこと。
--
-- rollback（適用を取り消す場合・適用の逆順に create or replace で復元）:
--   begin;
--   create or replace function public.get_family_shared_notes(p_group_id uuid)
--   returns table (owner_id uuid, school_id uuid, note text, commute_note text)
--   language plpgsql
--   stable
--   security definer
--   set search_path = public, pg_temp
--   as $$
--   declare
--     v_uid uuid := auth.uid();
--   begin
--     if v_uid is null then
--       raise exception 'authentication required';
--     end if;
--     if not exists (
--       select 1 from family_members
--       where group_id = p_group_id and user_id = v_uid and status = 'active'
--     ) then
--       raise exception 'not a member of this group';
--     end if;
--
--     return query
--       select n.user_id, n.school_id, n.note::text, n.commute_note::text
--       from user_school_notes n
--       join family_members m
--         on m.user_id = n.user_id
--        and m.group_id = p_group_id
--        and m.status = 'active'
--        and m.share_notes = true
--       where n.user_id <> v_uid;
--   end;
--   $$;
--   create or replace function public.get_family_shared_favorites(p_group_id uuid)
--   returns table (owner_id uuid, school_id uuid, priority integer, status text)
--   language plpgsql
--   stable
--   security definer
--   set search_path = public, pg_temp
--   as $$
--   declare
--     v_uid uuid := auth.uid();
--   begin
--     if v_uid is null then
--       raise exception 'authentication required';
--     end if;
--     if not exists (
--       select 1 from family_members
--       where group_id = p_group_id and user_id = v_uid and status = 'active'
--     ) then
--       raise exception 'not a member of this group';
--     end if;
--
--     return query
--       select f.user_id, f.school_id, f.priority::int, f.status::text
--       from user_school_favorites f
--       join family_members m
--         on m.user_id = f.user_id
--        and m.group_id = p_group_id
--        and m.status = 'active'
--        and m.share_favorites = true
--       where f.user_id <> v_uid;
--   end;
--   $$;
--   create or replace function public.accept_family_invite(p_token uuid)
--   returns uuid
--   language plpgsql
--   security definer
--   set search_path = public, pg_temp
--   as $$
--   declare
--     v_uid uuid := auth.uid();
--     v_group_id uuid;
--     v_status text;
--     v_expires_at timestamptz;
--   begin
--     if v_uid is null then
--       raise exception 'authentication required';
--     end if;
--     if coalesce(auth.jwt() ->> 'is_anonymous', 'false') = 'true' then
--       raise exception 'anonymous users cannot accept family invitations';
--     end if;
--
--     select group_id, status, expires_at
--       into v_group_id, v_status, v_expires_at
--     from public.family_members
--     where invite_token = p_token
--     for update;
--
--     if v_group_id is null then
--       raise exception 'invalid invitation';
--     end if;
--     if v_status <> 'invited' then
--       raise exception 'invitation already used';
--     end if;
--     if v_expires_at is null or v_expires_at <= now() then
--       raise exception 'invitation expired';
--     end if;
--
--     if exists (
--       select 1 from public.family_members
--       where group_id = v_group_id and user_id = v_uid
--     ) then
--       delete from public.family_members
--       where invite_token = p_token and status = 'invited' and user_id is null;
--       return v_group_id;
--     end if;
--
--     update public.family_members
--     set user_id = v_uid,
--         status = 'active',
--         accepted_at = now(),
--         expires_at = null
--     where invite_token = p_token;
--
--     return v_group_id;
--   end;
--   $$;
--   create or replace function public.create_family_invite(p_group_id uuid)
--   returns uuid
--   language plpgsql
--   security definer
--   set search_path = public, pg_temp
--   as $$
--   declare
--     v_uid uuid := auth.uid();
--     v_token uuid;
--   begin
--     if v_uid is null then
--       raise exception 'authentication required';
--     end if;
--     if not exists (
--       select 1 from public.family_groups g where g.id = p_group_id and g.owner_id = v_uid
--     ) then
--       raise exception 'only the group owner can invite';
--     end if;
--
--     -- 期限切れ招待は新しい URL を作る前に掃除する。
--     delete from public.family_members
--     where group_id = p_group_id
--       and status = 'invited'
--       and expires_at <= now();
--
--     insert into public.family_members (group_id, role, status, expires_at)
--     values (p_group_id, 'member', 'invited', now() + interval '7 days')
--     returning invite_token into v_token;
--
--     return v_token;
--   end;
--   $$;
--   create or replace function public.create_family_group(p_name text default '家族'::text)
--   returns uuid
--   language plpgsql
--   security definer
--   set search_path = public, pg_temp
--   as $$
--   declare
--     v_uid uuid := auth.uid();
--     v_group_id uuid;
--   begin
--     if v_uid is null then
--       raise exception 'authentication required';
--     end if;
--
--     insert into family_groups (owner_id, name)
--     values (v_uid, coalesce(nullif(btrim(p_name), ''), '家族'))
--     returning id into v_group_id;
--
--     insert into family_members (group_id, user_id, role, status, accepted_at)
--     values (v_group_id, v_uid, 'owner', 'active', now());
--
--     return v_group_id;
--   end;
--   $$;
--   commit;
--   （関数本体の差し替えのみ。テーブル・列・データには影響しない）
--   （create_family_invite / accept_family_invite の復元先は baseline_schema.sql ではなく 202608040101 の定義。baseline は F17/F18 適用前で expires_at を知らないため、baseline に戻すと招待の失効処理が壊れる）
--   （grant / revoke は復元不要。PUBLIC は適用前から剥奪済みで、anon / authenticated / service_role の execute も本 migration では変化しない）
--   （戻すと匿名ユーザーが家族共有 RPC を再び実行できる状態に戻る点を承知の上で行うこと）

begin;

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
  if coalesce((select u.is_anonymous from auth.users u where u.id = v_uid), true) then
    raise exception 'anonymous users cannot use family sharing';
  end if;

  insert into public.family_groups (owner_id, name)
  values (v_uid, coalesce(nullif(btrim(p_name), ''), '家族'))
  returning id into v_group_id;

  insert into public.family_members (group_id, user_id, role, status, accepted_at)
  values (v_group_id, v_uid, 'owner', 'active', now());

  return v_group_id;
end;
$$;

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
  if coalesce((select u.is_anonymous from auth.users u where u.id = v_uid), true) then
    raise exception 'anonymous users cannot use family sharing';
  end if;
  if not exists (
    select 1 from public.family_groups g where g.id = p_group_id and g.owner_id = v_uid
  ) then
    raise exception 'only the group owner can invite';
  end if;

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
  if coalesce((select u.is_anonymous from auth.users u where u.id = v_uid), true) then
    raise exception 'anonymous users cannot use family sharing';
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
  if coalesce((select u.is_anonymous from auth.users u where u.id = v_uid), true) then
    raise exception 'anonymous users cannot use family sharing';
  end if;
  if not exists (
    select 1 from public.family_members
    where group_id = p_group_id and user_id = v_uid and status = 'active'
  ) then
    raise exception 'not a member of this group';
  end if;

  return query
    select f.user_id, f.school_id, f.priority::int, f.status::text
    from public.user_school_favorites f
    join public.family_members m
      on m.user_id = f.user_id
     and m.group_id = p_group_id
     and m.status = 'active'
     and m.share_favorites = true
    where f.user_id <> v_uid;
end;
$$;

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
  if coalesce((select u.is_anonymous from auth.users u where u.id = v_uid), true) then
    raise exception 'anonymous users cannot use family sharing';
  end if;
  if not exists (
    select 1 from public.family_members
    where group_id = p_group_id and user_id = v_uid and status = 'active'
  ) then
    raise exception 'not a member of this group';
  end if;

  return query
    select n.user_id, n.school_id, n.note::text, n.commute_note::text
    from public.user_school_notes n
    join public.family_members m
      on m.user_id = n.user_id
     and m.group_id = p_group_id
     and m.status = 'active'
     and m.share_notes = true
    where n.user_id <> v_uid;
end;
$$;

revoke all on function public.create_family_group(text) from public;
grant execute on function public.create_family_group(text) to authenticated;
revoke all on function public.create_family_invite(uuid) from public;
grant execute on function public.create_family_invite(uuid) to authenticated;
revoke all on function public.accept_family_invite(uuid) from public;
grant execute on function public.accept_family_invite(uuid) to authenticated;
revoke all on function public.get_family_shared_favorites(uuid) from public;
grant execute on function public.get_family_shared_favorites(uuid) to authenticated;
revoke all on function public.get_family_shared_notes(uuid) from public;
grant execute on function public.get_family_shared_notes(uuid) to authenticated;

do $$
declare
  function_count integer;
  guarded_count integer;
begin
  select count(*), count(*) filter (where p.prosrc like '%auth.users%')
    into function_count, guarded_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'create_family_group', 'create_family_invite', 'accept_family_invite',
      'get_family_shared_favorites', 'get_family_shared_notes'
    )
    -- 引数 1 個の版だけを数える（将来オーバーロードが増えても誤検知しないため）。
    -- 旧実装は pg_get_function_identity_arguments(p.oid) in ('text','uuid') と書いていたが、
    -- この関数は引数名を含めて 'p_token uuid' / 'p_name text' の形で返すため常に 0 件になり、
    -- ガードが正しく入っていても必ず assert が落ちた（2026-08-05 の本番適用で判明・修正）。
    and p.pronargs = 1;
  if function_count <> 5 or guarded_count <> 5 then
    raise exception 'C2 assert failed: family RPC anonymous guards are incomplete';
  end if;
end;
$$;

commit;
