"""One owner-claimed correction -> live SQLite transaction and local receipt.

Offline only. The explicit input is NOT authentication: its controller must
obtain/validate the owner-only queue claim and the public-generation mapping.
No credentials, PG calls, queue ACK, generation, or publication occur here.
The source and parent must remain exclusively controlled throughout execution.
After an ambiguous commit, reconcile the receipt AND current tip before ACK.
Cancellation is a local tombstone after controller-confirmed withdrawal; an
already adopted change needs a new correction, never automatic source rollback.
"""

import argparse
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile

import school_live_source as live
import store
import store_school as school


FORMAT = "school-live-change-input"
RECEIPT_FORMAT = "school-live-change-receipt"
INPUT_MAX_BYTES = 64 * 1024
BODY = ("request_id", "kind", "school_id", "department_id", "new_value", "reason",
        "expected_generation", "expected_value", "submission_fingerprint")
BASE = {"dataset_version", "source_version", "source_content_sha256", "snapshot_content_sha256",
        "generator_snapshot_sha256"}
MUTATION = {"new_value_id", "applied_at", "dataset_version", "source_version"}
RECEIPT_KEYS = {"format", "format_version", "synthetic", "request_id", "request_sha256", "outcome",
                "base", "target", "value_id", "worker_code_sha256", "receipt_sha256"}
_IMPORTED_CODE = live._hash(Path(__file__).read_bytes())


class LiveApplyError(ValueError):
    """Sanitized failure; never expose a reason, private value, path or DB error."""


def _need(condition, message="live school correction rejected"):
    if not condition:
        raise LiveApplyError(message)


def _code():
    live._check_code()
    _need(live._hash(Path(__file__).read_bytes()) == _IMPORTED_CODE, "worker source changed during operation")


def _timestamp(value):
    live.core.value_for_storage(value, "timestamp")
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    _need(result.tzinfo is not None)
    return result


def _lease(queue, *, active=True):
    _need(queue.get("state") in (("claimed", "adopted") if active else ("received", "claimed", "adopted", "blocked", "rejected")),
          "owner claim required")
    _need(type(queue.get("revision")) is int and queue["revision"] > 0)
    if active or queue.get("lease_token") is not None:
        store.uuid_value(queue.get("lease_token"), "lease_token")
    until = _timestamp(queue["lease_until"]) if queue.get("lease_until") is not None else None
    _need(not active or (until is not None and until > datetime.now(timezone.utc)), "owner claim expired")


def _input(path, pin, operation):
    raw = live._read(path, INPUT_MAX_BYTES)
    _need(live._sha(pin) and live._hash(raw) == pin, "input pin mismatch")
    value = live._json(raw)
    _need(type(value) is dict and set(value) == {"format", "format_version", "synthetic", "queue_request",
                                               "base", "mutation", "withdrawal_confirmed"})
    _need(value["format"] == FORMAT and type(value["format_version"]) is int
          and value["format_version"] == 1 and value["synthetic"] is False)
    _need(type(value["withdrawal_confirmed"]) is bool)
    queue, base, mutation = value["queue_request"], value["base"], value["mutation"]
    _need(type(queue) is dict and set(BODY) <= set(queue), "incomplete owner queue payload")
    _need(queue["kind"] == "deviation", "only deviation adoption is supported")
    for key in ("request_id", "school_id", "department_id"):
        store.uuid_value(queue[key], key)
    _need(type(queue["new_value"]) is int and 20 <= queue["new_value"] <= 80)
    _need(queue["expected_value"] is None or (type(queue["expected_value"]) is int
          and -(2 ** 31) <= queue["expected_value"] < 2 ** 31))
    reason = queue["reason"]
    _need(type(reason) is str and reason.strip() == reason and 4 <= len(reason) <= 500 and "\0" not in reason)
    _need(queue["submission_fingerprint"] is None or live._sha(queue["submission_fingerprint"]))
    _need(type(base) is dict and set(base) == BASE and type(mutation) is dict and set(mutation) == MUTATION)
    for name in ("source_content_sha256", "snapshot_content_sha256", "generator_snapshot_sha256"):
        _need(live._sha(base[name]))
    _need(queue["expected_generation"] == base["generator_snapshot_sha256"], "public generation mapping mismatch")
    _need(queue.get("claimed_source_sha256") == base["source_content_sha256"]
          or (operation != "adopt" and queue.get("claimed_source_sha256") is None), "claim source mapping mismatch")
    for pair in (base, mutation):
        for name in ("dataset_version", "source_version"):
            _need(type(pair[name]) is str and 0 < len(pair[name]) <= 256)
            live.core.value_for_storage(pair[name], "nonempty")
    _need(all(mutation[key] != base[key] for key in ("dataset_version", "source_version")), "new generation required")
    store.uuid_value(mutation["new_value_id"], "new_value_id")
    _timestamp(mutation["applied_at"])
    _lease(queue, active=operation == "adopt")
    # Lease/revision and cancellation decision may change on a retry. Only the
    # immutable request, reviewed mapping and fixed mutation determine identity.
    requested = school.content_hash({"request": {key: queue[key] for key in BODY},
                                     "base": base, "mutation": mutation})
    return value, requested


def _current(db, deadline, maximum):
    metadata = live._check(db, deadline, maximum)
    snapshot = {"format": "school-source-snapshot", "format_version": 1, "schema_version": 3,
                "synthetic": False, "dataset_version": metadata["dataset_version"],
                "source_version": metadata["source_version"], "tables": live._project(db)}
    result = {"dataset_version": metadata["dataset_version"], "source_version": metadata["source_version"],
              "source_content_sha256": live._full_hash(live._all_tables(db)),
              "snapshot_content_sha256": school.content_hash(snapshot)}
    live._remaining(deadline)
    return result


def _read_receipt(db, request_id, requested):
    if db.execute("SELECT 1 FROM sqlite_master WHERE name='source_apply_receipts' AND type='table'").fetchone() is None:
        return None
    row = db.execute("SELECT * FROM source_apply_receipts WHERE request_id=?", (request_id,)).fetchone()
    if row is None:
        return None
    _need(len(row["document"].encode("utf-8")) <= INPUT_MAX_BYTES, "receipt exceeds limit")
    receipt = live._json(row["document"])
    _need(type(receipt) is dict and set(receipt) == RECEIPT_KEYS)
    _need(receipt["format"] == RECEIPT_FORMAT and type(receipt["format_version"]) is int
          and receipt["format_version"] == 1 and receipt["synthetic"] is False)
    _need(receipt["request_id"] == request_id and receipt["request_sha256"] == row["request_sha256"] == requested,
          "request ID reused with different content")
    _need(receipt["outcome"] in ("adopted", "cancelled"))
    _need(live._sha(receipt["worker_code_sha256"]))
    _need(school.content_hash({key: value for key, value in receipt.items() if key != "receipt_sha256"})
          == receipt["receipt_sha256"], "receipt hash mismatch")
    return receipt


def _save(db, receipt):
    if db.execute("SELECT 1 FROM sqlite_master WHERE name='source_apply_receipts' AND type='table'").fetchone() is None:
        db.execute(live.LIVE_RECEIPT_SQL)
    raw = school.canonical_json(receipt)
    _need(len(raw.encode("utf-8")) <= INPUT_MAX_BYTES)
    db.execute("INSERT INTO source_apply_receipts VALUES (?,?,?)",
               (receipt["request_id"], receipt["request_sha256"], raw))


def _transaction(db, envelope, requested, operation, deadline, maximum):
    queue, base, mutation = envelope["queue_request"], envelope["base"], envelope["mutation"]
    current = _current(db, deadline, maximum)
    if operation != "reconcile":
        _need(envelope["withdrawal_confirmed"] == (operation == "cancel"), "withdrawal decision differs")
    prior = _read_receipt(db, queue["request_id"], requested)
    if prior is not None:
        _need(prior["base"] == {key: value for key, value in base.items() if key != "generator_snapshot_sha256"},
              "receipt base differs")
        _need(prior["target"] == current, "receipt is not current source tip; reconciliation required")
        if prior["outcome"] == "adopted":
            _need(all(current[key] == mutation[key] for key in ("dataset_version", "source_version")))
            adopted = db.execute("SELECT value,note,estimate_method,estimate_basis,updated_at FROM school_deviation_values "
                                 "WHERE id=? AND school_id=? AND department_id=? AND is_active=1",
                                 (prior["value_id"], queue["school_id"], queue["department_id"])).fetchone()
            _need(adopted is not None and tuple(adopted) == (queue["new_value"], queue["reason"],
                  "admin_override_v1", "admin_override", mutation["applied_at"]), "adopted row differs")
            _need(queue.get("adopted_source_sha256") in (None, current["source_content_sha256"]))
        else:
            _need(prior["value_id"] is None)
        if operation == "reconcile":
            return prior
        wanted = "cancelled" if operation == "cancel" else "adopted"
        _need(prior["outcome"] == wanted, "request already adopted or cancelled; new correction required")
        return prior
    _need(operation != "reconcile", "source receipt not found")
    _need(queue["state"] == "claimed" or (operation == "cancel" and queue["state"] in ("received", "blocked", "rejected")),
          "adopted queue request has no source receipt")
    expected_base = {key: value for key, value in base.items() if key != "generator_snapshot_sha256"}
    if operation == "cancel":
        # This request has no adoption receipt. A tombstone at the CURRENT tip
        # stops late adoption even when unrelated edits caused the conflict.
        receipt = {"format": RECEIPT_FORMAT, "format_version": 1, "synthetic": False,
                   "request_id": queue["request_id"], "request_sha256": requested,
                   "outcome": "cancelled", "base": expected_base, "target": current,
                   "value_id": None, "worker_code_sha256": _IMPORTED_CODE}
        receipt["receipt_sha256"] = school.content_hash(receipt)
        _save(db, receipt)
        live._check(db, deadline, maximum)
        return receipt
    _need(current == expected_base, "full source or snapshot generation CAS mismatch")
    _need(db.execute("SELECT 1 FROM school_departments WHERE id=? AND school_id=?",
                     (queue["department_id"], queue["school_id"])).fetchone() is not None, "school department mismatch")
    old = db.execute("SELECT * FROM school_deviation_values WHERE department_id=? AND is_active=1",
                     (queue["department_id"],)).fetchmany(2)
    _need(len(old) <= 1 and (not old or old[0]["school_id"] == queue["school_id"]))
    _need((old[0]["value"] if old else None) == queue["expected_value"], "expected active value differs")
    value_id = old[0]["id"] if old else mutation["new_value_id"]
    if operation == "adopt":
        if old:
            db.execute("UPDATE school_deviation_values SET value=?,note=?,estimate_method='admin_override_v1',"
                       "estimate_basis='admin_override',updated_at=? WHERE id=?",
                       (queue["new_value"], queue["reason"], mutation["applied_at"], value_id))
        else:
            year = _timestamp(mutation["applied_at"]).astimezone(timezone(timedelta(hours=9))).year
            db.execute("INSERT INTO school_deviation_values "
                       "(id,school_id,department_id,value,year,source_type,estimate_method,note,is_active,created_at,updated_at,estimate_basis) "
                       "VALUES (?,?,?,?,?,'manabi_estimate','admin_override_v1',?,1,?,?,'admin_override')",
                       (value_id, queue["school_id"], queue["department_id"], queue["new_value"], year,
                        queue["reason"], mutation["applied_at"], mutation["applied_at"]))
        db.execute("UPDATE source_metadata SET dataset_version=?,source_version=? WHERE singleton=1",
                   (mutation["dataset_version"], mutation["source_version"]))
    target = _current(db, deadline, maximum)
    receipt = {"format": RECEIPT_FORMAT, "format_version": 1, "synthetic": False,
               "request_id": queue["request_id"], "request_sha256": requested,
               "outcome": "adopted" if operation == "adopt" else "cancelled", "base": current,
               "target": target, "value_id": value_id if operation == "adopt" else None,
               "worker_code_sha256": _IMPORTED_CODE}
    receipt["receipt_sha256"] = school.content_hash(receipt)
    _save(db, receipt)
    live._check(db, deadline, maximum)
    return receipt


def _source(path):
    source = live._path(path)
    for suffix in ("-wal", "-shm", "-journal"):
        sidecar = Path(str(source) + suffix)
        if os.path.lexists(sidecar):
            live._path(sidecar)
    _need(not Path(str(source) + "-wal").exists() or Path(str(source) + "-shm").is_file())
    return source


def process_request(source, request_path, *, input_sha256, operation="adopt", apply=False,
                    max_bytes=live.DEFAULT_MAX_BYTES, timeout_seconds=120):
    """Return a body-free local receipt; caller reconciles/ACKs the remote queue.

    base.generator_snapshot_sha256 is a controller-attested mapping from the
    published payload to base.snapshot_content_sha256 and full source hash. This
    worker verifies the latter two from SQLite; it cannot prove the HTTP payload
    or the remote claim/authentication. Neither receipt nor adoption is publish.
    """
    deadline = live._limits(max_bytes, timeout_seconds)
    _need(operation in ("adopt", "cancel", "reconcile") and type(apply) is bool)
    try:
        _code()
        envelope, requested = _input(request_path, input_sha256, operation)
        path = _source(source)
        identity, parent_identity = live._identity(path), live._identity(path.parent)
        _need(path.stat().st_size <= max_bytes)

        def run(db, *, commit):
            db.execute("BEGIN" if operation == "reconcile" else "BEGIN IMMEDIATE")
            try:
                receipt = _transaction(db, envelope, requested, operation, deadline, max_bytes)
                _code()
                _lease(envelope["queue_request"], active=operation == "adopt")
                live._remaining(deadline)
                _source(path)
                _need(live._identity(path) == identity and live._identity(path.parent) == parent_identity,
                      "source identity changed; reconciliation required")
                if commit:
                    db.commit()
                else:
                    db.rollback()
                live._remaining(deadline)
                return receipt
            except BaseException:
                db.rollback()
                raise

        if operation == "reconcile" or apply:
            with closing(live._connect(path, readonly=operation == "reconcile", deadline=deadline)) as db:
                receipt = run(db, commit=operation != "reconcile")
        else:
            with tempfile.TemporaryDirectory(prefix=".school-adoption-dryrun-", dir=path.parent) as temporary:
                stage = Path(temporary) / "source.sqlite"
                with stage.open("xb"):
                    pass
                with closing(live._connect(path, readonly=True, deadline=deadline)) as original, \
                     closing(live._connect(stage, deadline=deadline)) as target:
                    original.execute("BEGIN")
                    live._check(original, deadline, max_bytes)
                    def progress(_status, _remaining, total):
                        live._remaining(deadline)
                        _need(total * original.execute("PRAGMA page_size").fetchone()[0] <= max_bytes)
                    original.backup(target, pages=128, progress=progress, sleep=0)
                    receipt = run(target, commit=False)
        return {"mode": "reconciled" if operation == "reconcile" else "applied" if apply else "dry-run",
                "receipt": receipt}
    except LiveApplyError:
        raise
    except Exception:
        raise LiveApplyError("live school correction failed; reconcile any ambiguous commit") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("adopt", "cancel", "reconcile"))
    parser.add_argument("--source", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--input-sha256", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--max-bytes", type=int, default=live.DEFAULT_MAX_BYTES)
    parser.add_argument("--timeout-seconds", type=float, default=120)
    args = parser.parse_args()
    try:
        result = process_request(args.source, args.input, input_sha256=args.input_sha256,
                                 operation=args.operation, apply=args.apply,
                                 max_bytes=args.max_bytes, timeout_seconds=args.timeout_seconds)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (LiveApplyError, live.LiveSourceError):
        print("live school correction failed; reconcile any ambiguous commit", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
