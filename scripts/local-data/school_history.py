"""C1-b source metadata; persistence and transactions belong to the source store."""

from store import require


TABLES = {
    "school_relationship_type_master": {
        "code": "nonempty", "label_ja": "text", "label_en": "text", "sort_order": "int",
        "is_active": "bool", "notes": "text?", "created_at": "timestamp", "updated_at": "timestamp",
    },
    "school_name_history": {
        "id": "uuid", "school_id": "uuid", "name": "nonempty", "name_kana": "text?",
        "valid_from": "date?", "valid_to": "date?", "official_url": "url", "notes": "text?",
        "created_at": "timestamp", "updated_at": "timestamp",
    },
    "school_relationships": {
        "id": "uuid", "predecessor_school_id": "uuid", "successor_school_id": "uuid",
        "relationship_type_code": "text", "effective_on": "date?", "official_url": "url",
        "notes": "text?", "created_at": "timestamp", "updated_at": "timestamp",
        "effective_admission_year": "int?", "evidence_status": "text",
    },
}
KEYS = {table: ("code",) if table.endswith("_master") else ("id",) for table in TABLES}
PROJECTION = {
    "school_name_history": ("id", "name", "name_kana", "valid_from", "valid_to", "official_url", "notes"),
    "school_relationships": ("id", "relationship_type_code", "effective_on", "official_url", "notes"),
}
PREDECESSOR_COLUMNS = ("id", "record_key", "name", "lifecycle_status_code", "closed_on")


def validate_row(table, row):
    """Validate normalized values without generating IDs or deriving dates."""
    if table == "school_name_history":
        require(row["valid_from"] is None or row["valid_to"] is None
                or row["valid_to"] >= row["valid_from"], "history date order")
    elif table == "school_relationships":
        require(row["predecessor_school_id"] != row["successor_school_id"], "school self-link")
        require(row["effective_on"] is not None or row["effective_admission_year"] is not None,
                "relationship effective boundary required")
        require(row["effective_admission_year"] is None or 1900 <= row["effective_admission_year"] <= 2100,
                "relationship admission year range")
        require(row["evidence_status"] in ("official_confirmed", "official_partial", "unresolved"),
                "unknown relationship evidence status")


def check_consistency(db):
    require(not db.execute("PRAGMA foreign_key_check").fetchall(), "history foreign key violation")


def synthetic_rows(core_payload_tables):
    """Return synthetic history children for the core fixture; do not change core rows."""
    active = next(row for row in core_payload_tables["schools"] if row["is_active"])
    closed = next(row for row in core_payload_tables["schools"] if not row["is_active"])
    stamps = {"created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-02T00:00:00+09:00"}
    return {
        "school_relationship_type_master": [{
            "code": "synthetic_succeeded_by", "label_ja": "合成後継", "label_en": "Synthetic successor",
            "sort_order": 10, "is_active": False, "notes": None, **stamps,
        }],
        "school_name_history": [
            {"id": "44444444-4444-4444-8444-444444444441", "school_id": active["id"],
             "name": "合成旧名称", "name_kana": None, "valid_from": None, "valid_to": "2025-03-31",
             "official_url": "https://history.example/rename", "notes": "", **stamps},
            {"id": "44444444-4444-4444-8444-444444444442", "school_id": active["id"],
             "name": active["name"], "name_kana": "", "valid_from": "2025-04-01", "valid_to": None,
             "official_url": "https://history.example/rename", "notes": None, **stamps},
        ],
        "school_relationships": [{
            "id": "55555555-5555-4555-8555-555555555551", "predecessor_school_id": closed["id"],
            "successor_school_id": active["id"], "relationship_type_code": "synthetic_succeeded_by",
            "effective_on": None, "effective_admission_year": 2025,
            "evidence_status": "official_partial", "official_url": "https://history.example/successor",
            "notes": "合成の年度境界のみ", **stamps,
        }],
    }
