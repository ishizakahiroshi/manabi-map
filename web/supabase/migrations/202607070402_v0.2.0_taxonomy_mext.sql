-- =====================================================================
-- v0.2.0 taxonomy refactor: 学科分類の MEXT 準拠化
--
-- 参照: docs/local/plan_v0.2.0_taxonomy-mext.md (D1〜D7)
--
-- 変更:
--   1) course_type_master に mext_category / mext_category_detail /
--      classification_source / notes 列を追加。mext_category は MEXT 学校基本調査
--      の 17 分類（学校教育法施行規則 §81 + 別表）に一致。
--   2) ui_group を旧 6 分類 (general/comprehensive/commercial/industrial/
--      agricultural/welfare) から新 10 分類（英字識別子）へ再定義:
--        general              (普通科)
--        comprehensive        (総合学科)
--        sciences_langs       (理数・国際)
--        arts_sports          (芸術・体育)
--        industrial           (工業)
--        informatics          (情報)
--        commercial           (商業)
--        agriculture_marine   (農業・水産)
--        home_welfare_nursing (家庭・福祉・看護)
--        other                (その他)
--   3) 104 code 全てに mext_category + 新 ui_group を割当。
--      情報系は 工業側/商業側 を mext_category_detail で区別。
--   4) trigger（sync_master_ui_group）が新 ui_group を school_departments.ui_group
--      に自動伝播する既存挙動を維持。
--
-- 校パターン起因の再分類（都立工芸のグラフィックアーツ等）は本 migration では
-- 触れず、Phase 2（別 migration 202607070403）で扱う。本 migration はあくまで
-- 「code → MEXT 17 分類 → UI 10 分類」の master 整備のみ。
--
-- rollback:
--   drop constraint course_type_master_mext_category_check;
--   drop constraint course_type_master_ui_group_check_v2;
--   alter table course_type_master drop column mext_category,
--     drop column mext_category_detail, drop column classification_source, drop column notes;
--   -- ui_group を旧 6 分類に UPDATE 戻し（旧値は本 migration 前の pg_dump から復元）
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1) master に列追加（mext_category は暫定 nullable で入れ、UPDATE 後に NOT NULL 化）
-- ---------------------------------------------------------------------
alter table course_type_master
  add column if not exists mext_category text,
  add column if not exists mext_category_detail text,
  add column if not exists classification_source text default 'MEXT学校基本調査 R6',
  add column if not exists notes text;

-- MEXT 17 分類（学校教育法施行規則 §81 別表 + 学校基本調査 の分類）
alter table course_type_master
  add constraint course_type_master_mext_category_check
  check (mext_category in (
    '普通','総合',
    '農業','工業','商業','水産','家庭','看護','情報','福祉',
    '理数','体育','音楽','美術','外国語','国際関係',
    'その他'
  ));

-- ---------------------------------------------------------------------
-- 2) ui_group を新 10 分類に置き換え
--    先に旧 check を落として、UPDATE → 新 check を張る（同名で衝突しないよう rename）
-- ---------------------------------------------------------------------
alter table course_type_master
  drop constraint if exists course_type_master_ui_group_check;

-- ---------------------------------------------------------------------
-- 3) 104 code 全てを bulk UPDATE
--    (code, mext_category, ui_group, mext_category_detail)
--    mext_category_detail:
--      情報系の '工業寄り' / '商業寄り' を明示。他は null
-- ---------------------------------------------------------------------
update course_type_master m
   set mext_category = t.mext_category,
       ui_group = t.ui_group,
       mext_category_detail = t.mext_category_detail
  from (values
    -- 普通科系
    ('general',                 '普通',      'general',            null),
    ('humanities',              '普通',      'general',            null),
    ('chuko_ikkan',             '普通',      'general',            null),
    ('ib_diploma',              '普通',      'general',            null),
    -- 理数・国際
    ('science',                 '理数',      'sciences_langs',     null),
    ('science_advanced',        '理数',      'sciences_langs',     null),
    ('science_math',            '理数',      'sciences_langs',     null),
    ('international',           '国際関係',  'sciences_langs',     null),
    ('english',                 '外国語',    'sciences_langs',     null),
    ('foreign_language',        '外国語',    'sciences_langs',     null),
    -- 芸術・体育
    ('sports',                  '体育',      'arts_sports',        null),
    ('physical_education',      '体育',      'arts_sports',        null),
    ('art',                     '美術',      'arts_sports',        null),
    ('arts',                    '美術',      'arts_sports',        null),
    ('music',                   '音楽',      'arts_sports',        null),
    ('calligraphy',             '美術',      'arts_sports',        '書道系'),
    ('media_arts',              '美術',      'arts_sports',        null),
    ('stage_arts',              '美術',      'arts_sports',        '舞台表現'),
    ('graphic_arts',            '美術',      'arts_sports',        null),
    ('art_craft',               '美術',      'arts_sports',        null),
    ('interior_design',         '美術',      'arts_sports',        null),
    -- 総合
    ('comprehensive',           '総合',      'comprehensive',      null),
    ('integrated',              '総合',      'comprehensive',      null),
    -- 商業
    ('commercial',              '商業',      'commercial',         null),
    ('accounting',              '商業',      'commercial',         null),
    ('commercial_accounting',   '商業',      'commercial',         null),
    ('commercial_comprehensive_business', '商業', 'commercial',    null),
    ('commercial_international_business', '商業', 'commercial',    '国際ビジネス'),
    -- 情報系（商業寄り）
    ('commercial_info',                 '情報', 'informatics',     '商業寄り'),
    ('commercial_information',          '情報', 'informatics',     '商業寄り'),
    ('commercial_information_business', '情報', 'informatics',     '商業寄り'),
    ('information_processing',          '情報', 'informatics',     '商業寄り'),
    -- 情報系（工業寄り）
    ('industrial_information',          '情報', 'informatics',     '工業寄り'),
    ('industrial_electric_info',        '情報', 'informatics',     '工業寄り'),
    ('information',                     '情報', 'informatics',     null),
    ('information_communication',       '情報', 'informatics',     null),
    ('kosen_electronic_info',           '情報', 'informatics',     '工業寄り（高専）'),
    ('kosen_info',                      '情報', 'informatics',     '工業寄り（高専）'),
    -- 工業
    ('industrial',              '工業',      'industrial',         null),
    ('industrial_architecture', '工業',      'industrial',         null),
    ('industrial_automotive',   '工業',      'industrial',         null),
    ('industrial_chemical',     '工業',      'industrial',         null),
    ('industrial_chemistry',    '工業',      'industrial',         null),
    ('industrial_civil',        '工業',      'industrial',         null),
    ('industrial_construction', '工業',      'industrial',         null),
    ('industrial_creative_tech','工業',      'industrial',         null),
    ('industrial_design',       '工業',      'industrial',         null),
    ('industrial_electric',     '工業',      'industrial',         null),
    ('industrial_electrical',   '工業',      'industrial',         null),
    ('industrial_electronic_mechanical','工業','industrial',       null),
    ('industrial_electronics',  '工業',      'industrial',         null),
    ('industrial_environmental','工業',      'industrial',         null),
    ('industrial_interior',     '工業',      'industrial',         null),
    ('industrial_mechanical',   '工業',      'industrial',         null),
    ('industrial_mechanical_systems','工業', 'industrial',         null),
    ('industrial_mechatronics', '工業',      'industrial',         null),
    ('industrial_production',   '工業',      'industrial',         null),
    ('industrial_machine_craft','工業',      'industrial',         null),
    ('industrial_craft',        '工業',      'industrial',         null),
    ('industrial_general',      '工業',      'industrial',         null),
    ('career_tech',             '工業',      'industrial',         null),
    ('dual_system',             '工業',      'industrial',         null),
    ('civil',                   '工業',      'industrial',         null),
    ('environmental_engineering','工業',     'industrial',         null),
    ('environmental_technology','工業',      'industrial',         null),
    ('radio_technology',        '工業',      'industrial',         null),
    -- 高専（工業扱い。情報寄りは上で informatics）
    ('kosen',                   '工業',      'industrial',         '高専'),
    ('kosen_architecture',      '工業',      'industrial',         '高専'),
    ('kosen_chemistry',         '工業',      'industrial',         '高専'),
    ('kosen_civil',             '工業',      'industrial',         '高専'),
    ('kosen_control',           '工業',      'industrial',         '高専'),
    ('kosen_electrical',        '工業',      'industrial',         '高専'),
    ('kosen_electronic',        '工業',      'industrial',         '高専'),
    ('kosen_electronic_media',  '工業',      'industrial',         '高専'),
    ('kosen_integrated',        '工業',      'industrial',         '高専'),
    ('kosen_mechanical',        '工業',      'industrial',         '高専'),
    -- 農業
    ('agricultural',            '農業',      'agriculture_marine', null),
    ('agriculture',             '農業',      'agriculture_marine', null),
    ('agricultural_animal_science','農業',   'agriculture_marine', null),
    ('agricultural_bio',        '農業',      'agriculture_marine', null),
    ('agricultural_bioproduction','農業',    'agriculture_marine', null),
    ('agricultural_biotech',    '農業',      'agriculture_marine', null),
    ('agricultural_civil',      '農業',      'agriculture_marine', null),
    ('agricultural_economics',  '農業',      'agriculture_marine', null),
    ('agricultural_engineering','農業',      'agriculture_marine', null),
    ('agricultural_food',       '農業',      'agriculture_marine', null),
    ('agricultural_food_science','農業',     'agriculture_marine', null),
    ('agricultural_greenlife',  '農業',      'agriculture_marine', null),
    ('agricultural_horticulture','農業',     'agriculture_marine', null),
    ('agricultural_landscape',  '農業',      'agriculture_marine', null),
    ('agricultural_plant_design','農業',     'agriculture_marine', null),
    ('agricultural_plant_science','農業',    'agriculture_marine', null),
    ('landscape_planning',      '農業',      'agriculture_marine', null),
    ('landscape_environment',   '農業',      'agriculture_marine', null),
    ('natural_environment',     '農業',      'agriculture_marine', null),
    -- 水産
    ('fisheries',               '水産',      'agriculture_marine', null),
    ('fishery',                 '水産',      'agriculture_marine', null),
    ('fishery_food',            '水産',      'agriculture_marine', null),
    ('marine',                  '水産',      'agriculture_marine', null),
    ('marine_navigation',       '水産',      'agriculture_marine', null),
    -- 家庭・福祉・看護
    ('welfare',                 '福祉',      'home_welfare_nursing', null),
    ('human_service',           '福祉',      'home_welfare_nursing', null),
    ('health_nursing',          '看護',      'home_welfare_nursing', null),
    ('nursing',                 '看護',      'home_welfare_nursing', null),
    ('culinary',                '家庭',      'home_welfare_nursing', null),
    ('home_economics',          '家庭',      'home_welfare_nursing', null),
    ('home_economics_clothing', '家庭',      'home_welfare_nursing', null),
    ('home_economics_food',     '家庭',      'home_welfare_nursing', null),
    ('apparel_design',          '家庭',      'home_welfare_nursing', null),
    ('childcare',               '家庭',      'home_welfare_nursing', null),
    ('childcare_nutrition',     '家庭',      'home_welfare_nursing', null),
    -- その他
    ('other',                   'その他',    'other',              null)
  ) as t(code, mext_category, ui_group, mext_category_detail)
 where m.code = t.code;

-- ---------------------------------------------------------------------
-- 4) 未マップ検査（1件でも mext_category が null なら失敗させる）
-- ---------------------------------------------------------------------
do $$
declare
  n int;
begin
  select count(*) into n from course_type_master where mext_category is null;
  if n > 0 then
    raise exception 'mext_category が埋まっていない code が % 件残っています', n;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 5) mext_category を NOT NULL 化
-- ---------------------------------------------------------------------
alter table course_type_master alter column mext_category set not null;

-- ---------------------------------------------------------------------
-- 6) ui_group に新 10 分類の check を張る
-- ---------------------------------------------------------------------
alter table course_type_master
  add constraint course_type_master_ui_group_check_v2
  check (
    ui_group in (
      'general','comprehensive','sciences_langs','arts_sports',
      'industrial','informatics','commercial',
      'agriculture_marine','home_welfare_nursing','other'
    )
  );

-- 旧 6 分類の check は 2 で既に drop 済み。新 check だけ残る。

-- ---------------------------------------------------------------------
-- 7) trigger は既存の sync_master_ui_group が動くので不要。
--    UPDATE で master.ui_group が変わった行は school_departments.ui_group に
--    自動で伝播している（既存 trigger master_ui_group_propagate）。
--    念のため一括再同期しておく（trigger が動いていない万が一の case への保険）:
-- ---------------------------------------------------------------------
update school_departments d
   set ui_group = m.ui_group
  from course_type_master m
 where d.course_type = m.code
   and (d.ui_group is distinct from m.ui_group);

-- ---------------------------------------------------------------------
-- 8) school_departments.ui_group にも同じ check を張る（defense in depth）
-- ---------------------------------------------------------------------
alter table school_departments
  add constraint school_departments_ui_group_check
  check (
    ui_group is null or ui_group in (
      'general','comprehensive','sciences_langs','arts_sports',
      'industrial','informatics','commercial',
      'agriculture_marine','home_welfare_nursing','other'
    )
  );

-- ---------------------------------------------------------------------
-- 9) 分布確認（notice で表示）
-- ---------------------------------------------------------------------
do $$
declare
  r record;
begin
  raise notice '=== 新 ui_group 分布 ===';
  for r in select ui_group, count(*) as n
             from school_departments
            group by 1 order by 2 desc loop
    raise notice '  % : %', coalesce(r.ui_group,'(null)'), r.n;
  end loop;
end $$;

commit;
