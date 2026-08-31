-- =====================================================================
-- home_locations に残る中心地点を必要最小限の形に縮約する。
--
-- 変換:
--   label/address       -> '設定地点'
--   latitude/longitude  -> 小数3桁
--
-- 注意:
--   この変換で捨てる詳細labelと座標精度はSQLでは復元できない。
--   production適用前にbackupと対象件数を確認し、rollbackが必要な場合は
--   そのbackupからrestoreする。本fileを作成しただけではDBへ適用しない。
--
-- schema rollbackのみ（捨てたdataは戻らない）:
--   alter table public.home_locations
--     drop constraint if exists home_locations_label_minimized,
--     drop constraint if exists home_locations_address_minimized,
--     drop constraint if exists home_locations_latitude_minimized,
--     drop constraint if exists home_locations_longitude_minimized;
--   alter table public.home_locations
--     alter column label set default '自宅',
--     alter column address drop default;
-- =====================================================================

begin;

do $$
declare
  target_count bigint;
  converted_count bigint;
begin
  select count(*)
    into target_count
    from public.home_locations
   where label is distinct from '設定地点'
      or address is distinct from '設定地点'
      or latitude is distinct from round(latitude, 3)
      or longitude is distinct from round(longitude, 3);

  raise notice 'home_locations rows to minimize: %', target_count;

  update public.home_locations
     set label = '設定地点',
         address = '設定地点',
         latitude = round(latitude, 3),
         longitude = round(longitude, 3)
   where label is distinct from '設定地点'
      or address is distinct from '設定地点'
      or latitude is distinct from round(latitude, 3)
      or longitude is distinct from round(longitude, 3);

  get diagnostics converted_count = row_count;
  if converted_count <> target_count then
    raise exception
      'home_locations minimization count mismatch: expected %, updated %',
      target_count,
      converted_count;
  end if;

  if exists (
    select 1
      from public.home_locations
     where label is distinct from '設定地点'
        or address is distinct from '設定地点'
        or latitude is distinct from round(latitude, 3)
        or longitude is distinct from round(longitude, 3)
  ) then
    raise exception 'home_locations minimization assertion failed';
  end if;
end $$;

alter table public.home_locations
  alter column label set default '設定地点',
  alter column address set default '設定地点';

alter table public.home_locations
  add constraint home_locations_label_minimized
    check (label = '設定地点') not valid,
  add constraint home_locations_address_minimized
    check (address = '設定地点') not valid,
  add constraint home_locations_latitude_minimized
    check (latitude = round(latitude, 3)) not valid,
  add constraint home_locations_longitude_minimized
    check (longitude = round(longitude, 3)) not valid;

alter table public.home_locations
  validate constraint home_locations_label_minimized,
  validate constraint home_locations_address_minimized,
  validate constraint home_locations_latitude_minimized,
  validate constraint home_locations_longitude_minimized;

commit;
