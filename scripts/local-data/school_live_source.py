"""Explicit offline live-capture intake and school snapshot export.

No database service, credentials, configuration discovery, or network access.
The caller captures the 25 complete tables in one PostgreSQL READ ONLY REPEATABLE
READ transaction. This module verifies the supplied bytes and school contract;
the consistency declaration is collector evidence, not independently proven here.
Existing synthetic import/export/apply APIs retain their original restrictions.
Caller-owned external directories must remain exclusively controlled throughout.
"""

import argparse
from contextlib import closing
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import tempfile
import time

import store
import store_core as core
import store_school as school


PURPOSE = "school-source-live"
# Optional local transaction receipts; never part of the 25-table source hash
# or 13-table public projection. The synthetic entry points remain unchanged.
LIVE_RECEIPT_SQL = ("CREATE TABLE source_apply_receipts (request_id TEXT PRIMARY KEY NOT NULL, "
                    "request_sha256 TEXT NOT NULL, document TEXT NOT NULL) STRICT")
CONSISTENCY = "postgresql-repeatable-read-read-only"
DEFAULT_MAX_BYTES = 64 * 1024 * 1024
MAX_BYTES = 256 * 1024 * 1024
MAX_ROWS = 1_000_000
CODE_FILES = tuple(sorted((*school.CODE_FILES, "scripts/local-data/school_live_source.py")))
CAPTURE_KEYS = {"format", "format_version", "schema_version", "synthetic", "dataset_version",
                "source_version", "captured_at", "consistency", "columns", "tables"}
SNAPSHOT_KEYS = {"format", "format_version", "schema_version", "synthetic", "dataset_version",
                 "source_version", "tables"}
MANIFEST_KEYS = {"format", "format_version", "schema_version", "synthetic", "dataset_version",
                 "source_version", "created_at", "table_counts", "content_sha256", "snapshot_sha256", "code"}


class LiveSourceError(ValueError):
    """Sanitized failure: do not print underlying exceptions or input values."""


def _need(condition, message="live school source contract rejected"):
    if not condition:
        raise LiveSourceError(message)


def _limits(maximum, timeout):
    _need(type(maximum) is int and 0 < maximum <= MAX_BYTES, "invalid byte limit")
    _need(type(timeout) in (int, float) and math.isfinite(timeout) and 0 < timeout <= 300,
          "invalid operation deadline")
    return time.monotonic() + timeout


def _remaining(deadline):
    _need(time.monotonic() < deadline, "live school operation deadline exceeded")


def _hash(raw):
    return hashlib.sha256(raw).hexdigest()


def _sha(value):
    return type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _path(value, *, existing=True, directory=False):
    path = Path(value)
    _need(path.is_absolute() and ".." not in path.parts and path.parent != path
          and not str(path).startswith(("\\\\", "//")), "absolute external local path required")
    _need(not path.is_relative_to(school.REPO), "repository paths are forbidden")
    for item in (*reversed(path.parents), path):
        _need(not (item / ".git").exists(), "repository paths are forbidden")
        if item == path and not existing:
            _need(not os.path.lexists(item), "destination already exists")
            continue
        info = item.lstat()
        _need(not stat.S_ISLNK(info.st_mode) and not (getattr(info, "st_file_attributes", 0) & 0x400),
              "linked paths are forbidden")
        if item != path or directory:
            _need(stat.S_ISDIR(info.st_mode), "parent directory required")
        else:
            _need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "regular unaliased file required")
    return path


def _identity(path):
    info = path.lstat()
    return info.st_dev, info.st_ino


def _read(path, maximum):
    path = _path(path)
    before = path.stat()
    _need(0 < before.st_size <= maximum, "input exceeds byte limit")
    with path.open("rb") as stream:
        opened = os.fstat(stream.fileno())
        _need((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino))
        raw = stream.read(maximum + 1)
    after = _path(path).stat()
    _need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
          (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), "input changed during read")
    _need(0 < len(raw) <= maximum, "input exceeds byte limit")
    return raw


def _json(raw):
    return json.loads(raw, parse_float=Decimal, parse_constant=core.reject_constant,
                      object_pairs_hook=store.reject_duplicate_keys)


def _version_fields(value):
    _need(type(value["format_version"]) is int and value["format_version"] == 1
          and type(value["schema_version"]) is int and value["schema_version"] == 3
          and value["synthetic"] is False, "explicit live schema-3 input required")
    for name in ("dataset_version", "source_version"):
        _need(type(value[name]) is str and 0 < len(value[name]) <= 256)
        core.value_for_storage(value[name], "nonempty")


def _capture(raw, expected_sha256, deadline):
    _need(_sha(expected_sha256) and _hash(raw) == expected_sha256, "capture pin mismatch")
    payload = _json(raw)
    _need(type(payload) is dict and set(payload) == CAPTURE_KEYS, "unexpected capture envelope")
    _version_fields(payload)
    _need(payload["format"] == "school-live-source-capture" and payload["consistency"] == CONSISTENCY,
          "unsupported live capture declaration")
    core.value_for_storage(payload["captured_at"], "timestamp")
    _need(type(payload["columns"]) is dict and set(payload["columns"]) == set(school.TABLES),
          "complete column inventory required")
    for table, columns in school.TABLES.items():
        actual = payload["columns"][table]
        _need(type(actual) is list and all(type(c) is str for c in actual)
              and len(actual) == len(set(actual)) and set(actual) == set(columns),
              "capture columns differ from school contract")
    _need(type(payload["tables"]) is dict and set(payload["tables"]) == set(school.TABLES),
          "exactly 25 school tables required")
    _need(all(type(rows) is list for rows in payload["tables"].values()))
    _need(0 < len(payload["tables"]["schools"]) and
          sum(len(rows) for rows in payload["tables"].values()) <= MAX_ROWS, "invalid source row count")
    payload["tables"] = school.normalize_tables(payload["tables"])
    _remaining(deadline)
    return payload


def _connect(path, *, readonly=False, deadline):
    db = sqlite3.connect(path.as_uri() + ("?mode=ro" if readonly else "?mode=rw"), uri=True, timeout=0,
                         isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA trusted_schema=OFF")
    if readonly:
        db.execute("PRAGMA query_only=ON")
    db.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
    return db


def _schema(db):
    return [tuple(row) for row in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")]


def _check(db, deadline, maximum):
    _need(db.execute("PRAGMA page_count").fetchone()[0] * db.execute("PRAGMA page_size").fetchone()[0]
          <= maximum, "database exceeds byte limit")
    school.check_shape(db, school.TABLES,
                       {"singleton", "schema_version", "purpose", "dataset_version", "source_version"},
                       allow_apply_receipts=True)
    # Verify CHECK/UNIQUE/FK definitions too; matching column names alone cannot
    # establish the constraints on a later reopened, potentially edited source.
    with closing(sqlite3.connect(":memory:")) as expected:
        for filename in ("schema-core.sql", "schema-history.sql", "schema-admission.sql"):
            for statement in Path(__file__).with_name(filename).read_text(encoding="utf-8").split(";"):
                if statement.strip():
                    expected.execute(statement)
        expected.execute("ALTER TABLE source_metadata ADD COLUMN source_version TEXT NOT NULL")
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_apply_receipts'").fetchone():
            expected.execute(LIVE_RECEIPT_SQL)
        _need(_schema(db) == _schema(expected), "source schema differs from live contract")
    counts = [db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0] for table in school.TABLES]
    _need(sum(counts) <= MAX_ROWS and db.execute("SELECT 1 FROM schools LIMIT 1").fetchone() is not None,
          "invalid source row count")
    metadata = db.execute("SELECT * FROM source_metadata").fetchmany(2)
    _need(len(metadata) == 1 and metadata[0]["singleton"] == 1 and metadata[0]["schema_version"] == 3
          and metadata[0]["purpose"] == PURPOSE, "unsupported live source purpose or schema")
    for name in ("dataset_version", "source_version"):
        core.value_for_storage(metadata[0][name], "nonempty")
    school.check_consistency(db)
    _remaining(deadline)
    return metadata[0]


def _ordered_rows(table, rows):
    return sorted(rows, key=lambda row: tuple((row[key] is not None, row[key]) for key in school.KEYS[table]))


def _all_tables(db):
    return {table: _ordered_rows(table, [dict(row) for row in db.execute(f'SELECT * FROM "{table}"')])
            for table in school.TABLES}


def _full_hash(tables):
    ordered = {table: _ordered_rows(table, rows) for table, rows in tables.items()}
    return school.content_hash(ordered)


def _code_identity():
    files = [{"path": name, "sha256": _hash((school.REPO / name).read_bytes())} for name in CODE_FILES]
    return {"identity": "sha256", "files": files, "sha256": school.content_hash(files)}


# Pin the reviewed checkout at import, then reject source edits during a run.
_IMPORTED_CODE = _code_identity()


def _check_code():
    _need(_code_identity() == _IMPORTED_CODE, "producer source changed during operation")


def _write(path, raw, maximum):
    _need(0 < len(raw) <= maximum, "output exceeds byte limit")
    with path.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def import_capture(input_path, db_path, *, input_sha256, apply=False,
                   max_bytes=DEFAULT_MAX_BYTES, timeout_seconds=120):
    """Validate full capture; --apply publishes only a new private source file."""
    deadline = _limits(max_bytes, timeout_seconds)
    _need(type(apply) is bool)
    try:
        _check_code()
        output = _path(db_path, existing=False)
        parent_identity = _identity(output.parent)
        raw = _read(input_path, max_bytes)
        payload = _capture(raw, input_sha256, deadline)
        expected_hash = _full_hash(payload["tables"])
        with tempfile.TemporaryDirectory(prefix=".live-school-intake-", dir=output.parent) as temporary:
            staged = Path(temporary) / "source.sqlite"
            with staged.open("xb"):
                pass
            with closing(_connect(staged, deadline=deadline)) as db:
                db.execute("BEGIN IMMEDIATE")
                for name in ("schema-core.sql", "schema-history.sql", "schema-admission.sql"):
                    for statement in Path(__file__).with_name(name).read_text(encoding="utf-8").split(";"):
                        if statement.strip():
                            db.execute(statement)
                db.execute("ALTER TABLE source_metadata ADD COLUMN source_version TEXT NOT NULL")
                db.execute("INSERT INTO source_metadata VALUES (1, 3, ?, ?, ?)",
                           (PURPOSE, payload["dataset_version"], payload["source_version"]))
                for table, columns in school.TABLES.items():
                    _remaining(deadline)
                    db.executemany(f'INSERT INTO "{table}" ({", ".join(columns)}) VALUES '
                                   f'({", ".join("?" for _ in columns)})',
                                   (tuple(row[column] for column in columns) for row in payload["tables"][table]))
                    _need(db.execute("PRAGMA page_count").fetchone()[0] *
                          db.execute("PRAGMA page_size").fetchone()[0] <= max_bytes, "database exceeds byte limit")
                _check(db, deadline, max_bytes)
                actual = _all_tables(db)
                _need(_full_hash(actual) == expected_hash, "full source round-trip differs")
                db.commit()
            _need(staged.stat().st_size <= max_bytes, "database exceeds byte limit")
            # Reopen committed file: neither a precommit check nor a projection-only comparison.
            with closing(_connect(staged, readonly=True, deadline=deadline)) as db:
                db.execute("BEGIN")
                _check(db, deadline, max_bytes)
                _need(_full_hash(_all_tables(db)) == expected_hash, "committed source differs")
            _check_code()
            _remaining(deadline)
            _path(output, existing=False)
            _need(_identity(output.parent) == parent_identity, "destination parent changed")
            if apply:
                # Atomic create-only publication; no overwrite/rename fallback.
                owned = _identity(staged)
                try:
                    os.link(staged, output)
                    _remaining(deadline)
                except BaseException:
                    _path(output.parent, directory=True)
                    _need(_identity(output.parent) == parent_identity, "destination parent changed; recovery required")
                    if os.path.lexists(output) and _identity(output) == owned:
                        output.unlink()
                    raise
        return {"format": "school-live-import-receipt", "mode": "applied" if apply else "dry-run",
                "schema_version": 3, "input_sha256": input_sha256, "source_content_sha256": expected_hash,
                "dataset_version": payload["dataset_version"], "source_version": payload["source_version"],
                "captured_at": payload["captured_at"], "consistency": CONSISTENCY,
                "consistency_evidence": "collector-declared",
                "table_counts": {table: len(rows) for table, rows in payload["tables"].items()}}
    except LiveSourceError:
        raise
    except Exception:
        raise LiveSourceError("live school capture validation or import failed") from None


def _project(db):
    tables = {}
    for table, columns in school.PROJECTION.items():
        order = "prefecture, name, id" if table == "schools" else ", ".join(school.KEYS[table])
        rows = []
        for raw in db.execute(f'SELECT {", ".join(columns)} FROM "{table}" ORDER BY {order}'):
            row = school.decode_row(table, raw)
            for column, value in row.items():
                if school.TABLES[table][column].rstrip("?") == "decimal" and value is not None:
                    row[column] = Decimal(value)
            rows.append(row)
        tables[table] = rows
    return tables


def _verify_bytes(raw, manifest_raw):
    snapshot, manifest = _json(raw), _json(manifest_raw)
    _need(type(snapshot) is dict and set(snapshot) == SNAPSHOT_KEYS)
    _need(type(manifest) is dict and set(manifest) == MANIFEST_KEYS)
    _version_fields(snapshot)
    _version_fields(manifest)
    _need(snapshot["format"] == "school-source-snapshot" and manifest["format"] == "school-source-manifest")
    _need(all(snapshot[key] == manifest[key] for key in ("schema_version", "dataset_version", "source_version")))
    _need(_sha(manifest["snapshot_sha256"]) and _hash(raw) == manifest["snapshot_sha256"]
          and _sha(manifest["content_sha256"]) and school.content_hash(snapshot) == manifest["content_sha256"],
          "snapshot hash mismatch")
    core.value_for_storage(manifest["created_at"], "timestamp")
    _need(type(manifest["table_counts"]) is dict and set(manifest["table_counts"]) == set(school.TABLES))
    _need(all(type(count) is int and 0 <= count <= MAX_ROWS for count in manifest["table_counts"].values()))
    _need(sum(manifest["table_counts"].values()) <= MAX_ROWS and manifest["table_counts"]["schools"] > 0)
    _need(type(snapshot["tables"]) is dict and set(snapshot["tables"]) == set(school.PROJECTION))
    for table, columns in school.PROJECTION.items():
        rows = snapshot["tables"][table]
        _need(type(rows) is list and len(rows) == manifest["table_counts"][table])
        for row in rows:
            _need(type(row) is dict and set(row) == set(columns), "unexpected projection column")
            for column, value in row.items():
                core.value_for_storage(value, school.TABLES[table][column])
    code = manifest["code"]
    _need(type(code) is dict and set(code) == {"identity", "files", "sha256"} and code["identity"] == "sha256")
    _need(type(code["files"]) is list and len(code["files"]) == len(CODE_FILES))
    _need(all(type(entry) is dict and set(entry) == {"path", "sha256"} and _sha(entry["sha256"])
              for entry in code["files"]))
    _need([entry["path"] for entry in code["files"]] == list(CODE_FILES))
    _need(_sha(code["sha256"]) and school.content_hash(code["files"]) == code["sha256"])
    return snapshot, manifest


def verify_bundle(directory, *, max_bytes=DEFAULT_MAX_BYTES, timeout_seconds=120):
    """Verify a live bundle offline; code hashes are claimed producer identity."""
    deadline = _limits(max_bytes, timeout_seconds)
    try:
        root = _path(directory, directory=True)
        _need({p.name for p in root.iterdir()} == {"snapshot.json", "manifest.json"}, "unexpected bundle files")
        raw = _read(root / "snapshot.json", max_bytes)
        metadata = _read(root / "manifest.json", min(max_bytes, 1024 * 1024))
        _need(len(raw) + len(metadata) <= max_bytes, "bundle exceeds byte limit")
        result = _verify_bytes(raw, metadata)
        _remaining(deadline)
        return result
    except LiveSourceError:
        raise
    except Exception:
        raise LiveSourceError("live school bundle validation failed") from None


def export_snapshot(db_path, output_path, *, expected_source_sha256, apply=False,
                    max_bytes=DEFAULT_MAX_BYTES, timeout_seconds=120):
    """Export allowed 13-table projection from one read-only SQLite transaction."""
    deadline = _limits(max_bytes, timeout_seconds)
    _need(type(apply) is bool and _sha(expected_source_sha256), "explicit full-source pin required")
    try:
        _check_code()
        source, output = _path(db_path), _path(output_path, existing=False, directory=True)
        _need(source.stat().st_size <= max_bytes, "database exceeds byte limit")
        parent_identity = _identity(output.parent)
        for suffix in ("-wal", "-shm", "-journal"):
            sidecar = Path(str(source) + suffix)
            if os.path.lexists(sidecar):
                _path(sidecar)
        _need(not Path(str(source) + "-wal").exists() or Path(str(source) + "-shm").is_file(),
              "WAL source requires existing shared-memory sidecar")
        with closing(_connect(source, readonly=True, deadline=deadline)) as db:
            db.execute("BEGIN")
            metadata = _check(db, deadline, max_bytes)
            _need(_full_hash(_all_tables(db)) == expected_source_sha256, "full source pin mismatch")
            snapshot = {"format": "school-source-snapshot", "format_version": 1, "schema_version": 3,
                        "synthetic": False, "dataset_version": metadata["dataset_version"],
                        "source_version": metadata["source_version"], "tables": _project(db)}
            counts = {table: db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0] for table in school.TABLES}
        raw = (school.canonical_json(snapshot) + "\n").encode("utf-8")
        manifest = {"format": "school-source-manifest", "format_version": 1, "schema_version": 3,
                    "synthetic": False, "dataset_version": snapshot["dataset_version"],
                    "source_version": snapshot["source_version"], "created_at": datetime.now(timezone.utc).isoformat(),
                    "table_counts": counts, "content_sha256": school.content_hash(snapshot),
                    "snapshot_sha256": _hash(raw), "code": _IMPORTED_CODE}
        manifest_raw = (school.canonical_json(manifest) + "\n").encode("utf-8")
        _need(len(raw) + len(manifest_raw) <= max_bytes, "bundle exceeds byte limit")
        _verify_bytes(raw, manifest_raw)
        _check_code()
        _remaining(deadline)
        if apply:
            with tempfile.TemporaryDirectory(prefix=".live-school-export-", dir=output.parent) as temporary:
                staged = Path(temporary)
                _write(staged / "snapshot.json", raw, max_bytes)
                _write(staged / "manifest.json", manifest_raw, min(max_bytes, 1024 * 1024))
                _path(output, existing=False, directory=True)
                _need(_identity(output.parent) == parent_identity, "destination parent changed")
                _remaining(deadline)
                output.mkdir()  # reserve; existing directories (even empty) never replaced
                owned_root = _identity(output)
                linked = []
                try:
                    for name in ("snapshot.json", "manifest.json"):
                        _path(output, directory=True)
                        _need(_identity(output) == owned_root, "destination changed")
                        _remaining(deadline)
                        # Record the staged identity before link: cleanup also handles an
                        # interrupt raised immediately after a successful native link.
                        linked.append((output / name, _identity(staged / name)))
                        os.link(staged / name, output / name)
                    _remaining(deadline)
                except BaseException:
                    _path(output, directory=True)
                    _need(_identity(output) == owned_root, "destination changed; recovery required")
                    for path, identity in reversed(linked):
                        if os.path.lexists(path) and _identity(path) == identity:
                            path.unlink()
                    if not any(output.iterdir()):
                        output.rmdir()
                    raise
        return {"format": "school-live-export-receipt", "mode": "applied" if apply else "dry-run",
                "source_content_sha256": expected_source_sha256, "content_sha256": manifest["content_sha256"],
                "snapshot_sha256": manifest["snapshot_sha256"], "table_counts": counts}
    except LiveSourceError:
        raise
    except Exception:
        raise LiveSourceError("live school snapshot export failed") from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("import", "export", "verify"):
        command = commands.add_parser(name)
        command.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
        command.add_argument("--timeout-seconds", type=float, default=120)
        if name == "import":
            command.add_argument("--input", type=Path, required=True)
            command.add_argument("--input-sha256", required=True)
            command.add_argument("--db", type=Path, required=True)
        elif name == "export":
            command.add_argument("--db", type=Path, required=True)
            command.add_argument("--output", type=Path, required=True)
            command.add_argument("--expected-source-sha256", required=True)
        else:
            command.add_argument("--bundle", type=Path, required=True)
        if name != "verify":
            command.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    options = {"max_bytes": args.max_bytes, "timeout_seconds": args.timeout_seconds}
    try:
        if args.command == "import":
            receipt = import_capture(args.input, args.db, input_sha256=args.input_sha256, apply=args.apply, **options)
        elif args.command == "export":
            receipt = export_snapshot(args.db, args.output, expected_source_sha256=args.expected_source_sha256,
                                      apply=args.apply, **options)
        else:
            _, manifest = verify_bundle(args.bundle, **options)
            receipt = {"format": "school-live-verify-receipt", "content_sha256": manifest["content_sha256"],
                       "table_counts": manifest["table_counts"]}
        print(json.dumps(receipt, ensure_ascii=True, sort_keys=True))
        return 0
    except (ValueError, OSError, sqlite3.Error):
        print("live school operation rejected; inspect contract and private evidence", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
