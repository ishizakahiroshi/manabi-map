-- v0.1.5: user_school_deviations の department_id=NULL 重複掃除 + unique nulls not distinct 化
-- および moddatetime トリガによる updated_at 自動更新
--
-- 適用手順（人間が実施）:
--   1) 現行 unique 制約名の確認（本 migration では制約名を決め打ちしないため）:
--        select conname
--          from pg_constraint
--         where conrelid = 'public.user_school_deviations'::regclass
--           and contype = 'u';
--      → 出力された制約名を `<UNIQUE_NAME>` プレースホルダに置換してから適用する。
--         プレースホルダ未置換のままだと `alter table ... drop constraint '<UNIQUE_NAME>'` で必ず失敗する。
--   2) `pnpm dlx supabase db push`（もしくは psql で本ファイルを直接実行）
--   3) 適用後、user_school_deviations に (user_id, school_id, department_id NULL) の
--      重複がないことを確認:
--        select user_id, school_id, count(*)
--          from public.user_school_deviations
--         where department_id is null
--         group by 1, 2 having count(*) > 1;
--      → 0 行であること。
--
-- 冪等性: create extension if not exists / drop trigger if exists を用いており、
-- 制約張替以外は再適用しても安全。制約張替のブロックは適用済み環境で 2 回目を流すと
-- drop constraint が失敗するので、その時点で「本 migration は適用済み」と判定できる。

begin;

-- ============================================================
-- F-03: department_id=NULL の重複掃除 + unique nulls not distinct
-- ============================================================

-- 1) 重複掃除: (user_id, school_id) が同じで department_id IS NULL の行が複数ある場合、
--    updated_at が最新のもの以外を削除する。
with ranked as (
  select ctid,
         row_number() over (
           partition by user_id, school_id
           order by updated_at desc nulls last, ctid desc
         ) as rn
    from public.user_school_deviations
   where department_id is null
)
delete from public.user_school_deviations d
 using ranked r
 where d.ctid = r.ctid
   and r.rn > 1;

-- 2) 既存 unique 制約を drop → nulls not distinct 版へ張替
--    制約名は環境依存のため、適用時に上記プレースホルダ手順で置換すること。
alter table public.user_school_deviations
  drop constraint if exists "<UNIQUE_NAME>";

alter table public.user_school_deviations
  add constraint user_school_deviations_user_school_dept_key
    unique nulls not distinct (user_id, school_id, department_id);


-- ============================================================
-- F-17: moddatetime トリガで updated_at 自動更新
-- ============================================================

create extension if not exists moddatetime with schema extensions;

-- user_school_notes
drop trigger if exists set_updated_at on public.user_school_notes;
create trigger set_updated_at
  before update on public.user_school_notes
  for each row execute procedure extensions.moddatetime(updated_at);

-- user_school_deviations
drop trigger if exists set_updated_at on public.user_school_deviations;
create trigger set_updated_at
  before update on public.user_school_deviations
  for each row execute procedure extensions.moddatetime(updated_at);

-- home_locations
drop trigger if exists set_updated_at on public.home_locations;
create trigger set_updated_at
  before update on public.home_locations
  for each row execute procedure extensions.moddatetime(updated_at);

commit;
