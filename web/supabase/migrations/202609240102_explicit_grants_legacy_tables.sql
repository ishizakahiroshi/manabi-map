-- =====================================================================
-- Data API 用の権限（GRANT）が migration に書かれていないテーブルへ、使う分の権限を明示する。
--
-- 目的:
--   Supabase は、新しいプロジェクトでは 2026-05-30 から、既存のプロジェクトでも 2026-10-30 から、
--   public に新しく作ったテーブルへ anon / authenticated / service_role の権限を自動では付けなくなる
--   （https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically）。
--   本番の今の権限の多くは、作ったときに自動で付いた GRANT ALL で、migration には書いていない。
--   本番の復元手順（docs/local/manual_production-restore-runbook.md）は、--no-acl の dump を
--   新しいプロジェクトへ戻し、migration を流し直して権限を戻す。自動の権限が付かない先へ戻すと、
--   下の表は権限が無いまま残り、流し直しても戻らない（画面・ビルド・管理画面が permission denied で止まる）。
--   このファイルで権限を明示し、migration を流し直すだけで戻るようにする。
--   今の本番は、このファイルが無くても壊れない（今ある表の権限はそのまま残る）。
--
-- 計画: docs/local/plan_supabase-explicit-grants.md
--   C1 の「結果（2026-09-24・repo と baseline で確認）」の表（対象 27 テーブル）と、
--   「決定（2026-09-24）」が仕様の正本。下のコメントの #1〜#27 は、その表の行番号。
--
-- 決定（2026-09-24・4 つとも案 A）:
--   1. service_role は使う分だけ付ける。dash_* に select, insert, update、app_config に select, update、
--      admin_users に select (user_id)。service_role を使うコードは 4 か所だけで、ほかの対象には付けない
--      （今後この鍵で別の表を触るときは、その migration で GRANT を足す）。
--   2. 読むコードが無い公開の一覧表 8 つ（course_type_master、admission_*_master の 6 つ、
--      school_admission_stat_legacy_links）にも、anon・authenticated に select を付ける
--      （「誰でも読める」policy の意図どおりにする）。
--   3. home_locations は、update をアプリが書く 5 列（label, address, latitude, longitude, updated_at）
--      に絞る。delete は付ける。insert は今の 6 列（202608060101）を書き直す。anon には何も付けない。
--   4. 復元で巻き戻る 3 件（school_field_* の 2 表、関数 dash_app_counts、dash_supabase_usage の表と
--      関数 dash_supabase_usage_metrics）の権限も、元の migration（202608060201・202607100101・
--      202609240101）と同じ内容をここに書く。元のファイルは create table が先にあるので、復元先では
--      「既に存在する」で落ちてトランザクションごと取り消され、後ろの GRANT / REVOKE が入らない。
--      同じ GRANT が 2 つのファイルに並ぶが、後に流れるこのファイルが正本。
--
-- 書き方:
--   ・create / alter table を 1 文も含めない（revoke / grant と assert だけ）。復元先へ流し直しても
--     「既に存在する」で落ちず、必ず最後まで通る。何度流しても同じ結果になる。
--   ・狭める表は revoke all ... from public, anon, authenticated, service_role のあと、要る分だけ grant する。
--     今の本番（自動の GRANT ALL が付いている）に流しても、復元した直後（何も付いていない）に流しても、
--     同じ権限になる。
--   ・PostgreSQL の REVOKE は、表の権限を外すと同じ種類の列の権限も外す。home_locations は、
--     revoke のあとに列の insert・update を書き直す。
--   ・app_config・admin_users は revoke の相手を service_role だけにする。anon・authenticated の
--     列の select（202609180102・202607070502）は触らない。表単位の select は誰にも付けない
--     （app_config は updated_by、admin_users は pin_hash まで見えてしまう）。
--   ・行の保護は RLS に任せる。末尾の assert で、権限を付けた表の RLS が有効であることも確かめる。
--   ・対象外の表（schools・school_deviation_values など）には触らない。
--   ・assert が 1 つでも落ちたら、トランザクションごと取り消される（部分適用は起きない）。
--
-- 流す順番: 202609240101_dash_supabase_usage.sql の後に流すこと。dash_supabase_usage と
--   dash_supabase_usage_metrics() を参照するので、先に流すと grant が失敗してトランザクションごと止まる。
--
-- 今の本番で変わること（外れる権限。どれも書き込みの policy が無いか、その役割で呼ばない経路）:
--   ・公開の読み取り表 16（#1〜#15・#21）: anon・authenticated の insert・update・delete・truncate・
--     references・trigger・maintain と、service_role の ALL
--   ・dash_* 5（#16〜#20）: anon・authenticated の ALL と、service_role の delete・truncate・
--     references・trigger・maintain
--   ・利用者の表 3（#22〜#24）: anon と service_role の ALL、authenticated の truncate・references・
--     trigger・maintain
--   ・home_locations（#25）: anon のすべて（列の insert 6 列を含む）、service_role の ALL、
--     authenticated の表単位の update（5 列に絞る）と truncate・references・trigger・maintain
--   ・app_config（#26）: service_role の insert・delete・truncate・references・trigger・maintain
--   ・admin_users（#27）: service_role の ALL（select (user_id) だけにする）
--   ・巻き戻る 3 件は、今の本番と同じ権限を書くだけで変わらない
--
-- rollback（この migration の前の本番と同じ権限へ戻す場合。自動の GRANT ALL を書き写したもの）:
--   begin;
--   -- 公開の読み取り表 16・dash_* 5・利用者の表 3
--   grant all on table
--     public.course_type_master, public.admission_selection_stage_master,
--     public.admission_selection_track_master, public.admission_recruitment_unit_kind_master,
--     public.admission_map_role_master, public.admission_quality_reason_master,
--     public.admission_exam_component_master, public.admission_recruitment_units,
--     public.admission_recruitment_unit_departments, public.school_admission_selection_stats,
--     public.school_admission_stat_exam_components, public.school_admission_stat_quality_flags,
--     public.school_admission_stat_sources, public.school_admission_stat_legacy_links,
--     public.school_admission_stats, public.school_departments,
--     public.dash_daily, public.dash_gsc_queries, public.dash_gsc_pages,
--     public.dash_cf_referers, public.dash_cf_dims,
--     public.user_school_favorites, public.user_school_notes, public.user_school_deviations
--     to anon, authenticated, service_role;
--   -- home_locations: 表の insert は付けず、列の insert 6 列だけ（202608060101 と同じ）
--   revoke all on table public.home_locations from anon, authenticated, service_role;
--   grant all on table public.home_locations to anon, authenticated, service_role;
--   revoke insert on table public.home_locations from anon, authenticated;
--   grant insert (user_id, label, address, latitude, longitude, is_primary)
--     on table public.home_locations to anon, authenticated;
--   -- app_config・admin_users: service_role の分だけ。anon・authenticated の列の select は触らない
--   revoke all on table public.admin_users from service_role;
--   grant all on table public.app_config, public.admin_users to service_role;
--   commit;
--   巻き戻る 3 件は、元の migration と同じ内容を書いただけなので戻す対象にしない。
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. 公開の読み取り表（#1〜#15・#21）: anon・authenticated に select だけ。service_role には付けない。
--    行は「誰でも読める」policy（FOR SELECT USING (true)）で見える。書き込みは psql（postgres）で
--    流す SQL だけで、Data API から書くコードは無い。
--    #1〜#7・#14 は読むコードが無いが、決定 2 で select を付ける。
-- ---------------------------------------------------------------------
revoke all on table
  public.course_type_master,
  public.admission_selection_stage_master,
  public.admission_selection_track_master,
  public.admission_recruitment_unit_kind_master,
  public.admission_map_role_master,
  public.admission_quality_reason_master,
  public.admission_exam_component_master,
  public.admission_recruitment_units,
  public.admission_recruitment_unit_departments,
  public.school_admission_selection_stats,
  public.school_admission_stat_exam_components,
  public.school_admission_stat_quality_flags,
  public.school_admission_stat_sources,
  public.school_admission_stat_legacy_links,
  public.school_admission_stats,
  public.school_departments
  from public, anon, authenticated, service_role;

grant select on table
  public.course_type_master,
  public.admission_selection_stage_master,
  public.admission_selection_track_master,
  public.admission_recruitment_unit_kind_master,
  public.admission_map_role_master,
  public.admission_quality_reason_master,
  public.admission_exam_component_master,
  public.admission_recruitment_units,
  public.admission_recruitment_unit_departments,
  public.school_admission_selection_stats,
  public.school_admission_stat_exam_components,
  public.school_admission_stat_quality_flags,
  public.school_admission_stat_sources,
  public.school_admission_stat_legacy_links,
  public.school_admission_stats,
  public.school_departments
  to anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. 管理用の集計（#16〜#20）: service_role に select, insert, update だけ。
--    scripts/dashboard-snapshot.mjs の upsert（insert ... on conflict do update）と、
--    functions/api/admin/*.ts の読み込みに要る分。delete・truncate はどのコードにも無い。
--    anon・authenticated には付けない（RLS 有効・policy なしで、今も行は見えない）。
--    書き方は 202609240101_dash_supabase_usage.sql と同じ。
-- ---------------------------------------------------------------------
revoke all on table
  public.dash_daily,
  public.dash_gsc_queries,
  public.dash_gsc_pages,
  public.dash_cf_referers,
  public.dash_cf_dims
  from public, anon, authenticated, service_role;

grant select, insert, update on table
  public.dash_daily,
  public.dash_gsc_queries,
  public.dash_gsc_pages,
  public.dash_cf_referers,
  public.dash_cf_dims
  to service_role;

-- ---------------------------------------------------------------------
-- 3. 利用者の表（#22〜#24）: authenticated（匿名ログインを含む）に select, insert, update, delete。
--    行は本人 policy 4 本（auth.uid() = user_id）で本人の分だけに絞られる。
--    anon（ログイン前）は呼ばないので付けない。service_role で触るコードは無いので付けない
--    （件数の集計と家族共有は security definer 関数の中で読むので、Data API の権限は要らない）。
-- ---------------------------------------------------------------------
revoke all on table
  public.user_school_favorites,
  public.user_school_notes,
  public.user_school_deviations
  from public, anon, authenticated, service_role;

grant select, insert, update, delete on table
  public.user_school_favorites,
  public.user_school_notes,
  public.user_school_deviations
  to authenticated;

-- ---------------------------------------------------------------------
-- 4. 設定地点（#25 home_locations）: authenticated に select, delete と、列を絞った insert・update。
--    表の revoke で列の insert（202608060101）も消えるので、同じ 6 列をここで書き直す。
--    表単位の insert・update は付けない。id・created_at と、住所を分けて持つ列（postal_code・
--    prefecture・city）を利用者に書かせないため（202608060101 16 行と同じ理由）。
--    update は web/src/contexts/AppContext.tsx が書く 5 列だけ（決定 3）。
--    anon には何も付けない（session がある時だけ呼ぶ。今の anon の insert 6 列も RLS と
--    trigger で通らない）。service_role で触るコードは無い（件数は dash_app_counts の中で数える）。
-- ---------------------------------------------------------------------
revoke all on table public.home_locations from public, anon, authenticated, service_role;

grant select, delete on table public.home_locations to authenticated;
grant insert (user_id, label, address, latitude, longitude, is_primary)
  on table public.home_locations to authenticated;
grant update (label, address, latitude, longitude, updated_at)
  on table public.home_locations to authenticated;

-- ---------------------------------------------------------------------
-- 5. メンテナンスの設定（#26 app_config）: service_role に select, update だけ足す。
--    functions/api/admin/maintenance.ts と scripts/maintenance.mjs が読み、PATCH で更新する
--    （prefer: return=representation で更新後の行も読む）。行を足す・消すコードは無い。
--    revoke は service_role だけ。anon・authenticated の select (key, value)（202609180102）は触らない。
-- ---------------------------------------------------------------------
revoke all on table public.app_config from service_role;
grant select, update on table public.app_config to service_role;

-- ---------------------------------------------------------------------
-- 6. 管理者の一覧（#27 admin_users）: service_role に select (user_id) だけ足す。
--    web/supabase/functions/trigger-snapshot-rebuild/index.ts が select=user_id と
--    user_id=eq.<id> で読むだけ。表単位の select にすると pin_hash まで読める。
--    revoke は service_role だけ。authenticated の select (user_id, note, created_at)
--    （202607070502）は触らない。
-- ---------------------------------------------------------------------
revoke all on table public.admin_users from service_role;
grant select (user_id) on table public.admin_users to service_role;

-- ---------------------------------------------------------------------
-- 7. 復元で巻き戻る 3 件（決定 4）。元の migration の文を、そのまま書き写す。
-- ---------------------------------------------------------------------

-- 7-1. 202608060201_school_field_sources.sql 113〜120 行と同じ。
--      ビルドが anon で school_field_sources を埋め込んで読む（web/src/lib/school-select.ts）。
revoke insert, update, delete, truncate
  on public.school_field_source_field_master from anon, authenticated;
revoke insert, update, delete, truncate
  on public.school_field_sources from anon, authenticated;
grant select on public.school_field_source_field_master to anon, authenticated;
grant select on public.school_field_sources to anon, authenticated;
grant all on public.school_field_source_field_master to service_role;
grant all on public.school_field_sources to service_role;

-- 7-2. 202607100101_dash_snapshot_tables.sql 99〜100 行と同じ。
--      --no-acl で作り直した関数は PostgreSQL の既定で誰でも実行できるので、ここで絞り直す。
revoke all on function public.dash_app_counts() from public, anon, authenticated;
grant execute on function public.dash_app_counts() to service_role;

-- 7-3. 202609240101_dash_supabase_usage.sql 49・52・76・77 行と同じ。
revoke all on table public.dash_supabase_usage from public, anon, authenticated, service_role;
grant select, insert, update on table public.dash_supabase_usage to service_role;
revoke all on function public.dash_supabase_usage_metrics() from public, anon, authenticated, service_role;
grant execute on function public.dash_supabase_usage_metrics() to service_role;

-- ---------------------------------------------------------------------
-- 8. 付けた権限が付いていること、付けないと決めた権限が付いていないことを確かめる。
--    has_table_privilege は表単位の権限だけを見る。列単位の権限まで見るときは
--    has_any_column_privilege（表単位か、どれか 1 列にあれば true）を使う。
-- ---------------------------------------------------------------------
do $$
declare
  v_table text;
  v_role text;
  v_column text;
  v_privilege text;
  v_function text;
  v_expected boolean;
  -- 1. の 16 表
  public_read_tables constant text[] := array[
    'course_type_master',
    'admission_selection_stage_master',
    'admission_selection_track_master',
    'admission_recruitment_unit_kind_master',
    'admission_map_role_master',
    'admission_quality_reason_master',
    'admission_exam_component_master',
    'admission_recruitment_units',
    'admission_recruitment_unit_departments',
    'school_admission_selection_stats',
    'school_admission_stat_exam_components',
    'school_admission_stat_quality_flags',
    'school_admission_stat_sources',
    'school_admission_stat_legacy_links',
    'school_admission_stats',
    'school_departments'
  ];
  -- 2. の 5 表と 7-3. の dash_supabase_usage（service_role に select, insert, update だけ）
  service_tables constant text[] := array[
    'dash_daily',
    'dash_gsc_queries',
    'dash_gsc_pages',
    'dash_cf_referers',
    'dash_cf_dims',
    'dash_supabase_usage'
  ];
  -- 3. の 3 表
  owner_tables constant text[] := array[
    'user_school_favorites',
    'user_school_notes',
    'user_school_deviations'
  ];
  -- 7-1. の 2 表
  field_source_tables constant text[] := array[
    'school_field_source_field_master',
    'school_field_sources'
  ];
  home_insert_columns constant text[] := array[
    'user_id', 'label', 'address', 'latitude', 'longitude', 'is_primary'
  ];
  home_update_columns constant text[] := array[
    'label', 'address', 'latitude', 'longitude', 'updated_at'
  ];
begin
  -- 権限を付けた表は、すべて RLS が有効であること（行の保護は RLS に任せているため）。
  foreach v_table in array public_read_tables || service_tables || owner_tables
      || field_source_tables || array['home_locations', 'app_config', 'admin_users'] loop
    if not coalesce(
      (select c.relrowsecurity from pg_class c where c.oid = ('public.' || v_table)::regclass),
      false
    ) then
      raise exception 'assert failed: RLS is not enabled on %', v_table;
    end if;
  end loop;

  -- 1. 公開の読み取り表: anon・authenticated は select だけ。service_role は何も無い。
  foreach v_table in array public_read_tables loop
    foreach v_role in array array['anon', 'authenticated'] loop
      if not has_table_privilege(v_role, 'public.' || v_table, 'select') then
        raise exception 'assert failed: % lacks select on %', v_role, v_table;
      end if;
      if has_any_column_privilege(v_role, 'public.' || v_table, 'insert,update,references')
         or has_table_privilege(v_role, 'public.' || v_table, 'delete,truncate,trigger') then
        raise exception 'assert failed: % has write privileges on %', v_role, v_table;
      end if;
    end loop;
    if has_any_column_privilege('service_role', 'public.' || v_table, 'select,insert,update,references')
       or has_table_privilege('service_role', 'public.' || v_table, 'delete,truncate,trigger') then
      raise exception 'assert failed: service_role has privileges on %', v_table;
    end if;
  end loop;

  -- 2. と 7-3. 管理用の集計: service_role は select, insert, update だけ。anon・authenticated は何も無い。
  foreach v_table in array service_tables loop
    foreach v_privilege in array array['select', 'insert', 'update'] loop
      if not has_table_privilege('service_role', 'public.' || v_table, v_privilege) then
        raise exception 'assert failed: service_role lacks % on %', v_privilege, v_table;
      end if;
    end loop;
    if has_table_privilege('service_role', 'public.' || v_table, 'delete,truncate,references,trigger') then
      raise exception 'assert failed: service_role has delete/truncate/references/trigger on %', v_table;
    end if;
    foreach v_role in array array['anon', 'authenticated'] loop
      if has_any_column_privilege(v_role, 'public.' || v_table, 'select,insert,update,references')
         or has_table_privilege(v_role, 'public.' || v_table, 'delete,truncate,trigger') then
        raise exception 'assert failed: % has privileges on %', v_role, v_table;
      end if;
    end loop;
  end loop;

  -- 3. 利用者の表: authenticated は select, insert, update, delete だけ。
  --    anon は書き込みも読み込みも無い。service_role は読めない（何も無い）。
  foreach v_table in array owner_tables loop
    foreach v_privilege in array array['select', 'insert', 'update', 'delete'] loop
      if not has_table_privilege('authenticated', 'public.' || v_table, v_privilege) then
        raise exception 'assert failed: authenticated lacks % on %', v_privilege, v_table;
      end if;
    end loop;
    if has_table_privilege('authenticated', 'public.' || v_table, 'truncate,references,trigger') then
      raise exception 'assert failed: authenticated has truncate/references/trigger on %', v_table;
    end if;
    foreach v_role in array array['anon', 'service_role'] loop
      if has_any_column_privilege(v_role, 'public.' || v_table, 'select,insert,update,references')
         or has_table_privilege(v_role, 'public.' || v_table, 'delete,truncate,trigger') then
        raise exception 'assert failed: % has privileges on %', v_role, v_table;
      end if;
    end loop;
  end loop;

  -- 4. home_locations: authenticated は select, delete と、insert 6 列・update 5 列ちょうど。
  foreach v_privilege in array array['select', 'delete'] loop
    if not has_table_privilege('authenticated', 'public.home_locations', v_privilege) then
      raise exception 'assert failed: authenticated lacks % on home_locations', v_privilege;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.home_locations', 'insert,update,truncate,references,trigger') then
    raise exception 'assert failed: authenticated has table-level insert/update/truncate/references/trigger on home_locations';
  end if;
  for v_column in
    select a.attname::text
    from pg_attribute a
    where a.attrelid = 'public.home_locations'::regclass
      and a.attnum > 0
      and not a.attisdropped
  loop
    v_expected := v_column = any (home_insert_columns);
    if has_column_privilege('authenticated', 'public.home_locations', v_column, 'insert') is distinct from v_expected then
      raise exception 'assert failed: home_locations insert on % for authenticated should be %', v_column, v_expected;
    end if;
    v_expected := v_column = any (home_update_columns);
    if has_column_privilege('authenticated', 'public.home_locations', v_column, 'update') is distinct from v_expected then
      raise exception 'assert failed: home_locations update on % for authenticated should be %', v_column, v_expected;
    end if;
  end loop;
  foreach v_role in array array['anon', 'service_role'] loop
    if has_any_column_privilege(v_role, 'public.home_locations', 'select,insert,update,references')
       or has_table_privilege(v_role, 'public.home_locations', 'delete,truncate,trigger') then
      raise exception 'assert failed: % has privileges on home_locations', v_role;
    end if;
  end loop;

  -- 5. app_config: service_role は select, update だけ。
  --    anon・authenticated は今までどおり select (key, value) だけ（202609180102 のまま）。
  foreach v_privilege in array array['select', 'update'] loop
    if not has_table_privilege('service_role', 'public.app_config', v_privilege) then
      raise exception 'assert failed: service_role lacks % on app_config', v_privilege;
    end if;
  end loop;
  if has_table_privilege('service_role', 'public.app_config', 'insert,delete,truncate,references,trigger') then
    raise exception 'assert failed: service_role has insert/delete/truncate/references/trigger on app_config';
  end if;
  foreach v_role in array array['anon', 'authenticated'] loop
    if has_table_privilege(v_role, 'public.app_config', 'select') then
      raise exception 'assert failed: table-level select on app_config for %', v_role;
    end if;
    foreach v_column in array array['key', 'value'] loop
      if not has_column_privilege(v_role, 'public.app_config', v_column, 'select') then
        raise exception 'assert failed: % lost select on app_config.%', v_role, v_column;
      end if;
    end loop;
    foreach v_column in array array['updated_at', 'updated_by'] loop
      if has_column_privilege(v_role, 'public.app_config', v_column, 'select') then
        raise exception 'assert failed: % can select app_config.%', v_role, v_column;
      end if;
    end loop;
    if has_any_column_privilege(v_role, 'public.app_config', 'insert,update,references')
       or has_table_privilege(v_role, 'public.app_config', 'delete,truncate,trigger') then
      raise exception 'assert failed: % has write privileges on app_config', v_role;
    end if;
  end loop;

  -- 6. admin_users: service_role は select (user_id) だけで、pin_hash も note も見えない。
  --    authenticated は今までどおり select (user_id, note, created_at) だけ（202607070502 のまま）。
  --    anon は何も無い。
  if not has_column_privilege('service_role', 'public.admin_users', 'user_id', 'select') then
    raise exception 'assert failed: service_role lacks select on admin_users.user_id';
  end if;
  if has_table_privilege('service_role', 'public.admin_users', 'select') then
    raise exception 'assert failed: service_role has table-level select on admin_users';
  end if;
  foreach v_column in array array['pin_hash', 'note', 'created_at'] loop
    if has_column_privilege('service_role', 'public.admin_users', v_column, 'select') then
      raise exception 'assert failed: service_role can select admin_users.%', v_column;
    end if;
  end loop;
  foreach v_role in array array['service_role', 'authenticated'] loop
    if has_any_column_privilege(v_role, 'public.admin_users', 'insert,update,references')
       or has_table_privilege(v_role, 'public.admin_users', 'delete,truncate,trigger') then
      raise exception 'assert failed: % has write privileges on admin_users', v_role;
    end if;
  end loop;
  foreach v_column in array array['user_id', 'note', 'created_at'] loop
    if not has_column_privilege('authenticated', 'public.admin_users', v_column, 'select') then
      raise exception 'assert failed: authenticated lost select on admin_users.%', v_column;
    end if;
  end loop;
  if has_column_privilege('authenticated', 'public.admin_users', 'pin_hash', 'select') then
    raise exception 'assert failed: authenticated can select admin_users.pin_hash';
  end if;
  if has_any_column_privilege('anon', 'public.admin_users', 'select,insert,update,references')
     or has_table_privilege('anon', 'public.admin_users', 'delete,truncate,trigger') then
    raise exception 'assert failed: anon has privileges on admin_users';
  end if;

  -- 7-1. school_field_*: anon・authenticated は select があり書き込みが無い。service_role は ALL。
  foreach v_table in array field_source_tables loop
    foreach v_role in array array['anon', 'authenticated'] loop
      if not has_table_privilege(v_role, 'public.' || v_table, 'select') then
        raise exception 'assert failed: % lacks select on %', v_role, v_table;
      end if;
      if has_any_column_privilege(v_role, 'public.' || v_table, 'insert,update')
         or has_table_privilege(v_role, 'public.' || v_table, 'delete,truncate') then
        raise exception 'assert failed: % has write privileges on %', v_role, v_table;
      end if;
    end loop;
    foreach v_privilege in array array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] loop
      if not has_table_privilege('service_role', 'public.' || v_table, v_privilege) then
        raise exception 'assert failed: service_role lacks % on %', v_privilege, v_table;
      end if;
    end loop;
  end loop;

  -- 7-2・7-3. 集計の関数: service_role だけが実行できる（anon は PUBLIC の分も含めて実行できない）。
  foreach v_function in array array['public.dash_app_counts()', 'public.dash_supabase_usage_metrics()'] loop
    if not has_function_privilege('service_role', v_function, 'execute') then
      raise exception 'assert failed: service_role cannot execute %', v_function;
    end if;
    foreach v_role in array array['anon', 'authenticated'] loop
      if has_function_privilege(v_role, v_function, 'execute') then
        raise exception 'assert failed: % is executable by %', v_function, v_role;
      end if;
    end loop;
  end loop;
end;
$$;

commit;

-- 検証（適用後に SQL Editor / psql で確認）:
--   1. 対象の表の権限の一覧:
--        select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type)
--        from information_schema.role_table_grants
--        where table_schema = 'public'
--          and grantee in ('anon', 'authenticated', 'service_role')
--        group by table_name, grantee
--        order by table_name, grantee;
--      列単位の権限（home_locations・app_config・admin_users）は information_schema.column_privileges。
--   2. 画面: 学科の分類・入試の統計の表示、お気に入り・メモ・自分の記録・設定地点の保存と表示、
--      管理画面のダッシュボードとメンテナンスの切り替え（plan の C3）。
--   3. 次の dashboard-snapshot（.github/workflows/dashboard-snapshot.yml）が成功すること。
