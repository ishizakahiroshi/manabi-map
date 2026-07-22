-- Represents an official source that publishes a selection row but omits a
-- particular metric. It is distinct from a scope mismatch and preserves NULL
-- without deriving values from an aggregate.
begin;

insert into public.admission_quality_reason_master
  (code, label_ja, label_en, sort_order, notes)
values
  ('metric_not_published', '指標が公式未公表', 'Metric not published', 25,
   '公式資料に同一募集単位の行はあるが、当該指標を公表していない。集計値から補完しない。')
on conflict (code) do update set
  label_ja = excluded.label_ja,
  label_en = excluded.label_en,
  sort_order = excluded.sort_order,
  notes = excluded.notes,
  is_active = true;

commit;
