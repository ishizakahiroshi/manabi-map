"""Synthetic source transactions and replay; all databases are outside the repo."""

from contextlib import closing, redirect_stdout
from concurrent.futures import ThreadPoolExecutor
import copy
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
from types import SimpleNamespace
import unittest

from school_fixture import synthetic_payload
from school_source_apply import SourceAdapter
import store
import store_school as school


class SourceApplyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="synthetic-source-apply-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.path = self.root / "source.sqlite"
        self.payload = synthetic_payload()
        self.seed()
        self.adapter = SourceAdapter(self.path, synthetic=True)
        self.base = self.adapter.generation()
        row = self.payload["tables"]["school_deviation_values"][0]
        self.change = {"school_id": row["school_id"], "department_id": row["department_id"],
                       "field": "deviation_value", "value": 61}

    def seed(self):
        payload = {**self.payload, "tables": school.normalize_tables(self.payload["tables"])}
        with closing(store.connect(self.path)) as db:
            school.import_rows(db, payload, fresh=not self.path.exists() or self.path.stat().st_size == 0)

    def rows(self):
        with closing(store.connect(self.path, readonly=True)) as db:
            return [dict(r) for r in db.execute("SELECT * FROM school_deviation_values ORDER BY id")]

    def apply(self, request_id="synthetic-request-1", changes=None, base=None, **kwargs):
        return self.adapter.apply(request_id, self.base if base is None else base,
                                  [self.change] if changes is None else changes, **kwargs)

    def test_preview_readonly_apply_export_content_identity_and_restart(self):
        before = self.path.read_bytes()
        preview = self.adapter.preview("synthetic-request-1", self.base, [self.change])
        self.assertEqual(before, self.path.read_bytes())
        self.assertIsNone(self.adapter.read_receipt("synthetic-request-1"))
        receipt = self.apply()
        self.assertEqual(preview, receipt)
        self.assertEqual(receipt["before_values"], [50])
        self.assertEqual(self.rows()[0]["value"], 61)
        self.assertEqual(receipt["target"], self.adapter.generation())
        self.assertEqual(receipt["target"]["dataset_version"], "synthetic-applied-" + receipt["source_content_sha256"])
        restarted = SourceAdapter(self.path, synthetic=True)
        self.assertEqual(receipt, restarted.verify_receipt("synthetic-request-1", self.base, [self.change]))
        self.assertEqual(receipt, self.apply())
        bundle = self.root / "bundle"
        with redirect_stdout(io.StringIO()):
            school.export_command(SimpleNamespace(db=self.path, output=bundle))
        snapshot, manifest = school.verify_bundle(bundle)
        self.assertEqual(manifest["content_sha256"], receipt["target"]["snapshot_content_sha256"])
        self.assertEqual(snapshot["tables"]["school_deviation_values"][0]["value"], 61)
        self.assertNotIn("source_apply_receipts", snapshot["tables"])

    def test_same_content_derives_same_versions_independent_of_request_id(self):
        a = self.adapter.preview("synthetic-a", self.base, [self.change])
        b = self.adapter.preview("synthetic-b", self.base, [self.change])
        self.assertEqual(a["target"], b["target"])
        self.assertEqual(a["source_content_sha256"], b["source_content_sha256"])
        self.assertNotEqual(a["request_sha256"], b["request_sha256"])

    def test_wrong_expected_version_and_hash_fail_without_change(self):
        before = self.path.read_bytes()
        for base in ({**self.base, "dataset_version": "stale"},
                     {**self.base, "snapshot_content_sha256": "0" * 64},
                     {**self.base, "source_content_sha256": "0" * 64}):
            with self.assertRaises(store.InputError):
                self.apply(base=base)
        self.assertEqual(before, self.path.read_bytes())

    def test_only_explicit_external_synthetic_source_is_accepted(self):
        with self.assertRaises(store.InputError):
            SourceAdapter(self.path)
        foreign = self.root / "foreign.sqlite"
        with closing(sqlite3.connect(foreign)) as db:
            db.execute("CREATE TABLE private_records(id INTEGER)")
        before = foreign.read_bytes()
        with self.assertRaises(store.InputError):
            SourceAdapter(foreign, synthetic=True)
        self.assertEqual(before, foreign.read_bytes())
        with self.assertRaises((store.InputError, FileNotFoundError)):
            SourceAdapter(self.root / "missing.sqlite", synthetic=True)

    def test_bad_values_fields_and_duplicate_targets_rejected(self):
        bad_changes = [[{**self.change, "value": value}] for value in (None, True, 1.5, "61", -1, 101)]
        bad_changes += [[{**self.change, "field": "name"}], [{**self.change, "extra": "unknown"}],
                        [self.change, self.change], [], [{**self.change, "value": 50}]]
        before = self.path.read_bytes()
        for changes in bad_changes:
            with self.subTest(changes=changes), self.assertRaises(store.InputError):
                self.apply(changes=changes)
        self.assertEqual(before, self.path.read_bytes())

    def test_unknown_school_wrong_department_and_null_is_not_wildcard(self):
        other = self.payload["tables"]["schools"][1]["id"]
        invalid = [{**self.change, "school_id": other}, {**self.change, "department_id": None},
                   {**self.change, "school_id": "99999999-9999-4999-8999-999999999999"}]
        before = self.path.read_bytes()
        for change in invalid:
            with self.assertRaises(store.InputError):
                self.apply(changes=[change])
        self.assertEqual(before, self.path.read_bytes())

    def test_null_department_changes_only_unique_school_level(self):
        row = copy.deepcopy(self.payload["tables"]["school_deviation_values"][0])
        row.update(id="99999999-9999-4999-8999-999999999991", department_id=None, value=40)
        self.payload["tables"]["school_deviation_values"].append(row)
        self.seed()
        self.base = self.adapter.generation()
        receipt = self.apply(changes=[{**self.change, "department_id": None}])
        self.assertEqual(receipt["before_values"], [40])
        self.assertEqual([row["value"] for row in self.rows()], [50, 61])

    def test_ambiguous_active_rows_rejected(self):
        self.payload["tables"]["school_deviation_values"][0]["department_id"] = None
        row = copy.deepcopy(self.payload["tables"]["school_deviation_values"][0])
        row.update(id="99999999-9999-4999-8999-999999999991", year=2025)
        self.payload["tables"]["school_deviation_values"].append(row)
        self.seed()
        self.base = self.adapter.generation()
        with self.assertRaises(store.InputError):
            self.apply(changes=[{**self.change, "department_id": None}])

    def test_late_multi_change_failure_rolls_back_first_change(self):
        before = self.path.read_bytes()
        changes = [self.change, {**self.change, "department_id": None}]
        with self.assertRaises(store.InputError):
            self.apply(changes=changes)
        self.assertEqual(before, self.path.read_bytes())
        self.assertEqual(self.base, self.adapter.generation())
        self.assertIsNone(self.adapter.read_receipt("synthetic-request-1"))

    def test_multiple_valid_changes_commit_together(self):
        row = copy.deepcopy(self.payload["tables"]["school_deviation_values"][0])
        row.update(id="99999999-9999-4999-8999-999999999991", department_id=None, value=40)
        self.payload["tables"]["school_deviation_values"].append(row)
        self.seed()
        self.base = self.adapter.generation()
        receipt = self.apply(changes=[self.change, {**self.change, "department_id": None, "value": 62}])
        self.assertEqual(receipt["before_values"], [50, 40])
        self.assertEqual([row["value"] for row in self.rows()], [61, 62])

    def test_stop_before_source_commit_rolls_back_receipt_and_values(self):
        before = self.path.read_bytes()
        with self.assertRaises(RuntimeError):
            self.apply(fail_at="before_commit")
        self.assertEqual(before, self.path.read_bytes())
        self.assertIsNone(self.adapter.read_receipt("synthetic-request-1"))
        self.assertEqual(self.base, self.adapter.generation())
        self.apply()

    def test_stop_after_source_commit_resumes_exactly_once(self):
        with self.assertRaises(RuntimeError):
            self.apply(fail_at="after_commit")
        restarted = SourceAdapter(self.path, synthetic=True)
        receipt = restarted.read_receipt("synthetic-request-1")
        self.assertEqual(receipt, self.apply())
        self.assertEqual(receipt["before_values"], [50])
        with closing(store.connect(self.path, readonly=True)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM source_apply_receipts").fetchone()[0], 1)

    def test_reused_id_different_payload_and_stale_receipt_rejected(self):
        first = self.apply()
        with self.assertRaises(store.InputError):
            self.apply(changes=[{**self.change, "value": 62}])
        self.apply("synthetic-next", changes=[{**self.change, "value": 62}], base=first["target"])
        self.assertEqual(first, self.adapter.read_receipt("synthetic-request-1"))
        with self.assertRaises(store.InputError):
            self.adapter.verify_receipt("synthetic-request-1", self.base, [self.change])
        with self.assertRaises(store.InputError):
            self.apply()

    def test_nonprojected_source_mutation_invalidates_receipt(self):
        receipt = self.apply()
        with closing(store.connect(self.path)) as db:
            db.execute("UPDATE school_deviation_values SET note='synthetic changed private note'")
        current = self.adapter.generation()
        self.assertEqual(receipt["target"]["snapshot_content_sha256"], current["snapshot_content_sha256"])
        self.assertNotEqual(receipt["target"]["source_content_sha256"], current["source_content_sha256"])
        with self.assertRaises(store.InputError):
            self.adapter.verify_receipt("synthetic-request-1", self.base, [self.change])

    def test_first_apply_rejects_nonprojected_mutation_with_unchanged_public_snapshot(self):
        with closing(store.connect(self.path)) as db:
            db.execute("UPDATE school_deviation_values SET note='synthetic first apply conflict'")
        current = self.adapter.generation()
        self.assertEqual(self.base["dataset_version"], current["dataset_version"])
        self.assertEqual(self.base["snapshot_content_sha256"], current["snapshot_content_sha256"])
        self.assertNotEqual(self.base["source_content_sha256"], current["source_content_sha256"])
        before = self.path.read_bytes()
        for operation in (self.adapter.preview, self.adapter.apply, self.adapter.cancel):
            with self.assertRaisesRegex(store.InputError, "CAS mismatch"):
                operation("synthetic-request-1", self.base, [self.change])
        self.assertEqual(before, self.path.read_bytes())

    def test_generation_covers_all_25_tables_and_excludes_receipt_and_metadata(self):
        with closing(store.connect(self.path, readonly=True)) as db:
            expected = {table: [school.decode_row(table, row) for row in db.execute(
                f"SELECT * FROM {table} ORDER BY {', '.join(school.KEYS[table])}")]
                for table in school.TABLES}
        self.assertEqual(len(expected), 25)
        self.assertEqual(self.base["source_content_sha256"], school.content_hash(expected))
        self.adapter.cancel("synthetic-cancel", self.base, [self.change])
        self.assertEqual(self.base, self.adapter.generation())
        with closing(store.connect(self.path)) as db:
            db.execute("UPDATE source_metadata SET source_version='synthetic-metadata-only'")
        self.assertEqual(self.base["source_content_sha256"], self.adapter.generation()["source_content_sha256"])

    def test_old_missing_extra_or_invalid_generation_is_never_upgraded(self):
        cases = [{k: v for k, v in self.base.items() if k != "source_content_sha256"},
                 {**self.base, "source_content_sha256": None}, {**self.base, "extra": True}]
        for base in cases:
            for operation in (self.adapter.preview, self.adapter.apply, self.adapter.cancel, self.adapter.verify_receipt):
                with self.subTest(base=base, operation=operation.__name__), self.assertRaises(store.InputError):
                    operation("synthetic-request-1", base, [self.change])

    def test_two_concurrent_applications_of_same_base_have_exactly_one_winner(self):
        barrier = threading.Barrier(2)
        def run(number):
            adapter = SourceAdapter(self.path, synthetic=True)
            barrier.wait(timeout=10)
            try:
                return adapter.apply(f"synthetic-race-{number}", self.base, [{**self.change, "value": 61 + number}])
            except store.InputError as error:
                return str(error)
        with ThreadPoolExecutor(max_workers=2) as workers:
            results = list(workers.map(run, (0, 1)))
        successes = [result for result in results if isinstance(result, dict)]
        failures = [result for result in results if isinstance(result, str)]
        self.assertEqual(len(successes), 1)
        self.assertEqual(len(failures), 1)
        self.assertIn("CAS mismatch", failures[0])
        self.assertEqual(successes[0]["target"], self.adapter.generation())

    def test_cancel_stops_rollback_or_replay_tombstone_without_applying_values(self):
        with self.assertRaises(RuntimeError):
            self.adapter.cancel("synthetic-request-1", self.base, [self.change], fail_at="before_commit")
        self.assertIsNone(self.adapter.read_cancellation("synthetic-request-1"))
        with self.assertRaises(RuntimeError):
            self.adapter.cancel("synthetic-request-1", self.base, [self.change], fail_at="after_commit")
        restarted = SourceAdapter(self.path, synthetic=True)
        receipt = restarted.read_cancellation("synthetic-request-1")
        self.assertEqual(receipt, restarted.cancel("synthetic-request-1", self.base, [self.change]))
        self.assertEqual(self.rows()[0]["value"], 50)
        with self.assertRaisesRegex(store.InputError, "cancelled"):
            self.apply()

    def test_cancellation_success_replay_requires_current_tip(self):
        self.adapter.cancel("synthetic-request-1", self.base, [self.change])
        self.apply("synthetic-next")
        with self.assertRaisesRegex(store.InputError, "tip differs"):
            self.adapter.cancel("synthetic-request-1", self.base, [self.change])

    def test_cancel_tombstone_blocks_delayed_apply_and_is_replayable(self):
        cancellation = self.adapter.cancel("synthetic-request-1", self.base, [self.change])
        self.assertEqual(cancellation["outcome"], "cancelled")
        self.assertEqual(self.base, self.adapter.generation())
        self.assertIsNone(self.adapter.read_receipt("synthetic-request-1"))
        self.assertEqual(cancellation, self.adapter.read_cancellation("synthetic-request-1"))
        self.assertEqual(cancellation, self.adapter.cancel("synthetic-request-1", self.base, [self.change]))
        with self.assertRaises(store.InputError):
            self.apply()
        with self.assertRaises(store.InputError):
            self.adapter.cancel("synthetic-request-1", self.base, [{**self.change, "value": 62}])
        self.apply("synthetic-different-request")
        with self.assertRaises(store.InputError):
            self.apply()

    def test_cannot_cancel_applied_request(self):
        self.apply()
        with self.assertRaises(store.InputError):
            self.adapter.cancel("synthetic-request-1", self.base, [self.change])

    def test_malformed_receipt_table_is_not_exportable(self):
        with closing(store.connect(self.path)) as db:
            db.execute("CREATE TABLE source_apply_receipts(request_id TEXT, request_sha256 TEXT, document TEXT)")
        with self.assertRaises(store.InputError):
            self.adapter.generation()


if __name__ == "__main__":
    unittest.main()
