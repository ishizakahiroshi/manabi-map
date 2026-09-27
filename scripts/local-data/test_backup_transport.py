"""Synthetic local stand-ins only: these tests never access a real UNC share."""

from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import backup
import backup_replica as replica
import backup_transport as transport
from school_fixture import synthetic_payload
import store
import store_school as school


UNC = r"\\synthetic-host\synthetic-share\attempt"


class TransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template_temp = tempfile.TemporaryDirectory(prefix="transport-template-synthetic-")
        root = Path(cls.template_temp.name)
        payload = synthetic_payload()
        payload["tables"] = school.normalize_tables(payload["tables"])
        with closing(store.connect(root / "source.sqlite")) as database:
            school.import_rows(database, payload, fresh=True)
        cls.template = root / "generation"
        backup.create_backup(root / "source.sqlite", cls.template, apply=True)

    @classmethod
    def tearDownClass(cls):
        cls.template_temp.cleanup()

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="transport-test-synthetic-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source"
        shutil.copytree(self.template, self.source)
        self.parent = self.root / "remote-stand-in"
        self.parent.mkdir()
        self.destination = self.parent / "attempt"
        # The sole native UNC boundary is replaced, after real lexical validation.
        native_patch = patch.object(transport, "_native_unc", side_effect=lambda path: self.parent / path.name)
        self.mapper = native_patch.start()
        self.addCleanup(native_patch.stop)
        self.source_before = self.source_bytes()

    def source_bytes(self):
        return {path.name: path.read_bytes() for path in self.source.iterdir()}

    def assert_source_retained(self):
        self.assertEqual(self.source_bytes(), self.source_before)

    def copy(self, **kwargs):
        return transport.copy_backup_to_unc(self.source, UNC, **kwargs)

    def test_default_dry_run_has_no_remote_writes(self):
        result = self.copy()
        self.assertEqual(result["status"], "dry_run")
        self.assertFalse(result["readback_verified"])
        self.assertEqual(result["cloud_sync"], "unverified")
        self.assertEqual(list(self.parent.iterdir()), [])
        self.assert_source_retained()

    def test_apply_manifest_last_readback_only_local_and_idempotent(self):
        writer, verifier = transport._write_remote, backup.verify_backup
        writes, verified = [], []
        def observe(path, data, end, **options):
            self.assertFalse((self.destination / "manifest.json").exists())
            writes.append(path.name)
            writer(path, data, end, **options)
        def local_only(path):
            self.assertFalse(Path(path).is_relative_to(self.parent))
            self.assertFalse(str(path).startswith("\\\\"))
            verified.append(Path(path))
            return verifier(path)
        with patch.object(transport, "_write_remote", observe), patch.object(backup, "verify_backup", local_only):
            result = self.copy(apply=True)
        self.assertEqual(writes, ["database.sqlite", "manifest.json"])
        self.assertTrue(any(path != self.source for path in verified))
        self.assertEqual(result["status"], "copied")
        self.assertTrue(result["readback_verified"])
        self.assertEqual(result["cloud_sync"], "unverified")
        before = {path.name: path.read_bytes() for path in self.destination.iterdir()}
        for apply in (True, False):
            with patch.object(transport, "_write_remote", side_effect=AssertionError("must not write")):
                result = self.copy(apply=apply)
            self.assertEqual(result["status"], "already_present")
            self.assertTrue(result["readback_verified"])
        self.assertEqual(before, {path.name: path.read_bytes() for path in self.destination.iterdir()})
        self.assert_source_retained()

    def test_partial_database_disconnect_retained_and_new_attempt_required(self):
        def disconnect(path, data, end, **options):
            path.write_bytes(data[:32])
            raise OSError("injected disconnected drive")
        with patch.object(transport, "_write_remote", disconnect), self.assertRaises(OSError):
            self.copy(apply=True)
        self.assertEqual((self.destination / "database.sqlite").stat().st_size, 32)
        self.assertFalse((self.destination / "manifest.json").exists())
        with self.assertRaisesRegex(ValueError, "new attempt"):
            self.copy(apply=True)
        result = transport.copy_backup_to_unc(self.source, UNC + "-retry", apply=True)
        self.assertEqual(result["status"], "copied")
        self.assertEqual((self.destination / "database.sqlite").stat().st_size, 32)
        self.assert_source_retained()

    def test_manifest_flush_failure_retains_both_files_without_success(self):
        sync, calls = os.fsync, 0
        def fail_second(descriptor):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("injected unsupported remote flush")
            return sync(descriptor)
        with patch.object(transport.os, "fsync", fail_second), self.assertRaises(OSError):
            self.copy(apply=True)
        self.assertEqual({path.name for path in self.destination.iterdir()}, set(transport.FILES))
        self.assert_source_retained()

    def test_readback_corruption_fails_and_remote_evidence_is_preserved(self):
        writer = transport._write_remote
        def corrupt(path, data, end, **options):
            writer(path, data, end, **options)
            if path.name == "manifest.json":
                database = self.destination / "database.sqlite"
                altered = bytearray(database.read_bytes())
                altered[-1] ^= 1
                database.write_bytes(altered)
        with patch.object(transport, "_write_remote", corrupt), self.assertRaises(ValueError):
            self.copy(apply=True)
        self.assertTrue((self.destination / "manifest.json").exists())
        self.assert_source_retained()

    def test_existing_different_metadata_and_partial_directory_never_overwritten(self):
        self.destination.mkdir()
        with self.assertRaises(ValueError):
            self.copy(apply=True)
        self.assertEqual(list(self.destination.iterdir()), [])
        for name in transport.FILES:
            shutil.copyfile(self.source / name, self.destination / name)
        path = self.destination / "manifest.json"
        metadata = json.loads(path.read_text())
        metadata["created_at"] = "2020-01-01T00:00:00Z"
        path.write_text(json.dumps(metadata), encoding="utf-8")
        before = path.read_bytes()
        with self.assertRaisesRegex(ValueError, "differs"):
            self.copy(apply=True)
        self.assertEqual(path.read_bytes(), before)
        self.assert_source_retained()

    def test_invalid_unc_and_explicit_option_types_reject_before_io(self):
        bad = ("relative", "C:/destination", r"\\?\C:\destination", r"\\.\pipe\name",
               r"\\host\share", r"\\host\share\..\attempt", r"\\host\share\.\attempt",
               "\\\\host\\share\\\\attempt", r"\\host\share\NUL.json", r"\\host\share\NUL .json", r"\\host\share\CONOUT$",
               r"\\host\share\COM¹", r"\\host\share\file:stream", "\\\\host\\share\\trailing ")
        for destination in bad:
            with self.subTest(destination=destination), self.assertRaises(ValueError):
                transport.copy_backup_to_unc(self.source, destination, apply=True)
        for value in (None, 0, -1, True, float("nan"), float("inf"), "30", 10**1000):
            with self.subTest(timeout=value), self.assertRaises(ValueError):
                self.copy(timeout_seconds=value)
        with self.assertRaises(ValueError):
            self.copy(apply=1)
        self.mapper.assert_not_called()
        self.assertEqual(list(self.parent.iterdir()), [])
        self.assert_source_retained()

    def test_deadline_after_database_write_retains_partial_attempt(self):
        writer, expired = transport._write_remote, False
        def write_then_expire(path, data, end, **options):
            nonlocal expired
            writer(path, data, end, **options)
            expired = True
        with patch.object(transport.time, "monotonic", side_effect=lambda: 31.0 if expired else 0.0), \
                patch.object(transport, "_write_remote", write_then_expire), self.assertRaises(TimeoutError):
            self.copy(apply=True)
        self.assertTrue((self.destination / "database.sqlite").exists())
        self.assertFalse((self.destination / "manifest.json").exists())
        self.assert_source_retained()

    def test_deadline_after_readback_verification_does_not_claim_success(self):
        verifier, expired = backup.verify_backup, False
        def verify_then_expire(path):
            nonlocal expired
            result = verifier(path)
            if Path(path) != self.source:
                expired = True
            return result
        with patch.object(transport.time, "monotonic", side_effect=lambda: 31.0 if expired else 0.0), \
                patch.object(backup, "verify_backup", verify_then_expire), self.assertRaises(TimeoutError):
            self.copy(apply=True)
        self.assertEqual({path.name for path in self.destination.iterdir()}, set(transport.FILES))
        self.assert_source_retained()

    def test_remote_reparse_and_symlink_ancestors_are_refused(self):
        lstat = Path.lstat
        for mode, attributes in ((stat.S_IFLNK, 0), (stat.S_IFDIR, 0x400)):
            def linked(path, *args, **kwargs):
                if path == self.parent:
                    return SimpleNamespace(st_mode=mode, st_file_attributes=attributes)
                return lstat(path, *args, **kwargs)
            with self.subTest(mode=mode), patch.object(Path, "lstat", linked), self.assertRaises(ValueError):
                self.copy(apply=True)
        self.assertFalse(self.destination.exists())
        self.assert_source_retained()

    def test_remote_hardlink_and_unknown_file_link_metadata_are_refused(self):
        shutil.copytree(self.source, self.destination)
        os.link(self.destination / "database.sqlite", self.root / "extra-link")
        with self.assertRaises(ValueError):
            self.copy(apply=True)
        (self.root / "extra-link").unlink()
        lstat = Path.lstat
        def unknown(path, *args, **kwargs):
            info = lstat(path, *args, **kwargs)
            if path == self.destination / "database.sqlite":
                return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0, st_nlink=0)
            return info
        with patch.object(Path, "lstat", unknown), self.assertRaises(ValueError):
            self.copy(apply=True)
        self.assert_source_retained()

    def test_racing_destination_creator_preserved(self):
        mkdir = Path.mkdir
        def race(path, *args, **kwargs):
            if path == self.destination:
                mkdir(path)
                (path / "other-writer.txt").write_text("synthetic preserve", encoding="utf-8")
            return mkdir(path, *args, **kwargs)
        with patch.object(Path, "mkdir", race), self.assertRaises(FileExistsError):
            self.copy(apply=True)
        self.assertEqual((self.destination / "other-writer.txt").read_text(), "synthetic preserve")
        self.assert_source_retained()

    def test_local_source_guard_still_refuses_unc(self):
        with self.assertRaises(ValueError):
            transport.copy_backup_to_unc(UNC, UNC + "-other", apply=True)
        self.mapper.assert_not_called()
        self.assertFalse(self.destination.exists())
        self.assert_source_retained()

    def test_disconnect_during_readback_keeps_completed_remote_attempt(self):
        reader = transport._read_remote
        def disconnect(remote, local, end, **kwargs):
            reader(remote, local, end, **kwargs)
            raise OSError("injected readback disconnect")
        with patch.object(transport, "_read_remote", disconnect), self.assertRaises(OSError):
            self.copy(apply=True)
        self.assertEqual({path.name for path in self.destination.iterdir()}, set(transport.FILES))
        self.assert_source_retained()

    def test_permission_denied_before_copy_preserves_source_without_remote_write(self):
        lstat = Path.lstat
        def denied(path, *args, **kwargs):
            if path == self.parent:
                raise PermissionError("injected remote denial")
            return lstat(path, *args, **kwargs)
        with patch.object(Path, "lstat", denied), self.assertRaises(PermissionError):
            self.copy(apply=True)
        self.assertEqual(list(self.parent.iterdir()), [])
        self.assert_source_retained()

    def test_remote_manifest_change_during_readback_is_detected(self):
        reader = transport._read_remote
        def change(remote, local, end, **kwargs):
            reader(remote, local, end, **kwargs)
            if remote.name == "manifest.json":
                metadata = json.loads(remote.read_text())
                metadata["created_at"] = "2020-01-01T00:00:00Z"
                remote.write_text(json.dumps(metadata), encoding="utf-8")
        with patch.object(transport, "_read_remote", change), self.assertRaisesRegex(ValueError, "changed"):
            self.copy(apply=True)
        self.assertTrue((self.destination / "manifest.json").exists())
        self.assert_source_retained()

    def test_deadline_after_source_verification_prevents_remote_access(self):
        snapshot, expired = replica._snapshot, False
        def verify_then_expire(path):
            nonlocal expired
            result = snapshot(path)
            expired = True
            return result
        with patch.object(transport.time, "monotonic", side_effect=lambda: 31.0 if expired else 0.0), \
                patch.object(replica, "_snapshot", verify_then_expire), self.assertRaises(TimeoutError):
            self.copy(apply=True)
        self.mapper.assert_not_called()
        self.assertEqual(list(self.parent.iterdir()), [])
        self.assert_source_retained()

    def test_explicit_rdp_mode_accepts_unstable_ids_only_in_redirected_drive_namespace(self):
        lstat, observations = Path.lstat, 0
        def unstable(path, *args, **kwargs):
            nonlocal observations
            info = lstat(path, *args, **kwargs)
            if path.is_relative_to(self.parent):
                observations += 1
                return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=getattr(info, "st_file_attributes", 0),
                                       st_nlink=info.st_nlink, st_dev=info.st_dev, st_ino=observations,
                                       st_size=info.st_size, st_mtime_ns=info.st_mtime_ns, st_ctime_ns=info.st_ctime_ns)
            return info
        with patch.object(Path, "lstat", unstable):
            with self.assertRaisesRegex(ValueError, "changed"):
                self.copy(apply=True)
            result = transport.copy_backup_to_unc(self.source, r"\\tsclient\Q\rdp-attempt", apply=True, rdp_drive=True)
            again = transport.copy_backup_to_unc(self.source, r"\\tsclient\Q\rdp-attempt", apply=True, rdp_drive=True)
        self.assertEqual(result["status"], "copied")
        self.assertTrue(result["readback_verified"])
        self.assertEqual(result["metadata_mode"], "rdp-drive")
        self.assertEqual(result["directory_identity_check"], "unavailable")
        self.assertEqual(again["status"], "already_present")
        self.assert_source_retained()

    def test_rdp_flag_cannot_relax_arbitrary_unc_or_local_guards(self):
        for path in (UNC, r"\\tsclient\share\attempt", r"\\tsclient\QQ\attempt", r"\\host\Q\attempt"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                transport.copy_backup_to_unc(self.source, path, apply=True, rdp_drive=True)
        for flag in (None, 1, "true"):
            with self.subTest(flag=flag), self.assertRaises(ValueError):
                transport.copy_backup_to_unc(self.source, r"\\tsclient\Q\attempt", apply=True, rdp_drive=flag)
        with self.assertRaises(ValueError):
            transport.copy_backup_to_unc(UNC, r"\\tsclient\Q\attempt", apply=True, rdp_drive=True)
        self.mapper.assert_not_called()
        self.assertEqual(list(self.parent.iterdir()), [])
        self.assert_source_retained()

    def test_rdp_mode_still_requires_full_readback_hash_and_retains_failure(self):
        writer = transport._write_remote
        def corrupt(path, data, end, **options):
            writer(path, data, end, **options)
            if path.name == "manifest.json":
                database = path.parent / "database.sqlite"
                original = database.stat()
                altered = bytearray(database.read_bytes())
                altered[-1] ^= 1
                database.write_bytes(altered)
                os.utime(database, ns=(original.st_atime_ns, original.st_mtime_ns))
        with patch.object(transport, "_write_remote", corrupt), self.assertRaises(ValueError):
            transport.copy_backup_to_unc(self.source, r"\\tsclient\Q\rdp-attempt", apply=True, rdp_drive=True)
        self.assertTrue((self.parent / "rdp-attempt" / "manifest.json").exists())
        self.assert_source_retained()


if __name__ == "__main__":
    unittest.main()
