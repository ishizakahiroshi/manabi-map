"""Synthetic 25-table school source, explicit core migration, verified snapshot bundle."""

import argparse
from contextlib import closing
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile

import store
import store_core as core
import school_history as history
import school_admission as admission


SCHEMA_VERSION = 3
PURPOSE = "synthetic-school-source"
INPUT_FORMAT = "synthetic-school-source"
INPUT_VERSION = 1
TABLES = {**core.TABLES, **history.TABLES, **admission.TABLES}
KEYS = {**core.KEYS, **history.KEYS, **admission.KEYS}
PROJECTION = {
    "schools": core.SCHOOL_COLUMNS,
    "school_departments": core.DEPARTMENT_COLUMNS,
    "school_field_sources": ("school_id", *core.SOURCE_COLUMNS),
    **history.PROJECTION,
    **admission.PROJECTION,
    "school_name_history": ("school_id", *history.PROJECTION["school_name_history"]),
    "school_relationships": ("predecessor_school_id", "successor_school_id", *history.PROJECTION["school_relationships"]),
}
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
CODE_FILES = (
    "scripts/local-data/store.py", "scripts/local-data/store_core.py",
    "scripts/local-data/schema-core.sql", "scripts/local-data/store_school.py",
    "scripts/local-data/school_history.py", "scripts/local-data/schema-history.sql",
    "scripts/local-data/school_admission.py", "scripts/local-data/schema-admission.sql",
    "web/scripts/lib/school-source.mjs", "web/scripts/gen-schools-json.mjs",
    "web/src/lib/school-select.ts", "web/scripts/lib/public-api.mjs",
    "web/src/lib/mapPayload.ts", "web/src/lib/admissionUnits.ts", "web/src/lib/admission.ts",
)
require = store.require


def canonical_json(value):
    """UTF-8 JSON: sorted ASCII field names; numbers plain, exact <=7 decimals.

    Arrays preserve order. This grammar is shared with school-source.mjs and
    avoids Python/JS disagreement over 35.0, 1e-7, exponent zeroes and -0.
    """
    if value is None or type(value) in (str, bool):
        return json.dumps(value, ensure_ascii=False)
    if type(value) is int:
        return str(value)
    if type(value) in (float, Decimal):
        number = Decimal(str(value))
        require(number.is_finite(), "non-finite canonical number")
        if number == 0:
            return "0"
        return format(number, "f").rstrip("0").rstrip(".") if "." in format(number, "f") else format(number, "f")
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    require(isinstance(value, dict), "unsupported canonical value")
    return "{" + ",".join(json.dumps(k) + ":" + canonical_json(value[k]) for k in sorted(value)) + "}"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def content_hash(value):
    return sha256(canonical_json(value).encode("utf-8"))


def validate_row(table, row):
    if table in history.TABLES:
        history.validate_row(table, row)
    if table in admission.TABLES:
        admission.validate_row(table, row)


def normalize_tables(tables):
    require(isinstance(tables, dict) and set(tables) == set(TABLES), "exactly 25 source tables required")
    result = {}
    for table, columns in TABLES.items():
        rows = tables[table]
        require(isinstance(rows, list), "table array required")
        normalized, keys, record_keys = [], set(), set()
        for row in rows:
            require(isinstance(row, dict) and set(row) == set(columns), "unknown or missing source column")
            row = {column: core.value_for_storage(row[column], kind) for column, kind in columns.items()}
            validate_row(table, row)
            key = tuple(row[c] for c in KEYS[table])
            require(key not in keys, "duplicate input key")
            keys.add(key)
            if "record_key" in row:
                require(row["record_key"] not in record_keys, "duplicate record key")
                record_keys.add(row["record_key"])
            normalized.append(row)
        result[table] = normalized
    return result


def load_input(path):
    payload = json.loads(path.read_text(encoding="utf-8"), parse_float=Decimal,
                         parse_constant=core.reject_constant, object_pairs_hook=store.reject_duplicate_keys)
    require(isinstance(payload, dict) and set(payload) ==
            {"format", "input_version", "schema_version", "synthetic", "dataset_version", "source_version", "tables"},
            "unknown or missing input keys")
    require(payload["format"] == INPUT_FORMAT and type(payload["input_version"]) is int
            and payload["input_version"] == INPUT_VERSION, "unsupported input format")
    require(type(payload["schema_version"]) is int and payload["schema_version"] == SCHEMA_VERSION,
            "unsupported schema version")
    require(payload["synthetic"] is True, "only synthetic input is supported")
    for field in ("dataset_version", "source_version"):
        core.value_for_storage(payload[field], "nonempty")
    return {**payload, "tables": normalize_tables(payload["tables"])}


def create_schema(db, payload):
    # No executescript: each DDL stays inside the outer transaction.
    for name in ("schema-core.sql", "schema-history.sql", "schema-admission.sql"):
        for statement in (HERE / name).read_text(encoding="utf-8").split(";"):
            if statement.strip():
                db.execute(statement)
    db.execute("ALTER TABLE source_metadata ADD COLUMN source_version TEXT NOT NULL")
    db.execute("INSERT INTO source_metadata VALUES (1, ?, ?, ?, ?)",
               (SCHEMA_VERSION, PURPOSE, payload["dataset_version"], payload["source_version"]))


def check_metadata(db):
    check_shape(db, TABLES, {"singleton", "schema_version", "purpose", "dataset_version", "source_version"})
    row = db.execute("SELECT * FROM source_metadata WHERE singleton=1").fetchone()
    require(row is not None and row["schema_version"] == SCHEMA_VERSION and row["purpose"] == PURPOSE,
            "unsupported source purpose/schema; use explicit migration")
    require(db.execute("SELECT count(*) FROM source_metadata").fetchone()[0] == 1, "invalid metadata count")
    for key in ("dataset_version", "source_version"):
        core.value_for_storage(row[key], "nonempty")
    return row


def check_shape(db, table_contract, metadata_columns):
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    require(tables == set(table_contract) | {"source_metadata"}, "unexpected database tables")
    for table, columns in {**table_contract, "source_metadata": metadata_columns}.items():
        actual = {r["name"] for r in db.execute(f"PRAGMA table_info({table})")}
        require(actual == set(columns), "database columns differ from source contract")


def decode_row(table, row):
    result = dict(row)
    for column in result:
        kind = TABLES[table][column].rstrip("?")
        if result[column] is None:
            continue
        if kind == "bool":
            require(type(result[column]) is int and result[column] in (0, 1), "invalid stored boolean")
            result[column] = bool(result[column])
        elif kind == "courses":
            result[column] = json.loads(result[column])
    return result


def check_consistency(db):
    require(db.execute("PRAGMA integrity_check").fetchall()[0][0] == "ok", "database integrity failure")
    core.check_consistency(db)
    history.check_consistency(db)
    admission.check_consistency(db)
    # Validate storage readback too: malformed direct edits must never be exported.
    for table, columns in TABLES.items():
        for stored in db.execute(f"SELECT {', '.join(columns)} FROM {table}"):
            decoded = decode_row(table, stored)
            normalized = {c: core.value_for_storage(decoded[c], kind) for c, kind in columns.items()}
            validate_row(table, normalized)


def import_rows(db, payload, fresh):
    db.execute("BEGIN IMMEDIATE")
    try:
        if fresh:
            create_schema(db, payload)
        else:
            check_metadata(db)
            check_consistency(db)
        for table, columns in TABLES.items():
            key_columns = KEYS[table]
            for row in payload["tables"][table]:
                where = " AND ".join(f"{c} IS ?" for c in key_columns)
                key = tuple(row[c] for c in key_columns)
                previous = db.execute(f"SELECT * FROM {table} WHERE {where}", key).fetchone()
                if previous is not None:
                    if "record_key" in row:
                        require(previous["record_key"] == row["record_key"], "existing record key cannot change")
                    if table == "school_departments":
                        require(previous["school_id"] == row["school_id"], "existing department cannot change school")
                    if table == "admission_recruitment_units":
                        require(previous["unit_key"] == row["unit_key"], "existing unit key cannot change")
                    updates = [c for c in columns if c not in key_columns]
                    if updates:
                        db.execute(f"UPDATE {table} SET {', '.join(c + '=?' for c in updates)} WHERE {where}",
                                   tuple(row[c] for c in updates) + key)
                else:
                    db.execute(f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
                               tuple(row[c] for c in columns))
        check_consistency(db)
        db.execute("UPDATE source_metadata SET dataset_version=?, source_version=? WHERE singleton=1",
                   (payload["dataset_version"], payload["source_version"]))
        db.commit()
    except BaseException:
        db.rollback()
        raise


def validate_core_migration(source_path, payload):
    """Copy-on-migrate: all existing core rows must be supplied unchanged.

    The caller supplies the remaining 18 tables. Nothing is synthesized from a
    schema 1 prototype or filled with invented defaults; the old file is read-only.
    """
    with closing(store.connect(source_path, readonly=True)) as db:
        db.execute("BEGIN")
        check_shape(db, core.TABLES, {"singleton", "schema_version", "purpose", "dataset_version"})
        core.check_metadata(db)
        require(db.execute("PRAGMA integrity_check").fetchall()[0][0] == "ok", "core database integrity failure")
        require(db.execute("SELECT count(*) FROM source_metadata").fetchone()[0] == 1, "invalid core metadata")
        core.check_consistency(db)
        for table, columns in core.TABLES.items():
            received = {tuple(row[c] for c in core.KEYS[table]): row for row in payload["tables"][table]}
            for row in db.execute(f"SELECT {', '.join(columns)} FROM {table}"):
                key = tuple(row[c] for c in core.KEYS[table])
                require(key in received and received[key] == dict(row), "migration must preserve every core row/column")


def import_command(args):
    payload = load_input(args.input)
    if args.from_core is not None:
        require(args.from_core != args.db and not args.db.exists(), "migration requires a new destination")
        validate_core_migration(args.from_core, payload)
    exists, created, db = args.db.exists(), False, None
    try:
        if args.apply:
            if not exists:
                fd = os.open(args.db, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
                created = True
            else:
                require(args.from_core is None, "migration destination exists")
            db = store.connect(args.db)
        else:
            db = store.connect(Path(":memory:"))
            if exists:
                with closing(store.connect(args.db, readonly=True)) as source:
                    check_metadata(source)
                    source.backup(db)
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
                      "received": {t: len(rows) for t, rows in payload["tables"].items()}}))


def snapshot_content(db):
    meta = check_metadata(db)
    check_consistency(db)
    tables = {}
    for table, columns in PROJECTION.items():
        order = "prefecture, name, id" if table == "schools" else ", ".join(KEYS[table])
        rows = []
        for raw in db.execute(f"SELECT {', '.join(columns)} FROM {table} ORDER BY {order}"):
            row = decode_row(table, raw)
            for column in row:
                if TABLES[table][column].rstrip("?") == "decimal" and row[column] is not None:
                    row[column] = float(Decimal(row[column]))
            rows.append(row)
        tables[table] = rows
    counts = {t: db.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in TABLES}
    return {
        "format": "school-source-snapshot", "format_version": 1, "schema_version": SCHEMA_VERSION,
        "synthetic": True, "dataset_version": meta["dataset_version"],
        "source_version": meta["source_version"], "tables": tables,
    }, counts


def code_identity():
    files = [{"path": path, "sha256": sha256((REPO / path).read_bytes())} for path in sorted(CODE_FILES)]
    return {"identity": "sha256", "files": files, "sha256": content_hash(files)}


def write_json(path, value):
    data = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n").encode("utf-8")
    with path.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    return data


def verify_bundle(directory):
    """Verification never opens a DB, reads configuration, or accesses network."""
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"),
                          object_pairs_hook=store.reject_duplicate_keys)
    raw = (directory / "snapshot.json").read_bytes()
    snapshot = json.loads(raw, parse_float=Decimal, parse_constant=core.reject_constant,
                          object_pairs_hook=store.reject_duplicate_keys)
    require(isinstance(snapshot, dict) and isinstance(manifest, dict), "bundle objects required")
    require(set(snapshot) == {"format", "format_version", "schema_version", "synthetic",
                              "dataset_version", "source_version", "tables"}, "invalid snapshot envelope")
    require(set(manifest) == {"format", "format_version", "schema_version", "synthetic", "dataset_version",
                              "source_version", "created_at", "table_counts", "content_sha256", "snapshot_sha256", "code"},
            "invalid manifest envelope")
    require(snapshot["format"] == "school-source-snapshot" and manifest["format"] == "school-source-manifest",
            "unsupported bundle format")
    for item in (snapshot, manifest):
        require(type(item["format_version"]) is int and item["format_version"] == 1
                and type(item["schema_version"]) is int and item["schema_version"] == SCHEMA_VERSION
                and item["synthetic"] is True, "unsupported bundle version/purpose")
        for key in ("dataset_version", "source_version"):
            core.value_for_storage(item[key], "nonempty")
    for key in ("schema_version", "dataset_version", "source_version"):
        require(snapshot[key] == manifest[key], "bundle metadata mismatch")
    require(manifest["snapshot_sha256"] == sha256(raw) and manifest["content_sha256"] == content_hash(snapshot),
            "snapshot hash mismatch")
    require(isinstance(snapshot["tables"], dict) and isinstance(manifest["table_counts"], dict)
            and set(snapshot["tables"]) == set(PROJECTION) and set(manifest["table_counts"]) == set(TABLES),
            "bundle table set mismatch")
    for table, count in manifest["table_counts"].items():
        require(type(count) is int and count >= 0, "invalid source count")
        if table in PROJECTION:
            rows = snapshot["tables"][table]
            require(isinstance(rows, list) and len(rows) == count, "projected count mismatch")
            for row in rows:
                require(isinstance(row, dict) and set(row) == set(PROJECTION[table]), "unexpected projected column")
                for c, value in row.items():
                    core.value_for_storage(value, TABLES[table][c])
    core.value_for_storage(manifest["created_at"], "timestamp")
    code = manifest["code"]
    require(isinstance(code, dict) and set(code) == {"identity", "files", "sha256"}
            and code["identity"] == "sha256" and isinstance(code["files"], list) and code["files"], "invalid code identity")
    require(code["sha256"] == content_hash(code["files"]), "code identity hash mismatch")
    for entry in code["files"]:
        require(isinstance(entry, dict) and set(entry) == {"path", "sha256"}, "invalid code entry")
        require(isinstance(entry["path"], str) and entry["path"] in CODE_FILES, "unexpected code path")
        require(isinstance(entry["sha256"], str) and len(entry["sha256"]) == 64
                and all(c in "0123456789abcdef" for c in entry["sha256"]), "invalid code hash")
    require(len(code["files"]) == len(CODE_FILES) and {e["path"] for e in code["files"]} == set(CODE_FILES),
            "incomplete code identity")
    return snapshot, manifest


def publish_bundle(staging, output):
    """Reserve new directory; publish manifest last as the completion marker.

    Readers must use verify_bundle/the JS adapter. A killed process can leave an
    incomplete directory without a manifest; it is never a valid candidate.
    Existing directories are never replaced, including empty directories.
    """
    created = False
    try:
        output.mkdir()  # exclusive reservation, closes empty-directory rename race
        created = True
        os.link(staging / "snapshot.json", output / "snapshot.json")
        os.link(staging / "manifest.json", output / "manifest.json")
    except BaseException:
        if created:
            for name in ("manifest.json", "snapshot.json"):
                (output / name).unlink(missing_ok=True)
            output.rmdir()
        raise


def export_command(args):
    require(not args.output.exists(), "snapshot destination exists")
    with closing(store.connect(args.db, readonly=True)) as db:
        db.execute("BEGIN")
        content, counts = snapshot_content(db)
    with tempfile.TemporaryDirectory(prefix=".school-snapshot-", dir=args.output.parent) as temporary:
        staging = Path(temporary)
        raw = write_json(staging / "snapshot.json", content)
        manifest = {
            "format": "school-source-manifest", "format_version": 1, "schema_version": SCHEMA_VERSION,
            "synthetic": True, "dataset_version": content["dataset_version"], "source_version": content["source_version"],
            "created_at": datetime.now(timezone.utc).isoformat(), "table_counts": counts,
            "content_sha256": content_hash(content), "snapshot_sha256": sha256(raw), "code": code_identity(),
        }
        write_json(staging / "manifest.json", manifest)
        verify_bundle(staging)
        publish_bundle(staging, args.output)
    print(json.dumps({"exported_tables": len(content["tables"]), "source_tables": len(counts),
                      "content_sha256": manifest["content_sha256"]}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    importer = commands.add_parser("import")
    importer.add_argument("--input", type=Path, required=True)
    importer.add_argument("--db", type=Path, required=True)
    importer.add_argument("--apply", action="store_true")
    importer.add_argument("--from-core", type=Path, help="explicit schema2 copy migration; new destination only")
    exporter = commands.add_parser("export")
    exporter.add_argument("--db", type=Path, required=True)
    exporter.add_argument("--output", type=Path, required=True)
    verifier = commands.add_parser("verify")
    verifier.add_argument("--bundle", type=Path, required=True)
    args = parser.parse_args()
    for field in ("db", "input", "output", "from_core", "bundle"):
        if getattr(args, field, None) is not None:
            setattr(args, field, getattr(args, field).resolve())
    try:
        if args.command == "import":
            import_command(args)
        elif args.command == "export":
            export_command(args)
        else:
            verify_bundle(args.bundle)
            print('{"verified":true}')
    except (store.InputError, OSError, sqlite3.Error, ValueError, ArithmeticError):
        print("Operation failed. Reporting may fail after completion; inspect local results before retrying.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
