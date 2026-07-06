begin;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'school_course_time') then
    create type school_course_time as enum ('fulltime', 'parttime', 'correspondence');
  end if;

  if not exists (select 1 from pg_type where typname = 'school_campus_type') then
    create type school_campus_type as enum ('main', 'partner_school', 'satellite_campus', 'support_school');
  end if;
end $$;

alter table schools
  add column if not exists course_times school_course_time[] not null default array['fulltime']::school_course_time[],
  add column if not exists main_school_name text,
  add column if not exists campus_type school_campus_type not null default 'main',
  add column if not exists total_students integer,
  add column if not exists enrollment_year integer,
  add column if not exists male_ratio integer;

alter table schools
  drop constraint if exists schools_total_students_nonnegative,
  drop constraint if exists schools_enrollment_year_reasonable,
  drop constraint if exists schools_male_ratio_percent,
  drop constraint if exists schools_course_times_nonempty;

alter table schools
  add constraint schools_course_times_nonempty
    check (cardinality(course_times) > 0),
  add constraint schools_total_students_nonnegative
    check (total_students is null or total_students >= 0),
  add constraint schools_enrollment_year_reasonable
    check (enrollment_year is null or enrollment_year between 2000 and 2100),
  add constraint schools_male_ratio_percent
    check (male_ratio is null or male_ratio between 0 and 100);

update schools
set
  course_times = array['fulltime']::school_course_time[],
  campus_type = 'main'
where prefecture = '群馬県';

update schools
set course_times = array['fulltime','parttime']::school_course_time[]
where name = '桐生市立商業高等学校';

-- source: https://otaflex-hs.gsn.ed.jp/
-- source: https://mapfan.com/spots/SC3IA%2CJ%2CWT5
insert into schools
  (name, name_kana, type, ownership, gender_type, is_integrated, postal_code, prefecture, city, address,
   latitude, longitude, official_url, is_active, is_recruiting, course_times, campus_type)
select
  '群馬県立太田フレックス高等学校',
  'ぐんまけんりつおおたふれっくすこうとうがっこう',
  'high_school',
  'prefectural',
  'coed',
  false,
  '373-0844',
  '群馬県',
  '太田市',
  '群馬県太田市下田島町1243-1',
  36.2653691,
  139.3160590,
  'https://otaflex-hs.gsn.ed.jp/',
  true,
  true,
  array['parttime','correspondence']::school_course_time[],
  'main'
where not exists (
  select 1 from schools where name = '群馬県立太田フレックス高等学校'
);

update schools
set
  course_times = array['parttime','correspondence']::school_course_time[],
  campus_type = 'main'
where name = '群馬県立太田フレックス高等学校';

commit;
