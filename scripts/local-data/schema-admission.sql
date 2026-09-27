-- C1-c. No defaults, generated identities or silent repairs.
-- FK actions preserve baseline DDL. The importer does not expose deletion.
CREATE TABLE admission_recruitment_unit_kind_master (
 code TEXT PRIMARY KEY NOT NULL CHECK(code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z0-9_]*'),
 label_ja TEXT NOT NULL CHECK(trim(label_ja) <> ''), label_en TEXT NOT NULL CHECK(trim(label_en) <> ''),
 sort_order INTEGER NOT NULL, is_active INTEGER NOT NULL CHECK(is_active IN (0,1)),
 notes TEXT, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE admission_selection_stage_master (
 code TEXT PRIMARY KEY NOT NULL CHECK(code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z0-9_]*'),
 label_ja TEXT NOT NULL CHECK(trim(label_ja) <> ''), label_en TEXT NOT NULL CHECK(trim(label_en) <> ''),
 sort_order INTEGER NOT NULL, is_active INTEGER NOT NULL CHECK(is_active IN (0,1)),
 notes TEXT, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE admission_selection_track_master (
 code TEXT PRIMARY KEY NOT NULL CHECK(code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z0-9_]*'),
 label_ja TEXT NOT NULL CHECK(trim(label_ja) <> ''), label_en TEXT NOT NULL CHECK(trim(label_en) <> ''),
 sort_order INTEGER NOT NULL, is_active INTEGER NOT NULL CHECK(is_active IN (0,1)),
 notes TEXT, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE admission_map_role_master (
 code TEXT PRIMARY KEY NOT NULL CHECK(code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z0-9_]*'),
 label_ja TEXT NOT NULL CHECK(trim(label_ja) <> ''), label_en TEXT NOT NULL CHECK(trim(label_en) <> ''),
 sort_order INTEGER NOT NULL, is_active INTEGER NOT NULL CHECK(is_active IN (0,1)),
 notes TEXT, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE admission_exam_component_master (
 code TEXT PRIMARY KEY NOT NULL CHECK(code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z0-9_]*'),
 label_ja TEXT NOT NULL CHECK(trim(label_ja) <> ''), label_en TEXT NOT NULL CHECK(trim(label_en) <> ''),
 sort_order INTEGER NOT NULL, is_active INTEGER NOT NULL CHECK(is_active IN (0,1)),
 notes TEXT, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE admission_quality_reason_master (
 code TEXT PRIMARY KEY NOT NULL CHECK(code GLOB '[a-z]*' AND code NOT GLOB '*[^a-z0-9_]*'),
 label_ja TEXT NOT NULL CHECK(trim(label_ja) <> ''), label_en TEXT NOT NULL CHECK(trim(label_en) <> ''),
 sort_order INTEGER NOT NULL, is_active INTEGER NOT NULL CHECK(is_active IN (0,1)),
 notes TEXT, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE school_admission_stats (
 id TEXT PRIMARY KEY NOT NULL, school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 department_id TEXT REFERENCES school_departments(id) ON DELETE CASCADE, year INTEGER NOT NULL CHECK(year BETWEEN 2000 AND 2100),
 capacity INTEGER CHECK(capacity >= 0), applicants INTEGER CHECK(applicants >= 0),
 examinees INTEGER CHECK(examinees >= 0), admitted INTEGER CHECK(admitted >= 0),
 note TEXT, source_url TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX admission_legacy_department_year ON school_admission_stats(school_id, department_id, year)
 WHERE department_id IS NOT NULL;
CREATE UNIQUE INDEX admission_legacy_school_year ON school_admission_stats(school_id, year)
 WHERE department_id IS NULL;
CREATE TABLE school_deviation_values (
 id TEXT PRIMARY KEY NOT NULL, school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 department_id TEXT REFERENCES school_departments(id), value INTEGER NOT NULL, year INTEGER NOT NULL,
 source_type TEXT NOT NULL CHECK(source_type IN ('manabi_estimate','official','user_estimate')),
 estimate_method TEXT, note TEXT, is_active INTEGER NOT NULL CHECK(is_active IN (0,1)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 estimate_basis TEXT CHECK(estimate_basis IN ('official_exam_distribution','licensed_assessment',
 'human_anchor_review','admin_override','application_ratio_legacy','editorial_unverified')),
 CHECK(NOT (estimate_basis = 'application_ratio_legacy' AND is_active = 1))
) STRICT;
-- PostgreSQL ordinary UNIQUE preserves distinct NULL department entries here.
CREATE UNIQUE INDEX admission_deviation_active_department ON school_deviation_values(department_id) WHERE is_active = 1;
CREATE UNIQUE INDEX admission_deviation_active_school_department ON school_deviation_values(school_id, department_id) WHERE is_active = 1;
CREATE TABLE admission_recruitment_units (
 id TEXT PRIMARY KEY NOT NULL, school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 unit_key TEXT NOT NULL CHECK(trim(unit_key) <> ''),
 unit_kind_code TEXT NOT NULL REFERENCES admission_recruitment_unit_kind_master(code) ON UPDATE CASCADE ON DELETE RESTRICT,
 label TEXT NOT NULL CHECK(trim(label) <> ''),
 course_time TEXT CHECK(course_time IN ('fulltime','parttime','correspondence')),
 valid_from_year INTEGER CHECK(valid_from_year BETWEEN 2000 AND 2100),
 valid_to_year INTEGER CHECK(valid_to_year BETWEEN 2000 AND 2100),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(school_id, unit_key), CHECK(valid_to_year >= valid_from_year)
) STRICT;
CREATE TABLE admission_recruitment_unit_departments (
 unit_id TEXT NOT NULL REFERENCES admission_recruitment_units(id) ON DELETE CASCADE,
 department_id TEXT NOT NULL REFERENCES school_departments(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
 PRIMARY KEY(unit_id, department_id)
) STRICT;
CREATE TABLE school_admission_selection_stats (
 id TEXT PRIMARY KEY NOT NULL, recruitment_unit_id TEXT NOT NULL REFERENCES admission_recruitment_units(id) ON DELETE CASCADE,
 year INTEGER NOT NULL CHECK(year BETWEEN 2000 AND 2100),
 selection_stage_code TEXT NOT NULL REFERENCES admission_selection_stage_master(code) ON UPDATE CASCADE ON DELETE RESTRICT,
 selection_track_code TEXT NOT NULL REFERENCES admission_selection_track_master(code) ON UPDATE CASCADE ON DELETE RESTRICT,
 stage_label_raw TEXT NOT NULL CHECK(trim(stage_label_raw) <> ''),
 track_label_raw TEXT NOT NULL CHECK(trim(track_label_raw) <> ''),
 selection_scope_raw TEXT NOT NULL CHECK(trim(selection_scope_raw) <> ''), population_scope_raw TEXT,
 scope_key TEXT NOT NULL CHECK(trim(scope_key) <> ''),
 map_role_code TEXT NOT NULL REFERENCES admission_map_role_master(code) ON UPDATE CASCADE ON DELETE RESTRICT,
 is_ratio_comparable INTEGER NOT NULL CHECK(is_ratio_comparable IN (0,1)),
 capacity INTEGER CHECK(capacity >= 0), applicants INTEGER CHECK(applicants >= 0),
 examinees INTEGER CHECK(examinees >= 0), admitted INTEGER CHECK(admitted >= 0), exam_scope_raw TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(recruitment_unit_id, year, selection_stage_code, selection_track_code, scope_key),
 CHECK(is_ratio_comparable = 0 OR (capacity IS NOT NULL AND capacity > 0 AND applicants IS NOT NULL)),
 CHECK(map_role_code <> 'primary_total' OR (selection_stage_code = 'primary' AND is_ratio_comparable = 1))
) STRICT;
CREATE TABLE school_admission_stat_exam_components (
 stat_id TEXT NOT NULL REFERENCES school_admission_selection_stats(id) ON DELETE CASCADE,
 component_code TEXT NOT NULL REFERENCES admission_exam_component_master(code) ON UPDATE CASCADE ON DELETE RESTRICT, created_at TEXT NOT NULL,
 PRIMARY KEY(stat_id, component_code)
) STRICT;
CREATE TABLE school_admission_stat_quality_flags (
 stat_id TEXT NOT NULL REFERENCES school_admission_selection_stats(id) ON DELETE CASCADE,
 metric_code TEXT CHECK(metric_code IN ('capacity','applicants','examinees','admitted','selection_rule','exam_method')),
 reason_code TEXT NOT NULL REFERENCES admission_quality_reason_master(code) ON UPDATE CASCADE ON DELETE RESTRICT,
 note TEXT CHECK(trim(note) <> ''), created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX admission_quality_metric ON school_admission_stat_quality_flags(stat_id, metric_code, reason_code)
 WHERE metric_code IS NOT NULL;
CREATE UNIQUE INDEX admission_quality_whole ON school_admission_stat_quality_flags(stat_id, reason_code)
 WHERE metric_code IS NULL;
CREATE TABLE school_admission_stat_sources (
 stat_id TEXT NOT NULL REFERENCES school_admission_selection_stats(id) ON DELETE CASCADE,
 fact_kind_code TEXT NOT NULL CHECK(fact_kind_code IN ('capacity','applicants','examinees','admitted','selection_rule','exam_method')),
 official_url TEXT NOT NULL CHECK(lower(official_url) GLOB 'http://?*' OR lower(official_url) GLOB 'https://?*'),
 doc_title TEXT NOT NULL CHECK(trim(doc_title) <> ''), published_at TEXT,
 source_page_or_table TEXT CHECK(trim(source_page_or_table) <> ''),
 quoted_evidence TEXT CHECK(trim(quoted_evidence) <> '' AND length(quoted_evidence) <= 80),
 last_verified_at TEXT, last_http_status INTEGER CHECK(last_http_status BETWEEN 100 AND 599),
 created_at TEXT NOT NULL, PRIMARY KEY(stat_id, fact_kind_code),
 CHECK((last_verified_at IS NULL) = (last_http_status IS NULL))
) STRICT;
CREATE TABLE school_admission_stat_legacy_links (
 stat_id TEXT NOT NULL REFERENCES school_admission_selection_stats(id) ON DELETE CASCADE,
 legacy_stat_id TEXT NOT NULL REFERENCES school_admission_stats(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
 PRIMARY KEY(stat_id, legacy_stat_id)
) STRICT;
