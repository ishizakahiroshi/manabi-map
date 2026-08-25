-- =====================================================================
-- 所在地（schools.address / schools.city）を出典管理の対象に加える
--
-- 県ページ・市区町村ページの一覧が所在地を表示するようになったため、
-- 値の根拠を school_field_sources へ残せるようにする。既存 master には
-- latitude / longitude / official_url しか無く、所在地そのものの出典は
-- 「同じ資料から取った座標の行」を経由してしか辿れなかった。
--
-- sort_order は座標（latitude=60 / longitude=70）の直前に置く。
-- 住所 → 市区町村 → 緯度 → 経度 の順で並ぶようにするため、既存の
-- 10 刻みの間へ割り込ませる（既存行の番号は動かさない）。
--
-- rollback:
--   delete from public.school_field_sources
--    where field_name in ('schools.address', 'schools.city');
--   delete from public.school_field_source_field_master
--    where code in ('schools.address', 'schools.city');
-- =====================================================================

begin;

insert into public.school_field_source_field_master
  (code, table_name, column_name, label_ja, sort_order, notes)
values
  (
    'schools.address',
    'schools',
    'address',
    '所在地',
    52,
    '一覧・地図・学校ページに出す所在地。拠点が単一に定まらない広域通信制は、どの拠点を指すかを source_page_or_table に書く'
  ),
  (
    'schools.city',
    'schools',
    'city',
    '市区町村',
    54,
    '所在地の市区町村。値が無い行は address から resolveCityGroup で解決する（gen-schools-json.mjs）'
  )
on conflict (code) do update
   set table_name = excluded.table_name,
       column_name = excluded.column_name,
       label_ja = excluded.label_ja,
       sort_order = excluded.sort_order,
       is_active = true,
       notes = excluded.notes;

do $$
begin
  if not exists (
    select 1
      from public.school_field_source_field_master
     where code = 'schools.address'
       and table_name = 'schools'
       and column_name = 'address'
       and is_active
  ) then
    raise exception 'schools.address source field master row is missing';
  end if;

  if not exists (
    select 1
      from public.school_field_source_field_master
     where code = 'schools.city'
       and table_name = 'schools'
       and column_name = 'city'
       and is_active
  ) then
    raise exception 'schools.city source field master row is missing';
  end if;
end $$;

commit;
