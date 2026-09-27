"""Synthetic contract rejection and old school bundle compatibility."""

import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import source_manifest as common
import school_common_manifest as adapter
import store_school as school
from school_fixture import synthetic_payload


HERE = Path(__file__).resolve().parent


def fixture():
    files = {"fixture.json": b'{"synthetic":true}\n'}
    code = [{"path": "scripts/fixture.py", "sha256": "0" * 64}]
    return {
        "format": "local-source-manifest", "format_version": 1, "service": "kanji",
        "artifact_role": "source-snapshot", "synthetic": True, "dataset_version": "synthetic-v1",
        "source_version": "invented-v1", "created_at": "2026-09-27T12:00:00Z",
        "payload": {"format": "synthetic-example", "version": "1", "entrypoint": "fixture.json"},
        "counts": {"records": 1},
        "artifacts": [{"path": "fixture.json", "media_type": "application/json", "sha256": common.digest(files["fixture.json"])}],
        "code": {"identity": "sha256", "files": code, "sha256": common.code_hash(code)},
    }, files


class CommonTests(unittest.TestCase):
    def test_valid_explicit_service_and_no_mutation(self):
        manifest, files = fixture()
        before = copy.deepcopy(manifest)
        self.assertEqual(common.validate(manifest, files, expected_service="kanji"), before)
        self.assertEqual(manifest, before)
        with self.assertRaises(ValueError):
            common.validate(manifest, files, expected_service="school")

    def test_reject_metadata_and_unverified_counts(self):
        changes = [("format_version", True), ("format_version", 2), ("synthetic", False),
                   ("synthetic", 1), ("service", "unknown"), ("artifact_role", "backup"),
                   ("dataset_version", " "), ("source_version", None), ("created_at", "2026-09-27"),
                   ("created_at", "2026-09-27T12:00:00"), ("created_at", "2026-02-30T12:00:00Z"),
                   ("created_at", "2026-09-27T12:00:00+01:60"), ("created_at", "2026-09-27T12:00:00+00:99"),
                   ("counts", {}), ("counts", {"rows": True}), ("counts", {"rows": -1}),
                   ("counts", {"rows": 9007199254740992}), ("counts", {"rows": None})]
        for key, value in changes:
            with self.subTest(key=key, value=value):
                manifest, files = fixture()
                manifest[key] = value
                with self.assertRaises(ValueError):
                    common.validate(manifest, files, expected_service="kanji")

    def test_paths_are_canonical_without_filesystem_access(self):
        for path in ("../fixture.json", "/fixture.json", "a//b", "a/./b", "C:/b", "a\\b", "a/%2e/b", "https://a", "a/", "é.json"):
            with self.subTest(path=path):
                manifest, files = fixture()
                manifest["artifacts"][0]["path"] = path
                with self.assertRaises(ValueError):
                    common.validate(manifest, files, expected_service="kanji")

    def test_tampering_and_extra_artifacts_rejected(self):
        manifest, files = fixture()
        for altered in ({"fixture.json": b"tampered"}, {}, {**files, "extra.json": b"{}"}):
            with self.assertRaises(ValueError):
                common.validate(manifest, altered, expected_service="kanji")
        manifest["extra"] = "private metadata"
        with self.assertRaises(ValueError):
            common.validate(manifest, files, expected_service="kanji")

    def test_duplicate_artifacts_code_and_code_hash_rejected(self):
        for section in ("artifacts", "code"):
            manifest, files = fixture()
            entries = manifest[section] if section == "artifacts" else manifest["code"]["files"]
            entries.append(copy.deepcopy(entries[0]))
            with self.assertRaises(ValueError):
                common.validate(manifest, files, expected_service="kanji")
        manifest, files = fixture()
        manifest["code"]["sha256"] = "1" * 64
        with self.assertRaises(ValueError):
            common.validate(manifest, files, expected_service="kanji")


class SchoolAdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="common-school-synthetic-")
        cls.root = Path(cls.temp.name)
        payload = cls.root / "synthetic.json"
        payload.write_text(json.dumps(synthetic_payload()), encoding="utf-8")
        for args in (("import", "--input", payload, "--db", cls.root / "school.sqlite", "--apply"),
                     ("export", "--db", cls.root / "school.sqlite", "--output", cls.root / "bundle")):
            result = subprocess.run([sys.executable, "-B", str(HERE / "store_school.py"), *map(str, args)],
                                    capture_output=True, text=True, timeout=30)
            if result.returncode:
                raise AssertionError(result.stderr)
        cls.bundle = cls.root / "bundle"

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_old_bundle_preserved_and_new_envelope_verifies(self):
        before = {p.name: p.read_bytes() for p in self.bundle.iterdir()}
        manifest, files = adapter.adapt(self.bundle)
        common.validate(manifest, files, expected_service="school")
        self.assertEqual(manifest["payload"]["version"], "3")
        self.assertEqual(len(manifest["counts"]), 25)
        self.assertEqual(len(manifest["code"]["files"]), 15)
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.bundle.iterdir()})
        school.verify_bundle(self.bundle)

    def test_invalid_legacy_bundle_cannot_gain_common_envelope(self):
        with patch.object(school, "verify_bundle", side_effect=ValueError("invalid")):
            with self.assertRaises(ValueError):
                adapter.adapt(self.bundle)

    def test_changed_manifest_types_between_reads_are_rejected(self):
        original = json.loads((self.bundle / "manifest.json").read_text(encoding="utf-8"))
        read_bytes = Path.read_bytes
        cases = [("format_version", True), ("format_version", 1.0), ("count", True)]
        for key, value in cases:
            changed = copy.deepcopy(original)
            if key == "count":
                count_key = next(key for key, count in changed["table_counts"].items() if count == 1)
                changed["table_counts"][count_key] = value
            else:
                changed[key] = value
            def reread(path):
                if path == self.bundle / "manifest.json":
                    return json.dumps(changed).encode()
                return read_bytes(path)
            with self.subTest(key=key, value=value), patch.object(Path, "read_bytes", reread):
                with self.assertRaisesRegex(ValueError, "changed during adaptation"):
                    adapter.adapt(self.bundle)

    def test_readonly_cli_outputs_json_and_redacts_failure_path(self):
        result = subprocess.run([sys.executable, "-B", str(HERE / "school_common_manifest.py"), "--bundle", str(self.bundle)],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["service"], "school")
        result = subprocess.run([sys.executable, "-B", str(HERE / "school_common_manifest.py"), "--bundle", str(self.root / "missing")],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertNotIn(str(self.root), result.stderr)
        self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
