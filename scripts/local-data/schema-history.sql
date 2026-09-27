-- C1-b: lossless history source, following lifecycle and west-contract migrations.
CREATE TABLE school_relationship_type_master (
    code TEXT PRIMARY KEY NOT NULL CHECK (trim(code) <> ''),
    label_ja TEXT NOT NULL,
    label_en TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    is_active INTEGER NOT NULL CHECK (is_active IN (0,1)),
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE school_name_history (
    id TEXT PRIMARY KEY NOT NULL,
    school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
    name TEXT NOT NULL CHECK (trim(name) <> ''),
    name_kana TEXT,
    valid_from TEXT,
    valid_to TEXT,
    official_url TEXT NOT NULL CHECK (official_url GLOB 'http://*' OR official_url GLOB 'https://*'),
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from)
) STRICT;
CREATE UNIQUE INDEX school_name_history_unique
    ON school_name_history (school_id, name, coalesce(valid_from, '0001-01-01'));
CREATE INDEX school_name_history_school_idx ON school_name_history (school_id, valid_from DESC);

CREATE TABLE school_relationships (
    id TEXT PRIMARY KEY NOT NULL,
    predecessor_school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
    successor_school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
    relationship_type_code TEXT NOT NULL REFERENCES school_relationship_type_master(code)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    effective_on TEXT,
    official_url TEXT NOT NULL CHECK (official_url GLOB 'http://*' OR official_url GLOB 'https://*'),
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    effective_admission_year INTEGER CHECK (effective_admission_year BETWEEN 1900 AND 2100),
    evidence_status TEXT NOT NULL CHECK (evidence_status IN ('official_confirmed','official_partial','unresolved')),
    CHECK (predecessor_school_id <> successor_school_id),
    CHECK (effective_on IS NOT NULL OR effective_admission_year IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX school_relationships_unique_null_safe ON school_relationships (
    predecessor_school_id, successor_school_id, relationship_type_code,
    coalesce(effective_on, '0001-01-01'), coalesce(effective_admission_year, -1)
);
CREATE INDEX school_relationships_predecessor_idx ON school_relationships (predecessor_school_id, effective_on DESC);
CREATE INDEX school_relationships_successor_idx ON school_relationships (successor_school_id, effective_on DESC);
