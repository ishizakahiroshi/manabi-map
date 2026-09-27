"""Apply only synthetic deviation projections to an external schema-3 scratch DB.

This is not authentication or a production correction policy. NULL department
means one school-level row, never every department. A unique active existing row
is required; year selection, inserts and other fields are deliberately absent.
The source transaction owns its receipt. A separate queue must verify it before
advancing; two SQLite files are never claimed to commit atomically.
"""

from contextlib import closing
import json
from pathlib import Path
import sqlite3

import school_id_index as index
import store
import store_school as school


FORMAT = "synthetic-school-source-apply-receipt"
REPO = Path(__file__).resolve().parents[2]
require = store.require
RECEIPT_FIELDS = {"format", "synthetic", "outcome", "request_id", "request_sha256", "base", "target",
                  "source_content_sha256", "source_version", "changes", "before_values", "receipt_sha256"}


def _generation(value):
    require(type(value) is dict and set(value) == {"dataset_version", "snapshot_content_sha256", "source_content_sha256"},
            "generation fields differ")
    _text(value["dataset_version"])
    index._hash(value["snapshot_content_sha256"])
    index._hash(value["source_content_sha256"])


def _text(value):
    require(type(value) is str and 0 < len(value) <= 200 and value.strip() == value,
            "bounded nonempty identifier required")


def _changes(changes):
    require(type(changes) is list and 0 < len(changes) <= 100, "bounded nonempty changes required")
    seen = set()
    for change in changes:
        require(type(change) is dict and set(change) == {"school_id", "department_id", "field", "value"},
                "unsupported change projection")
        store.uuid_value(change["school_id"], "school_id")
        if change["department_id"] is not None:
            store.uuid_value(change["department_id"], "department_id")
        require(change["field"] == "deviation_value", "unsupported synthetic field")
        require(type(change["value"]) is int and 0 <= change["value"] <= 100, "invalid correction value")
        key = (change["school_id"], change["department_id"])
        require(key not in seen, "duplicate change target")
        seen.add(key)


def _request(request_id, expected, changes):
    _text(request_id)
    _generation(expected)
    _changes(changes)
    return school.content_hash({"request_id": request_id, "expected": expected, "changes": changes})


def _source_hash(db):
    # Includes private/nonprojected columns but exports only the resulting hash.
    return school.content_hash({table: [school.decode_row(table, row) for row in db.execute(
        f"SELECT * FROM {table} ORDER BY {', '.join(school.KEYS[table])}")]
        for table in school.TABLES})


def _current(db):
    content, _ = school.snapshot_content(db)
    return {"dataset_version": content["dataset_version"], "snapshot_content_sha256": school.content_hash(content),
            "source_content_sha256": _source_hash(db)}


def _read_receipt(db, request_id):
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_apply_receipts'").fetchone() is None:
        return None
    row = db.execute("SELECT request_sha256, document FROM source_apply_receipts WHERE request_id=?", (request_id,)).fetchone()
    if row is None:
        return None
    receipt = json.loads(row["document"], object_pairs_hook=store.reject_duplicate_keys)
    require(type(receipt) is dict and set(receipt) == RECEIPT_FIELDS, "invalid receipt fields")
    require(receipt["format"] == FORMAT and receipt["synthetic"] is True and receipt["request_id"] == request_id,
            "invalid receipt purpose/request")
    require(receipt["outcome"] in ("applied", "cancelled"), "invalid receipt outcome")
    request_hash = _request(request_id, receipt["base"], receipt["changes"])
    require(row["request_sha256"] == receipt["request_sha256"] == request_hash, "receipt request hash mismatch")
    _generation(receipt["target"])
    index._hash(receipt["source_content_sha256"])
    require(receipt["target"]["source_content_sha256"] == receipt["source_content_sha256"],
            "receipt target full content hash mismatch")
    _text(receipt["source_version"])
    before = receipt["before_values"]
    require(type(before) is list and len(before) == (len(receipt["changes"]) if receipt["outcome"] == "applied" else 0)
            and all(type(v) is int and 0 <= v <= 100 for v in before), "invalid receipt before values")
    require(receipt["receipt_sha256"] == school.content_hash({k: v for k, v in receipt.items() if k != "receipt_sha256"}),
            "receipt hash mismatch")
    return receipt


def _verify_tip(db, receipt):
    require(_current(db) == receipt["target"], "source tip differs from receipt")
    require(_source_hash(db) == receipt["source_content_sha256"], "source full content differs from receipt")
    require(school.check_metadata(db)["source_version"] == receipt["source_version"], "source version differs from receipt")


class SourceAdapter:
    def __init__(self, path, *, synthetic=False):
        require(synthetic is True, "explicit synthetic declaration required")
        self.path = self._path(path)
        self.generation()  # Read-only validation before any write connection.

    @staticmethod
    def _path(path):
        path = index._path(path)
        require(not path.is_relative_to(REPO) and path.is_file(), "external regular scratch source required")
        return path

    def _connect(self, readonly=True):
        path = self._path(self.path)
        db = sqlite3.connect(path.as_uri() + ("?mode=ro" if readonly else "?mode=rw"), uri=True, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=5000")
        return db

    def generation(self):
        with closing(self._connect()) as db:
            db.execute("BEGIN")
            return _current(db)

    def read_receipt(self, request_id):
        _text(request_id)
        with closing(self._connect()) as db:
            db.execute("BEGIN")
            school.check_metadata(db)
            receipt = _read_receipt(db, request_id)
            return receipt if receipt is not None and receipt["outcome"] == "applied" else None

    def read_cancellation(self, request_id):
        _text(request_id)
        with closing(self._connect()) as db:
            db.execute("BEGIN")
            school.check_metadata(db)
            receipt = _read_receipt(db, request_id)
            return receipt if receipt is not None and receipt["outcome"] == "cancelled" else None

    def cancel(self, request_id, expected, changes, *, fail_at=None):
        """Persist a request tombstone so a delayed worker cannot apply it later."""
        requested = _request(request_id, expected, changes)
        require(fail_at in (None, "before_commit", "after_commit"), "unsupported failure injection")
        self.generation()
        with closing(self._connect(readonly=False)) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                school.check_metadata(db)
                existing = _read_receipt(db, request_id)
                if existing is not None:
                    require(existing["request_sha256"] == requested and existing["outcome"] == "cancelled",
                            "source request already applied or differs")
                    _verify_tip(db, existing)
                    return existing
                require(_current(db) == expected, "source generation CAS mismatch")
                receipt = {"format": FORMAT, "synthetic": True, "outcome": "cancelled", "request_id": request_id,
                           "request_sha256": requested, "base": expected, "target": expected,
                           "source_content_sha256": _source_hash(db),
                           "source_version": school.check_metadata(db)["source_version"],
                           "changes": changes, "before_values": []}
                receipt["receipt_sha256"] = school.content_hash(receipt)
                self._save_receipt(db, receipt)
                if fail_at == "before_commit":
                    raise RuntimeError("synthetic stop before source cancel commit")
                db.commit()
                if fail_at == "after_commit":
                    raise RuntimeError("synthetic stop after source cancel commit")
                return receipt
            except BaseException:
                db.rollback()
                raise

    def verify_receipt(self, request_id, expected, changes):
        requested = _request(request_id, expected, changes)
        with closing(self._connect()) as db:
            db.execute("BEGIN")
            school.check_metadata(db)
            receipt = _read_receipt(db, request_id)
            require(receipt is not None and receipt["outcome"] == "applied"
                    and receipt["request_sha256"] == requested, "source receipt request mismatch")
            _verify_tip(db, receipt)
            return receipt

    @staticmethod
    def _apply(db, request_id, expected, changes, requested):
        school.check_metadata(db)
        existing = _read_receipt(db, request_id)
        if existing is not None:
            require(existing["request_sha256"] == requested, "request ID reused with different content")
            require(existing["outcome"] == "applied", "source request was cancelled")
            _verify_tip(db, existing)
            return existing
        require(_current(db) == expected, "source generation CAS mismatch")
        before = []
        for change in changes:
            sid, did = change["school_id"], change["department_id"]
            require(db.execute("SELECT 1 FROM schools WHERE id=?", (sid,)).fetchone() is not None, "unknown school")
            if did is not None:
                require(db.execute("SELECT 1 FROM school_departments WHERE id=? AND school_id=?", (did, sid)).fetchone()
                        is not None, "department membership mismatch")
            rows = db.execute("SELECT id, value FROM school_deviation_values WHERE school_id=? AND department_id IS ? AND is_active=1",
                              (sid, did)).fetchall()
            require(len(rows) == 1, "exactly one active synthetic deviation row required")
            require(rows[0]["value"] != change["value"], "no-op changes are not adopted")
            before.append(rows[0]["value"])
            db.execute("UPDATE school_deviation_values SET value=? WHERE id=?", (change["value"], rows[0]["id"]))
        school.check_consistency(db)
        source_hash = _source_hash(db)
        source_version = "synthetic-source-" + source_hash
        db.execute("UPDATE source_metadata SET dataset_version=?, source_version=? WHERE singleton=1",
                   ("synthetic-applied-" + source_hash, source_version))
        receipt = {"format": FORMAT, "synthetic": True, "outcome": "applied", "request_id": request_id, "request_sha256": requested,
                   "base": expected, "target": _current(db), "source_content_sha256": source_hash,
                   "source_version": source_version, "changes": changes, "before_values": before}
        receipt["receipt_sha256"] = school.content_hash(receipt)
        SourceAdapter._save_receipt(db, receipt)
        return receipt

    @staticmethod
    def _save_receipt(db, receipt):
        db.execute("CREATE TABLE IF NOT EXISTS source_apply_receipts (request_id TEXT PRIMARY KEY NOT NULL, "
                   "request_sha256 TEXT NOT NULL, document TEXT NOT NULL) STRICT")
        db.execute("INSERT INTO source_apply_receipts VALUES(?,?,?)",
                   (receipt["request_id"], receipt["request_sha256"], school.canonical_json(receipt)))

    def preview(self, request_id, expected, changes):
        requested = _request(request_id, expected, changes)
        with closing(self._connect()) as source, closing(sqlite3.connect(":memory:", isolation_level=None)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            source.backup(db)
            db.execute("BEGIN IMMEDIATE")
            return self._apply(db, request_id, expected, changes, requested)

    def apply(self, request_id, expected, changes, *, fail_at=None):
        requested = _request(request_id, expected, changes)
        require(fail_at in (None, "before_commit", "after_commit"), "unsupported failure injection")
        self.generation()
        with closing(self._connect(readonly=False)) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                receipt = self._apply(db, request_id, expected, changes, requested)
                if fail_at == "before_commit":
                    raise RuntimeError("synthetic stop before source commit")
                db.commit()
            except BaseException:
                db.rollback()
                raise
        if fail_at == "after_commit":
            raise RuntimeError("synthetic stop after source commit")
        return receipt
