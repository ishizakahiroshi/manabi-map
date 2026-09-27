-- Synthetic-only prototype schema 1. Not the complete school source schema.
CREATE TABLE prototype_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    purpose TEXT NOT NULL CHECK (purpose = 'synthetic-school-prototype'),
    dataset_version TEXT NOT NULL
);
CREATE TABLE schools (
    id TEXT PRIMARY KEY NOT NULL,
    record_key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('high_school', 'kosen')),
    ownership TEXT NOT NULL CHECK (ownership IN ('prefectural', 'municipal', 'national', 'private', 'union')),
    gender_type TEXT NOT NULL CHECK (gender_type IN ('coed', 'boys', 'girls')),
    prefecture TEXT NOT NULL,
    address TEXT NOT NULL,
    official_url TEXT,
    is_integrated INTEGER NOT NULL CHECK (is_integrated IN (0, 1)),
    is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
    updated_at TEXT NOT NULL
);
CREATE TABLE school_departments (
    id TEXT PRIMARY KEY NOT NULL,
    record_key TEXT UNIQUE NOT NULL,
    school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    -- Only this canonical master member is supported in the first slice.
    course_type TEXT CHECK (course_type IS NULL OR course_type = 'general')
);
