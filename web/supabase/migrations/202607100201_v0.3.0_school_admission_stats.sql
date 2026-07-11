-- =====================================================================
-- v0.3.0: school_admission_stats — 学校・学科・年度別の入試実績
--
-- 募集人数（capacity）・志願者数（applicants）・受検者数（examinees）・
-- 合格者数（admitted）を年度別に保持する。県教委が公表する
-- 「志願状況」「入学者選抜の実施状況」「合格状況」由来の事実データのみを
-- 入れる（推計値は school_deviation_values 側・本テーブルには入れない）。
--
-- 背景: 学校別の得点データを公表しない県（北陸 3 県で確認）では偏差値の
-- 式推計が成立せず、倍率参考値は誤読リスクが高い。事実データ（倍率の推移）を
-- 一級市民として持つことで、偏差値は式算出できた学科のみに絞れる。
-- =====================================================================

begin;

create table if not exists public.school_admission_stats (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  department_id uuid references public.school_departments(id) on delete cascade,
  year integer not null check (year between 2000 and 2100),
  capacity integer check (capacity >= 0),
  applicants integer check (applicants >= 0),
  examinees integer check (examinees >= 0),
  admitted integer check (admitted >= 0),
  note text,
  source_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (school_id, department_id, year)
);

comment on table public.school_admission_stats is
  '学校・学科・年度別の入試実績（募集/志願/受検/合格）。公的資料の転記のみ・推計値や商用サイト由来の数値は入れない';

create index if not exists idx_admission_stats_school
  on public.school_admission_stats (school_id, year desc);

alter table public.school_admission_stats enable row level security;

create policy "Public read school_admission_stats"
  on public.school_admission_stats for select using (true);

commit;
