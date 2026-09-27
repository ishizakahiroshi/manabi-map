"""Verified, synthetic schema-3 school backups. No scheduling, sync or real DB access.

All three public functions return the strict manifest dictionary. create/restore
default to dry-run; dry-run validates in OS temporary storage, never at destination.
The manifest is the completion marker. No destination, even empty, is replaced.
File fsync and exception cleanup are tested; power loss/filesystem durability and
hostile concurrent directory replacement are not claimed to be solved portably.
"""

from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import tempfile
import time

import store
import store_core
import store_school as school


GENERATION_FILES = ("database.sqlite", "manifest.json")
MANIFEST_FIELDS = {"format", "format_version", "synthetic", "schema_version",
                   "dataset_version", "source_version", "created_at", "database_sha256",
                   "table_counts", "snapshot_content_sha256"}
TIMEOUT_SECONDS = 5.0
BACKUP_PAGES = 64
SIDECARS = ("-wal", "-shm", "-journal")
require = store.require


def _deadline(end):
    if time.monotonic() >= end:
        raise TimeoutError("school backup operation exceeded its time limit")


def _path(value, *, missing=False):
    path = Path(value)
    require(".." not in path.parts, "parent traversal is not supported")
    path = path.absolute()
    for part in (*reversed(path.parents), path):
        try:
            info = part.lstat()
        except FileNotFoundError:
            require(missing and part == path, "path parent does not exist")
            continue
        require(not stat.S_ISLNK(info.st_mode)
                and not (getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)),
                "linked/reparse paths are not supported")
        if part != path:
            require(stat.S_ISDIR(info.st_mode), "path ancestor is not a directory")
        elif stat.S_ISREG(info.st_mode):
            require(info.st_nlink == 1, "hard-linked files are not supported")
    return path


def _identity(path):
    info = path.lstat()
    return info.st_dev, info.st_ino


def _regular(path):
    path = _path(path)
    require(stat.S_ISREG(path.lstat().st_mode), "regular file required")
    return path


def _absent(path):
    path = _path(path, missing=True)
    require(not os.path.lexists(path), "destination already exists")
    return path


def _sidecars(path, *, source=False):
    for suffix in SIDECARS:
        companion = Path(str(path) + suffix)
        if os.path.lexists(companion):
            require(source and suffix != "-journal", "SQLite sidecar is not allowed here")
            _regular(companion)


def _open_read(path):
    path = _regular(path)
    identity = _identity(path)
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        info = os.fstat(fd)
        require((info.st_dev, info.st_ino) == identity and info.st_nlink == 1, "file changed while opening")
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise


def _digest(path, end):
    identity = _identity(_regular(path))
    digest = hashlib.sha256()
    with _open_read(path) as stream:
        while block := stream.read(1024 * 1024):
            _deadline(end)
            digest.update(block)
    require(_identity(_regular(path)) == identity, "file replaced during hashing")
    return digest.hexdigest()


def _connect(path, end, *, immutable=False):
    _deadline(end)
    uri = path.as_uri() + "?mode=ro" + ("&immutable=1" if immutable else "")
    db = sqlite3.connect(uri, uri=True, isolation_level=None, timeout=0.05)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    db.execute("PRAGMA trusted_schema=OFF")
    db.execute("PRAGMA foreign_keys=ON")
    db.set_progress_handler(lambda: int(time.monotonic() >= end), 1000)
    return db


def _retry_busy(call, end):
    while True:
        _deadline(end)
        try:
            return call()
        except sqlite3.OperationalError as exc:
            if getattr(exc, "sqlite_errorcode", None) not in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
                raise
            time.sleep(min(0.01, max(0, end - time.monotonic())))


def _schema(db):
    return [tuple(row) for row in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")]


def _inspect(path, end):
    """Inspect the finished standalone file, never a live WAL file as immutable."""
    _sidecars(path)
    with closing(_connect(path, end, immutable=True)) as db:
        # Exact schema includes constraints, indexes, views/triggers, not just names.
        has_receipts = db.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='source_apply_receipts'").fetchone() is not None
        with closing(sqlite3.connect(":memory:")) as expected:
            school.create_schema(expected, {"dataset_version": "synthetic", "source_version": "synthetic"})
            if has_receipts:
                # The sole optional extension is SourceAdapter's private journal.
                # Preserve it for idempotency/cancellation without exporting it.
                expected.execute("CREATE TABLE source_apply_receipts (request_id TEXT PRIMARY KEY NOT NULL, "
                                 "request_sha256 TEXT NOT NULL, document TEXT NOT NULL) STRICT")
            require(_schema(db) == _schema(expected), "database schema differs from synthetic schema 3")
        require([tuple(row) for row in db.execute("PRAGMA integrity_check")] == [("ok",)], "database integrity failure")
        require(not db.execute("PRAGMA foreign_key_check").fetchall(), "foreign key violation")
        content, counts = school.snapshot_content(db)  # metadata + all stored row validators
        if has_receipts:
            from school_source_apply import _read_receipt
            for row in db.execute("SELECT request_id FROM source_apply_receipts"):
                _deadline(end)
                # Historical receipts need not match the current tip. Validate
                # their full document and request hashes with the source reader.
                _read_receipt(db, row["request_id"])
    _deadline(end)
    result = {"dataset_version": content["dataset_version"], "source_version": content["source_version"],
              "table_counts": counts, "snapshot_content_sha256": school.content_hash(content)}
    _deadline(end)
    return result


def _validate_manifest(manifest):
    require(isinstance(manifest, dict) and set(manifest) == MANIFEST_FIELDS, "invalid backup manifest fields")
    require(manifest["format"] == "school-source-backup" and type(manifest["format_version"]) is int
            and manifest["format_version"] == 1 and type(manifest["schema_version"]) is int
            and manifest["schema_version"] == 3 and manifest["synthetic"] is True, "unsupported backup format/schema")
    for key in ("dataset_version", "source_version"):
        store_core.value_for_storage(manifest[key], "nonempty")
    stamp = manifest["created_at"]
    require(isinstance(stamp, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)", stamp),
            "timezone-qualified backup timestamp required")
    require(datetime.fromisoformat(stamp).utcoffset() is not None, "invalid backup timestamp")
    for key in ("database_sha256", "snapshot_content_sha256"):
        require(isinstance(manifest[key], str) and re.fullmatch(r"[0-9a-f]{64}", manifest[key]), "invalid backup hash")
    counts = manifest["table_counts"]
    require(isinstance(counts, dict) and set(counts) == set(school.TABLES), "backup table set mismatch")
    require(all(type(v) is int and 0 <= v <= 2**63 - 1 for v in counts.values()), "invalid backup counts")


def _verify_database(path, manifest, end):
    before = _digest(path, end)
    require(before == manifest["database_sha256"], "database hash mismatch")
    actual = _inspect(path, end)
    require(all(actual[key] == manifest[key] for key in actual), "database metadata/content mismatch")
    require(_digest(path, end) == before, "database changed during verification")


def _verify(generation, end):
    generation = _path(generation)
    require(generation.is_dir(), "generation directory required")
    identity = _identity(generation)
    require({p.name for p in generation.iterdir()} == set(GENERATION_FILES), "generation must contain exactly two completed files")
    manifest_path = _regular(generation / "manifest.json")
    with _open_read(manifest_path) as stream:
        raw = stream.read(1024 * 1024 + 1)
    require(len(raw) <= 1024 * 1024, "backup manifest is too large")
    manifest = json.loads(raw, object_pairs_hook=store.reject_duplicate_keys, parse_constant=store_core.reject_constant)
    _validate_manifest(manifest)
    _verify_database(_regular(generation / "database.sqlite"), manifest, end)
    with _open_read(manifest_path) as stream:
        require(stream.read(1024 * 1024 + 1) == raw, "manifest changed during verification")
    require(_identity(_path(generation)) == identity and {p.name for p in generation.iterdir()} == set(GENERATION_FILES),
            "generation changed during verification")
    return manifest


def verify_backup(generation):
    """Reject incomplete, linked, corrupted or unsupported synthetic generations."""
    return _verify(generation, time.monotonic() + TIMEOUT_SECONDS)


def _copy_new(source, destination, end):
    _absent(destination)
    with _open_read(source) as incoming, destination.open("xb") as outgoing:
        info = os.fstat(outgoing.fileno())
        identity = info.st_dev, info.st_ino
        try:
            while block := incoming.read(1024 * 1024):
                _deadline(end)
                outgoing.write(block)
            outgoing.flush()
            os.fsync(outgoing.fileno())
        except BaseException:
            outgoing.close()
            _remove_own(destination, identity)
            raise
    return identity


def _remove_own(path, identity):
    """Never follow/delete a replacement, a linked path, or another writer's file."""
    try:
        if _identity(_path(path)) == identity:
            path.unlink()
    except (OSError, store.InputError):
        pass


def _publish(staging, destination, end):
    _absent(destination)
    destination.mkdir()
    identity = _identity(destination)
    owned = {}
    try:
        for name in GENERATION_FILES:  # manifest last, after the DB copy has been synced
            target = destination / name
            owned[name] = _copy_new(staging / name, target, end)
        return _verify(destination, end)
    except BaseException:
        try:
            if _identity(_path(destination)) == identity:
                for name, file_identity in owned.items():
                    _remove_own(destination / name, file_identity)
                destination.rmdir()  # Only our now-empty directory; no recursive delete.
        except (OSError, store.InputError):
            pass
        raise


def create_backup(source, destination, *, apply=False):
    """Capture a read transaction with SQLite Backup API, including committed WAL."""
    require(type(apply) is bool, "apply must be a boolean")
    end = time.monotonic() + TIMEOUT_SECONDS
    source = _regular(source)
    identity = _identity(source)
    _sidecars(source, source=True)
    destination = _absent(destination)
    with tempfile.TemporaryDirectory(prefix="school-backup-") as temporary:
        staging = Path(temporary)
        database = staging / "database.sqlite"
        with closing(_connect(source, end)) as incoming:
            incoming.execute("BEGIN")  # stable read snapshot while a WAL writer continues
            _retry_busy(lambda: school.check_metadata(incoming), end)
            with closing(sqlite3.connect(database)) as outgoing:
                incoming.backup(outgoing, pages=BACKUP_PAGES,
                                progress=lambda *_: _deadline(end), sleep=0.01)
                outgoing.execute("PRAGMA journal_mode=DELETE")
                outgoing.commit()
        require(_identity(_regular(source)) == identity, "source replaced during backup")
        _sidecars(source, source=True)
        _sidecars(database)
        with database.open("r+b") as stream:  # Windows fsync requires a writable fd; this is our private candidate.
            os.fsync(stream.fileno())
        manifest = {"format": "school-source-backup", "format_version": 1, "synthetic": True,
                    "schema_version": 3, "created_at": datetime.now(timezone.utc).isoformat(),
                    "database_sha256": _digest(database, end), **_inspect(database, end)}
        school.write_json(staging / "manifest.json", manifest)
        _verify(staging, end)
        return _publish(staging, destination, end) if apply else manifest


def restore_backup(generation, destination, *, apply=False):
    """Validate bytes in a separate candidate, then exclusively claim a new DB path."""
    require(type(apply) is bool, "apply must be a boolean")
    end = time.monotonic() + TIMEOUT_SECONDS
    generation = _path(generation)
    manifest = _verify(generation, end)
    destination = _absent(destination)
    _sidecars(destination)
    # Apply stages on the same filesystem for an atomic, non-replacing hard link.
    # Remove the staging link before checking the resulting standalone file.
    with tempfile.TemporaryDirectory(prefix="school-restore-", dir=destination.parent if apply else None) as temporary:
        candidate = Path(temporary) / "candidate.sqlite"
        _copy_new(generation / "database.sqlite", candidate, end)
        _verify_database(candidate, manifest, end)
        require(_verify(generation, end) == manifest, "source generation changed during restore")
        if not apply:
            return manifest
        _absent(destination)
        _sidecars(destination)
        identity = _identity(candidate)
        try:
            os.link(candidate, destination)  # EEXIST fails; never replaces a file.
            candidate.unlink()
            _verify_database(destination, manifest, end)
        except BaseException:
            # Also handles interruption immediately after link() succeeds, before
            # the next Python statement. A competing file has a different identity.
            candidate.unlink(missing_ok=True)
            _remove_own(destination, identity)
            raise
    return manifest
