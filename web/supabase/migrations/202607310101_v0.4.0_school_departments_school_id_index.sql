-- school_departments.school_id に索引が無く、PostgREST の embed
-- （schools?select=*,school_departments(...)）が親 1 行ごとに school_departments を
-- 全件走査していた。全国 47 都道府県への拡大で学科が 3,993 → 7,798 行になった結果、
-- 250 行/ページの取得でも 3.1 秒かかり Supabase の statement timeout に達して
-- ビルド時の gen-schools-json.mjs が失敗するようになった（2026-07-31 実測）。
--
-- 他の子テーブルには同等の索引が既にある:
--   school_admission_stats  -> idx_admission_stats_school
--   school_name_history     -> school_name_history_school_idx
-- school_departments だけが漏れていたため追加する。
--
-- rollback: drop index if exists school_departments_school_id_idx;
--   （索引の削除のみ。データには影響しない）

begin;

create index if not exists school_departments_school_id_idx
  on school_departments (school_id);

commit;
