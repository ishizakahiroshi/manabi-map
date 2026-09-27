"""Synthetic-only SQLite import and reduced public JSON; Python 3.14 stdlib."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from urllib.parse import urlsplit
from uuid import UUID


PURPOSE = "synthetic-school-prototype"
SCHEMA_VERSION = 1
SCHOOL_COLUMNS = (
    "id", "record_key", "name", "type", "ownership", "gender_type",
    "prefecture", "address", "official_url", "is_integrated", "is_active", "updated_at",
)
DEPARTMENT_COLUMNS = ("id", "record_key", "school_id", "name", "course_type")
# Subset of web/scripts/lib/public-api.mjs BASIC_FIELDS. No source-gated fields.
PUBLIC_COLUMNS = (
    "id", "record_key", "name", "type", "ownership", "gender_type",
    "prefecture", "address", "official_url", "is_integrated", "updated_at",
)


class InputError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise InputError(message)


def text_value(value, label, nullable=False):
    if nullable and value is None:
        return value
    require(isinstance(value, str) and bool(value.strip()), f"{label}: nonempty text required")
    return value


def uuid_value(value, label):
    text_value(value, label)
    try:
        valid = str(UUID(value)) == value
    except ValueError:
        valid = False
    require(valid, f"{label}: canonical UUID required; IDs are never regenerated")


def http_url(value):
    if not isinstance(value, str) or any(char.isspace() for char in value):
        return False
    try:
        parsed = urlsplit(value)
        # urlsplit defers numeric/range validation until the port is accessed.
        # Without this, malformed URLs can be imported and published.
        _ = parsed.port
        return parsed.scheme in ("http", "https") and bool(parsed.hostname)
    except ValueError:
        return False


def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON object key")
        result[key] = value
    return result


def load_input(path):
    payload = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=reject_duplicate_keys)
    require(isinstance(payload, dict), "input must be an object")
    require(set(payload) == {"schema_version", "synthetic", "dataset_version", "schools", "school_departments"},
            "unexpected or missing top-level keys; unrelated tables are not accepted")
    require(type(payload["schema_version"]) is int and payload["schema_version"] == SCHEMA_VERSION,
            "unsupported input schema version")
    require(payload["synthetic"] is True, "only explicitly synthetic input is supported")
    text_value(payload["dataset_version"], "dataset_version")
    ignored = 0
    for table, columns in (("schools", SCHOOL_COLUMNS), ("school_departments", DEPARTMENT_COLUMNS)):
        rows = payload[table]
        require(isinstance(rows, list), f"{table}: array required")
        ids, keys = set(), set()
        for index, row in enumerate(rows):
            label = f"{table}[{index}]"
            require(isinstance(row, dict), f"{label}: object required")
            require(set(columns).issubset(row), f"{label}: required columns missing")
            ignored += len(set(row) - set(columns))
            uuid_value(row["id"], label + ".id")
            # record_key has an independent identity in PostgreSQL, not necessarily id.
            prefix = "school-" if table == "schools" else "department-"
            key = text_value(row["record_key"], label + ".record_key")
            require(key.startswith(prefix), label + ": invalid record_key prefix")
            uuid_value(key[len(prefix):], label + ".record_key UUID")
            require(row["id"] not in ids and key not in keys, label + ": duplicate identity")
            ids.add(row["id"])
            keys.add(key)
            text_value(row["name"], label + ".name")
            if table == "schools":
                for field in ("type", "ownership", "gender_type", "prefecture", "address"):
                    text_value(row[field], label + "." + field)
                for field in ("is_integrated", "is_active"):
                    require(type(row[field]) is bool, label + ": booleans must be JSON true/false")
                require(row["official_url"] is None or http_url(row["official_url"]),
                        label + ": official_url must be HTTP(S) or null")
                text_value(row["updated_at"], label + ".updated_at")
                try:
                    stamp = datetime.fromisoformat(row["updated_at"])
                except ValueError as exc:
                    raise InputError(label + ": invalid updated_at") from exc
                require(stamp.utcoffset() is not None, label + ": updated_at needs timezone")
            else:
                uuid_value(row["school_id"], label + ".school_id")
                require(row["course_type"] in (None, "general"),
                        label + ": unsupported course_type (prototype accepts general/null only)")
            # Unknown row columns are deliberately discarded, including internal notes.
            rows[index] = {column: row[column] for column in columns}
    return payload, ignored


def connect(path, readonly=False):
    db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, isolation_level=None) if readonly else sqlite3.connect(path, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    db.execute("PRAGMA busy_timeout = 5000")
    return db


def check_metadata(db):
    row = db.execute("SELECT * FROM prototype_metadata WHERE singleton = 1").fetchone()
    require(row is not None and row["schema_version"] == SCHEMA_VERSION and row["purpose"] == PURPOSE,
            "database is not a supported synthetic prototype")


def import_rows(db, payload, fresh):
    db.execute("BEGIN IMMEDIATE")
    try:
        if fresh:
            # execute individually: executescript() can commit an existing transaction.
            for statement in Path(__file__).with_name("schema.sql").read_text(encoding="utf-8").split(";"):
                if statement.strip():
                    db.execute(statement)
            db.execute("INSERT INTO prototype_metadata VALUES (1, ?, ?, ?)",
                       (SCHEMA_VERSION, PURPOSE, payload["dataset_version"]))
        else:
            check_metadata(db)
        for table, columns in (("schools", SCHOOL_COLUMNS), ("school_departments", DEPARTMENT_COLUMNS)):
            for row in payload[table]:
                previous = db.execute(f"SELECT record_key FROM {table} WHERE id = ?", (row["id"],)).fetchone()
                require(previous is None or previous["record_key"] == row["record_key"],
                        f"{table}: existing ID cannot change record_key")
                if table == "school_departments":
                    previous_school = db.execute("SELECT school_id FROM school_departments WHERE id = ?", (row["id"],)).fetchone()
                    require(previous_school is None or previous_school["school_id"] == row["school_id"],
                            "school_departments: existing ID cannot change school")
                updates = ", ".join(f"{column}=excluded.{column}" for column in columns if column != "id")
                db.execute(f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)}) "
                           f"ON CONFLICT(id) DO UPDATE SET {updates}", tuple(row[column] for column in columns))
        require(not db.execute("PRAGMA foreign_key_check").fetchall(), "foreign key violation")
        db.execute("UPDATE prototype_metadata SET dataset_version = ? WHERE singleton = 1", (payload["dataset_version"],))
        db.commit()
    except BaseException:
        db.rollback()
        raise


def import_command(args):
    payload, ignored = load_input(args.input)
    exists = args.db.exists()
    created = False
    db = None
    try:
        if args.apply:
            if not exists:
                # Exclusive creation prevents overwriting a concurrently created file.
                fd = os.open(args.db, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
                created = True
            db = connect(args.db)
        else:
            db = sqlite3.connect(":memory:", isolation_level=None)
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys = ON")
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
    print(json.dumps({"mode": "applied" if args.apply else "dry-run", "schools_received": len(payload["schools"]),
                      "departments_received": len(payload["school_departments"]), "ignored_columns": ignored}))


def export_command(args):
    require(args.output != args.db, "output must differ from database")
    db = connect(args.db, readonly=True)
    try:
        db.execute("BEGIN")
        check_metadata(db)
        require(not db.execute("PRAGMA foreign_key_check").fetchall(), "foreign key violation")
        dataset_version = db.execute("SELECT dataset_version FROM prototype_metadata").fetchone()[0]
        schools = []
        for row in db.execute(f"SELECT {', '.join(PUBLIC_COLUMNS)} FROM schools WHERE is_active = 1 ORDER BY id"):
            if not http_url(row["official_url"]):
                continue
            school = dict(row)
            school["is_integrated"] = bool(school["is_integrated"])
            schools.append(school)
        db.commit()
    finally:
        db.close()
    content = {"format": "synthetic-school-public-subset", "schema_version": SCHEMA_VERSION,
               "synthetic": True, "dataset_version": dataset_version, "schools": schools}
    canonical = json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    output = {**content, "created_at": datetime.now(timezone.utc).isoformat(),
              "content_sha256": hashlib.sha256(canonical).hexdigest(), "school_count": len(schools)}
    # Complete a sibling temporary file first, then atomically claim a new name.
    # link() fails if the destination exists; it never replaces an older snapshot.
    # Filesystems without hard links fail closed, with no partial final JSON.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                         dir=args.output.parent, prefix=".school-export-",
                                         suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(output, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, args.output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    print(json.dumps({"exported_schools": len(schools), "departments_exported": 0}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    importer = commands.add_parser("import", help="validate/import synthetic schools and departments")
    importer.add_argument("--input", type=Path, required=True)
    importer.add_argument("--db", type=Path, required=True)
    importer.add_argument("--apply", action="store_true", help="write DB; default uses memory only")
    exporter = commands.add_parser("export", help="write a reduced synthetic public JSON")
    exporter.add_argument("--db", type=Path, required=True)
    exporter.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.db = args.db.resolve()
    if args.command == "export":
        args.output = args.output.resolve()
    try:
        (import_command if args.command == "import" else export_command)(args)
    except (InputError, OSError, sqlite3.Error, ValueError):
        # Never echo arbitrary input rows, database values or private paths.
        print("Operation failed. If the failure occurred during result reporting, the import or export may already be complete. Inspect the local result before retrying.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
