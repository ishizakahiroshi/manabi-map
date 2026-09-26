-- RLS 自動有効化の失敗を握りつぶさず、CREATE TABLE ごと失敗させる（fail-closed）。
--
-- 現状: public.rls_auto_enable()（baseline_schema.sql:879-905 が本番の実体。
-- 202609180104_v0.9_rls_auto_enable_event_trigger.sql:37-63 は復元先用の写しで内容は一致）の
-- 内側 BEGIN ... EXCEPTION WHEN OTHERS が、失敗時に RAISE LOG を 1 行出すだけで握りつぶしている。
-- 成功側も RAISE LOG なので、CREATE TABLE を実行した側からは成功と失敗の区別が付かない。
-- Supabase の Data API は「新しいテーブルを自動的に公開する」が ON なので、有効化が失敗した瞬間に
-- そのテーブルは RLS 無しで匿名へ公開されるが、それが誰にも見えない。
-- 失敗しうる経路は具体的に 1 つ特定できている: 関数は SECURITY DEFINER なので alter table の
-- 所有者判定は関数の所有者に対して行われ、関数所有者とテーブル作成ロールが一致しない場合に
-- 権限不足で失敗して WHEN OTHERS に吸われる。
--
-- 変更 1: 失敗時を RAISE EXCEPTION にする。event trigger は CREATE TABLE と同じトランザクションで
-- 走るので、ここで例外を投げると CREATE TABLE ごと巻き戻る（fail-closed）。
-- **RLS 無しのテーブルが黙って残るより、テーブルが作れないほうが安全側**という判断。
-- 元の失敗メッセージ（対象の object_identity）は落とさず、原因の SQLERRM を添える。
-- それ以外（絞り込み条件・成功時の RAISE LOG・skip 側の RAISE LOG・SECURITY DEFINER・
-- SET search_path TO 'pg_catalog'）は 1 文字も変えない。
--
-- 変更 2: 末尾の assertion を evtenabled の「通常のセッションで発火しない値」まで広げる。
-- pg_event_trigger.evtenabled は 'O'（origin・既定）/ 'D'（無効）/ 'R'（replica のみ）/ 'A'（always）の
-- 4 値で、通常の CREATE TABLE で発火するのは 'O' と 'A' だけ。202609180104:101-103 は 'D' しか見て
-- おらず、'R'（session_replication_role = 'replica' のセッションでしか発火しない）を「有効」として
-- 通過させていた。'R' は復元・ETL 経路と重なるため、この安全網が最も要る場面で素通りする。
-- **202609180104 は本番適用済みなので書き換えない。** assertion は本 migration の中に置く。
--
-- 注意: create or replace function は関数の所有者でなければ実行できない。
-- 所有者でないロールで流した場合はここで停止する（トランザクションなので部分適用は起きない）。
--
-- 冪等性: create or replace と assertion だけなので再実行できる。
-- rollback（適用を取り消す場合）:
--   baseline_schema.sql:879-905 の関数本体（失敗時が RAISE LOG のもの）で create or replace し直す。
--   **取り消すと握りつぶしが戻る**ので、運用を止める実害が出た場合だけにすること。

begin;

create or replace function public.rls_auto_enable() returns event_trigger
    language plpgsql security definer
    set search_path to 'pg_catalog'
    as $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE EXCEPTION 'rls_auto_enable: failed to enable RLS on % (%)', cmd.object_identity, SQLERRM;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;

do $$
declare
  v_source text;
  v_secdef boolean;
  v_enabled "char";
  v_function text;
begin
  select p.prosrc, p.prosecdef
    into v_source, v_secdef
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'rls_auto_enable';

  if v_source is null then
    raise exception 'assert failed: public.rls_auto_enable() is missing';
  end if;
  if not v_secdef then
    raise exception 'assert failed: rls_auto_enable is not security definer';
  end if;
  -- 失敗を握りつぶす実装へ戻っていないこと（WHEN OTHERS の先が RAISE LOG だけなら 0 件になる）。
  if position('RAISE EXCEPTION' in v_source) = 0 then
    raise exception 'assert failed: rls_auto_enable still swallows failures (no RAISE EXCEPTION in body)';
  end if;

  select t.evtenabled, p.proname
    into v_enabled, v_function
  from pg_event_trigger t
  join pg_proc p on p.oid = t.evtfoid
  where t.evtname = 'ensure_rls';

  if v_function is null then
    raise exception 'assert failed: event trigger ensure_rls is missing';
  end if;
  -- evtenabled は 'O' / 'D' / 'R' / 'A' の 4 値。通常の CREATE TABLE で発火するのは 'O' と 'A' だけで、
  -- 'D'（無効）と 'R'（replica のみ）は発火しない。202609180104 の assertion は 'D' しか弾いていない。
  if v_enabled is null or (v_enabled <> 'O' and v_enabled <> 'A') then
    raise exception 'assert failed: ensure_rls does not fire in ordinary sessions (evtenabled = %)', v_enabled;
  end if;
end;
$$;

commit;

-- 検証（適用後に SQL Editor / psql で確認）:
--   1. select evtname, evtevent, evtenabled from pg_event_trigger where evtname = 'ensure_rls';
--      evtenabled が 'O' か 'A' であること
--   2. begin;
--      create table public.tmp_rls_probe (id int);
--      select relrowsecurity from pg_class where relname = 'tmp_rls_probe';  -- true であること
--      rollback;
--      （本番 DDL を残さない transaction rollback 方式。2026-09-18 に同方式の実績あり）
--   3. 失敗側: 権限不足を再現した場合に CREATE TABLE 自体がエラーで止まり、
--      メッセージに対象テーブル名と原因（SQLERRM）が含まれること
