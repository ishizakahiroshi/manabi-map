"""Invented SQLite sources only; no real keys, source files or remote writes."""

from contextlib import closing
import hashlib
import gzip
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import backup_school_live as backup
from school_fixture import synthetic_payload
import store_core
import store_school


HEADER = b"age-encryption.org/v1\n"


class FakeCodec:
    """Transport stand-in, deliberately NOT cryptographic verification."""
    workspaces = []
    plaintexts = []

    def __init__(self, **kwargs):
        self.workspaces.append(Path(kwargs["workspace"]))

    def encrypt(self, plaintext):
        self.plaintexts.append(plaintext)
        return HEADER + plaintext

    def decrypt(self, ciphertext):
        return ciphertext[len(HEADER):]


class SchoolBackupTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="school-backup-test-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.source = self.root / "invented-schools.sqlite"
        FakeCodec.workspaces = []
        FakeCodec.plaintexts = []

    def create(self, *, core=False):
        with closing(sqlite3.connect(self.source)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            if core:
                payload = store_core.load_input(Path(__file__).with_name("example.core.synthetic.json"))
                store_core.import_rows(db, payload, True)
            else:
                payload = synthetic_payload()
                payload["tables"] = store_school.normalize_tables(payload["tables"])
                store_school.import_rows(db, payload, True)

    def prepare(self, **kwargs):
        return backup.prepare_school_backup(self.source, age_executable=self.root / "invented-age.exe",
                                             recipient="age1" + "a" * 58, **kwargs)

    def restore(self, ciphertext, metadata, destination=None, **kwargs):
        return backup.restore_school_backup(ciphertext, metadata, destination or self.root / "restored.sqlite",
            age_executable=self.root / "invented-age.exe", recipient="age1" + "a" * 58,
            identity_path=self.root / "invented-identity", **kwargs)

    def assert_clean(self):
        self.assertTrue(FakeCodec.workspaces)
        self.assertTrue(all(not item.exists() for item in FakeCodec.workspaces))

    @patch.object(backup, "AgeCodec", FakeCodec)
    def test_full_snapshot_hashes_counts_source_unchanged_and_cleanup(self):
        self.create()
        before, info = self.source.read_bytes(), self.source.stat()
        encrypted, metadata = self.prepare()
        plain = gzip.decompress(encrypted[len(HEADER):])
        self.assertTrue(plain.startswith(b"SQLite format 3\x00"))
        self.assertEqual(metadata["source_sha256"], hashlib.sha256(plain).hexdigest())
        self.assertEqual(metadata["ciphertext_sha256"], hashlib.sha256(encrypted).hexdigest())
        self.assertEqual(metadata["source_bytes"], len(plain))
        self.assertEqual(metadata["ciphertext_bytes"], len(encrypted))
        self.assertEqual(metadata["format"], "school-sqlite-gzip-age-v1")
        self.assertEqual(metadata["compression"], "gzip")
        self.assertEqual(metadata["schema_version"], 3)
        self.assertEqual(len(metadata["table_counts"]), 26)
        self.assertGreater(metadata["table_counts"]["schools"], 0)
        self.assertNotIn(str(self.source), json.dumps(metadata))
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(self.source.stat().st_mtime_ns, info.st_mtime_ns)
        recovered = self.root / "recovered.sqlite"
        recovered.write_bytes(plain)
        with closing(sqlite3.connect(recovered)) as db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone(), ("ok",))
            self.assertEqual(db.execute("SELECT purpose FROM source_metadata").fetchone(), (store_school.PURPOSE,))
        self.assert_clean()

    @patch.object(backup, "AgeCodec", FakeCodec)
    def test_core_contract_and_optional_full_apply_receipts(self):
        self.create(core=True)
        self.assertEqual(self.prepare()[1]["schema_version"], 2)
        self.source.unlink()
        self.create()
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("CREATE TABLE source_apply_receipts (request_id TEXT PRIMARY KEY NOT NULL, "
                       "request_sha256 TEXT NOT NULL, document TEXT NOT NULL) STRICT")
        self.assertEqual(self.prepare()[1]["table_counts"]["source_apply_receipts"], 0)
        self.assert_clean()

    @patch.object(backup, "AgeCodec", FakeCodec)
    def test_matching_school_schema_does_not_require_fake_synthetic_marker(self):
        self.create()
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("UPDATE source_metadata SET purpose='school-source'")
        encrypted, _ = self.prepare()
        recovered = self.root / "recovered.sqlite"
        recovered.write_bytes(gzip.decompress(encrypted[len(HEADER):]))
        with closing(sqlite3.connect(recovered)) as db:
            self.assertEqual(db.execute("SELECT purpose FROM source_metadata").fetchone(), ("school-source",))
            db.row_factory = sqlite3.Row
            with self.assertRaises(ValueError):
                store_school.check_metadata(db)  # Synthetic export remains closed.

    @patch.object(backup, "AgeCodec", FakeCodec)
    def test_reject_arbitrary_sqlite_before_encryption(self):
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("CREATE TABLE private_notes (text TEXT)")
        with self.assertRaisesRegex(backup.SchoolBackupError, "inventory"):
            self.prepare()
        self.assertEqual(FakeCodec.plaintexts, [])
        self.assert_clean()

    @patch.object(backup, "AgeCodec", FakeCodec)
    def test_unexpected_user_table_view_trigger_and_changed_columns_rejected(self):
        for sql in ("CREATE TABLE private_notes (text TEXT)",
                    "CREATE VIEW private_notes AS SELECT name FROM schools",
                    "CREATE TRIGGER private_notes AFTER INSERT ON schools BEGIN SELECT 1; END",
                    "ALTER TABLE schools ADD COLUMN private_note TEXT"):
            with self.subTest(sql=sql):
                if self.source.exists():
                    self.source.unlink()
                self.create()
                with closing(sqlite3.connect(self.source)) as db, db:
                    db.execute(sql)
                with self.assertRaises(backup.SchoolBackupError):
                    self.prepare()
        self.assertEqual(FakeCodec.plaintexts, [])
        self.assert_clean()

    @patch.object(backup, "AgeCodec", FakeCodec)
    def test_foreign_key_corruption_rejected(self):
        self.create()
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("UPDATE school_departments SET school_id='invented-missing-school'")
        with self.assertRaisesRegex(backup.SchoolBackupError, "foreign key"):
            self.prepare()
        self.assert_clean()

    @patch.object(backup, "AgeCodec", FakeCodec)
    def test_unimported_empty_school_and_unknown_metadata_version_rejected(self):
        self.create()
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("UPDATE source_metadata SET schema_version=900")
        with self.assertRaisesRegex(backup.SchoolBackupError, "metadata"):
            self.prepare()
        self.source.unlink()
        with closing(sqlite3.connect(self.source)) as db, db:
            store_school.create_schema(db, synthetic_payload())
        with self.assertRaisesRegex(backup.SchoolBackupError, "no imported"):
            self.prepare()
        self.assert_clean()

    @patch.object(backup, "AgeCodec", FakeCodec)
    def test_corrupt_file_fails_without_exposing_input_or_path(self):
        self.source.write_bytes(b"invented-private-file-content")
        with self.assertRaises(backup.SchoolBackupError) as caught:
            self.prepare()
        self.assertNotIn("invented", str(caught.exception))
        self.assertNotIn(str(self.root), str(caught.exception))
        self.assert_clean()

    @patch.object(backup, "AgeCodec", FakeCodec)
    def test_plaintext_and_ciphertext_limit_and_invalid_limits(self):
        self.create()
        size = self.source.stat().st_size
        for maximum in (1, 0, True, backup.DEFAULT_MAX_BYTES + 1):
            with self.subTest(maximum=maximum), self.assertRaises(backup.SchoolBackupError):
                self.prepare(max_bytes=maximum)
        for maximum in (size - 1, 0, True, backup.MAX_SOURCE_BYTES + 1):
            with self.subTest(source_maximum=maximum), self.assertRaises(backup.SchoolBackupError):
                self.prepare(source_max_bytes=maximum)
        encrypted, metadata = self.prepare(source_max_bytes=size, max_bytes=size // 2)
        self.assertLess(len(encrypted), size // 2)
        self.assertEqual(metadata["source_bytes"], size)
        for timeout in (0, -1, True, float("nan"), float("inf"), 301):
            with self.subTest(timeout=timeout), self.assertRaises(backup.SchoolBackupError):
                self.prepare(timeout_seconds=timeout)

    @patch.object(backup, "AgeCodec", FakeCodec)
    def test_locked_source_deadline_and_no_encryption(self):
        self.create()
        with closing(sqlite3.connect(self.source)) as locked:
            locked.execute("BEGIN EXCLUSIVE")
            started = time.monotonic()
            with self.assertRaises(backup.SchoolBackupError):
                self.prepare(timeout_seconds=0.05)
            self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(FakeCodec.plaintexts, [])
        self.assert_clean()

    @patch.object(backup, "AgeCodec", FakeCodec)
    def test_late_encryption_success_rejected_and_temp_cleaned(self):
        self.create()
        def late(plain):
            time.sleep(0.08)
            return HEADER + plain
        with patch.object(FakeCodec, "encrypt", side_effect=late):
            with self.assertRaisesRegex(backup.SchoolBackupError, "deadline"):
                self.prepare(timeout_seconds=0.06)
        self.assert_clean()

    @patch.object(backup, "AgeCodec", FakeCodec)
    def test_encryption_failure_sanitized_source_kept_and_temp_cleaned(self):
        self.create()
        before = self.source.read_bytes()
        with patch.object(FakeCodec, "encrypt", side_effect=RuntimeError("invented-private-error")):
            with self.assertRaises(backup.SchoolBackupError) as caught:
                self.prepare()
        self.assertNotIn("private", str(caught.exception))
        self.assertEqual(self.source.read_bytes(), before)
        self.assert_clean()

    @patch.object(backup, "AgeCodec", FakeCodec)
    def test_wal_snapshot_includes_committed_rows_without_checkpoint(self):
        self.create()
        with closing(sqlite3.connect(self.source)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("UPDATE schools SET name='Invented WAL school'")
            writer.commit()
            before = self.source.read_bytes()
            encrypted, _ = self.prepare()
            self.assertEqual(self.source.read_bytes(), before)
            recovered = self.root / "recovered.sqlite"
            recovered.write_bytes(gzip.decompress(encrypted[len(HEADER):]))
            with closing(sqlite3.connect(recovered)) as db:
                self.assertEqual(db.execute("SELECT DISTINCT name FROM schools").fetchall(), [("Invented WAL school",)])
        self.assert_clean()

    @patch.object(backup, "AgeCodec", FakeCodec)
    def test_hardlink_and_relative_source_rejected(self):
        self.create()
        alias = self.root / "alias.sqlite"
        alias.hardlink_to(self.source)
        with self.assertRaisesRegex(backup.SchoolBackupError, "unaliased"):
            self.prepare()
        with self.assertRaises(backup.SchoolBackupError):
            backup.prepare_school_backup(Path("invented.sqlite"), age_executable="unused", recipient="unused")

    @patch.object(backup, "AgeCodec", FakeCodec)
    def test_sidecar_alias_rejected_before_sqlite_reads(self):
        self.create()
        unrelated = self.root / "invented-unrelated"
        unrelated.write_bytes(b"invented contents")
        Path(str(self.source) + "-wal").hardlink_to(unrelated)
        with self.assertRaisesRegex(backup.SchoolBackupError, "unaliased"):
            self.prepare()
        self.assertEqual(unrelated.read_bytes(), b"invented contents")
        self.assertEqual(FakeCodec.workspaces, [])

    @patch.object(backup, "AgeCodec", FakeCodec)
    def test_gzip_deterministic_and_restore_dry_run_then_create_only(self):
        self.create()
        ciphertext, metadata = self.prepare()
        self.assertEqual(ciphertext, self.prepare()[0])
        before = self.source.read_bytes()
        receipt = self.restore(ciphertext, metadata)
        self.assertEqual(receipt["mode"], "dry-run")
        self.assertFalse((self.root / "restored.sqlite").exists())
        self.restore(ciphertext, metadata, apply=True)
        restored = self.root / "restored.sqlite"
        self.assertEqual(hashlib.sha256(restored.read_bytes()).hexdigest(), metadata["source_sha256"])
        with self.assertRaises(backup.SchoolBackupError):
            self.restore(ciphertext, metadata, apply=True)
        with self.assertRaises(backup.SchoolBackupError):
            self.restore(ciphertext, metadata, self.source, apply=True)
        self.assertEqual(self.source.read_bytes(), before)
        self.assert_clean()

    @patch.object(backup, "AgeCodec", FakeCodec)
    def test_legacy_uncompressed_artifact_still_restores(self):
        self.create(core=True)
        cipher, metadata = self.prepare()
        plain = gzip.decompress(cipher[len(HEADER):])
        legacy = HEADER + plain
        metadata.update(format="school-sqlite-age-v1", compression="none",
                        ciphertext_bytes=len(legacy), ciphertext_sha256=hashlib.sha256(legacy).hexdigest())
        self.restore(legacy, metadata, apply=True)
        self.assertEqual((self.root / "restored.sqlite").read_bytes(), plain)

    @patch.object(backup, "AgeCodec", FakeCodec)
    def test_gzip_corruption_truncation_trailing_and_multiple_members_rejected(self):
        self.create()
        cipher, metadata = self.prepare()
        encoded = cipher[len(HEADER):]
        corrupt = encoded[:-8] + bytes([encoded[-8] ^ 1]) + encoded[-7:]
        for invalid in (encoded[:-1], encoded + b"trailing", encoded + gzip.compress(b"extra", mtime=0), corrupt):
            with self.subTest(length=len(invalid)):
                payload = HEADER + invalid
                changed = dict(metadata, ciphertext_bytes=len(payload), ciphertext_sha256=hashlib.sha256(payload).hexdigest())
                with self.assertRaises(backup.SchoolBackupError):
                    self.restore(payload, changed, apply=True)
                self.assertFalse((self.root / "restored.sqlite").exists())
        self.assert_clean()

    @patch.object(backup, "AgeCodec", FakeCodec)
    def test_restore_pins_expansion_limit_format_counts_and_sidecars_fail_closed(self):
        self.create()
        cipher, metadata = self.prepare()
        variants = ({"source_sha256": "0" * 64}, {"source_bytes": metadata["source_bytes"] - 1},
                    {"source_bytes": metadata["source_bytes"] + 1}, {"ciphertext_bytes": len(cipher) + 1},
                    {"compression": "none"}, {"schema_version": True},
                    {"table_counts": dict(metadata["table_counts"], schools=True)},
                    {"table_counts": dict(metadata["table_counts"], schools=999)})
        for fields in variants:
            with self.subTest(fields=list(fields)), self.assertRaises(backup.SchoolBackupError):
                self.restore(cipher, dict(metadata, **fields), apply=True)
            self.assertFalse((self.root / "restored.sqlite").exists())
        with self.assertRaises(backup.SchoolBackupError):
            self.restore(cipher, metadata, source_max_bytes=metadata["source_bytes"] - 1, apply=True)
        sidecar = self.root / "restored.sqlite-wal"
        sidecar.write_bytes(b"invented unrelated sidecar")
        with self.assertRaises(backup.SchoolBackupError):
            self.restore(cipher, metadata, apply=True)
        self.assertEqual(sidecar.read_bytes(), b"invented unrelated sidecar")

    @patch.object(backup, "AgeCodec", FakeCodec)
    def test_restore_interrupted_link_cleans_own_output_and_preserves_competitor(self):
        self.create()
        cipher, metadata = self.prepare()
        real = os.link
        def fail_after(source, target):
            real(source, target)
            raise OSError("invented private failure")
        with patch.object(backup.os, "link", side_effect=fail_after):
            with self.assertRaises(backup.SchoolBackupError):
                self.restore(cipher, metadata, apply=True)
        self.assertFalse((self.root / "restored.sqlite").exists())
        def compete(source, target):
            Path(target).write_bytes(b"invented other owner")
            real(source, target)
        with patch.object(backup.os, "link", side_effect=compete):
            with self.assertRaises(backup.SchoolBackupError):
                self.restore(cipher, metadata, apply=True)
        self.assertEqual((self.root / "restored.sqlite").read_bytes(), b"invented other owner")
        self.assert_clean()

    @patch.object(backup, "AgeCodec", FakeCodec)
    def test_source_larger_than_64_mib_requires_explicit_limit_and_restores_completely(self):
        self.create()
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("UPDATE schools SET status_note=? WHERE id=(SELECT id FROM schools ORDER BY id LIMIT 1)",
                       ("x" * (65 * 1024 * 1024),))
        self.assertGreater(self.source.stat().st_size, backup.DEFAULT_MAX_BYTES)
        with self.assertRaises(backup.SchoolBackupError):
            self.prepare()
        cipher, metadata = self.prepare(source_max_bytes=backup.MAX_SOURCE_BYTES)
        self.assertGreater(metadata["source_bytes"], backup.DEFAULT_MAX_BYTES)
        self.assertLess(len(cipher), backup.DEFAULT_MAX_BYTES)
        with self.assertRaises(backup.SchoolBackupError):
            self.restore(cipher, metadata, apply=True)
        self.restore(cipher, metadata, source_max_bytes=backup.MAX_SOURCE_BYTES, apply=True)
        with closing(sqlite3.connect(self.root / "restored.sqlite")) as db:
            self.assertEqual(db.execute("SELECT max(length(status_note)) FROM schools").fetchone()[0], 65 * 1024 * 1024)

    @unittest.skipUnless(os.environ.get("MANABI_NATIVE_AGE_BIN"), "explicit native age test directory required")
    def test_native_age_gzip_and_legacy_with_fresh_temporary_identity(self):
        self.create()
        binary = Path(os.environ["MANABI_NATIVE_AGE_BIN"])
        identity = self.root / "invented-private-identity.txt"
        executable = binary / ("age.exe" if os.name == "nt" else "age")
        keygen = binary / ("age-keygen.exe" if os.name == "nt" else "age-keygen")
        env = {k: v for k, v in os.environ.items() if k.upper() in {"SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH"}}
        generated = subprocess.run([str(keygen), "-o", str(identity)], capture_output=True, timeout=20, env=env)
        self.assertEqual(generated.returncode, 0, "temporary native identity generation failed")
        public = subprocess.run([str(keygen), "-y", str(identity)], capture_output=True, timeout=20, env=env)
        self.assertEqual(public.returncode, 0, "temporary public recipient extraction failed")
        recipient = public.stdout.decode("ascii").strip()
        cipher, metadata = backup.prepare_school_backup(self.source, age_executable=executable, recipient=recipient)
        restored = self.root / "native.sqlite"
        backup.restore_school_backup(cipher, metadata, restored, age_executable=executable,
            recipient=recipient, identity_path=identity, apply=True)
        self.assertEqual(hashlib.sha256(restored.read_bytes()).hexdigest(), metadata["source_sha256"])
        damaged = cipher[:-1] + bytes([cipher[-1] ^ 1])
        changed = dict(metadata, ciphertext_sha256=hashlib.sha256(damaged).hexdigest())
        with self.assertRaises(backup.SchoolBackupError):
            backup.restore_school_backup(damaged, changed, self.root / "native-rejected.sqlite",
                age_executable=executable, recipient=recipient, identity_path=identity, apply=True)
        self.assertFalse((self.root / "native-rejected.sqlite").exists())
        codec = backup.AgeCodec(executable=executable, recipient=recipient, workspace=self.root)
        legacy = codec.encrypt(restored.read_bytes())
        old = dict(metadata, format="school-sqlite-age-v1", compression="none", ciphertext_bytes=len(legacy),
                   ciphertext_sha256=hashlib.sha256(legacy).hexdigest())
        backup.restore_school_backup(legacy, old, self.root / "native-old.sqlite", age_executable=executable,
            recipient=recipient, identity_path=identity, apply=True)
        self.assertEqual((self.root / "native-old.sqlite").read_bytes(), restored.read_bytes())


if __name__ == "__main__":
    unittest.main()
