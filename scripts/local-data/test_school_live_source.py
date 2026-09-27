"""Invented captures only, in owned temp directories; no live DB or network."""

from contextlib import closing
import copy
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import school_live_source as live
from school_fixture import synthetic_payload
import store_school as school


def invented_capture():
    """false exercises the live envelope with entirely invented fixture values."""
    payload = synthetic_payload()
    return {"format": "school-live-source-capture", "format_version": 1, "schema_version": 3,
            "synthetic": False, "dataset_version": "invented-observation-001", "source_version": "invented-source-001",
            "captured_at": "2026-09-01T00:00:00Z", "consistency": live.CONSISTENCY,
            "columns": {table: list(columns) for table, columns in school.TABLES.items()},
            "tables": payload["tables"]}


class LiveSourceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="invented-live-source-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.input = self.root / "capture.json"
        self.db = self.root / "source.sqlite"
        self.output = self.root / "bundle"
        self.capture = invented_capture()
        self.pin = self.write_capture()

    def write_capture(self, value=None):
        raw = (school.canonical_json(self.capture if value is None else value) + "\n").encode("utf-8")
        self.input.write_bytes(raw)
        return hashlib.sha256(raw).hexdigest()

    def take(self, **options):
        return live.import_capture(self.input, self.db, input_sha256=self.pin, **options)

    def exported(self):
        receipt = self.take(apply=True)
        live.export_snapshot(self.db, self.output, expected_source_sha256=receipt["source_content_sha256"], apply=True)
        return receipt, live.verify_bundle(self.output)

    def test_full_roundtrip_exact_values_projection_and_legacy_guard(self):
        self.capture["tables"]["schools"][0]["latitude"] = Decimal("35.1234567")
        self.capture["tables"]["schools"][0]["longitude"] = Decimal("139.7654321")
        self.pin = self.write_capture()
        receipt, (snapshot, manifest) = self.exported()
        with closing(sqlite3.connect(self.db)) as db:
            db.row_factory = sqlite3.Row
            row = db.execute("SELECT * FROM schools WHERE id=?", (self.capture["tables"]["schools"][0]["id"],)).fetchone()
            self.assertEqual(row["latitude"], "35.1234567")
            self.assertEqual(row["longitude"], "139.7654321")
            self.assertEqual(row["status_note"], self.capture["tables"]["schools"][0]["status_note"])
            self.assertEqual(db.execute("SELECT purpose FROM source_metadata").fetchone()[0], live.PURPOSE)
            with self.assertRaises(ValueError):
                school.check_metadata(db)
            self.assertEqual(live._full_hash(live._all_tables(db)), receipt["source_content_sha256"])
        self.assertFalse(snapshot["synthetic"])
        self.assertEqual(len(snapshot["tables"]), 13)
        self.assertEqual(len(manifest["table_counts"]), 25)
        self.assertEqual(len(manifest["code"]["files"]), 16)
        self.assertEqual(manifest["code"]["files"][-1]["path"], sorted(live.CODE_FILES)[-1])
        self.assertEqual(set(snapshot["tables"]["schools"][0]), set(school.PROJECTION["schools"]))
        self.assertTrue(all("status_note" not in row for row in snapshot["tables"]["schools"]))
        self.assertNotIn("school_admission_stat_legacy_links", snapshot["tables"])
        self.assertEqual(manifest["table_counts"]["school_admission_stat_legacy_links"],
                         len(self.capture["tables"]["school_admission_stat_legacy_links"]))
        self.assertEqual(receipt["consistency_evidence"], "collector-declared")
        with self.assertRaises(ValueError):
            school.verify_bundle(self.output)
        self.assertNotIn(str(self.root), json.dumps(manifest))

    def test_default_dry_run_creates_no_db_or_bundle_and_preserves_input(self):
        before = self.input.read_bytes()
        receipt = self.take()
        self.assertEqual(receipt["mode"], "dry-run")
        self.assertEqual(list(self.root.iterdir()), [self.input])
        self.assertEqual(self.input.read_bytes(), before)
        self.take(apply=True)
        original = self.db.read_bytes()
        result = live.export_snapshot(self.db, self.output, expected_source_sha256=receipt["source_content_sha256"])
        self.assertEqual(result["mode"], "dry-run")
        self.assertFalse(self.output.exists())
        self.assertEqual(original, self.db.read_bytes())

    def test_fixed_local_receipt_schema_does_not_change_projection_or_source_hash(self):
        receipt = self.take(apply=True)
        with closing(sqlite3.connect(self.db)) as db:
            db.execute(live.LIVE_RECEIPT_SQL)
            db.commit()
        live.export_snapshot(self.db, self.output, expected_source_sha256=receipt["source_content_sha256"], apply=True)
        snapshot, manifest = live.verify_bundle(self.output)
        self.assertNotIn("source_apply_receipts", snapshot["tables"])
        self.assertNotIn("source_apply_receipts", manifest["table_counts"])
        with closing(sqlite3.connect(self.db)) as db:
            db.execute("CREATE INDEX unexpected_receipt_index ON source_apply_receipts(request_sha256)")
            db.commit()
        with self.assertRaises(live.LiveSourceError):
            live.export_snapshot(self.db, self.root / "rejected", expected_source_sha256=receipt["source_content_sha256"])

    def test_non_uuid_record_keys_preserved_without_becoming_file_paths(self):
        school_key, department_key = "合成学校 / arbitrary-key", "invented-department-key-B"
        self.capture["tables"]["schools"][0]["record_key"] = school_key
        self.capture["tables"]["school_departments"][0]["record_key"] = department_key
        self.pin = self.write_capture()
        _, (snapshot, _) = self.exported()
        with closing(sqlite3.connect(self.db)) as db:
            self.assertIn((school_key,), db.execute("SELECT record_key FROM schools").fetchall())
            self.assertIn((department_key,), db.execute("SELECT record_key FROM school_departments").fetchall())
        self.assertIn(school_key, [row["record_key"] for row in snapshot["tables"]["schools"]])
        self.assertEqual({path.name for path in self.output.iterdir()}, {"snapshot.json", "manifest.json"})

    def test_existing_destinations_never_overwritten(self):
        receipt, _ = self.exported()
        before = self.db.read_bytes()
        with self.assertRaises(live.LiveSourceError):
            self.take(apply=True)
        with self.assertRaises(live.LiveSourceError):
            live.export_snapshot(self.db, self.output, expected_source_sha256=receipt["source_content_sha256"], apply=True)
        self.assertEqual(before, self.db.read_bytes())
        empty = self.root / "existing-empty"
        empty.mkdir()
        with self.assertRaises(live.LiveSourceError):
            live.export_snapshot(self.db, empty, expected_source_sha256=receipt["source_content_sha256"], apply=True)
        self.assertEqual(list(empty.iterdir()), [])

    def test_capture_pin_duplicate_json_nan_and_synthetic_marker_rejected(self):
        cases = [self.input.read_bytes() + b" ", b'{"format":1,"format":2}', b'{"value":NaN}']
        for raw in cases:
            self.input.write_bytes(raw)
            pin = self.pin if raw == cases[0] else hashlib.sha256(raw).hexdigest()
            with self.assertRaises(live.LiveSourceError):
                live.import_capture(self.input, self.db, input_sha256=pin, apply=True)
            self.assertFalse(self.db.exists())
        self.capture["synthetic"] = True
        self.pin = self.write_capture()
        with self.assertRaises(live.LiveSourceError):
            self.take(apply=True)

    def test_unknown_table_and_columns_in_empty_table_rejected(self):
        variants = []
        value = copy.deepcopy(self.capture); value["tables"]["private_user_notes"] = []; variants.append(value)
        value = copy.deepcopy(self.capture); value["tables"]["schools"][0]["private_added"] = None; variants.append(value)
        value = copy.deepcopy(self.capture)
        value["columns"]["school_name_history"].append("new_upstream_column")
        value["tables"]["school_name_history"] = []; variants.append(value)
        value = copy.deepcopy(self.capture); value["columns"]["schools"].append("id"); variants.append(value)
        value = copy.deepcopy(self.capture); value["tables"].pop("school_field_sources"); variants.append(value)
        for value in variants:
            with self.subTest(tables=len(value["tables"])):
                self.pin = self.write_capture(value)
                with self.assertRaises(live.LiveSourceError):
                    self.take(apply=True)
                self.assertFalse(self.db.exists())
                self.assertEqual(list(self.root.iterdir()), [self.input])

    def test_decimal_rounding_null_boolean_and_uuid_not_coerced(self):
        for column, invalid in (("latitude", Decimal("35.12345678")), ("is_active", 1),
                                ("id", "invented-not-uuid"), ("course_times", []),
                                ("name", None)):
            with self.subTest(column=column):
                value = copy.deepcopy(self.capture)
                value["tables"]["schools"][0][column] = invalid
                self.pin = self.write_capture(value)
                with self.assertRaises(live.LiveSourceError):
                    self.take(apply=True)
                self.assertFalse(self.db.exists())

    def test_foreign_key_and_cross_school_membership_fail_before_publication(self):
        value = copy.deepcopy(self.capture)
        value["tables"]["school_departments"][0]["school_id"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        self.pin = self.write_capture(value)
        with self.assertRaises(live.LiveSourceError):
            self.take(apply=True)
        self.assertFalse(self.db.exists())
        value = copy.deepcopy(self.capture)
        value["tables"]["admission_recruitment_units"][0]["school_id"] = value["tables"]["schools"][1]["id"]
        self.pin = self.write_capture(value)
        with self.assertRaises(live.LiveSourceError):
            self.take(apply=True)
        self.assertEqual(list(self.root.iterdir()), [self.input])

    def test_full_private_column_change_rejected_by_export_pin(self):
        receipt = self.take(apply=True)
        with closing(sqlite3.connect(self.db)) as db, db:
            db.execute("UPDATE schools SET status_note='invented-private-change'")
        with self.assertRaisesRegex(live.LiveSourceError, "source pin"):
            live.export_snapshot(self.db, self.output, expected_source_sha256=receipt["source_content_sha256"], apply=True)
        self.assertFalse(self.output.exists())

    def test_removed_constraint_index_rejected_even_when_rows_and_pin_match(self):
        receipt = self.take(apply=True)
        with closing(sqlite3.connect(self.db)) as db, db:
            name = db.execute("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL LIMIT 1").fetchone()[0]
            db.execute(f'DROP INDEX "{name}"')
        with self.assertRaisesRegex(live.LiveSourceError, "schema differs"):
            live.export_snapshot(self.db, self.output, expected_source_sha256=receipt["source_content_sha256"], apply=True)
        self.assertFalse(self.output.exists())

    def test_bundle_modified_bytes_false_marker_extra_file_and_private_projection_rejected(self):
        _, (_, manifest) = self.exported()
        path = self.output / "snapshot.json"
        original = path.read_bytes()
        path.write_bytes(original + b" ")
        with self.assertRaises(live.LiveSourceError):
            live.verify_bundle(self.output)
        path.write_bytes(original)
        extra = self.output / "private.sqlite"
        extra.write_bytes(b"invented")
        with self.assertRaises(live.LiveSourceError):
            live.verify_bundle(self.output)
        extra.unlink()
        for mutate in (lambda s: s.update(synthetic=True),
                       lambda s: s["tables"]["schools"][0].update(status_note="invented-private")):
            snapshot = live._json(original)
            mutate(snapshot)
            raw = school.canonical_json(snapshot).encode()
            changed = dict(manifest, snapshot_sha256=hashlib.sha256(raw).hexdigest(), content_sha256=school.content_hash(snapshot))
            path.write_bytes(raw)
            (self.output / "manifest.json").write_bytes(school.canonical_json(changed).encode())
            with self.assertRaises(live.LiveSourceError):
                live.verify_bundle(self.output)

    def test_input_output_limits_and_expired_work_publish_nothing(self):
        for maximum in (True, 0, self.input.stat().st_size - 1, live.MAX_BYTES + 1):
            with self.subTest(maximum=maximum), self.assertRaises(live.LiveSourceError):
                self.take(apply=True, max_bytes=maximum)
        for timeout in (True, 0, float("nan"), 301):
            with self.subTest(timeout=timeout), self.assertRaises(live.LiveSourceError):
                self.take(apply=True, timeout_seconds=timeout)
        real = school.normalize_tables
        def late(value):
            result = real(value)
            time.sleep(0.05)
            return result
        with patch.object(school, "normalize_tables", side_effect=late):
            with self.assertRaises(live.LiveSourceError):
                self.take(apply=True, timeout_seconds=0.03)
        self.assertEqual(list(self.root.iterdir()), [self.input])

    def test_source_hash_stable_when_capture_table_rows_reordered(self):
        first = self.take()["source_content_sha256"]
        for rows in self.capture["tables"].values():
            rows.reverse()
        self.pin = self.write_capture()
        self.assertEqual(first, self.take()["source_content_sha256"])

    def test_repo_relative_links_and_code_drift_rejected(self):
        for path in (Path("relative.sqlite"), school.REPO / "never-created.sqlite"):
            with self.assertRaises(live.LiveSourceError):
                live.import_capture(self.input, path, input_sha256=self.pin, apply=True)
            self.assertFalse(path.exists())
        alias = self.root / "alias.json"
        alias.hardlink_to(self.input)
        with self.assertRaises(live.LiveSourceError):
            self.take(apply=True)
        alias.unlink()
        with patch.object(live, "_code_identity", return_value={}):
            with self.assertRaisesRegex(live.LiveSourceError, "source changed"):
                self.take(apply=True)

    def test_failed_second_bundle_link_cleans_only_own_files(self):
        receipt = self.take(apply=True)
        real = os.link
        def fail_manifest(source, target):
            if Path(target).name == "manifest.json":
                raise OSError("invented private exception")
            return real(source, target)
        with patch.object(live.os, "link", side_effect=fail_manifest):
            with self.assertRaises(live.LiveSourceError):
                live.export_snapshot(self.db, self.output, expected_source_sha256=receipt["source_content_sha256"], apply=True)
        self.assertFalse(self.output.exists())
        self.assertEqual({p.name for p in self.root.iterdir()}, {"capture.json", "source.sqlite"})

    def test_interrupt_after_database_link_removes_only_owned_publication(self):
        real = os.link
        def link_then_fail(source, target):
            real(source, target)
            raise OSError("invented post-link failure")
        with patch.object(live.os, "link", side_effect=link_then_fail):
            with self.assertRaises(live.LiveSourceError):
                self.take(apply=True)
        self.assertEqual(list(self.root.iterdir()), [self.input])

    def test_competing_database_is_never_replaced_or_cleaned(self):
        real = os.link
        def create_competitor(source, target):
            Path(target).write_bytes(b"invented other writer")
            real(source, target)
        with patch.object(live.os, "link", side_effect=create_competitor):
            with self.assertRaises(live.LiveSourceError):
                self.take(apply=True)
        self.assertEqual(self.db.read_bytes(), b"invented other writer")

    def test_competing_manifest_is_not_deleted_by_failure_cleanup(self):
        receipt = self.take(apply=True)
        real = os.link
        def race_manifest(source, target):
            if Path(target).name == "manifest.json":
                Path(target).write_bytes(b"invented competing owner")
            return real(source, target)
        with patch.object(live.os, "link", side_effect=race_manifest):
            with self.assertRaises(live.LiveSourceError):
                live.export_snapshot(self.db, self.output, expected_source_sha256=receipt["source_content_sha256"], apply=True)
        self.assertEqual((self.output / "manifest.json").read_bytes(), b"invented competing owner")
        self.assertFalse((self.output / "snapshot.json").exists())

    def test_cli_dryrun_apply_export_verify_and_sanitized_rejection(self):
        cli = Path(live.__file__)
        def run(*args):
            return subprocess.run([sys.executable, "-B", str(cli), *map(str, args)], cwd=self.root,
                                  capture_output=True, text=True, encoding="utf-8", timeout=20)
        args = ("import", "--input", self.input, "--input-sha256", self.pin, "--db", self.db)
        dry = run(*args)
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertFalse(self.db.exists())
        imported = run(*args, "--apply")
        self.assertEqual(imported.returncode, 0, imported.stderr)
        source_hash = json.loads(imported.stdout)["source_content_sha256"]
        exported = run("export", "--db", self.db, "--output", self.output,
                       "--expected-source-sha256", source_hash, "--apply")
        self.assertEqual(exported.returncode, 0, exported.stderr)
        verified = run("verify", "--bundle", self.output)
        self.assertEqual(verified.returncode, 0, verified.stderr)
        rejected = run(*args, "--apply")
        self.assertEqual(rejected.returncode, 1)
        self.assertEqual(rejected.stdout, "")
        self.assertNotIn(str(self.root), rejected.stderr)
        self.assertNotIn("Traceback", rejected.stderr)


if __name__ == "__main__":
    unittest.main()
