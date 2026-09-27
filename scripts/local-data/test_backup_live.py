import contextlib
import io
import hashlib
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

import backup_live


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = {"version": 1, "local_root": str(self.root / "local"),
                       "drive_root": str(self.root / "drive"), "archive_root": str(self.root / "archive"),
                       "school_source": None}
        self.secret = {"R2_ACCOUNT_ID": "synthetic", "R2_BUCKET": "synthetic",
                       "R2_ACCESS_KEY_ID": "synthetic", "R2_SECRET_ACCESS_KEY": "do-not-log-this"}
        self.calls = []

    def modules(self, *, fetch_fails=False, drive_fails=False):
        calls = self.calls
        class Client:
            def __init__(self, **kwargs):
                pass
            def fetch_latest_nightly(self):
                calls.append("fetch")
                if fetch_fails:
                    raise RuntimeError("do-not-log-this")
                return b"age-encryption.org/v1\nsynthetic", {"key": "nightly/2030-01-01.dump.gz.age"}
            def upload_school(self, payload, metadata):
                calls.append("upload-school")
                return {"verified": True}
        def latest(root, name, payload, metadata, **kwargs):
            calls.append(("latest", name, root.name))
            if drive_fails and root.name == "drive":
                raise OSError("do-not-log-this")
            return {"verified": True}
        def archive(root, name, payload, metadata, **kwargs):
            calls.append(("archive", name, kwargs["apply_retention"]))
            return {"verified": True}
        def prepare(*args, **kwargs):
            calls.append("prepare-school")
            return b"age-encryption.org/v1\nsynthetic-school", {"format": "school-sqlite-age-v1"}
        return {"backup_r2_live": types.SimpleNamespace(BackupR2Client=Client),
                "backup_local_store": types.SimpleNamespace(save_latest=latest, archive_generation=archive,
                                                            read_latest=lambda *args, **kwargs: None),
                "backup_school_live": types.SimpleNamespace(prepare_school_backup=prepare)}

    def test_missing_school_does_not_block_nightly(self):
        with patch.dict(sys.modules, self.modules()):
            result = backup_live.run(self.config, self.secret, prune=True)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["school"]["snapshot"]["status"], "pending_source")
        self.assertIn(("archive", "supabase", True), self.calls)
        self.assertNotIn("prepare-school", self.calls)
        self.assertNotIn("upload-school", self.calls)

    def test_acquisition_failure_never_overwrites_copies(self):
        with patch.dict(sys.modules, self.modules(fetch_fails=True)):
            result = backup_live.run(self.config, self.secret, only="supabase")
        self.assertEqual(result["status"], "failed")
        self.assertEqual(self.calls, ["fetch"])
        self.assertNotIn("do-not-log-this", json.dumps(result))
        self.assertFalse((self.root / "local" / "supabase.latest.age").exists())

    def test_drive_failure_does_not_skip_independent_archive(self):
        with patch.dict(sys.modules, self.modules(drive_fails=True)):
            result = backup_live.run(self.config, self.secret, only="supabase")
        self.assertEqual(result["supabase"]["local"]["status"], "ok")
        self.assertEqual(result["supabase"]["drive_copy"]["status"], "failed")
        self.assertEqual(result["supabase"]["archive"]["status"], "ok")
        self.assertEqual(result["cloud_sync"], "unverified")

    def test_school_upload_is_separate_from_nightly(self):
        self.config.update(school_source=str(self.root / "source.sqlite"),
                           age_executable=str(self.root / "age"), recipient="synthetic")
        with patch.dict(sys.modules, self.modules()):
            result = backup_live.run(self.config, self.secret, only="school")
        self.assertEqual(result["status"], "ok")
        self.assertNotIn("fetch", self.calls)
        self.assertIn("upload-school", self.calls)

    def test_dry_run_does_not_read_credentials_or_make_directories(self):
        config_file = self.root / "config.json"
        config_file.write_text(json.dumps(self.config), encoding="utf-8")
        output = io.StringIO()
        with patch.object(backup_live, "run", side_effect=AssertionError("must not execute")), contextlib.redirect_stdout(output):
            code = backup_live.main(["--config", str(config_file)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())["writes"], 0)
        self.assertFalse((self.root / "local").exists())

    def test_working_source_cannot_be_inside_sync_backup_root(self):
        self.config["school_source"] = str(self.root / "drive" / "working.sqlite")
        config_file = self.root / "config.json"
        config_file.write_text(json.dumps(self.config), encoding="utf-8")
        with self.assertRaises(ValueError):
            backup_live.load_config(config_file)

    def test_concurrent_run_rejected_before_fetch_and_through_report_write(self):
        modules = self.modules()
        entered, proceed = threading.Event(), threading.Event()
        writing, finish = threading.Event(), threading.Event()
        results = []
        original_fetch = modules["backup_r2_live"].BackupR2Client.fetch_latest_nightly
        original_report = backup_live._write_report
        def fetch(client):
            entered.set()
            if not proceed.wait(5):
                raise AssertionError("test fetch deadline")
            return original_fetch(client)
        def report(root, result):
            writing.set()
            if not finish.wait(5):
                raise AssertionError("test report deadline")
            original_report(root, result)
        modules["backup_r2_live"].BackupR2Client.fetch_latest_nightly = fetch
        with patch.dict(sys.modules, modules), patch.object(backup_live, "_write_report", report):
            worker = threading.Thread(target=lambda: results.append(backup_live.run(self.config, self.secret, only="supabase")))
            worker.start()
            try:
                self.assertTrue(entered.wait(3))
                with self.assertRaisesRegex(ValueError, "already active"):
                    backup_live.run(self.config, self.secret, only="supabase")
                self.assertEqual(self.calls, [])
                proceed.set()
                self.assertTrue(writing.wait(3))
                with self.assertRaisesRegex(ValueError, "already active"):
                    backup_live.run(self.config, self.secret, only="supabase")
                self.assertEqual(self.calls.count("fetch"), 1)
            finally:
                proceed.set()
                finish.set()
                worker.join(5)
            self.assertFalse(worker.is_alive())
        self.assertEqual(json.loads((self.root / "local" / "last-run.json").read_text()), results[0])

    def test_os_process_lock_released_after_forced_exit(self):
        root = backup_live._ensure_root(self.config["local_root"])
        code = ("import sys; from pathlib import Path; from backup_live import _run_lock; "
                "lock=_run_lock(Path(sys.argv[1])); lock.__enter__(); "
                "print('locked',flush=True); sys.stdin.read()")
        process = subprocess.Popen([sys.executable, "-B", "-c", code, str(root)],
                                   cwd=Path(backup_live.__file__).parent, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(), "locked")
            with self.assertRaisesRegex(ValueError, "already active"):
                with backup_live._run_lock(root):
                    self.fail("second process acquired lock")
            process.kill()
            process.wait(timeout=5)
            # A persistent empty file is not a stale logical lock.
            self.assertTrue((root / ".backup-run.lock").exists())
            with backup_live._run_lock(root):
                pass
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)

    def test_unchanged_school_reuses_cipher_but_source_or_recipient_change_does_not(self):
        from backup_local_store import read_latest
        self.config.pop("archive_root")
        self.config.update(school_source=str(self.root / "source.sqlite"),
                           age_executable=str(self.root / "age"), recipient="invented-recipient-a")
        modules = self.modules()
        del modules["backup_local_store"]  # Exercise actual latest-pair validation.
        state = {"source": "a" * 64, "number": 0, "compression": "gzip"}
        uploaded = []
        def prepare(*args, **kwargs):
            state["number"] += 1
            payload = b"age-encryption.org/v1\n" + bytes([state["number"]]) * 80
            return payload, {"format": "school-sqlite-gzip-age-v1", "source_sha256": state["source"],
                             "source_bytes": 100000, "schema_version": 3, "compression": state["compression"],
                             "ciphertext_sha256": hashlib.sha256(payload).hexdigest(),
                             "ciphertext_bytes": len(payload), "created_at": "2030-01-01T00:00:00Z"}
        def upload(client, payload, metadata):
            uploaded.append(payload)
            return {"verified": True}
        modules["backup_school_live"].prepare_school_backup = prepare
        modules["backup_r2_live"].BackupR2Client.upload_school = upload
        with patch.dict(sys.modules, modules):
            first = backup_live.run(self.config, self.secret, only="school")
            same = backup_live.run(self.config, self.secret, only="school")
            state["source"] = "b" * 64
            changed = backup_live.run(self.config, self.secret, only="school")
            self.config["recipient"] = "invented-recipient-b"
            rotated = backup_live.run(self.config, self.secret, only="school")
            state["compression"] = "none"
            encoding_changed = backup_live.run(self.config, self.secret, only="school")
        self.assertEqual([item["status"] for item in (first, same, changed, rotated, encoding_changed)], ["ok"] * 5)
        self.assertEqual([item["school"]["snapshot"]["reused"] for item in (first, same, changed, rotated, encoding_changed)],
                         [False, True, False, False, False])
        self.assertEqual(uploaded[0], uploaded[1])
        self.assertNotEqual(uploaded[1], uploaded[2])
        self.assertNotEqual(uploaded[2], uploaded[3])
        self.assertNotEqual(uploaded[3], uploaded[4])
        self.assertEqual(read_latest(self.root / "drive", "school")["payload"], uploaded[4])

    def test_source_limit_is_separate_validated_and_forwarded_only_to_school(self):
        self.config.update(source_max_bytes=256 * 1024 * 1024, school_source=str(self.root / "source.sqlite"),
                           age_executable=str(self.root / "age"), recipient="invented-recipient")
        path = self.root / "config.json"
        path.write_text(json.dumps(self.config), encoding="utf-8")
        self.assertEqual(backup_live.load_config(path)["source_max_bytes"], 256 * 1024 * 1024)
        modules = self.modules()
        observed = []
        original = modules["backup_school_live"].prepare_school_backup
        def prepare(*args, **kwargs):
            observed.append(kwargs)
            return original(*args, **kwargs)
        modules["backup_school_live"].prepare_school_backup = prepare
        with patch.dict(sys.modules, modules):
            backup_live.run(self.config, self.secret, only="school")
        self.assertEqual(observed[0]["source_max_bytes"], 256 * 1024 * 1024)
        self.assertEqual(observed[0]["max_bytes"], 64 * 1024 * 1024)
        for value in (True, 0, 256 * 1024 * 1024 + 1):
            self.config["source_max_bytes"] = value
            path.write_text(json.dumps(self.config), encoding="utf-8")
            with self.assertRaises(ValueError):
                backup_live.load_config(path)

    def test_redirected_archive_flag_is_boolean_and_only_passed_to_archive(self):
        self.config["rdp_drive"] = True
        modules = self.modules()
        observed = []
        modules["backup_local_store"].archive_generation = lambda *a, **kw: observed.append(kw) or {}
        def latest(*args, **kwargs):
            self.assertNotIn("rdp_drive", kwargs)
            return {}
        modules["backup_local_store"].save_latest = latest
        with patch.dict(sys.modules, modules):
            backup_live.run(self.config, self.secret, only="supabase")
        self.assertTrue(observed[0]["rdp_drive"])
        config_file = self.root / "config.json"
        config_file.write_text(json.dumps(self.config), encoding="utf-8")
        self.assertTrue(backup_live.load_config(config_file)["rdp_drive"])
        self.config["rdp_drive"] = "true"
        config_file.write_text(json.dumps(self.config), encoding="utf-8")
        with self.assertRaises(ValueError):
            backup_live.load_config(config_file)


if __name__ == "__main__":
    unittest.main()
