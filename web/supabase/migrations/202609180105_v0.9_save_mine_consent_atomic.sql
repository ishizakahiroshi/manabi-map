-- 偏差値の共有同意（提供する / 撤回する）の適用を 1 トランザクションにまとめる RPC を足す。
--
-- 現状: web/src/hooks/useUserData.ts の saveMineConsent が
--   1) 学校単位のセンチネル行（department_id is null）への upsert
--   2) 同じ学校の学科行（department_id is not null）の visibility 更新
-- という 2 文で構成されている。PostgREST の 1 要求は 1 文なので 2 文は別のトランザクションになり、
-- 2 文目が失敗すると画面だけ巻き戻り、DB には「センチネル行は private・学科行は submit_to_manabi」
-- という半分だけ適用された状態が残る。学科行が submit_to_manabi のままだと、集計キュー
-- （get_deviation_review_queue）と再読込時の OR 集約（visibility の OR）に撤回後も残り続ける。
-- 同じ画面の一括削除（deleteMine）は 1 文なので原子的で、同意の切替だけが穴になっていた。
--
-- 変更: 2 文を save_mine_consent() にまとめ、関数本体の暗黙トランザクションで完結させる。
-- **破壊的な変更はしない。** 既存データは書き換えず、テーブルへの直接 upsert / update の経路も
-- RLS ごとそのまま残す（関数を足して呼び出し側を切り替えるだけ）。
--
-- 認可: security definer は RLS を迂回するため、書き込む行は user_id = auth.uid() に固定し、
-- 呼び出し元からは school_id しか受け取らない（他人の記録を指定する余地を作らない）。
-- 実ログインが無い経路（anon ロール）は revoke / grant で実行できない。
-- 匿名サインイン（auth.users.is_anonymous = true・画面上の「ゲスト（匿名）」）は、家族共有 RPC と違い
-- **本関数では拒否しない**。個人偏差値記録は匿名のままでも保存・撤回できるのが現行仕様
-- （user_school_deviations の 4 方針はいずれも auth.uid() = user_id のみを見る）で、ここで拒否すると
-- ゲストが同意を撤回できなくなり、緩めるのではなく壊す変更になるため。
--
-- 冪等性: create or replace と revoke / grant だけなので再実行できる。
-- rollback:
--   begin;
--   drop function if exists public.save_mine_consent(uuid, boolean);
--   commit;
--   （併せて useUserData.ts の saveMineConsent を 2 文の経路へ戻すこと。
--     テーブル・列・データ・方針には影響しない）

begin;

create or replace function public.save_mine_consent(p_school_id uuid, p_submit boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_visibility text := case when coalesce(p_submit, false) then 'submit_to_manabi' else 'private' end;
begin
  if v_uid is null then
    raise exception 'authentication required';
  end if;
  if p_school_id is null then
    raise exception 'school is required';
  end if;

  -- 学校単位のセンチネル行。学科の記録が 1 件も無い学校でも同意の状態を保持する。
  -- note は既存の値を残す（同意の切替はメモを書き換えない）。
  -- 一意キーは 202608040104 の unique nulls not distinct なので、department_id が null でも競合する。
  insert into public.user_school_deviations (user_id, school_id, department_id, value, visibility)
  values (v_uid, p_school_id, null, 0, v_visibility)
  on conflict on constraint user_school_deviations_user_school_dept_key
  do update set visibility = excluded.visibility,
                updated_at = now();

  -- 学科行にも同じ visibility を反映する。センチネル行と同じトランザクションなので、
  -- どちらかだけが適用された状態は残らない（updated_at は set_updated_at トリガでも維持される）。
  update public.user_school_deviations
  set visibility = v_visibility,
      updated_at = now()
  where user_id = v_uid
    and school_id = p_school_id
    and department_id is not null;
end;
$$;

-- Supabase の function 作成 hook は PUBLIC だけでなく anon / authenticated にも
-- EXECUTE を直接付与するため、3 者を明示 revoke してから必要なロールだけ戻す。
revoke all on function public.save_mine_consent(uuid, boolean) from public, anon, authenticated;
grant execute on function public.save_mine_consent(uuid, boolean) to authenticated;

do $$
declare
  v_source text;
  v_secdef boolean;
  v_config text[];
begin
  select p.prosrc, p.prosecdef, p.proconfig
    into v_source, v_secdef, v_config
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'save_mine_consent'
    and p.pronargs = 2;

  if v_source is null then
    raise exception 'C6+ assert failed: save_mine_consent is missing';
  end if;
  if not v_secdef then
    raise exception 'C6+ assert failed: save_mine_consent is not security definer';
  end if;
  if v_config is null or not exists (
    select 1 from unnest(v_config) as c
    where c like 'search_path=%' and c like '%public%' and c like '%pg_temp%'
  ) then
    raise exception 'C6+ assert failed: save_mine_consent does not pin search_path';
  end if;
  if position('auth.uid()' in v_source) = 0
     or position('user_id = v_uid' in v_source) = 0 then
    raise exception 'C6+ assert failed: save_mine_consent does not restrict writes to the caller''s own records';
  end if;
  -- センチネル行と学科行の両方を 1 本の関数で書くこと（片方だけなら原子化になっていない）。
  if position('department_id is not null' in v_source) = 0
     or position('on conflict' in v_source) = 0 then
    raise exception 'C6+ assert failed: save_mine_consent does not apply both the sentinel row and the department rows';
  end if;
  if not has_function_privilege('authenticated', 'public.save_mine_consent(uuid, boolean)', 'execute') then
    raise exception 'C6+ assert failed: authenticated cannot execute save_mine_consent';
  end if;
  if has_function_privilege('anon', 'public.save_mine_consent(uuid, boolean)', 'execute') then
    raise exception 'C6+ assert failed: save_mine_consent is executable by anon';
  end if;
end;
$$;

commit;
