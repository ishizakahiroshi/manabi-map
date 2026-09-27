"""Invented live envelopes and SQLite only; no remote DB/auth or real data."""

from contextlib import closing
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch

import school_live_apply as worker
import school_live_source as live
import store_school as school
from test_school_live_source import invented_capture


class LiveApplyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="invented-school-adoption-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.source, self.capture_path, self.request_path = (self.root / name for name in ("source.sqlite", "capture.json", "request.json"))
        self.capture = invented_capture()
        self.initialize()

    def initialize(self):
        raw = (school.canonical_json(self.capture) + "\n").encode()
        self.capture_path.write_bytes(raw)
        live.import_capture(self.capture_path, self.source, input_sha256=hashlib.sha256(raw).hexdigest(), apply=True)
        with closing(live._connect(self.source, readonly=True, deadline=time.monotonic() + 30)) as db:
            base = worker._current(db, time.monotonic() + 30, live.DEFAULT_MAX_BYTES)
        base["generator_snapshot_sha256"] = "a" * 64
        active = next((row for row in self.capture["tables"]["school_deviation_values"] if row["is_active"]), None)
        self.envelope = {"format": worker.FORMAT, "format_version": 1, "synthetic": False,
            "queue_request": {"request_id": "88888888-8888-4888-8888-888888888888", "kind": "deviation",
                "school_id": self.capture["tables"]["school_departments"][0]["school_id"],
                "department_id": self.capture["tables"]["school_departments"][0]["id"],
                "new_value": 61, "reason": "合成レビュー済み訂正", "expected_generation": "a" * 64,
                "expected_value": active["value"] if active else None, "submission_fingerprint": None,
                "state": "claimed", "revision": 1, "lease_token": "99999999-9999-4999-8999-999999999999",
                "lease_until": (datetime.now(timezone.utc) + timedelta(minutes=4)).isoformat(),
                "claimed_source_sha256": base["source_content_sha256"], "adopted_source_sha256": None},
            "base": base, "mutation": {"new_value_id": "77777777-7777-4777-8777-777777777777",
                "applied_at": "2025-12-31T16:00:00Z", "dataset_version": "invented-adopted-001",
                "source_version": "invented-adopted-source-001"}, "withdrawal_confirmed": False}

    def process(self, **options):
        raw = (school.canonical_json(self.envelope) + "\n").encode()
        self.request_path.write_bytes(raw)
        return worker.process_request(self.source, self.request_path, input_sha256=hashlib.sha256(raw).hexdigest(), **options)

    def rows(self):
        with closing(sqlite3.connect(self.source)) as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute("SELECT * FROM school_deviation_values ORDER BY id")]

    def test_dryrun_keeps_source_bytes_metadata_and_no_receipt(self):
        before, info = self.source.read_bytes(), self.source.stat()
        result = self.process()
        self.assertEqual(result["mode"], "dry-run")
        self.assertEqual(result["receipt"]["outcome"], "adopted")
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(self.source.stat().st_mtime_ns, info.st_mtime_ns)
        self.assertEqual({path.name for path in self.root.iterdir()}, {"source.sqlite", "capture.json", "request.json"})

    def test_existing_active_row_retains_identity_and_unmodified_fields_with_atomic_receipt(self):
        before = self.rows()[0]
        result = self.process(apply=True)
        after = self.rows()[0]
        changed = {"value", "note", "estimate_method", "estimate_basis", "updated_at"}
        self.assertEqual({k: v for k, v in before.items() if k not in changed},
                         {k: v for k, v in after.items() if k not in changed})
        self.assertEqual((after["value"], after["estimate_method"], after["estimate_basis"]), (61, "admin_override_v1", "admin_override"))
        self.assertNotEqual(result["receipt"]["target"]["source_content_sha256"], self.envelope["base"]["source_content_sha256"])
        self.assertNotIn(self.envelope["queue_request"]["reason"], json.dumps(result, ensure_ascii=False))
        bundle = self.root / "bundle"
        live.export_snapshot(self.source, bundle, expected_source_sha256=result["receipt"]["target"]["source_content_sha256"], apply=True)
        snapshot, manifest = live.verify_bundle(bundle)
        self.assertEqual(snapshot["tables"]["school_deviation_values"][0]["value"], 61)
        self.assertEqual(manifest["content_sha256"], result["receipt"]["target"]["snapshot_content_sha256"])
        self.assertNotIn("source_apply_receipts", snapshot["tables"])

    def test_missing_active_row_inserts_fixed_uuid_jst_year_and_keeps_inactive_history(self):
        # A new invented source path; never delete/overwrite a source to reset it.
        self.source = self.root / "inactive-source.sqlite"
        self.capture["tables"]["school_deviation_values"][0]["is_active"] = False
        self.initialize()
        before = self.rows()[0]
        self.process(apply=True)
        rows = self.rows()
        self.assertIn(before, rows)
        inserted = next(row for row in rows if row["is_active"])
        self.assertEqual(inserted["id"], self.envelope["mutation"]["new_value_id"])
        self.assertEqual(inserted["year"], 2026)
        self.assertEqual(inserted["source_type"], "manabi_estimate")

    def test_existing_pg_integer_outside_new_value_range_can_be_corrected(self):
        self.source = self.root / "historic-value-source.sqlite"
        self.capture["tables"]["school_deviation_values"][0]["value"] = 19
        self.initialize()
        self.assertEqual(self.envelope["queue_request"]["expected_value"], 19)
        self.process(apply=True)
        self.assertEqual(self.rows()[0]["value"], 61)

    def test_retry_after_new_claim_reconciles_same_receipt_without_second_adoption(self):
        first = self.process(apply=True)
        self.envelope["queue_request"]["revision"] = 2
        self.envelope["queue_request"]["lease_token"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        before = self.source.read_bytes()
        self.assertEqual(self.process(apply=True)["receipt"], first["receipt"])
        self.assertEqual(self.process(operation="reconcile")["receipt"], first["receipt"])
        self.assertEqual(self.source.read_bytes(), before)
        with closing(sqlite3.connect(self.source)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM source_apply_receipts").fetchone()[0], 1)

    def test_private_column_drift_and_old_receipt_at_new_tip_are_rejected(self):
        self.process(apply=True)
        with closing(sqlite3.connect(self.source)) as db:
            db.execute("UPDATE schools SET status_note='invented private drift'")
            db.commit()
        for options in ({"apply": True}, {"operation": "reconcile"}):
            with self.subTest(options=options), self.assertRaises(worker.LiveApplyError):
                self.process(**options)

    def test_readonly_reconciliation_after_expired_claim_is_not_new_adoption(self):
        first = self.process(apply=True)
        self.envelope["queue_request"]["lease_until"] = "2000-01-01T00:00:00Z"
        self.envelope["queue_request"]["state"] = "blocked"
        before = self.source.read_bytes()
        self.assertEqual(self.process(operation="reconcile")["receipt"], first["receipt"])
        with self.assertRaises(worker.LiveApplyError):
            self.process(apply=True)
        self.assertEqual(self.source.read_bytes(), before)

    def test_before_apply_fullhash_cas_even_for_nonprojected_column(self):
        with closing(sqlite3.connect(self.source)) as db:
            db.execute("UPDATE schools SET status_note='invented private drift'")
            db.commit()
        before = self.source.read_bytes()
        with self.assertRaises(worker.LiveApplyError):
            self.process(apply=True)
        self.assertEqual(self.source.read_bytes(), before)

    def test_invalid_value_membership_expected_value_and_generation_fail_closed(self):
        original = copy.deepcopy(self.envelope)
        changes = [("queue_request", "new_value", True), ("queue_request", "new_value", 19),
                   ("queue_request", "new_value", 81), ("queue_request", "expected_value", 49),
                   ("queue_request", "school_id", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
                   ("queue_request", "expected_generation", "b" * 64),
                   ("base", "snapshot_content_sha256", "b" * 64),
                   ("queue_request", "reason", "bad"), ("queue_request", "lease_until", "2000-01-01T00:00:00Z")]
        before = self.source.read_bytes()
        for part, key, value in changes:
            with self.subTest(key=key, value=value):
                self.envelope = copy.deepcopy(original)
                self.envelope[part][key] = value
                with self.assertRaises(worker.LiveApplyError):
                    self.process(apply=True)
                self.assertEqual(self.source.read_bytes(), before)

    def test_receipt_failure_rolls_back_all_source_changes(self):
        before = self.source.read_bytes()
        with patch.object(worker, "_save", side_effect=RuntimeError("invented failure")):
            with self.assertRaises(worker.LiveApplyError):
                self.process(apply=True)
        self.assertEqual(self.source.read_bytes(), before)
        with self.assertRaises(worker.LiveApplyError):
            self.process(operation="reconcile")

    def test_commit_response_failure_is_recovered_by_receipt_without_reapplying(self):
        connect = live._connect
        class AmbiguousConnection:
            def __init__(self, db): self.db = db
            def __getattr__(self, key): return getattr(self.db, key)
            def commit(self):
                self.db.commit()
                raise RuntimeError("invented lost completion")
        with patch.object(live, "_connect", side_effect=lambda *a, **k: AmbiguousConnection(connect(*a, **k))):
            with self.assertRaises(worker.LiveApplyError):
                self.process(apply=True)
        result = self.process(operation="reconcile")
        self.assertEqual(result["receipt"]["outcome"], "adopted")
        self.assertEqual(self.rows()[0]["value"], 61)

    def test_withdrawal_tombstone_prevents_delayed_adoption(self):
        self.envelope["withdrawal_confirmed"] = True
        cancelled = self.process(operation="cancel", apply=True)
        self.assertEqual(cancelled["receipt"]["base"], cancelled["receipt"]["target"])
        self.assertEqual(self.rows()[0]["value"], 50)
        self.envelope["withdrawal_confirmed"] = False
        with self.assertRaises(worker.LiveApplyError):
            self.process(apply=True)
        self.assertEqual(self.process(operation="reconcile")["receipt"]["outcome"], "cancelled")

    def test_cancel_after_adoption_requires_new_correction_and_never_unapplies(self):
        self.process(apply=True)
        before = self.source.read_bytes()
        self.envelope["withdrawal_confirmed"] = True
        with self.assertRaises(worker.LiveApplyError):
            self.process(operation="cancel", apply=True)
        self.assertEqual(self.source.read_bytes(), before)

    def test_blocked_without_lease_can_cancel_at_changed_current_tip(self):
        with closing(sqlite3.connect(self.source)) as db:
            db.execute("UPDATE schools SET status_note='invented later source edit'")
            db.commit()
        self.envelope["queue_request"].update(state="blocked", lease_until=None)
        self.envelope["withdrawal_confirmed"] = True
        receipt = self.process(operation="cancel", apply=True)["receipt"]
        self.assertNotEqual(receipt["base"]["source_content_sha256"], receipt["target"]["source_content_sha256"])
        self.assertEqual(self.process(operation="reconcile")["receipt"], receipt)
        self.assertEqual(self.rows()[0]["value"], 50)
        self.envelope["withdrawal_confirmed"] = False
        self.envelope["queue_request"].update(state="claimed", lease_until=(datetime.now(timezone.utc) + timedelta(minutes=4)).isoformat())
        with self.assertRaises(worker.LiveApplyError):
            self.process(apply=True)

    def test_blocked_adopted_request_cannot_be_cancelled_even_without_lease(self):
        self.process(apply=True)
        before = self.source.read_bytes()
        self.envelope["queue_request"].update(state="blocked", lease_until=None)
        self.envelope["withdrawal_confirmed"] = True
        with self.assertRaises(worker.LiveApplyError):
            self.process(operation="cancel", apply=True)
        self.assertEqual(self.source.read_bytes(), before)

    def test_expired_deadline_and_changed_request_body_do_not_mutate(self):
        self.process(apply=True)
        before = self.source.read_bytes()
        with self.assertRaises((worker.LiveApplyError, live.LiveSourceError)):
            self.process(apply=True, timeout_seconds=0.000001)
        self.envelope["queue_request"]["new_value"] = 62
        with self.assertRaises(worker.LiveApplyError):
            self.process(apply=True)
        self.assertEqual(self.source.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
