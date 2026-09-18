-- C14: 新規テーブルへ RLS を自動で有効化する event trigger を migration に落とす。
--
-- 本番には event trigger ensure_rls（ddl_command_end / 有効 / 関数 public.rls_auto_enable）が
-- 存在し有効だが、リポジトリのどこにも create event trigger が無い。
-- baseline_schema.sql は pg_dump --schema-only --no-owner -n public で取っており、
-- event trigger は schema に属さないオブジェクトなので構造的に dump へ入らない。
-- 一方で関数のほうは dump に入っているため、復元先では「関数はあるのに発火しない」状態になる。
-- 復元手順（manual_production-restore-runbook.md:26 の「新規 project へ丸ごと復元」）を通ると
-- この安全網だけが復元されず、しかも Data API の「新しいテーブルを自動的に公開する」が ON なので、
-- 復元先で作った新しいテーブルは公開されたうえに RLS も無い状態になる。
--
-- 関数本体の出所: web/supabase/baseline_schema.sql:566-592（2026-08-05 の本番 dump）。
-- **既に本体がある環境では上書きしない。** 本番の現物を今このリポジトリから読み直す手段が無く、
-- dump 以降に変わっていた場合に create or replace で静かに巻き戻してしまうため。
-- event trigger も同じ理由で、既にある場合は作り直さずそのまま残す。
-- したがって本 migration は本番では no-op（最後の assertion による現状確認のみ）で、
-- 効くのは復元先・再構築先だけになる。
--
-- 注意: create event trigger は superuser 権限を要求する。
-- 復元先へ流す経路の接続ロールに権限が無い場合は、ここで停止する（部分適用は起きない）。
--
-- rollback（適用を取り消す場合）:
--   drop event trigger if exists ensure_rls;
--   drop function if exists public.rls_auto_enable();
--   （本番では取り消さない。取り消すと新規テーブルの RLS 自動有効化が失われる）

begin;

do $c14$
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    create function public.rls_auto_enable() returns event_trigger
        language plpgsql security definer
        set search_path to 'pg_catalog'
        as $fn$
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
              RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
          END;
         ELSE
            RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
         END IF;
      END LOOP;
    END;
    $fn$;
    raise notice 'C14: created function public.rls_auto_enable()';
  else
    raise notice 'C14: public.rls_auto_enable() already exists; left as is';
  end if;

  if not exists (select 1 from pg_event_trigger where evtname = 'ensure_rls') then
    create event trigger ensure_rls
      on ddl_command_end
      execute function public.rls_auto_enable();
    raise notice 'C14: created event trigger ensure_rls';
  else
    raise notice 'C14: event trigger ensure_rls already exists; left as is';
  end if;
end
$c14$;

do $$
declare
  v_event text;
  v_enabled "char";
  v_function text;
begin
  select t.evtevent, t.evtenabled, p.proname
    into v_event, v_enabled, v_function
  from pg_event_trigger t
  join pg_proc p on p.oid = t.evtfoid
  where t.evtname = 'ensure_rls';

  if v_function is null then
    raise exception 'C14 assert failed: event trigger ensure_rls is missing';
  end if;
  if v_function <> 'rls_auto_enable' then
    raise exception 'C14 assert failed: ensure_rls does not run rls_auto_enable (runs %)', v_function;
  end if;
  if v_event <> 'ddl_command_end' then
    raise exception 'C14 assert failed: ensure_rls fires on % instead of ddl_command_end', v_event;
  end if;
  if v_enabled = 'D' then
    raise exception 'C14 assert failed: ensure_rls is disabled';
  end if;
end;
$$;

commit;

-- 検証（適用後に SQL Editor / psql で確認）:
--   1. select evtname, evtevent, evtenabled from pg_event_trigger where evtname = 'ensure_rls';
--   2. create table public.tmp_rls_probe (id int); のあと
--      select relrowsecurity from pg_class where relname = 'tmp_rls_probe'; が true であること
--   3. drop table public.tmp_rls_probe;
