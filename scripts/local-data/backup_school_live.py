"""Explicit local school SQLite backup; no import, publication or transport.

Accepts the existing core/schema-2 or full/schema-3 physical school contracts.
It preserves metadata as stored, including synthetic purpose markers; it does
not turn a synthetic export into a live source. Source and its parent directories
must remain caller-owned throughout the operation. SQLite may use existing WAL
sidecars for locking, but this module never writes SQL to the source database.
The returned artifact contains the complete private source, NOT public JSON.
"""

from contextlib import closing
from datetime import datetime, timezone
import hashlib
import gzip
import math
import os
from pathlib import Path
import sqlite3
import stat
import tempfile
import time
import zlib

from restore_transport import DEFAULT_MAX_BYTES
from restore_transport_adapters import AgeCodec
import store_core
import store_school

MAX_SOURCE_BYTES = 256 * 1024 * 1024
CHUNK_BYTES = 64 * 1024


class SchoolBackupError(ValueError):
    """Sanitized local backup failure; no source paths or row values."""


def _require(condition, message):
    if not condition:
        raise SchoolBackupError(message)


def _remaining(deadline):
    remaining = deadline - time.monotonic()
    _require(remaining > 0, "school backup deadline exceeded")
    return remaining


def _source_path(source):
    path = Path(source)
    _require(path.is_absolute() and not str(path).startswith(("\\\\", "//")),
             "explicit absolute local school source required")
    for item in (path, *path.parents):
        info = item.lstat()
        _require(not stat.S_ISLNK(info.st_mode) and
                 not (getattr(info, "st_file_attributes", 0) & 0x400),
                 "school source links are unsupported")
    info = path.stat()
    _require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
             "school source must be a regular unaliased file")
    return path, (info.st_dev, info.st_ino)


def _descriptor(db, table):
    # Names come exclusively from our fixed schema, never source SQL/text.
    return (list(db.execute(f'PRAGMA table_xinfo("{table}")')),
            list(db.execute(f'PRAGMA foreign_key_list("{table}")')),
            next(tuple(row[2:]) for row in db.execute("PRAGMA table_list")
                 if row[1] == table))


def _inspect(db, deadline):
    db.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
    _require(db.execute("PRAGMA integrity_check").fetchall() == [("ok",)],
             "school snapshot integrity check failed")
    _require(db.execute("PRAGMA foreign_key_check").fetchone() is None,
             "school snapshot foreign key check failed")
    _require(db.execute("SELECT 1 FROM sqlite_master WHERE type IN ('view','trigger') LIMIT 1").fetchone() is None,
             "school snapshot contains unsupported schema objects")
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    core_tables, full_tables = set(store_core.TABLES), set(store_school.TABLES)
    if tables == core_tables | {"source_metadata"}:
        version, names = 2, core_tables
    elif tables in (full_tables | {"source_metadata"},
                    full_tables | {"source_metadata", "source_apply_receipts"}):
        version, names = 3, full_tables
    else:
        raise SchoolBackupError("unsupported school table inventory")
    with closing(sqlite3.connect(":memory:")) as expected:
        for filename in (("schema-core.sql",) if version == 2 else
                         ("schema-core.sql", "schema-history.sql", "schema-admission.sql")):
            expected.executescript(Path(__file__).with_name(filename).read_text(encoding="utf-8"))
        if version == 3:
            expected.execute("ALTER TABLE source_metadata ADD COLUMN source_version TEXT NOT NULL")
        if "source_apply_receipts" in tables:
            expected.execute("CREATE TABLE source_apply_receipts (request_id TEXT PRIMARY KEY NOT NULL, "
                             "request_sha256 TEXT NOT NULL, document TEXT NOT NULL) STRICT")
        for table in sorted(tables):
            _require(_descriptor(db, table) == _descriptor(expected, table),
                     "school schema differs from supported contract")
    rows = db.execute("SELECT * FROM source_metadata").fetchmany(2)
    _require(len(rows) == 1 and rows[0][0:2] == (1, version) and
             all(type(value) is str and 0 < len(value.strip()) <= 1024 for value in rows[0][2:]),
             "invalid school source metadata")
    counts = {table: db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
              for table in sorted(tables)}
    _require(counts["schools"] > 0, "school source has no imported schools")
    _remaining(deadline)
    return version, counts


def _limits(max_bytes, source_max_bytes, timeout_seconds):
    _require(type(max_bytes) is int and 0 < max_bytes <= DEFAULT_MAX_BYTES,
             "invalid school backup byte limit")
    _require(type(source_max_bytes) is int and 0 < source_max_bytes <= MAX_SOURCE_BYTES,
             "invalid school source byte limit")
    _require(type(timeout_seconds) in (int, float) and math.isfinite(timeout_seconds)
             and 0 < timeout_seconds <= 300, "invalid school backup deadline")
    return time.monotonic() + timeout_seconds


def _compress_snapshot(snapshot, compressed, source_max_bytes, max_bytes, deadline):
    digest, count = hashlib.sha256(), 0
    with snapshot.open("rb") as source, compressed.open("xb") as target:
        with gzip.GzipFile(filename="", mode="wb", fileobj=target, compresslevel=6, mtime=0) as encoder:
            while chunk := source.read(CHUNK_BYTES):
                _remaining(deadline)
                count += len(chunk)
                _require(count <= source_max_bytes, "school snapshot size exceeds limit")
                digest.update(chunk)
                encoder.write(chunk)
                _require(target.tell() <= max_bytes, "compressed school snapshot exceeds limit")
        target.flush()
        os.fsync(target.fileno())
        _require(0 < count and target.tell() <= max_bytes, "compressed school snapshot exceeds limit")
    _remaining(deadline)
    return digest.hexdigest(), count


def prepare_school_backup(source, *, age_executable, recipient,
                          max_bytes=DEFAULT_MAX_BYTES, source_max_bytes=DEFAULT_MAX_BYTES,
                          timeout_seconds=120):
    """Return age-encrypted SQLite bytes and non-row metadata, or fail closed.

    source_max_bytes bounds the full SQLite snapshot (default 64, at most 256
    MiB). max_bytes bounds gzip bytes AND ciphertext (at most 64 MiB), preserving
    the AgeCodec contract. source_sha256/source_bytes describe expanded SQLite.
    Encryption overhead also counts. A complete
    operation shares one monotonic deadline (maximum 300 seconds). Synchronous
    OS I/O cannot be forcibly cancelled; late results are always rejected.
    """
    deadline = _limits(max_bytes, source_max_bytes, timeout_seconds)
    try:
        path, identity = _source_path(source)
        _require(0 < path.stat().st_size <= source_max_bytes, "school source size exceeds limit")
        for suffix in ("-wal", "-shm", "-journal"):
            sidecar = Path(str(path) + suffix)
            if sidecar.exists() or sidecar.is_symlink():
                _source_path(sidecar)
        # Missing SHM can cause SQLite to create it even on a read-only WAL open.
        _require(not Path(str(path) + "-wal").exists() or Path(str(path) + "-shm").is_file(),
                 "school WAL source requires existing shared-memory sidecar")
        with tempfile.TemporaryDirectory(prefix="school-backup-") as temporary:
            snapshot = Path(temporary) / "snapshot.sqlite"
            # Validate explicit encryption config before opening a source.
            AgeCodec(executable=age_executable, recipient=recipient, workspace=temporary,
                     max_bytes=max_bytes, timeout_seconds=min(300, _remaining(deadline)))
            with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0)) as original:
                original.execute("PRAGMA query_only=ON")
                original.execute("PRAGMA trusted_schema=OFF")
                _require(_source_path(path)[1] == identity, "school source identity changed")
                page_size = original.execute("PRAGMA page_size").fetchone()[0]

                def progress(status, remaining, total):
                    _remaining(deadline)
                    _require(total * page_size <= source_max_bytes, "school snapshot size exceeds limit")

                with closing(sqlite3.connect(snapshot)) as copied:
                    original.backup(copied, pages=128, progress=progress, sleep=0.01)
                    copied.execute("PRAGMA query_only=ON")
                    copied.execute("PRAGMA trusted_schema=OFF")
                    _remaining(deadline)
                    version, counts = _inspect(copied, deadline)
            _require(_source_path(path)[1] == identity, "school source identity changed")
            compressed = Path(temporary) / "snapshot.sqlite.gz"
            source_hash, source_bytes = _compress_snapshot(
                snapshot, compressed, source_max_bytes, max_bytes, deadline)
            with compressed.open("rb") as stream:
                encoded = stream.read(max_bytes + 1)
            _require(0 < len(encoded) <= max_bytes, "compressed school snapshot exceeds limit")
            codec = AgeCodec(executable=age_executable, recipient=recipient, workspace=temporary,
                             max_bytes=max_bytes, timeout_seconds=min(300, _remaining(deadline)))
            ciphertext = codec.encrypt(encoded)
            _require(type(ciphertext) is bytes and 0 < len(ciphertext) <= max_bytes
                     and ciphertext.startswith(b"age-encryption.org/v1\n"),
                     "invalid school backup encrypted output")
            metadata = {"format": "school-sqlite-gzip-age-v1", "compression": "gzip",
                        "source_sha256": source_hash, "source_bytes": source_bytes,
                        "ciphertext_sha256": hashlib.sha256(ciphertext).hexdigest(),
                        "ciphertext_bytes": len(ciphertext), "schema_version": version,
                        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                        "table_counts": counts}
            _remaining(deadline)
            return ciphertext, metadata
    except SchoolBackupError:
        raise
    except Exception:
        raise SchoolBackupError("school snapshot or encryption failed") from None


def _destination(destination):
    path = Path(destination)
    _require(path.is_absolute() and path.parent != path and ".." not in path.parts
             and not str(path).startswith(("\\\\", "//")), "new absolute local destination required")
    for parent in path.parents:
        info = parent.lstat()
        _require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
                 and not (getattr(info, "st_file_attributes", 0) & 0x400), "linked destination forbidden")
    _require(not any(os.path.lexists(Path(str(path) + suffix)) for suffix in ("", "-wal", "-shm", "-journal")),
             "restore destination or sidecar already exists")
    info = path.parent.stat()
    return path, (info.st_dev, info.st_ino)


def _expand_snapshot(encoded, snapshot, compression, maximum, deadline):
    digest, count = hashlib.sha256(), 0
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS) if compression == "gzip" else None
    with snapshot.open("xb") as target:
        for offset in range(0, len(encoded), CHUNK_BYTES):
            pending = encoded[offset:offset + CHUNK_BYTES]
            while pending:
                _remaining(deadline)
                if decoder is not None:
                    _require(not decoder.eof, "trailing or multiple gzip members rejected")
                    chunk = decoder.decompress(pending, min(CHUNK_BYTES, maximum - count + 1))
                    pending = decoder.unconsumed_tail
                    _require(not decoder.unused_data, "trailing or multiple gzip members rejected")
                else:
                    chunk, pending = pending, b""
                count += len(chunk)
                _require(count <= maximum, "expanded school snapshot exceeds limit")
                digest.update(chunk)
                target.write(chunk)
        _require(decoder is None or decoder.eof, "incomplete gzip snapshot")
        target.flush()
        os.fsync(target.fileno())
    _require(count > 0, "empty school snapshot")
    _remaining(deadline)
    return digest.hexdigest(), count


def restore_school_backup(ciphertext, metadata, destination, *, age_executable, recipient,
                          identity_path, apply=False, max_bytes=DEFAULT_MAX_BYTES,
                          source_max_bytes=DEFAULT_MAX_BYTES, timeout_seconds=120):
    """Verify age + old raw SQLite/new single-member gzip; publish create-only.

    Metadata must come from the caller's trusted backup receipt. Its hashes are
    integrity pins, not a signature or proof of provenance. Dry-run still fully
    decrypts/validates in owned TEMP but leaves no destination. No source DB or
    existing destination is modified. Identity is passed only to native age.
    """
    deadline = _limits(max_bytes, source_max_bytes, timeout_seconds)
    _require(type(apply) is bool, "explicit boolean apply required")
    try:
        output, parent_identity = _destination(destination)
        _require(type(ciphertext) is bytes and 0 < len(ciphertext) <= max_bytes
                 and ciphertext.startswith(b"age-encryption.org/v1\n"), "invalid encrypted school artifact")
        _require(type(metadata) is dict, "school backup metadata required")
        compression = metadata.get("compression")
        _require((metadata.get("format"), compression) in
                 (("school-sqlite-age-v1", "none"), ("school-sqlite-gzip-age-v1", "gzip")),
                 "unsupported school backup format")
        _require(type(metadata.get("ciphertext_bytes")) is int and metadata["ciphertext_bytes"] == len(ciphertext)
                 and metadata.get("ciphertext_sha256") == hashlib.sha256(ciphertext).hexdigest(),
                 "school ciphertext pin mismatch")
        expected_size = metadata.get("source_bytes")
        _require(type(expected_size) is int and 0 < expected_size <= source_max_bytes,
                 "invalid expanded school size")
        _require(type(metadata.get("schema_version")) is int and metadata["schema_version"] in (2, 3),
                 "unsupported school schema version")
        _require(type(metadata.get("table_counts")) is dict and
                 all(type(v) is int and v >= 0 for v in metadata["table_counts"].values()),
                 "invalid school row counts")
        with tempfile.TemporaryDirectory(prefix="school-artifact-restore-", dir=output.parent) as temporary:
            codec = AgeCodec(executable=age_executable, recipient=recipient, identity_path=identity_path,
                             workspace=temporary, max_bytes=max_bytes,
                             timeout_seconds=min(300, _remaining(deadline)))
            encoded = codec.decrypt(ciphertext)
            _require(type(encoded) is bytes and 0 < len(encoded) <= max_bytes, "invalid decrypted school size")
            snapshot = Path(temporary) / "snapshot.sqlite"
            digest, count = _expand_snapshot(encoded, snapshot, compression, expected_size, deadline)
            _require(count == expected_size and digest == metadata.get("source_sha256"), "school source pin mismatch")
            with snapshot.open("rb") as stream:
                _require(stream.read(16) == b"SQLite format 3\x00", "SQLite snapshot required")
            with closing(sqlite3.connect(snapshot.as_uri() + "?mode=ro", uri=True, timeout=0)) as db:
                db.execute("PRAGMA query_only=ON")
                db.execute("PRAGMA trusted_schema=OFF")
                version, counts = _inspect(db, deadline)
            _require(version == metadata["schema_version"] and counts == metadata["table_counts"],
                     "school restored contract differs")
            _remaining(deadline)
            if apply:
                _require(_destination(output)[1] == parent_identity, "destination parent changed")
                owned = snapshot.stat()
                try:
                    os.link(snapshot, output)
                    _remaining(deadline)
                except BaseException:
                    # Never delete a racing file belonging to another writer.
                    parent = output.parent.lstat()
                    if (parent.st_dev, parent.st_ino) == parent_identity and os.path.lexists(output):
                        actual = output.lstat()
                        if (actual.st_dev, actual.st_ino) == (owned.st_dev, owned.st_ino):
                            output.unlink()
                    raise
        return {"format": "school-artifact-restore-receipt", "mode": "applied" if apply else "dry-run",
                "source_sha256": digest, "source_bytes": count, "schema_version": version,
                "table_counts": counts}
    except SchoolBackupError:
        raise
    except Exception:
        raise SchoolBackupError("school artifact verification or restore failed") from None
