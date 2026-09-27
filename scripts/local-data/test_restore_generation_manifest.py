"""All inputs invented; no real dump, database, credentials, or remote storage."""

import copy
import json
import unittest

import restore_generation_manifest as restore
import source_manifest as common


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def fixture():
    generation = {
        "generation": "synthetic-restore-001", "snapshot": "invented-snapshot-001",
        "app_revision": "a" * 40, "state": "complete", "dump_flags": list(restore.FLAGS),
        "versions": {"server": "17.6", "pg_dump": "18.4", "pg_restore": "18.4"},
        "migrations": [{"id": "200001010001", "sha256": common.digest(b"invented migration")}],
        "baseline_sha256": common.digest(b"invented baseline"),
    }
    files = {"generation.json": encode(generation), "backup.dump": b"synthetic dump placeholder; not pg_restore input"}
    for kind in restore.KINDS:
        entry = {"identity": f"synthetic_{kind}", "sha256": common.digest(f"invented {kind}".encode())}
        if kind == "data":
            entry["rows"] = 2
        files[f"{kind}.json"] = encode({"generation": generation["generation"], "snapshot": generation["snapshot"],
                                        "kind": kind, "entries": [entry]})
    code = [{"path": "scripts/synthetic-producer.py", "sha256": common.digest(b"synthetic producer")}]
    manifest = {
        "format": "local-source-manifest", "format_version": 1, "service": "school",
        "artifact_role": "source-snapshot", "synthetic": True,
        "dataset_version": generation["generation"], "source_version": generation["snapshot"],
        "created_at": "2026-09-28T00:00:00Z",
        "payload": {"format": "synthetic-restore-generation", "version": "1", "entrypoint": "generation.json"},
        "counts": {kind: 1 for kind in restore.KINDS}, "artifacts": [],
        "code": {"identity": "sha256", "files": code, "sha256": common.code_hash(code)},
    }
    return seal(manifest, files)


def seal(manifest, files):
    """Invent a newly reviewed pin; only for testing semantic gates past hashing."""
    manifest["artifacts"] = [{"path": name, "sha256": common.digest(raw),
                               "media_type": "application/octet-stream" if name.endswith(".dump") else "application/json"}
                              for name, raw in sorted(files.items())]
    raw = encode(manifest)
    generation = restore.decode(files["generation.json"])
    expected = {key: generation[key] for key in ("generation", "snapshot", "app_revision")}
    expected["manifest_sha256"] = common.digest(raw)
    completion = {"state": "complete", "generation": expected["generation"],
                  "manifest_sha256": expected["manifest_sha256"],
                  "stored": {**{name: common.digest(data) for name, data in files.items()}, "manifest.json": common.digest(raw)}}
    return raw, files, completion, expected


class RestoreGenerationTests(unittest.TestCase):
    def verify(self, fixture):
        raw, files, completion, expected = fixture
        return restore.validate(raw, files, completion, expected=expected)

    def test_accept_complete_and_do_not_mutate(self):
        inputs = fixture()
        before = copy.deepcopy(inputs)
        self.assertEqual(self.verify(inputs)["generation"], "synthetic-restore-001")
        self.assertEqual(inputs, before)

    def test_reject_missing_extra_changed_and_empty_artifacts(self):
        for name in restore.PATHS:
            for operation in ("missing", "modified", "empty"):
                with self.subTest(name=name, operation=operation):
                    raw, files, receipt, pin = fixture()
                    if operation == "missing":
                        del files[name]
                    else:
                        files[name] = b"changed" if operation == "modified" else b""
                    with self.assertRaises(ValueError):
                        self.verify((raw, files, receipt, pin))
        raw, files, receipt, pin = fixture()
        files["extra.json"] = b"{}"
        with self.assertRaises(ValueError):
            self.verify((raw, files, receipt, pin))

    def test_reject_rehashed_tampering_against_retained_pin(self):
        raw, files, receipt, pin = fixture()
        files["backup.dump"] = b"other synthetic dump"
        changed = seal(restore.decode(raw), files)
        with self.assertRaisesRegex(ValueError, "pin mismatch"):
            restore.validate(*changed[:3], expected=pin)

    def test_reject_mixed_generation_even_when_rehashed(self):
        for kind in restore.KINDS:
            for key in ("generation", "snapshot"):
                with self.subTest(kind=kind, key=key):
                    raw, files, _, _ = fixture()
                    evidence = restore.decode(files[f"{kind}.json"])
                    evidence[key] = "synthetic-other-generation"
                    files[f"{kind}.json"] = encode(evidence)
                    with self.assertRaisesRegex(ValueError, "mixed evidence"):
                        self.verify(seal(restore.decode(raw), files))

    def test_reject_semantically_incomplete_descriptor(self):
        changes = {
            "state": ["capturing", "failed", None], "dump_flags": [[], restore.FLAGS + ["--schema=public"]],
            "versions": [{"server": "18.4", "pg_dump": "17.6", "pg_restore": "17.6"},
                         {"server": "17.6", "pg_dump": "18.4", "pg_restore": "17.6"},
                         {"server": "17", "pg_dump": "18.4", "pg_restore": "18.4"}],
            "app_revision": ["main", ""], "baseline_sha256": ["", "unknown"],
            "migrations": [[], [{"id": "now", "sha256": "0" * 64}],
                           [{"id": "200001010001", "sha256": "0" * 64}] * 2],
        }
        for key, values in changes.items():
            for value in values:
                with self.subTest(key=key, value=value):
                    raw, files, _, _ = fixture()
                    generation = restore.decode(files["generation.json"])
                    generation[key] = value
                    files["generation.json"] = encode(generation)
                    with self.assertRaises(ValueError):
                        self.verify(seal(restore.decode(raw), files))

    def test_reject_incomplete_publication_or_wrong_pin(self):
        for key in ("state", "generation", "manifest_sha256", "stored"):
            raw, files, receipt, pin = fixture()
            receipt[key] = "incomplete"
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.verify((raw, files, receipt, pin))
        for name in (*restore.PATHS, "manifest.json"):
            raw, files, receipt, pin = fixture()
            del receipt["stored"][name]
            with self.subTest(missing_receipt=name), self.assertRaises(ValueError):
                self.verify((raw, files, receipt, pin))
        for key in ("generation", "snapshot", "app_revision"):
            raw, files, receipt, pin = fixture()
            pin[key] = "different"
            with self.subTest(pin=key), self.assertRaises(ValueError):
                self.verify((raw, files, receipt, pin))

    def test_reject_bad_evidence_and_false_counts(self):
        for value in (True, -1, 9007199254740992, "2"):
            raw, files, _, _ = fixture()
            evidence = restore.decode(files["data.json"])
            evidence["entries"][0]["rows"] = value
            files["data.json"] = encode(evidence)
            with self.subTest(rows=value), self.assertRaises(ValueError):
                self.verify(seal(restore.decode(raw), files))
        raw, files, _, _ = fixture()
        manifest = restore.decode(raw)
        manifest["counts"]["schema"] = 2
        with self.assertRaises(ValueError):
            self.verify(seal(manifest, files))
        for entries in ([], [{"identity": "x", "sha256": "0" * 64}] * 2):
            raw, files, _, _ = fixture()
            evidence = restore.decode(files["acl.json"])
            evidence["entries"] = entries
            files["acl.json"] = encode(evidence)
            with self.subTest(entries=entries), self.assertRaises(ValueError):
                self.verify(seal(restore.decode(raw), files))

    def test_reject_real_input_and_unknown_format(self):
        for key, value in (("synthetic", False), ("format_version", 2), ("service", "karuta")):
            raw, files, _, _ = fixture()
            manifest = restore.decode(raw)
            manifest[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.verify(seal(manifest, files))

    def test_reject_duplicate_keys_and_nonfinite_json(self):
        for raw in (b'{"state":1,"state":2}', b'{"x":NaN}', b'{"x":Infinity}', b'\xff'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                restore.decode(raw)


if __name__ == "__main__":
    unittest.main()
