"""Synthetic school backups only; all artifacts stay in an OS temporary directory."""

from contextlib import closing
import copy
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import backup
import store
import store_school as school
from school_fixture import synthetic_payload


class BackupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="synthetic-backup-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.assertFalse(self.root.is_relative_to(school.REPO))
        self.source = self.root / "source.sqlite"
        self.generation = self.root / "generation"
        self.restored = self.root / "restored.sqlite"
        self.payload = synthetic_payload()
        self.payload["tables"] = school.normalize_tables(self.payload["tables"])
        with closing(store.connect(self.source)) as db:
            school.import_rows(db, self.payload, fresh=True)

    def make(self):
        return backup.create_backup(self.source, self.generation, apply=True)

    def manifest(self):
        return json.loads((self.generation / "manifest.json").read_text(encoding="utf-8"))

    def write_manifest(self, data):
        (self.generation / "manifest.json").write_text(json.dumps(data), encoding="utf-8")

    def content(self, path):
        with closing(store.connect(path, readonly=True)) as db:
            return school.snapshot_content(db)

    def test_dry_run_creates_nothing_and_does_not_change_source(self):
        before = self.source.read_bytes()
        listing = set(self.root.iterdir())
        manifest = backup.create_backup(self.source, self.generation)
        self.assertEqual(manifest["format"], "school-source-backup")
        self.assertEqual(before, self.source.read_bytes())
        self.assertEqual(set(self.root.iterdir()), listing)
        self.assertEqual(len(manifest["table_counts"]), 25)

    def test_backup_restore_and_regeneration_preserve_all_rows_and_content(self):
        before = self.source.read_bytes()
        original_content, counts = self.content(self.source)
        manifest = self.make()
        self.assertEqual(set(p.name for p in self.generation.iterdir()), set(backup.GENERATION_FILES))
        self.assertEqual(manifest, backup.verify_backup(self.generation))
        self.assertEqual(manifest["snapshot_content_sha256"], school.content_hash(original_content))
        self.assertEqual(manifest["table_counts"], counts)
        self.assertEqual(manifest["database_sha256"], hashlib.sha256((self.generation / "database.sqlite").read_bytes()).hexdigest())
        self.assertEqual(backup.restore_backup(self.generation, self.restored), manifest)
        self.assertFalse(self.restored.exists())
        self.assertEqual(backup.restore_backup(self.generation, self.restored, apply=True), manifest)
        self.assertEqual(self.content(self.restored), (original_content, counts))
        self.assertEqual(self.restored.read_bytes(), (self.generation / "database.sqlite").read_bytes())
        self.assertEqual(self.source.read_bytes(), before)
        with closing(store.connect(self.source, readonly=True)) as first, closing(store.connect(self.restored, readonly=True)) as second:
            for table in (*school.TABLES, "source_metadata"):
                self.assertEqual([tuple(row) for row in first.execute(f"SELECT * FROM {table} ORDER BY 1,2")],
                                 [tuple(row) for row in second.execute(f"SELECT * FROM {table} ORDER BY 1,2")])
        regenerated = backup.create_backup(self.restored, self.root / "second", apply=True)
        self.assertEqual(regenerated["snapshot_content_sha256"], manifest["snapshot_content_sha256"])

    def test_existing_destinations_empty_directories_files_and_source_are_never_replaced(self):
        self.generation.mkdir()
        for apply in (False, True):
            with self.assertRaises(ValueError): backup.create_backup(self.source, self.generation, apply=apply)
        self.generation.rmdir()
        self.make()
        self.restored.write_bytes(b"synthetic sentinel")
        for apply in (False, True):
            with self.assertRaises(ValueError): backup.restore_backup(self.generation, self.restored, apply=apply)
        self.assertEqual(self.restored.read_bytes(), b"synthetic sentinel")
        with self.assertRaises(ValueError): backup.restore_backup(self.generation, self.source, apply=True)

    def test_applied_and_cancelled_receipts_survive_backup_restore(self):
        from school_source_apply import SourceAdapter
        adapter = SourceAdapter(self.source, synthetic=True)
        base = adapter.generation()
        row = self.payload["tables"]["school_deviation_values"][0]
        change = {"school_id": row["school_id"], "department_id": row["department_id"],
                  "field": "deviation_value", "value": 61}
        cancelled = adapter.cancel("synthetic-cancelled", base, [change])
        first = adapter.apply("synthetic-first", base, [change])
        latest_change = {**change, "value": 62}
        latest = adapter.apply("synthetic-latest", first["target"], [latest_change])
        before = self.source.read_bytes()
        manifest = self.make()
        backup.restore_backup(self.generation, self.restored, apply=True)
        restored = SourceAdapter(self.restored, synthetic=True)
        self.assertEqual(restored.generation(), latest["target"])
        self.assertEqual(restored.read_receipt("synthetic-first"), first)
        self.assertEqual(restored.read_cancellation("synthetic-cancelled"), cancelled)
        self.assertEqual(restored.verify_receipt("synthetic-latest", first["target"], [latest_change]), latest)
        with self.assertRaisesRegex(ValueError, "cancelled"):
            restored.apply("synthetic-cancelled", base, [change])
        self.assertEqual(len(manifest["table_counts"]), 25)
        self.assertEqual(manifest["snapshot_content_sha256"], latest["target"]["snapshot_content_sha256"])
        self.assertEqual(self.source.read_bytes(), before)

    def test_receipt_only_cancellation_can_be_backed_up(self):
        from school_source_apply import SourceAdapter
        adapter = SourceAdapter(self.source, synthetic=True)
        row = self.payload["tables"]["school_deviation_values"][0]
        change = {"school_id": row["school_id"], "department_id": row["department_id"],
                  "field": "deviation_value", "value": 61}
        cancelled = adapter.cancel("synthetic-cancelled", adapter.generation(), [change])
        self.make()
        backup.restore_backup(self.generation, self.restored, apply=True)
        self.assertEqual(SourceAdapter(self.restored, synthetic=True).read_cancellation("synthetic-cancelled"), cancelled)

    def test_malformed_receipt_content_and_extra_schema_are_rejected(self):
        from school_source_apply import SourceAdapter
        adapter = SourceAdapter(self.source, synthetic=True)
        row = self.payload["tables"]["school_deviation_values"][0]
        change = {"school_id": row["school_id"], "department_id": row["department_id"],
                  "field": "deviation_value", "value": 61}
        adapter.apply("synthetic-first", adapter.generation(), [change])
        clean = self.source.read_bytes()
        mutations = [
            "UPDATE source_apply_receipts SET request_sha256='invalid'",
            "UPDATE source_apply_receipts SET document='{}'",
            "CREATE INDEX unexpected_receipt_index ON source_apply_receipts(request_sha256)",
            "CREATE TRIGGER unexpected_receipt_trigger AFTER INSERT ON source_apply_receipts BEGIN SELECT 1; END",
        ]
        for sql in mutations:
            self.source.write_bytes(clean)
            with closing(sqlite3.connect(self.source)) as db:
                db.executescript(sql)
                db.commit()
            with self.subTest(sql=sql), self.assertRaises((ValueError, sqlite3.Error)):
                self.make()
            self.assertFalse(self.generation.exists())

    def test_sidecars_extra_files_and_incomplete_generations_are_rejected(self):
        self.make()
        for name in ("database.sqlite-wal", "database.sqlite-shm", "database.sqlite-journal", "extra"):
            extra = self.generation / name
            extra.write_bytes(b"synthetic")
            with self.subTest(name=name), self.assertRaises(ValueError): backup.verify_backup(self.generation)
            extra.unlink()
        (self.generation / "manifest.json").unlink()
        with self.assertRaises(ValueError): backup.verify_backup(self.generation)
        for suffix in backup.SIDECARS:
            sidecar = Path(str(self.restored) + suffix)
            sidecar.touch()
            # Recreate a valid generation for restore's preflight.
            target = self.root / ("valid" + suffix)
            backup.create_backup(self.source, target, apply=True)
            with self.assertRaises(ValueError): backup.restore_backup(target, self.restored, apply=True)
            self.assertFalse(self.restored.exists())
            sidecar.unlink()

    def test_manifest_types_unknown_fields_duplicates_and_hashes_are_strict(self):
        original = self.make()
        mutations = [lambda m: m.update(extra=True), lambda m: m.update(format_version=True),
                     lambda m: m.update(synthetic=1), lambda m: m.update(schema_version=2),
                     lambda m: m.update(created_at="2026-09-27"), lambda m: m.update(database_sha256="0" * 64),
                     lambda m: m.update(created_at="2026-09-27T10:00:00+01:60"),
                     lambda m: m.update(created_at="2026-09-27T10:00:00+00:99"),
                     lambda m: m.update(snapshot_content_sha256="0" * 64), lambda m: m.update(dataset_version="different"),
                     lambda m: m["table_counts"].update(schools=True), lambda m: m["table_counts"].pop("schools")]
        for mutate in mutations:
            changed = copy.deepcopy(original)
            mutate(changed)
            self.write_manifest(changed)
            with self.subTest(mutate=mutate), self.assertRaises(ValueError): backup.verify_backup(self.generation)
        self.write_manifest(original)
        text = (self.generation / "manifest.json").read_text()
        (self.generation / "manifest.json").write_text(text.replace('{', '{"format_version":1,', 1))
        with self.assertRaises(ValueError): backup.verify_backup(self.generation)

    def test_apply_must_be_an_explicit_boolean(self):
        self.make()
        for value in (1, 0, "true", None):
            with self.subTest(apply=value):
                with self.assertRaises(ValueError): backup.create_backup(self.source, self.root / "another", apply=value)
                with self.assertRaises(ValueError): backup.restore_backup(self.generation, self.restored, apply=value)
        self.assertFalse(self.restored.exists())

    def test_corrupt_bytes_rejected_even_when_manifest_hash_is_recomputed(self):
        self.make()
        path = self.generation / "database.sqlite"
        path.write_bytes(b"not an SQLite database")
        with self.assertRaises(ValueError): backup.verify_backup(self.generation)
        manifest = self.manifest()
        manifest["database_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.write_manifest(manifest)
        with self.assertRaises((ValueError, sqlite3.Error)): backup.verify_backup(self.generation)

    def test_wrong_schema_metadata_extra_objects_and_invalid_rows_are_rejected(self):
        mutations = ["UPDATE source_metadata SET schema_version=99", "CREATE TABLE unexpected(id int)",
                     "CREATE VIEW unexpected AS SELECT 1", "UPDATE schools SET official_url='not-http'",
                     "PRAGMA foreign_keys=OFF; UPDATE school_departments SET school_id='00000000-0000-0000-0000-000000000001'"]
        clean = self.source.read_bytes()
        for sql in mutations:
            self.source.write_bytes(clean)
            with closing(sqlite3.connect(self.source)) as db:
                db.executescript(sql)
                db.commit()
            with self.subTest(sql=sql), self.assertRaises((ValueError, sqlite3.Error)):
                backup.create_backup(self.source, self.generation, apply=True)
            self.assertFalse(self.generation.exists())

    def test_tampered_nonprojected_rows_are_validated_after_hash_update(self):
        self.make()
        database = self.generation / "database.sqlite"
        with closing(sqlite3.connect(database)) as db:
            # SQL type/constraints still pass; only the existing row validator
            # recognizes the invalid timestamp in this nonprojected master.
            db.execute("UPDATE course_type_master SET created_at='not-a-timestamp'")
            db.commit()
        manifest = self.manifest()
        manifest["database_sha256"] = hashlib.sha256(database.read_bytes()).hexdigest()
        self.write_manifest(manifest)
        with self.assertRaises(ValueError): backup.verify_backup(self.generation)

    def test_hardlinks_are_rejected_for_source_and_generation_files(self):
        alias = self.root / "alias.sqlite"
        os.link(self.source, alias)
        with self.assertRaises(ValueError): self.make()
        alias.unlink()
        self.make()
        os.link(self.generation / "database.sqlite", alias)
        with self.assertRaises(ValueError): backup.verify_backup(self.generation)

    def test_symlink_ancestors_and_dangling_destinations_are_rejected(self):
        linked = self.root / "linked"
        try:
            linked.symlink_to(self.root, target_is_directory=True)
        except OSError:
            self.skipTest("OS does not permit creating synthetic symlinks")
        with self.assertRaises(ValueError): backup.create_backup(linked / self.source.name, self.generation, apply=True)
        with self.assertRaises(ValueError): backup.create_backup(self.source, linked / "new", apply=True)
        dangling = self.root / "dangling"
        dangling.symlink_to(self.root / "missing")
        with self.assertRaises(ValueError): backup.create_backup(self.source, dangling, apply=True)

    def test_manifest_is_last_and_publish_failure_cleans_only_owned_files(self):
        original = backup._copy_new
        def interrupt(source, destination, end):
            if destination.parent == self.generation and destination.name == "manifest.json":
                self.assertTrue((self.generation / "database.sqlite").is_file())
                with self.assertRaises(ValueError): backup.verify_backup(self.generation)
                raise KeyboardInterrupt("synthetic interruption")
            return original(source, destination, end)
        with patch.object(backup, "_copy_new", side_effect=interrupt), self.assertRaises(KeyboardInterrupt): self.make()
        self.assertFalse(self.generation.exists())
        self.make()  # Retry succeeds without an abandoned generation.

    def test_competing_file_is_not_deleted_during_failure_cleanup(self):
        original = backup._copy_new
        def compete(source, destination, end):
            if destination.parent == self.generation and destination.name == "manifest.json":
                destination.write_text("synthetic competing writer")
            return original(source, destination, end)
        with patch.object(backup, "_copy_new", side_effect=compete), self.assertRaises(ValueError): self.make()
        self.assertEqual((self.generation / "manifest.json").read_text(), "synthetic competing writer")
        self.assertFalse((self.generation / "database.sqlite").exists())

    def test_fsync_failure_and_restore_link_failure_leave_no_candidate(self):
        with patch.object(backup.os, "fsync", side_effect=OSError("synthetic fsync failure")), self.assertRaises(OSError): self.make()
        self.assertFalse(self.generation.exists())
        self.make()
        before = set(self.root.iterdir())
        with patch.object(backup.os, "link", side_effect=OSError("synthetic link failure")), self.assertRaises(OSError):
            backup.restore_backup(self.generation, self.restored, apply=True)
        self.assertEqual(set(self.root.iterdir()), before)

    def test_destination_fsync_failure_reclaims_partial_backup(self):
        original = backup._publish
        def publish(staging, destination, end):
            with patch.object(backup.os, "fsync", side_effect=OSError("synthetic destination flush failure")):
                return original(staging, destination, end)
        with patch.object(backup, "_publish", side_effect=publish), self.assertRaises(OSError): self.make()
        self.assertFalse(self.generation.exists())

    def test_restore_interrupt_after_link_reclaims_only_owned_result(self):
        self.make()
        original = os.link
        def interrupt(source, target):
            original(source, target)
            raise KeyboardInterrupt("synthetic interruption after link")
        with patch.object(backup.os, "link", side_effect=interrupt), self.assertRaises(KeyboardInterrupt):
            backup.restore_backup(self.generation, self.restored, apply=True)
        self.assertFalse(self.restored.exists())
        self.assertEqual({p.name for p in self.root.iterdir()}, {"source.sqlite", "generation"})
        def competitor(_source, target):
            target.write_bytes(b"synthetic competing restore")
            raise FileExistsError("synthetic race")
        with patch.object(backup.os, "link", side_effect=competitor), self.assertRaises(FileExistsError):
            backup.restore_backup(self.generation, self.restored, apply=True)
        self.assertEqual(self.restored.read_bytes(), b"synthetic competing restore")

    def test_restore_validation_failure_after_publication_removes_only_new_file(self):
        self.make()
        original = backup._verify_database
        def fail(path, manifest, end):
            if path == self.restored:
                raise ValueError("synthetic post-publication failure")
            return original(path, manifest, end)
        with patch.object(backup, "_verify_database", side_effect=fail), self.assertRaises(ValueError):
            backup.restore_backup(self.generation, self.restored, apply=True)
        self.assertFalse(self.restored.exists())
        self.assertEqual(backup.verify_backup(self.generation), self.manifest())

    def test_wal_writer_remains_active_and_committed_wal_is_included(self):
        with closing(sqlite3.connect(self.source, isolation_level=None)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute("UPDATE source_metadata SET dataset_version='synthetic-wal-committed'")
            self.assertTrue(Path(str(self.source) + "-wal").exists())
            writer.execute("BEGIN IMMEDIATE")
            writer.execute("UPDATE source_metadata SET dataset_version='synthetic-uncommitted'")
            manifest = self.make()
            self.assertEqual(manifest["dataset_version"], "synthetic-wal-committed")
            self.assertTrue(writer.in_transaction)
            writer.rollback()
            self.assertEqual(writer.execute("SELECT dataset_version FROM source_metadata").fetchone()[0], "synthetic-wal-committed")

    def test_concurrent_wal_commits_produce_one_consistent_read_snapshot(self):
        ready, stop = threading.Event(), threading.Event()
        errors = []
        def write():
            try:
                with closing(sqlite3.connect(self.source, isolation_level=None)) as db:
                    db.execute("PRAGMA journal_mode=WAL")
                    db.execute("PRAGMA wal_autocheckpoint=0")
                    counter = 0
                    ready.set()
                    while not stop.is_set():
                        db.execute("BEGIN IMMEDIATE")
                        version = f"synthetic-writer-{counter}"
                        db.execute("UPDATE source_metadata SET dataset_version=?,source_version=?", (version, version))
                        db.commit()
                        counter += 1
            except BaseException as exc: errors.append(exc); ready.set()
        worker = threading.Thread(target=write)
        worker.start()
        self.assertTrue(ready.wait(2))
        try:
            with patch.object(backup, "BACKUP_PAGES", 1): manifest = self.make()
        finally:
            stop.set()
            worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(manifest["dataset_version"], manifest["source_version"])
        self.assertEqual(backup.verify_backup(self.generation), manifest)

    def test_busy_wait_has_a_deadline_and_leaves_source_and_output_untouched(self):
        before = self.source.read_bytes()
        with closing(sqlite3.connect(self.source, isolation_level=None)) as writer:
            writer.execute("BEGIN EXCLUSIVE")
            started = time.monotonic()
            with patch.object(backup, "TIMEOUT_SECONDS", 0.15), self.assertRaises(TimeoutError): self.make()
            self.assertLess(time.monotonic() - started, 1.0)
            writer.rollback()
        self.assertEqual(self.source.read_bytes(), before)
        self.assertFalse(self.generation.exists())


if __name__ == "__main__":
    unittest.main()
