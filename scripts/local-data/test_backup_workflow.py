"""Real CLI workflow with invented data and all products outside the repository."""

from contextlib import closing
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import school_common_manifest
from school_fixture import synthetic_payload
import store
import store_school as school


HERE = Path(__file__).resolve().parent


class BackupWorkflowTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="school-backup-workflow-synthetic-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.assertFalse(self.root.is_relative_to(HERE.parents[1]))
        self.source = self.root / "source.sqlite"
        payload = synthetic_payload()
        payload["tables"] = school.normalize_tables(payload["tables"])
        with closing(store.connect(self.source)) as db:
            school.import_rows(db, payload, fresh=True)

    def cli(self, *args, expected=0, program="school_backup.py"):
        result = subprocess.run([sys.executable, "-B", str(HERE / program), *map(str, args)],
                                cwd=self.root, capture_output=True, text=True, encoding="utf-8", timeout=20)
        self.assertEqual(result.returncode, expected, result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        if expected:
            self.assertNotIn(str(self.root), result.stderr)
        return json.loads(result.stdout) if result.stdout else None

    def test_backup_replica_restore_and_existing_export_agree(self):
        before = hashlib.sha256(self.source.read_bytes()).hexdigest()
        generations = self.root / "generations"
        generations.mkdir()
        generation = generations / "g001"
        original_names = set(self.root.rglob("*"))
        dry = self.cli("create", "--source", self.source, "--output", generation)
        self.assertEqual(dry["status"], "dry_run")
        self.assertEqual(set(self.root.rglob("*")), original_names)
        created = self.cli("create", "--source", self.source, "--output", generation, "--apply")
        checked = self.cli("verify", "--generation", generation)
        self.assertEqual(created["manifest"], checked["manifest"])
        replica = self.root / "replica"
        self.assertEqual(self.cli("replicate", "--generation", generation, "--output", replica)["status"], "dry_run")
        self.assertFalse(replica.exists())
        copied = self.cli("replicate", "--generation", generation, "--output", replica, "--apply")
        self.assertEqual(copied["cloud_sync"], "unverified")
        self.assertEqual(self.cli("replicate", "--generation", generation, "--output", replica, "--apply")["status"], "already_present")
        restored = self.root / "restored.sqlite"
        self.assertEqual(self.cli("restore", "--generation", replica, "--output", restored)["status"], "dry_run")
        self.assertFalse(restored.exists())
        self.cli("restore", "--generation", replica, "--output", restored, "--apply")
        for db, name in ((self.source, "original-bundle"), (restored, "restored-bundle")):
            self.cli("export", "--db", db, "--output", self.root / name, program="store_school.py")
        original = school.verify_bundle(self.root / "original-bundle")
        recovered = school.verify_bundle(self.root / "restored-bundle")
        self.assertEqual(original[0], recovered[0])
        self.assertEqual(original[1]["table_counts"], recovered[1]["table_counts"])
        self.assertEqual(created["manifest"]["snapshot_content_sha256"], recovered[1]["content_sha256"])
        school_common_manifest.adapt(self.root / "restored-bundle")
        self.assertEqual(before, hashlib.sha256(self.source.read_bytes()).hexdigest())
        keep = self.cli("retention", "--root", generations, "--keep", "1")
        self.assertFalse(keep["deletion_performed"])
        self.assertEqual(keep["delete_candidates"], [])

    def test_cli_failures_preserve_existing_and_incomplete_outputs(self):
        generation = self.root / "generation"
        self.cli("create", "--source", self.source, "--output", generation, "--apply")
        before = self.source.read_bytes()
        self.cli("restore", "--generation", generation, "--output", self.source, "--apply", expected=1)
        self.assertEqual(self.source.read_bytes(), before)
        self.cli("create", "--source", self.root / "missing.sqlite", "--output", self.root / "no-output", "--apply", expected=1)
        self.assertFalse((self.root / "missing.sqlite").exists())
        generations = self.root / "incomplete-generations"
        generations.mkdir()
        incomplete = generations / "incomplete"
        incomplete.mkdir()
        (incomplete / "database.sqlite").write_bytes(b"synthetic-corrupt")
        result = self.cli("retention", "--root", generations, "--keep", "1", expected=1)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["delete_candidates"], [])
        self.assertEqual((incomplete / "database.sqlite").read_bytes(), b"synthetic-corrupt")


if __name__ == "__main__":
    unittest.main()
