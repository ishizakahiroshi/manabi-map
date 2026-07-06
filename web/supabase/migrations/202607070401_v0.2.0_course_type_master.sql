-- =====================================================================
-- v0.2.0 C-refactor: course_type master 化
--
-- 背景:
--   school_departments.course_type がフリーテキストで運用されており、
--   (a) 表記ゆれ（art/arts, agricultural/agriculture, fishery/fisheries,
--       industrial_electric/industrial_electrical 等）を DB が防げず、
--   (b) UI の 6 カテゴリへの畳込を deptGroupOf() が startsWith / 個別列挙で
--       ハードコードしており、新 code 追加のたびにフロントを触る必要があった。
--   (c) 東京国立 6 校が seed 誤り (other) で 商業系フィルタ選択時にも表示、
--       都立の家政/工芸/デュアル等 27 件も同じ症状を出していた。
--
-- 変更:
--   1) course_type_master(code, label_ja, label_en, ui_group, sort_order, is_active)
--      を新設し既知 100+ code を seed（ui_group は general/comprehensive/
--      commercial/industrial/agricultural/welfare の 6 分類 or null=その他）。
--   2) school_departments に ui_group 列を追加（非正規化キャッシュ）。
--      master から trigger で自動同期。
--   3) 東京の 27 件 other を学科名に基づき適切な code に再分類。
--   4) 既存 138 件の group を全て backfill、FK 制約で以降のタイポを DB で弾く。
--
-- rollback（適用を取り消す場合・依存順に drop）:
--   alter table school_departments drop constraint school_departments_course_type_fkey;
--   drop trigger if exists master_ui_group_propagate on course_type_master;
--   drop function if exists sync_master_ui_group();
--   drop trigger if exists dept_ui_group_sync on school_departments;
--   drop function if exists sync_dept_ui_group();
--   alter table school_departments drop column ui_group;
--   drop table course_type_master;
--   -- 東京 27 件の other 復元は本 migration 前の pg_dump（backup_pre_v0.2.0_*.dump）から。
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1) master テーブル
-- ---------------------------------------------------------------------
create table course_type_master (
  code text primary key,
  label_ja text not null,
  label_en text not null,
  ui_group text check (
    ui_group in ('general','comprehensive','commercial','industrial','agricultural','welfare')
    or ui_group is null
  ),
  sort_order int not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table course_type_master is
  'department course_type の正規辞書。ui_group は UI 6 カテゴリ絞込に使う。null = その他（UI 全選択時のみ表示）';

alter table course_type_master enable row level security;
create policy "Public read course_type_master"
  on course_type_master for select using (true);

-- ---------------------------------------------------------------------
-- 2) 既知 code の seed
--    ui_group 分類方針:
--      - general:      普通・理数・国際・外国語・IB・スポーツ・美術・音楽・書道・舞台
--                      （中高一貫 chuko_ikkan もここ）
--      - comprehensive: 総合学科・integrated
--      - commercial:   商業系・会計・情報処理・commercial_information*
--                      （情報処理は伝統的に商業系）
--      - industrial:   工業・工科・kosen 全種・情報通信・海洋・無線
--                      （情報単独 information/information_communication もここ）
--      - agricultural: 農業・水産・造園・緑地・自然環境
--      - welfare:      福祉・看護・調理・家政・服飾・食物・保育・ヒューマンサービス
--      - null (その他): その他区分
-- ---------------------------------------------------------------------
insert into course_type_master (code, label_ja, label_en, ui_group, sort_order) values
  -- 普通科系 (general)
  ('general',                 '普通科',                 'General',                'general', 10),
  ('science',                 '理数科',                 'Science',                'general', 11),
  ('science_advanced',        '先進理数科',             'Advanced Science',       'general', 12),
  ('science_math',            '理数・数理科',           'Math & Science',         'general', 13),
  ('international',           '国際科',                 'International',          'general', 20),
  ('english',                 '英語科',                 'English',                'general', 21),
  ('foreign_language',        '外国語科',               'Foreign Language',       'general', 22),
  ('humanities',              '人文科',                 'Humanities',             'general', 23),
  ('chuko_ikkan',             '中高一貫',               'Integrated JHS-HS',      'general', 30),
  ('ib_diploma',              'IB ディプロマ',          'IB Diploma',             'general', 31),
  ('sports',                  'スポーツ科',             'Sports',                 'general', 40),
  ('physical_education',      '体育科',                 'Physical Education',     'general', 41),
  ('art',                     '美術科',                 'Art',                    'general', 50),
  ('arts',                    '芸術科',                 'Arts',                   'general', 51),
  ('music',                   '音楽科',                 'Music',                  'general', 52),
  ('calligraphy',             '書道科',                 'Calligraphy',            'general', 53),
  ('media_arts',              'メディア芸術科',         'Media Arts',             'general', 54),
  ('stage_arts',              '舞台表現科',             'Stage Arts',             'general', 55),
  ('graphic_arts',            'グラフィックアーツ科',   'Graphic Arts',           'general', 56),
  ('art_craft',               'アートクラフト科',       'Art Craft',              'general', 57),
  ('interior_design',         'インテリア科',           'Interior Design',        'general', 58),

  -- 総合学科 (comprehensive)
  ('comprehensive',           '総合学科',               'Comprehensive',          'comprehensive', 100),
  ('integrated',              '総合科',                 'Integrated',             'comprehensive', 101),

  -- 商業系 (commercial)
  ('commercial',              '商業科',                 'Commercial',             'commercial', 200),
  ('accounting',              '会計科',                 'Accounting',             'commercial', 201),
  ('commercial_accounting',   '商業・会計科',           'Commercial Accounting',  'commercial', 202),
  ('commercial_comprehensive_business', '総合ビジネス科', 'Comprehensive Business','commercial', 203),
  ('commercial_info',         '商業情報科',             'Commercial Info',        'commercial', 204),
  ('commercial_information',  '商業情報処理科',         'Commercial Information', 'commercial', 205),
  ('commercial_information_business',  '情報ビジネス科',   'Info Business',        'commercial', 206),
  ('commercial_international_business','国際ビジネス科','International Business','commercial', 207),
  ('information_processing',  '情報処理科',             'Information Processing', 'commercial', 208),

  -- 工業系 (industrial)
  ('industrial',              '工業科',                 'Industrial',             'industrial', 300),
  ('industrial_architecture', '建築科',                 'Architecture',           'industrial', 301),
  ('industrial_automotive',   '自動車科',               'Automotive',             'industrial', 302),
  ('industrial_chemical',     '化学工業科',             'Industrial Chemistry',   'industrial', 303),
  ('industrial_chemistry',    '化学科',                 'Chemistry',              'industrial', 304),
  ('industrial_civil',        '土木科',                 'Civil Engineering',      'industrial', 305),
  ('industrial_construction', '建設科',                 'Construction',           'industrial', 306),
  ('industrial_creative_tech','クリエイティブ技術科',   'Creative Tech',          'industrial', 307),
  ('industrial_design',       'デザイン科',             'Design',                 'industrial', 308),
  ('industrial_electric',     '電気科',                 'Electric',               'industrial', 309),
  ('industrial_electric_info','電気情報科',             'Electric Info',          'industrial', 310),
  ('industrial_electrical',   '電気・電子科',           'Electrical',             'industrial', 311),
  ('industrial_electronic_mechanical','電子機械科',     'Electronic Mechanical',  'industrial', 312),
  ('industrial_electronics',  '電子科',                 'Electronics',            'industrial', 313),
  ('industrial_environmental','環境工業科',             'Environmental Ind.',     'industrial', 314),
  ('industrial_information',  '情報技術科',             'Information Technology', 'industrial', 315),
  ('industrial_interior',     'インテリア工業科',       'Industrial Interior',    'industrial', 316),
  ('industrial_mechanical',   '機械科',                 'Mechanical',             'industrial', 317),
  ('industrial_mechanical_systems','機械システム科',    'Mechanical Systems',     'industrial', 318),
  ('industrial_mechatronics', 'メカトロニクス科',       'Mechatronics',           'industrial', 319),
  ('industrial_production',   '生産システム科',         'Production Systems',     'industrial', 320),
  ('industrial_machine_craft','マシンクラフト科',       'Machine Craft',          'industrial', 321),
  ('industrial_craft',        '産業科（クラフト）',     'Industrial (Craft)',     'industrial', 322),
  ('industrial_general',      '産業科',                 'Industrial (General)',   'industrial', 323),
  ('career_tech',             'キャリア技術科',         'Career Tech',            'industrial', 324),
  ('dual_system',             'デュアルシステム科',     'Dual System',            'industrial', 325),
  ('civil',                   '土木科',                 'Civil',                  'industrial', 330),
  ('environmental_engineering','環境工学科',            'Environmental Eng.',     'industrial', 331),
  ('environmental_technology','環境化学科',             'Environmental Tech.',    'industrial', 332),
  ('information',             '情報科',                 'Information',            'industrial', 333),
  ('information_communication','情報通信科',            'Information Comm.',      'industrial', 334),
  ('marine',                  '海洋科',                 'Marine',                 'industrial', 340),
  ('marine_navigation',       '海洋航海科',             'Marine Navigation',      'industrial', 341),
  ('radio_technology',        '無線技術科',             'Radio Technology',       'industrial', 342),
  ('kosen',                   '本科（高専）',           'Kosen',                  'industrial', 350),
  ('kosen_architecture',      '建築学科（高専）',       'Kosen Architecture',     'industrial', 351),
  ('kosen_chemistry',         '化学分野（高専）',       'Kosen Chemistry',        'industrial', 352),
  ('kosen_civil',             '土木分野（高専）',       'Kosen Civil',            'industrial', 353),
  ('kosen_control',           '制御分野（高専）',       'Kosen Control',          'industrial', 354),
  ('kosen_electrical',        '電気分野（高専）',       'Kosen Electrical',       'industrial', 355),
  ('kosen_electronic',        '電子分野（高専）',       'Kosen Electronic',       'industrial', 356),
  ('kosen_electronic_info',   '電子情報分野（高専）',   'Kosen Electronic Info',  'industrial', 357),
  ('kosen_electronic_media',  '電子メディア分野（高専）','Kosen Electronic Media','industrial', 358),
  ('kosen_info',              '情報分野（高専）',       'Kosen Info',             'industrial', 359),
  ('kosen_integrated',        '融合分野（高専）',       'Kosen Integrated',       'industrial', 360),
  ('kosen_mechanical',        '機械分野（高専）',       'Kosen Mechanical',       'industrial', 361),

  -- 農業系 (agricultural)
  ('agricultural',            '農業科',                 'Agricultural',           'agricultural', 400),
  ('agriculture',             '農業（agriculture）',    'Agriculture',            'agricultural', 401),
  ('agricultural_animal_science','動物科学科',          'Animal Science',         'agricultural', 402),
  ('agricultural_bio',        'バイオ農業科',           'Agricultural Bio',       'agricultural', 403),
  ('agricultural_bioproduction','バイオ生産科',         'Bioproduction',          'agricultural', 404),
  ('agricultural_biotech',    'バイオテクノロジー科',   'Biotech',                'agricultural', 405),
  ('agricultural_civil',      '農業土木科',             'Agricultural Civil',     'agricultural', 406),
  ('agricultural_economics',  '農業経済科',             'Agricultural Economics', 'agricultural', 407),
  ('agricultural_engineering','農業機械科',             'Agricultural Eng.',      'agricultural', 408),
  ('agricultural_food',       '食料生産科',             'Agricultural Food',      'agricultural', 409),
  ('agricultural_food_science','食品科学科',            'Food Science',           'agricultural', 410),
  ('agricultural_greenlife',  'グリーンライフ科',       'Green Life',             'agricultural', 411),
  ('agricultural_horticulture','園芸科',                'Horticulture',           'agricultural', 412),
  ('agricultural_landscape',  '造園科',                 'Landscape',              'agricultural', 413),
  ('agricultural_plant_design','植物デザイン科',        'Plant Design',           'agricultural', 414),
  ('agricultural_plant_science','植物科学科',           'Plant Science',          'agricultural', 415),
  ('landscape_planning',      '緑地計画科',             'Landscape Planning',     'agricultural', 416),
  ('landscape_environment',   '緑地環境科',             'Landscape Environment',  'agricultural', 417),
  ('natural_environment',     '自然環境科',             'Natural Environment',    'agricultural', 418),
  ('fisheries',               '水産科',                 'Fisheries',              'agricultural', 420),
  ('fishery',                 '水産（fishery）',        'Fishery',                'agricultural', 421),
  ('fishery_food',            '水産食品科',             'Fishery Food',           'agricultural', 422),

  -- 福祉・看護・家庭系 (welfare)
  ('welfare',                 '福祉科',                 'Welfare',                'welfare', 500),
  ('health_nursing',          '看護科',                 'Health & Nursing',       'welfare', 501),
  ('nursing',                 '看護（nursing）',        'Nursing',                'welfare', 502),
  ('human_service',           'ヒューマンサービス科',   'Human Service',          'welfare', 503),
  ('culinary',                '調理科',                 'Culinary',               'welfare', 510),
  ('home_economics',          '家政科',                 'Home Economics',         'welfare', 520),
  ('home_economics_clothing', '服飾科',                 'Home Economics (Clothing)','welfare', 521),
  ('home_economics_food',     '食物科',                 'Home Economics (Food)',  'welfare', 522),
  ('apparel_design',          'ファッションデザイン科', 'Apparel Design',         'welfare', 523),
  ('childcare',               '保育科',                 'Childcare',              'welfare', 524),
  ('childcare_nutrition',     '保育・栄養科',           'Childcare & Nutrition',  'welfare', 525),

  -- その他 (null = 未分類 = UI 全選択時のみ表示)
  ('other',                   'その他',                 'Other',                  null, 999)
;

-- ---------------------------------------------------------------------
-- 3) school_departments に ui_group 列を追加（非正規化キャッシュ）
-- ---------------------------------------------------------------------
alter table school_departments add column if not exists ui_group text;

-- ---------------------------------------------------------------------
-- 4) 既存 138 件を backfill（他都県は現行 code に対応する ui_group が入る。
--    東京の other 27 件はこの時点で ui_group=null になり、次の step で
--    course_type を差し替えた後に再 backfill）
-- ---------------------------------------------------------------------
update school_departments d
   set ui_group = m.ui_group
  from course_type_master m
 where d.course_type = m.code;

-- ---------------------------------------------------------------------
-- 5) 東京 27 件 other → 学科名から適切な code へ再分類
--    国立 6 校（普通科）は 202607070401 の前段（既に手動で general 化済）
--    にて処理済のため対象外。
-- ---------------------------------------------------------------------
update school_departments d set course_type = 'home_economics'
  from schools s where d.school_id = s.id
   and d.course_type = 'other' and d.name = '家政科' and s.prefecture='東京都';

update school_departments d set course_type = 'career_tech'
  from schools s where d.school_id = s.id
   and d.course_type = 'other' and d.name = 'キャリア技術科' and s.prefecture='東京都';

update school_departments d set course_type = 'industrial_craft'
  from schools s where d.school_id = s.id
   and d.course_type = 'other' and d.name = '産業科(クラフト分野)' and s.prefecture='東京都';

update school_departments d set course_type = 'industrial_general'
  from schools s where d.school_id = s.id
   and d.course_type = 'other' and d.name = '産業科' and s.prefecture='東京都';

update school_departments d set course_type = 'dual_system'
  from schools s where d.school_id = s.id
   and d.course_type = 'other' and d.name = 'デュアルシステム科' and s.prefecture='東京都';

update school_departments d set course_type = 'environmental_technology'
  from schools s where d.school_id = s.id
   and d.course_type = 'other' and d.name = '環境化学科' and s.prefecture='東京都';

update school_departments d set course_type = 'industrial_electronics'
  from schools s where d.school_id = s.id
   and d.course_type = 'other' and d.name = '電子科' and s.prefecture='東京都';

update school_departments d set course_type = 'industrial_machine_craft'
  from schools s where d.school_id = s.id
   and d.course_type = 'other' and d.name = 'マシンクラフト科' and s.prefecture='東京都';

update school_departments d set course_type = 'graphic_arts'
  from schools s where d.school_id = s.id
   and d.course_type = 'other' and d.name = 'グラフィックアーツ科' and s.prefecture='東京都';

update school_departments d set course_type = 'interior_design'
  from schools s where d.school_id = s.id
   and d.course_type = 'other' and d.name = 'インテリア科' and s.prefecture='東京都';

update school_departments d set course_type = 'art_craft'
  from schools s where d.school_id = s.id
   and d.course_type = 'other' and d.name = 'アートクラフト科' and s.prefecture='東京都';

update school_departments d set course_type = 'stage_arts'
  from schools s where d.school_id = s.id
   and d.course_type = 'other' and d.name = '舞台表現科' and s.prefecture='東京都';

update school_departments d set course_type = 'childcare_nutrition'
  from schools s where d.school_id = s.id
   and d.course_type = 'other' and d.name = '保育・栄養科' and s.prefecture='東京都';

update school_departments d set course_type = 'culinary'
  from schools s where d.school_id = s.id
   and d.course_type = 'other' and d.name = '調理科' and s.prefecture='東京都';

update school_departments d set course_type = 'home_economics_clothing'
  from schools s where d.school_id = s.id
   and d.course_type = 'other' and d.name = '服飾科' and s.prefecture='東京都';

update school_departments d set course_type = 'landscape_planning'
  from schools s where d.school_id = s.id
   and d.course_type = 'other' and d.name = '緑地計画科' and s.prefecture='東京都';

update school_departments d set course_type = 'landscape_environment'
  from schools s where d.school_id = s.id
   and d.course_type = 'other' and d.name = '緑地環境科' and s.prefecture='東京都';

update school_departments d set course_type = 'home_economics_food'
  from schools s where d.school_id = s.id
   and d.course_type = 'other' and d.name = '食物科' and s.prefecture='東京都';

update school_departments d set course_type = 'industrial_automotive'
  from schools s where d.school_id = s.id
   and d.course_type = 'other' and d.name = '自動車科' and s.prefecture='東京都';

-- ---------------------------------------------------------------------
-- 6) ui_group を再 backfill（step 5 で course_type が変わった行のため）
-- ---------------------------------------------------------------------
update school_departments d
   set ui_group = m.ui_group
  from course_type_master m
 where d.course_type = m.code;

-- ---------------------------------------------------------------------
-- 7) trigger: school_departments 側の course_type 変更時に ui_group を master から自動同期
-- ---------------------------------------------------------------------
create or replace function sync_dept_ui_group() returns trigger
language plpgsql
as $$
begin
  select ui_group into new.ui_group
    from course_type_master
   where code = new.course_type;
  return new;
end;
$$;

drop trigger if exists dept_ui_group_sync on school_departments;
create trigger dept_ui_group_sync
  before insert or update of course_type on school_departments
  for each row execute function sync_dept_ui_group();

-- ---------------------------------------------------------------------
-- 8) trigger: master 側の ui_group を変えた時に school_departments に伝播
-- ---------------------------------------------------------------------
create or replace function sync_master_ui_group() returns trigger
language plpgsql
as $$
begin
  update school_departments
     set ui_group = new.ui_group
   where course_type = new.code
     and (ui_group is distinct from new.ui_group);
  return new;
end;
$$;

drop trigger if exists master_ui_group_propagate on course_type_master;
create trigger master_ui_group_propagate
  after update of ui_group on course_type_master
  for each row execute function sync_master_ui_group();

-- ---------------------------------------------------------------------
-- 9) 未マップ検査（1件でも残っていたら FK 追加は失敗するはずだが明示的に）
-- ---------------------------------------------------------------------
do $$
declare
  n_missing int;
  n_other int;
begin
  select count(*) into n_missing
    from school_departments d
   where d.course_type is not null
     and not exists (select 1 from course_type_master m where m.code = d.course_type);
  if n_missing > 0 then
    raise exception 'course_type without master row: % 件', n_missing;
  end if;

  select count(*) into n_other
    from school_departments where course_type = 'other';
  raise notice '残 other 行数: % 件（master 側で ui_group=null なので UI 全選択時のみ表示）', n_other;
end $$;

-- ---------------------------------------------------------------------
-- 10) FK 制約: 以降は master に存在しない code の INSERT/UPDATE は DB が弾く
--     on update cascade: master 側で code を rename しても departments 側は追随
--     on delete restrict: 使用中の code は master から削除できない
-- ---------------------------------------------------------------------
alter table school_departments
  add constraint school_departments_course_type_fkey
  foreign key (course_type) references course_type_master(code)
  on update cascade on delete restrict;

commit;
