"""C1-c admission source contract. Synthetic input only, no external services."""

from store import require


MASTER_COLUMNS = {
    "code": "identifier", "label_ja": "nonempty", "label_en": "nonempty",
    "sort_order": "int", "is_active": "bool", "notes": "text?", "created_at": "timestamp",
}
TABLES = {name: dict(MASTER_COLUMNS) for name in (
    "admission_recruitment_unit_kind_master", "admission_selection_stage_master",
    "admission_selection_track_master", "admission_map_role_master",
    "admission_exam_component_master", "admission_quality_reason_master",
)}
TABLES.update({
    "school_admission_stats": {
        "id": "uuid", "school_id": "uuid", "department_id": "uuid?", "year": "int",
        "capacity": "int?", "applicants": "int?", "examinees": "int?", "admitted": "int?",
        "note": "text?", "source_url": "text?", "created_at": "timestamp", "updated_at": "timestamp",
    },
    "school_deviation_values": {
        "id": "uuid", "school_id": "uuid", "department_id": "uuid?", "value": "int",
        "year": "int", "source_type": "text", "estimate_method": "text?", "note": "text?",
        "is_active": "bool", "created_at": "timestamp", "updated_at": "timestamp", "estimate_basis": "text?",
    },
    "admission_recruitment_units": {
        "id": "uuid", "school_id": "uuid", "unit_key": "nonempty", "unit_kind_code": "text",
        "label": "nonempty", "course_time": "text?", "valid_from_year": "int?", "valid_to_year": "int?",
        "created_at": "timestamp", "updated_at": "timestamp",
    },
    "admission_recruitment_unit_departments": {
        "unit_id": "uuid", "department_id": "uuid", "created_at": "timestamp",
    },
    "school_admission_selection_stats": {
        "id": "uuid", "recruitment_unit_id": "uuid", "year": "int", "selection_stage_code": "text",
        "selection_track_code": "text", "stage_label_raw": "nonempty", "track_label_raw": "nonempty",
        "selection_scope_raw": "nonempty", "population_scope_raw": "text?", "scope_key": "nonempty",
        "map_role_code": "text", "is_ratio_comparable": "bool", "capacity": "int?", "applicants": "int?",
        "examinees": "int?", "admitted": "int?", "exam_scope_raw": "text?",
        "created_at": "timestamp", "updated_at": "timestamp",
    },
    "school_admission_stat_exam_components": {
        "stat_id": "uuid", "component_code": "text", "created_at": "timestamp",
    },
    "school_admission_stat_quality_flags": {
        "stat_id": "uuid", "metric_code": "text?", "reason_code": "text", "note": "nonempty?",
        "created_at": "timestamp",
    },
    "school_admission_stat_sources": {
        "stat_id": "uuid", "fact_kind_code": "text", "official_url": "url", "doc_title": "nonempty",
        "published_at": "date?", "source_page_or_table": "nonempty?", "quoted_evidence": "nonempty?",
        "last_verified_at": "timestamp?", "last_http_status": "int?", "created_at": "timestamp",
    },
    "school_admission_stat_legacy_links": {
        "stat_id": "uuid", "legacy_stat_id": "uuid", "created_at": "timestamp",
    },
})
KEYS = {table: ("code",) if table.endswith("_master") else ("id",) for table in TABLES}
KEYS.update({
    "admission_recruitment_unit_departments": ("unit_id", "department_id"),
    "school_admission_stat_exam_components": ("stat_id", "component_code"),
    "school_admission_stat_quality_flags": ("stat_id", "metric_code", "reason_code"),
    "school_admission_stat_sources": ("stat_id", "fact_kind_code"),
    "school_admission_stat_legacy_links": ("stat_id", "legacy_stat_id"),
})

# Parent IDs are selected only to assemble children and removed by the adapter.
PROJECTION = {
    "school_admission_stats": ("school_id", "id", "department_id", "year", "capacity", "applicants",
                               "examinees", "admitted", "note", "source_url"),
    "school_deviation_values": ("school_id", "department_id", "value", "is_active"),
    "admission_recruitment_units": ("school_id", "id", "unit_key", "unit_kind_code", "label", "course_time",
                                    "valid_from_year", "valid_to_year"),
    "admission_recruitment_unit_departments": ("unit_id", "department_id"),
    "school_admission_selection_stats": ("recruitment_unit_id", "id", "year", "selection_stage_code",
        "selection_track_code", "stage_label_raw", "track_label_raw", "selection_scope_raw",
        "population_scope_raw", "scope_key", "map_role_code", "is_ratio_comparable", "capacity",
        "applicants", "examinees", "admitted", "exam_scope_raw"),
    "school_admission_stat_exam_components": ("stat_id", "component_code"),
    "school_admission_stat_quality_flags": ("stat_id", "metric_code", "reason_code", "note"),
    "school_admission_stat_sources": ("stat_id", "fact_kind_code", "official_url", "doc_title", "published_at",
        "source_page_or_table", "quoted_evidence", "last_verified_at", "last_http_status"),
}


def validate_row(table, row):
    """SQL provides relational/range checks after strict input type normalization."""
    if table == "school_admission_stat_sources":
        evidence = row["quoted_evidence"]
        require(evidence is None or len(evidence) <= 80, "quoted evidence exceeds 80 characters")


def check_consistency(db):
    # Recheck retained membership after either parent was updated. No repair.
    require(db.execute("""
        SELECT 1 FROM admission_recruitment_unit_departments m
        JOIN admission_recruitment_units u ON u.id = m.unit_id
        JOIN school_departments d ON d.id = m.department_id
        WHERE u.school_id <> d.school_id LIMIT 1
    """).fetchone() is None, "recruitment unit and department must belong to the same school")


def synthetic_rows(core_tables):
    """All values originate here or from the checked-in synthetic core fixture."""
    stamp = "2026-01-01T00:00:00Z"
    school = core_tables["schools"][0]["id"]
    department = core_tables["school_departments"][0]["id"]
    legacy = "44444444-4444-4444-8444-444444444444"
    deviation = "55555555-5555-4555-8555-555555555555"
    unit = "66666666-6666-4666-8666-666666666666"
    stat = "77777777-7777-4777-8777-777777777777"
    rows = {table: [] for table in TABLES}
    codes = ("synthetic_group", "primary", "synthetic_track", "primary_total", "synthetic_exam", "synthetic_warning")
    for table, code in zip(list(TABLES)[:6], codes):
        rows[table] = [dict(code=code, label_ja="合成分類", label_en="Synthetic classification",
                           sort_order=10, is_active=False, notes=None, created_at=stamp)]
    rows["school_admission_stats"] = [dict(id=legacy, school_id=school, department_id=department, year=2026,
        capacity=10, applicants=15, examinees=None, admitted=0, note="合成旧統計", source_url=None,
        created_at=stamp, updated_at=stamp)]
    rows["school_deviation_values"] = [dict(id=deviation, school_id=school, department_id=department, value=50,
        year=2026, source_type="manabi_estimate", estimate_method="合成検証", note="SYNTHETIC_PRIVATE_DEVIATION",
        is_active=True, created_at=stamp, updated_at=stamp, estimate_basis="human_anchor_review")]
    rows["admission_recruitment_units"] = [dict(id=unit, school_id=school, unit_key="synthetic-unit",
        unit_kind_code=codes[0], label="合成募集単位", course_time=None, valid_from_year=2000,
        valid_to_year=2100, created_at=stamp, updated_at=stamp)]
    rows["admission_recruitment_unit_departments"] = [dict(unit_id=unit, department_id=department, created_at=stamp)]
    rows["school_admission_selection_stats"] = [dict(id=stat, recruitment_unit_id=unit, year=2026,
        selection_stage_code="primary", selection_track_code=codes[2], stage_label_raw="合成一次",
        track_label_raw="合成一般", selection_scope_raw="合成全体", population_scope_raw=None,
        scope_key="synthetic-scope", map_role_code="primary_total", is_ratio_comparable=True,
        capacity=10, applicants=15, examinees=None, admitted=0, exam_scope_raw="", created_at=stamp, updated_at=stamp)]
    rows["school_admission_stat_exam_components"] = [dict(stat_id=stat, component_code=codes[4], created_at=stamp)]
    rows["school_admission_stat_quality_flags"] = [dict(stat_id=stat, metric_code=None,
        reason_code=codes[5], note="合成注意", created_at=stamp)]
    rows["school_admission_stat_sources"] = [dict(stat_id=stat, fact_kind_code="capacity",
        official_url="https://school.example/admission", doc_title="合成入試資料", published_at="2024-02-29",
        source_page_or_table="表1", quoted_evidence="合成引用", last_verified_at=stamp,
        last_http_status=404, created_at=stamp)]
    rows["school_admission_stat_legacy_links"] = [dict(stat_id=stat, legacy_stat_id=legacy, created_at=stamp)]
    return rows
