"""C1-a synthetic seven-table source. Not a complete school source or snapshot."""

import argparse
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

from store import InputError, connect, http_url, reject_duplicate_keys, require, uuid_value


PURPOSE = "synthetic-school-core-c1a"
SCHEMA_VERSION = 2
INPUT_FORMAT = "synthetic-school-core"
INPUT_VERSION = 1
# Required keys include nullable columns. No defaults or generated identities.
# ? is nullable; text permits empty strings unless a column constraint forbids them.
TABLES = {
    "course_type_master": {
        "code": "text", "label_ja": "text", "label_en": "text", "ui_group": "text?",
        "sort_order": "int", "is_active": "bool", "created_at": "timestamp",
        "mext_category": "text", "mext_category_detail": "text?",
        "classification_source": "text?", "notes": "text?",
    },
    "school_lifecycle_status_master": {
        "code": "nonempty", "label_ja": "text", "label_en": "text", "is_map_active": "bool",
        "forces_not_recruiting": "bool", "sort_order": "int", "is_active": "bool",
        "notes": "text?", "created_at": "timestamp", "updated_at": "timestamp",
    },
    "school_recruitment_status_master": {
        "code": "nonempty", "label_ja": "text", "label_en": "text",
        "is_recruiting_compat": "bool", "sort_order": "int", "is_active": "bool",
        "notes": "text?", "created_at": "timestamp", "updated_at": "timestamp",
    },
    "school_field_source_field_master": {
        "code": "text", "table_name": "identifier", "column_name": "identifier",
        "label_ja": "nonempty", "sort_order": "int", "is_active": "bool",
        "notes": "text?", "created_at": "timestamp",
    },
    "schools": {
        "id": "uuid", "name": "text", "name_kana": "text?", "type": "text",
        "ownership": "text", "gender_type": "text", "is_integrated": "bool",
        "postal_code": "text?", "prefecture": "text", "city": "text?", "address": "text",
        "latitude": "decimal?", "longitude": "decimal?", "official_url": "url?",
        "is_active": "bool", "is_recruiting": "bool", "created_at": "timestamp",
        "updated_at": "timestamp", "course_times": "courses", "main_school_name": "text?",
        "campus_type": "text", "total_students": "int?", "enrollment_year": "int?",
        "male_ratio": "int?", "record_key": "school-key", "lifecycle_status_code": "text",
        "recruitment_status_code": "text", "legally_established_on": "date?",
        "opened_on": "date?", "recruitment_ended_on": "date?", "closed_on": "date?",
        "status_official_url": "text?", "status_note": "text?",
        "recruitment_ended_year": "int?", "status_description": "text?",
    },
    "school_departments": {
        "id": "uuid", "school_id": "uuid", "name": "text", "course_type": "text?",
        "created_at": "timestamp", "ui_group": "text?", "record_key": "department-key",
    },
    "school_field_sources": {
        "school_id": "uuid", "field_name": "text", "official_url": "url",
        "doc_title": "nonempty", "published_at": "date?", "source_page_or_table": "nonempty?",
        "last_verified_at": "timestamp?", "last_http_status": "int?",
        "is_official_source": "bool", "note": "nonempty?", "created_at": "timestamp",
    },
}
KEYS = {table: ("code",) for table in TABLES}
KEYS.update(schools=("id",), school_departments=("id",),
            school_field_sources=("school_id", "field_name", "official_url"))

# Explicit projection, never SELECT * into generator rows. C1-b/c children absent.
SCHOOL_COLUMNS = (
    "id", "name", "name_kana", "type", "ownership", "gender_type", "is_integrated",
    "postal_code", "prefecture", "city", "address", "latitude", "longitude", "official_url",
    "is_active", "is_recruiting", "updated_at", "course_times", "main_school_name", "campus_type",
    "total_students", "enrollment_year", "male_ratio", "record_key", "lifecycle_status_code",
    "recruitment_status_code", "legally_established_on", "opened_on", "recruitment_ended_on",
    "closed_on", "status_official_url", "recruitment_ended_year", "status_description",
)
DEPARTMENT_COLUMNS = ("id", "school_id", "name", "course_type", "ui_group")
SOURCE_COLUMNS = ("field_name", "official_url", "doc_title", "published_at",
                  "source_page_or_table", "last_verified_at", "last_http_status", "is_official_source")


def value_for_storage(value, kind):
    if kind.endswith("?"):
        if value is None:
            return None
        kind = kind[:-1]
    if kind == "bool":
        require(type(value) is bool, "JSON boolean required")
        return int(value)
    if kind == "int":
        require(type(value) is int and -(2**31) <= value < 2**31, "PostgreSQL integer required")
        return value
    if kind == "courses":
        require(isinstance(value, list) and bool(value), "nonempty course array required")
        require(all(v in ("fulltime", "parttime", "correspondence") for v in value), "unknown course")
        return json.dumps(value, separators=(",", ":"))
    if kind == "decimal":
        require(type(value) in (str, int, Decimal), "exact decimal required, not binary float")
        if isinstance(value, str):
            require(re.fullmatch(r"-?\d+(?:\.\d+)?", value) is not None, "decimal text required")
        number = Decimal(value)
        require(number.is_finite() and abs(number) < 1000, "numeric(10,7) range exceeded")
        try:
            fixed = number.quantize(Decimal("0.0000001"))
        except InvalidOperation as exc:
            raise InputError("numeric(10,7) precision exceeded") from exc
        require(fixed == number, "numeric(10,7) must not be rounded")
        return format(fixed, ".7f")
    require(isinstance(value, str), "text required")
    require("\x00" not in value, "PostgreSQL text cannot contain NUL")
    if kind == "nonempty":
        require(bool(value.strip(" ")), "nonempty text required")
    elif kind == "uuid":
        uuid_value(value, "id")
    elif kind.endswith("-key"):
        prefix = kind.removesuffix("key")
        require(value.startswith(prefix), "invalid record key")
        uuid_value(value[len(prefix):], "record key")
    elif kind == "url":
        require(http_url(value), "HTTP(S) URL required")
    elif kind == "identifier":
        require(re.fullmatch(r"[a-z][a-z0-9_]*", value) is not None, "invalid field identifier")
    elif kind == "date":
        require(re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) is not None, "ISO date required")
        date.fromisoformat(value)
    elif kind == "timestamp":
        require(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})", value)
                is not None, "timezone-aware ISO timestamp required")
        if not value.endswith("Z"):
            require(int(value[-5:-3]) < 24 and int(value[-2:]) < 60, "invalid timezone offset")
        stamp = datetime.fromisoformat(value)
        require(stamp.utcoffset() is not None, "timezone required")
    return value


def reject_constant(_):
    raise InputError("non-finite JSON number")


def load_input(path):
    payload = json.loads(path.read_text(encoding="utf-8"), parse_float=Decimal,
                         parse_constant=reject_constant, object_pairs_hook=reject_duplicate_keys)
    require(isinstance(payload, dict) and set(payload) ==
            {"format", "input_version", "schema_version", "synthetic", "dataset_version", "tables"},
            "unknown or missing input keys")
    require(payload["format"] == INPUT_FORMAT and type(payload["input_version"]) is int
            and payload["input_version"] == INPUT_VERSION, "unsupported input format/version")
    require(type(payload["schema_version"]) is int and payload["schema_version"] == SCHEMA_VERSION,
            "unsupported schema version; no automatic upgrade")
    require(payload["synthetic"] is True, "synthetic input only")
    value_for_storage(payload["dataset_version"], "nonempty")
    require(isinstance(payload["tables"], dict) and set(payload["tables"]) == set(TABLES),
            "exactly seven supported tables required")
    for table, columns in TABLES.items():
        rows = payload["tables"][table]
        require(isinstance(rows, list), "table must be an array")
        keys, record_keys = set(), set()
        for i, row in enumerate(rows):
            require(isinstance(row, dict) and set(row) == set(columns), "unknown or missing row columns")
            row = {column: value_for_storage(row[column], kind) for column, kind in columns.items()}
            key = tuple(row[column] for column in KEYS[table])
            require(key not in keys, "duplicate input primary key")
            keys.add(key)
            if "record_key" in row:
                require(row["record_key"] not in record_keys, "duplicate input record key")
                record_keys.add(row["record_key"])
            rows[i] = row
    return payload


def check_metadata(db):
    row = db.execute("SELECT * FROM source_metadata WHERE singleton = 1").fetchone()
    require(row is not None and row["schema_version"] == SCHEMA_VERSION and row["purpose"] == PURPOSE,
            "unsupported database purpose/schema")


def check_consistency(db):
    require(not db.execute("PRAGMA foreign_key_check").fetchall(), "foreign key violation")
    require(db.execute("""
        SELECT 1 FROM schools s
        JOIN school_lifecycle_status_master l ON l.code = s.lifecycle_status_code
        JOIN school_recruitment_status_master r ON r.code = s.recruitment_status_code
        WHERE s.is_active <> l.is_map_active OR s.is_recruiting <> r.is_recruiting_compat
           OR ((l.forces_not_recruiting = 1 OR l.code = 'closing') AND r.is_recruiting_compat = 1)
        LIMIT 1
    """).fetchone() is None, "school status contradicts masters")
    require(db.execute("""
        SELECT 1 FROM school_departments d LEFT JOIN course_type_master m ON m.code = d.course_type
        WHERE d.ui_group IS NOT m.ui_group LIMIT 1
    """).fetchone() is None, "department group contradicts master")


def import_rows(db, payload, fresh):
    db.execute("BEGIN IMMEDIATE")
    try:
        if fresh:
            for statement in Path(__file__).with_name("schema-core.sql").read_text(encoding="utf-8").split(";"):
                if statement.strip():
                    db.execute(statement)
            db.execute("INSERT INTO source_metadata VALUES (1, ?, ?, ?)",
                       (SCHEMA_VERSION, PURPOSE, payload["dataset_version"]))
        else:
            check_metadata(db)
        for table, columns in TABLES.items():
            for row in payload["tables"][table]:
                if "record_key" in row:
                    previous = db.execute(f"SELECT * FROM {table} WHERE id = ?", (row["id"],)).fetchone()
                    require(previous is None or previous["record_key"] == row["record_key"],
                            "existing identity cannot change record key")
                    if table == "school_departments":
                        require(previous is None or previous["school_id"] == row["school_id"],
                                "existing department cannot change school")
                updates = ", ".join(f"{c}=excluded.{c}" for c in columns if c not in KEYS[table])
                db.execute(f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)}) "
                           f"ON CONFLICT ({', '.join(KEYS[table])}) DO UPDATE SET {updates}",
                           tuple(row[c] for c in columns))
        # Validate all retained rows, including rows omitted from this upsert input.
        check_consistency(db)
        db.execute("UPDATE source_metadata SET dataset_version = ? WHERE singleton = 1",
                   (payload["dataset_version"],))
        db.commit()
    except BaseException:
        db.rollback()
        raise


def import_command(args):
    payload = load_input(args.input)
    exists, created, db = args.db.exists(), False, None
    try:
        if args.apply:
            if not exists:
                fd = os.open(args.db, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
                created = True
            db = connect(args.db)
        else:
            db = connect(Path(":memory:"))
            if exists:
                source = connect(args.db, readonly=True)
                try:
                    check_metadata(source)
                    source.backup(db)
                finally:
                    source.close()
        import_rows(db, payload, fresh=not exists)
    except BaseException:
        if db is not None:
            db.close()
            db = None
        if created:
            args.db.unlink()
        raise
    finally:
        if db is not None:
            db.close()
    print(json.dumps({"mode": "applied" if args.apply else "dry-run", "schema_version": SCHEMA_VERSION,
                      "received": {table: len(rows) for table, rows in payload["tables"].items()}}))


def project_core_rows(db):
    """Partial C1-a projection for synthetic checks, NOT the C1-e generator adapter.

    Caller owns a read transaction. Only active schools are projected; the source
    retains inactive schools. URL and field-source gates belong to public-api.mjs.
    """
    check_metadata(db)
    check_consistency(db)
    schools = []
    for row in db.execute(f"SELECT {', '.join(SCHOOL_COLUMNS)} FROM schools "
                          "WHERE is_active = 1 ORDER BY prefecture, name, id"):
        school = dict(row)
        for field in ("is_active", "is_recruiting", "is_integrated"):
            school[field] = bool(school[field])
        for field in ("latitude", "longitude"):
            school[field] = None if school[field] is None else float(Decimal(school[field]))
        school["course_times"] = json.loads(school["course_times"])
        school["school_departments"] = [dict(d) for d in db.execute(
            f"SELECT {', '.join(DEPARTMENT_COLUMNS)} FROM school_departments WHERE school_id = ? ORDER BY id",
            (school["id"],))]
        school["school_field_sources"] = []
        for source in db.execute(f"SELECT {', '.join(SOURCE_COLUMNS)} FROM school_field_sources "
                                 "WHERE school_id = ? ORDER BY field_name, official_url", (school["id"],)):
            source = dict(source)
            source["is_official_source"] = bool(source["is_official_source"])
            school["school_field_sources"].append(source)
        schools.append(school)
    return schools


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--apply", action="store_true", help="write DB; default validates in memory")
    args = parser.parse_args()
    args.db = args.db.resolve()
    try:
        import_command(args)
    except (InputError, OSError, sqlite3.Error, ValueError, InvalidOperation):
        print("Operation failed. Result reporting may fail after commit. Inspect the local result before retrying.",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
