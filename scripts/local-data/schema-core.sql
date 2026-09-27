-- C1-a only: seven source tables plus private version metadata, no implicit upgrade.
CREATE TABLE source_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    schema_version INTEGER NOT NULL,
    purpose TEXT NOT NULL,
    dataset_version TEXT NOT NULL
) STRICT;

CREATE TABLE course_type_master (
    code TEXT PRIMARY KEY NOT NULL,
    label_ja TEXT NOT NULL,
    label_en TEXT NOT NULL,
    ui_group TEXT CHECK (ui_group IN ('general','comprehensive','sciences_langs','arts_sports','industrial','informatics','commercial','agriculture_marine','home_welfare_nursing','other')),
    sort_order INTEGER NOT NULL,
    is_active INTEGER NOT NULL CHECK (is_active IN (0,1)),
    created_at TEXT NOT NULL,
    mext_category TEXT NOT NULL CHECK (mext_category IN ('普通','総合','農業','工業','商業','水産','家庭','看護','情報','福祉','理数','体育','音楽','美術','外国語','国際関係','その他')),
    mext_category_detail TEXT,
    classification_source TEXT,
    notes TEXT
) STRICT;

CREATE TABLE school_lifecycle_status_master (
    code TEXT PRIMARY KEY NOT NULL CHECK (trim(code) <> ''),
    label_ja TEXT NOT NULL,
    label_en TEXT NOT NULL,
    is_map_active INTEGER NOT NULL CHECK (is_map_active IN (0,1)),
    forces_not_recruiting INTEGER NOT NULL CHECK (forces_not_recruiting IN (0,1)),
    sort_order INTEGER NOT NULL,
    is_active INTEGER NOT NULL CHECK (is_active IN (0,1)),
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE school_recruitment_status_master (
    code TEXT PRIMARY KEY NOT NULL CHECK (trim(code) <> ''),
    label_ja TEXT NOT NULL,
    label_en TEXT NOT NULL,
    is_recruiting_compat INTEGER NOT NULL CHECK (is_recruiting_compat IN (0,1)),
    sort_order INTEGER NOT NULL,
    is_active INTEGER NOT NULL CHECK (is_active IN (0,1)),
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE school_field_source_field_master (
    code TEXT PRIMARY KEY NOT NULL,
    table_name TEXT NOT NULL,
    column_name TEXT NOT NULL,
    label_ja TEXT NOT NULL CHECK (trim(label_ja) <> ''),
    sort_order INTEGER NOT NULL,
    is_active INTEGER NOT NULL CHECK (is_active IN (0,1)),
    notes TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (table_name, column_name),
    CHECK (code = table_name || '.' || column_name)
) STRICT;

CREATE TABLE schools (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    name_kana TEXT,
    type TEXT NOT NULL CHECK (type IN ('high_school','kosen')),
    ownership TEXT NOT NULL CHECK (ownership IN ('prefectural','municipal','national','private','union')),
    gender_type TEXT NOT NULL CHECK (gender_type IN ('coed','boys','girls')),
    is_integrated INTEGER NOT NULL CHECK (is_integrated IN (0,1)),
    postal_code TEXT,
    prefecture TEXT NOT NULL,
    city TEXT,
    address TEXT NOT NULL,
    latitude TEXT,
    longitude TEXT,
    official_url TEXT,
    is_active INTEGER NOT NULL CHECK (is_active IN (0,1)),
    is_recruiting INTEGER NOT NULL CHECK (is_recruiting IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    course_times TEXT NOT NULL CHECK (json_valid(course_times) AND json_type(course_times) = 'array' AND json_array_length(course_times) > 0),
    main_school_name TEXT,
    campus_type TEXT NOT NULL CHECK (campus_type IN ('main','partner_school','satellite_campus','support_school')),
    total_students INTEGER CHECK (total_students >= 0),
    enrollment_year INTEGER CHECK (enrollment_year BETWEEN 2000 AND 2100),
    male_ratio INTEGER CHECK (male_ratio BETWEEN 0 AND 100),
    record_key TEXT UNIQUE NOT NULL,
    lifecycle_status_code TEXT NOT NULL REFERENCES school_lifecycle_status_master(code) ON UPDATE CASCADE ON DELETE RESTRICT,
    recruitment_status_code TEXT NOT NULL REFERENCES school_recruitment_status_master(code) ON UPDATE CASCADE ON DELETE RESTRICT,
    legally_established_on TEXT,
    opened_on TEXT,
    recruitment_ended_on TEXT,
    closed_on TEXT,
    status_official_url TEXT,
    status_note TEXT,
    recruitment_ended_year INTEGER CHECK (recruitment_ended_year BETWEEN 1900 AND 2100),
    status_description TEXT,
    CHECK (opened_on >= legally_established_on),
    CHECK (closed_on >= opened_on),
    CHECK (closed_on >= recruitment_ended_on)
) STRICT;

CREATE TABLE school_departments (
    id TEXT PRIMARY KEY NOT NULL,
    school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    course_type TEXT REFERENCES course_type_master(code) ON UPDATE CASCADE ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    ui_group TEXT CHECK (ui_group IN ('general','comprehensive','sciences_langs','arts_sports','industrial','informatics','commercial','agriculture_marine','home_welfare_nursing','other')),
    record_key TEXT UNIQUE NOT NULL
) STRICT;

CREATE TABLE school_field_sources (
    school_id TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    field_name TEXT NOT NULL REFERENCES school_field_source_field_master(code) ON UPDATE CASCADE ON DELETE RESTRICT,
    official_url TEXT NOT NULL,
    doc_title TEXT NOT NULL CHECK (trim(doc_title) <> ''),
    published_at TEXT,
    source_page_or_table TEXT CHECK (trim(source_page_or_table) <> ''),
    last_verified_at TEXT,
    last_http_status INTEGER CHECK (last_http_status BETWEEN 100 AND 599),
    is_official_source INTEGER NOT NULL CHECK (is_official_source IN (0,1)),
    note TEXT CHECK (trim(note) <> ''),
    created_at TEXT NOT NULL,
    PRIMARY KEY (school_id, field_name, official_url),
    CHECK ((last_http_status IS NULL) = (last_verified_at IS NULL))
) STRICT;
