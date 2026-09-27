"""Synthetic metadata readback checks independent of the TypeScript adapter."""
import base64
import copy
import json
from pathlib import Path
import unittest

import kanji_content_manifest as bridge
import source_manifest as common


def fixture():
    missing = {"state": "not_collected", "reason": "Invented fixture reason"}
    character = {"id": "U+4E00", "character": "一", **{
        field: dict(missing) for field in ("readings", "strokeCount", "radical", "meanings", "strokes")}}
    payload = {"datasetVersion": "synthetic-v1", "sourceVersion": "invented-v1", "dataset": {
        "format": "kanji-content-preparation", "schemaVersion": 1, "synthetic": True,
        "characters": [character], "collections": [],
        "sources": [{"id": "invented", "title": "Invented metadata", "kind": "synthetic", "sourceVersion": "v1"}]}}
    files = {"dataset.json": json.dumps(payload).encode(), "diff.json": b'{}'}
    code = [{"path": "scripts/local-data/" + name,
             "sha256": common.digest(Path(__file__).with_name(name).read_bytes())}
            for name in ("kanji_content_manifest.py", "source_manifest.py")]
    return {"operation": "create", "artifacts": {key: base64.b64encode(raw).decode() for key, raw in files.items()},
            "codeFiles": code, "createdAt": "2026-09-27T00:00:00Z",
            "counts": {"sources": 1, "characters": 1, "collections": 0, "facts_available": 0,
                       "facts_not_collected": 5, "facts_unverified": 0, "facts_not_applicable": 0}}


class BridgeTests(unittest.TestCase):
    def test_common_readback_and_counts(self):
        request = fixture()
        manifest = bridge.run(request)
        files = {key: base64.b64decode(raw) for key, raw in request["artifacts"].items()}
        common.validate(manifest, files, expected_service="kanji")
        self.assertEqual(manifest["counts"]["facts_not_collected"], 5)
        self.assertEqual(manifest["dataset_version"], "synthetic-v1")

    def test_wrong_counts_and_versions_despite_valid_common_manifest(self):
        request = fixture()
        manifest = bridge.run(request)
        files = {key: base64.b64decode(raw) for key, raw in request["artifacts"].items()}
        for field, value in (("counts", {"characters": 2}), ("dataset_version", "different"),
                             ("source_version", "different"), ("artifact_role", "source-snapshot"),
                             ("payload", {"format": "wrong", "version": "1", "entrypoint": "dataset.json"})):
            changed = copy.deepcopy(manifest)
            changed[field] = value
            common.validate(changed, files, expected_service="kanji")
            with self.subTest(field=field), self.assertRaises(ValueError):
                bridge.run({"operation": "verify", "manifest": changed, "artifacts": request["artifacts"]})

    def test_bytes_tampering(self):
        request = fixture()
        manifest = bridge.run(request)
        request["artifacts"]["diff.json"] = base64.b64encode(b'{"tampered":true}').decode()
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            bridge.run({"operation": "verify", "manifest": manifest, "artifacts": request["artifacts"]})

    def test_wrong_claimed_code(self):
        request = fixture()
        request["codeFiles"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "code identity"):
            bridge.run(request)

    def test_invalid_json_duplicate_keys_nonfinite(self):
        for raw in ('{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":NaN}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                bridge.read_json(raw)

    def test_no_timestamp_or_version_defaults(self):
        for key, value in (("createdAt", "2026-02-30T00:00:00Z"), ("createdAt", "2026-09-27")):
            request = fixture()
            request[key] = value
            with self.assertRaises(ValueError):
                bridge.run(request)


if __name__ == "__main__":
    unittest.main()
