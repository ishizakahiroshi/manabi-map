-- =====================================================================
-- v0.2.0 taxonomy Phase 2: 校の系統と学科名がずれるケースの再分類
--
-- 参照: docs/local/plan_v0.2.0_taxonomy-mext.md (Phase 2)
--
-- 背景:
--   Phase 1 で 学科名だけを見て ui_group を割当てたが、都立工芸高校のような
--   「校の系統は工業だがカタカナ学科名（アートクラフト・グラフィックアーツ等）」
--   や、都立八王子桑志の「総合産業高校の産業科(デザイン分野)」、
--   都立瑞穂農芸の「農業高校の生活デザイン科（家政系）」等、
--   校の系統ラベルで再分類が要る個別ケースが Tokyo に集中している。
--
--   関東 6 県を通しで見た結果、Tokyo の 6 校（下記）だけが該当:
--     - 都立工芸高校 (4 学科) — 工業高校
--     - 都立八王子桑志高校 (1 学科) — 総合産業高校
--     - 都立瑞穂農芸高校 (1 学科) — 農業高校
--   他県の芸術系学科は「校が芸術系」or「普通科校の芸術コース」で妥当なため
--   本 migration では触らない。
--
-- 変更:
--   校名 + 学科名を key に course_type を上書き（既存 code に振り直し）。
--   trigger が ui_group / mext_category を master から自動同期する。
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1) 都立工芸高校（工業高等学校）: 全学科を工業系 code へ
--    - アートクラフト科 (art_craft)  → industrial_design（工業デザイン扱い）
--    - インテリア科     (interior_design) → industrial_interior（工業インテリア・既存 code）
--    - グラフィックアーツ科 (graphic_arts) → industrial_design
--    - デザイン科       (art) → industrial_design
--   マシンクラフト科 (industrial_machine_craft) は既に industrial のため触らない
-- ---------------------------------------------------------------------
update school_departments d
   set course_type = 'industrial_design'
  from schools s
 where d.school_id = s.id
   and s.name = '東京都立工芸高等学校'
   and d.course_type in ('art_craft','graphic_arts','art');

update school_departments d
   set course_type = 'industrial_interior'
  from schools s
 where d.school_id = s.id
   and s.name = '東京都立工芸高等学校'
   and d.course_type = 'interior_design';

-- ---------------------------------------------------------------------
-- 2) 都立八王子桑志高校（総合産業高等学校 = 工業系）:
--    産業科(デザイン分野) → industrial_design
-- ---------------------------------------------------------------------
update school_departments d
   set course_type = 'industrial_design'
  from schools s
 where d.school_id = s.id
   and s.name = '東京都立八王子桑志高等学校'
   and d.name = '産業科(デザイン分野)';

-- ---------------------------------------------------------------------
-- 3) 都立瑞穂農芸高校（農業高等学校）:
--    生活デザイン科 → home_economics（家政系・農業校の家庭系学科）
-- ---------------------------------------------------------------------
update school_departments d
   set course_type = 'home_economics'
  from schools s
 where d.school_id = s.id
   and s.name = '東京都立瑞穂農芸高等学校'
   and d.name = '生活デザイン科';

-- ---------------------------------------------------------------------
-- 4) 確認: Tokyo の arts_sports 残り（触るべきでない校のみ残るはず）
-- ---------------------------------------------------------------------
do $$
declare
  r record;
  n int;
begin
  raise notice '=== 再分類後 Tokyo の arts_sports 残 ===';
  for r in
    select s.name as school_name, d.name as dept_name, d.course_type
      from school_departments d
      join schools s on s.id = d.school_id
      join course_type_master m on m.code = d.course_type
     where s.prefecture='東京都' and m.ui_group='arts_sports'
     order by s.name, d.name
  loop
    raise notice '  % / % / %', r.school_name, r.dept_name, r.course_type;
  end loop;

  select count(*) into n
    from school_departments d
    join schools s on s.id = d.school_id
    join course_type_master m on m.code = d.course_type
   where s.prefecture='東京都' and m.ui_group='arts_sports';
  raise notice '合計: % 件（想定: 都立片倉 造形美術 / 都立総合芸術 3 / 都立野津田 体育 / 都立駒場 保健体育 = 計 6 件）', n;
end $$;

commit;
