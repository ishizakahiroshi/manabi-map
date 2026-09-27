"""Local-only synthetic replica failures and read-only retention guarantees."""

from contextlib import closing
import copy
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import backup
import backup_replica as replica
from school_fixture import synthetic_payload
import store
import store_school as school


class ReplicaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template_temp = tempfile.TemporaryDirectory(prefix="replica-template-synthetic-")
        root = Path(cls.template_temp.name)
        payload = synthetic_payload()
        payload["tables"] = school.normalize_tables(payload["tables"])
        with closing(store.connect(root / "source.sqlite")) as db:
            school.import_rows(db, payload, fresh=True)
        cls.template = root / "generation"
        backup.create_backup(root / "source.sqlite", cls.template, apply=True)

    @classmethod
    def tearDownClass(cls):
        cls.template_temp.cleanup()

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="replica-test-synthetic-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source"
        shutil.copytree(self.template, self.source)
        self.destination = self.root / "replica"

    def inventory(self):
        return {str(p.relative_to(self.root)): p.read_bytes() if p.is_file() else None
                for p in self.root.rglob("*")}

    def set_created(self, directory, timestamp):
        path = directory / "manifest.json"
        metadata = json.loads(path.read_text(encoding="utf-8"))
        metadata["created_at"] = timestamp
        path.write_text(json.dumps(metadata), encoding="utf-8")

    def generations(self):
        directory = self.root / "generations"
        directory.mkdir()
        for name, timestamp in (("a-new", "2026-01-01T04:00:00Z"),
                                ("b-offset", "2026-01-01T12:00:00+09:00"),
                                ("c-old", "2025-12-31T23:00:00Z")):
            shutil.copytree(self.template, directory / name)
            self.set_created(directory / name, timestamp)
        return directory

    def test_default_dry_run_has_no_filesystem_writes(self):
        before = self.inventory()
        result = replica.replicate_backup(self.source, self.destination)
        self.assertEqual(result["status"], "dry_run")
        self.assertEqual(result["cloud_sync"], "unverified")
        self.assertEqual(before, self.inventory())
        with self.assertRaises(ValueError):
            replica.replicate_backup(self.source, self.destination, apply=1)

    def test_copy_manifest_last_and_idempotent_without_cloud_claim(self):
        writer, seen = replica._write_new, []
        def observe(path, data, owned):
            self.assertFalse((self.destination / "manifest.json").exists())
            seen.append(path.name)
            writer(path, data, owned)
        with patch.object(replica, "_write_new", observe):
            result = replica.replicate_backup(self.source, self.destination, apply=True)
        self.assertEqual(seen, ["database.sqlite", "manifest.json"])
        self.assertEqual(result["status"], "copied")
        self.assertEqual(result["cloud_sync"], "unverified")
        self.assertEqual(backup.verify_backup(self.destination), result["manifest"])
        before = self.inventory()
        for apply in (False, True):
            result = replica.replicate_backup(self.source, self.destination, apply=apply)
            self.assertEqual(result["status"], "already_present")
            self.assertEqual(result["cloud_sync"], "unverified")
        self.assertEqual(before, self.inventory())

    def test_full_metadata_difference_refuses_same_database(self):
        shutil.copytree(self.source, self.destination)
        self.set_created(self.destination, "2025-01-01T00:00:00Z")
        before = self.inventory()
        with self.assertRaisesRegex(ValueError, "different generation"):
            replica.replicate_backup(self.source, self.destination, apply=True)
        self.assertEqual(before, self.inventory())

    def test_partial_existing_destination_never_overwritten(self):
        self.destination.mkdir()
        (self.destination / "database.sqlite").write_bytes(b"synthetic partial")
        before = self.inventory()
        with self.assertRaises(ValueError):
            replica.replicate_backup(self.source, self.destination, apply=True)
        self.assertEqual(before, self.inventory())

    def test_failed_manifest_write_cleans_own_partial_copy(self):
        writer = replica._write_new
        def fail(path, data, owned):
            if path.name == "manifest.json":
                raise OSError("injected full disk")
            writer(path, data, owned)
        before = self.inventory()
        with patch.object(replica, "_write_new", fail), self.assertRaises(OSError):
            replica.replicate_backup(self.source, self.destination, apply=True)
        self.assertEqual(before, self.inventory())

    def test_source_replacement_during_copy_is_detected_and_cleaned(self):
        writer = replica._write_new
        def change(path, data, owned):
            writer(path, data, owned)
            if path.name == "manifest.json":
                self.set_created(self.source, "2025-01-01T00:00:00Z")
        with patch.object(replica, "_write_new", change), self.assertRaisesRegex(ValueError, "changed"):
            replica.replicate_backup(self.source, self.destination, apply=True)
        self.assertFalse(self.destination.exists())

    def test_failure_after_manifest_creation_cleans_both_files(self):
        sync = os.fsync
        calls = 0
        def fail_second(descriptor):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("injected manifest flush failure")
            sync(descriptor)
        before = self.inventory()
        with patch.object(replica.os, "fsync", fail_second), self.assertRaises(OSError):
            replica.replicate_backup(self.source, self.destination, apply=True)
        self.assertEqual(before, self.inventory())

    def test_cleanup_does_not_remove_replaced_destination(self):
        writer = replica._write_new
        def replace(path, data, owned):
            writer(path, data, owned)
            self.destination.rename(self.root / "interrupted")
            self.destination.mkdir()
            (self.destination / "unrelated.txt").write_text("preserve", encoding="utf-8")
            raise OSError("injected directory replacement")
        with patch.object(replica, "_write_new", replace), self.assertRaises(OSError):
            replica.replicate_backup(self.source, self.destination, apply=True)
        self.assertEqual((self.destination / "unrelated.txt").read_text(), "preserve")

    def test_racing_destination_creator_never_overwritten(self):
        mkdir = Path.mkdir
        def create_first(path, *args, **kwargs):
            if path == self.destination:
                mkdir(path)
                (path / "unrelated.txt").write_text("preserve", encoding="utf-8")
            return mkdir(path, *args, **kwargs)
        with patch.object(Path, "mkdir", create_first), self.assertRaises(FileExistsError):
            replica.replicate_backup(self.source, self.destination, apply=True)
        self.assertEqual((self.destination / "unrelated.txt").read_text(), "preserve")

    def test_metadata_type_swap_between_reads_rejected(self):
        original = json.loads((self.source / "manifest.json").read_text())
        reader = Path.read_bytes
        for value in (True, 1.0):
            changed = copy.deepcopy(original)
            changed["format_version"] = value
            def replace(path):
                return json.dumps(changed).encode() if path == self.source / "manifest.json" else reader(path)
            with self.subTest(value=value), patch.object(Path, "read_bytes", replace), self.assertRaises(ValueError):
                replica.replicate_backup(self.source, self.destination, apply=True)
        self.assertFalse(self.destination.exists())

    def test_hardlinks_and_linked_ancestors_and_traversal_refused(self):
        os.link(self.source / "database.sqlite", self.root / "hardlink.sqlite")
        with self.assertRaises(ValueError):
            replica.replicate_backup(self.source, self.destination, apply=True)
        (self.root / "hardlink.sqlite").unlink()
        original = Path.is_junction
        def junction(path):
            return path == self.root or original(path)
        with patch.object(Path, "is_junction", junction), self.assertRaises(ValueError):
            replica.replicate_backup(self.source, self.destination, apply=True)
        with self.assertRaises(ValueError):
            replica.replicate_backup(self.source, self.root / "missing" / ".." / "replica", apply=True)
        for destination in (self.source, self.source / "nested"):
            with self.assertRaises(ValueError):
                replica.replicate_backup(self.source, destination, apply=True)
        self.assertFalse(self.destination.exists())

    def test_retention_orders_instants_is_read_only_and_requires_explicit_keep(self):
        root = self.generations()
        before = self.inventory()
        result = replica.retention_plan(root, 1)
        self.assertEqual(result["status"], "planned")
        self.assertEqual(result["keep_candidates"], ["a-new"])
        self.assertEqual(result["delete_candidates"], ["b-offset", "c-old"])
        self.assertFalse(result["deletion_performed"])
        self.assertEqual(result["cloud_sync"], "unverified")
        self.assertEqual(replica.retention_plan(root, 99)["delete_candidates"], [])
        for keep in (None, 0, -1, True, 1.0, "1"):
            with self.subTest(keep=keep), self.assertRaises(ValueError):
                replica.retention_plan(root, keep)
        self.assertEqual(before, self.inventory())

    def test_any_corrupt_incomplete_or_unexpected_child_blocks_all_deletion(self):
        root = self.generations()
        for kind in ("corrupt", "incomplete", "file"):
            bad = root / "bad"
            if kind == "file":
                bad.write_bytes(b"synthetic unexpected")
            else:
                shutil.copytree(self.template, bad)
                if kind == "corrupt":
                    (bad / "database.sqlite").write_bytes(b"synthetic corruption")
                else:
                    (bad / "manifest.json").unlink()
            before = self.inventory()
            with self.subTest(kind=kind):
                result = replica.retention_plan(root, 1)
                self.assertEqual(result["status"], "blocked")
                self.assertEqual(result["delete_candidates"], [])
                self.assertIn("bad", result["blocked_generations"])
                self.assertEqual(before, self.inventory())
            if bad.is_dir():
                shutil.rmtree(bad)
            else:
                bad.unlink()

    def test_retention_equal_times_have_deterministic_name_order(self):
        root = self.generations()
        for child in root.iterdir():
            self.set_created(child, "2026-01-01T00:00:00Z")
        result = replica.retention_plan(root, 2)
        self.assertEqual(result["keep_candidates"], ["a-new", "b-offset"])
        self.assertEqual(result["delete_candidates"], ["c-old"])

    def test_retention_child_arriving_during_check_blocks_deletion(self):
        root = self.generations()
        checker = replica._unchanged
        def arrive(path, snapshot):
            checker(path, snapshot)
            (root / "incomplete-new").mkdir(exist_ok=True)
        with patch.object(replica, "_unchanged", arrive):
            result = replica.retention_plan(root, 1)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["delete_candidates"], [])

    def test_retention_linked_child_is_blocked_without_opening_target(self):
        root = self.generations()
        original = Path.is_symlink
        linked = root / "c-old"
        def symlink(path):
            return path == linked or original(path)
        with patch.object(Path, "is_symlink", symlink):
            result = replica.retention_plan(root, 1)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["delete_candidates"], [])
        self.assertIn("c-old", result["blocked_generations"])


if __name__ == "__main__":
    unittest.main()
