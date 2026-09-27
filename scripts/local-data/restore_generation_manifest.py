"""Synthetic restore-generation contract; no DB, filesystem, keys, or network I/O.

Reuses the common source manifest envelope. The payload is restore evidence, not
a production backup implementation. Hashes and snapshot labels bind supplied
bytes; they do not prove that a real collector used one database snapshot.
"""

import json
import re

import source_manifest as common


KINDS = ("schema", "data", "acl", "rls", "rpc", "provider")
PATHS = {"generation.json", "backup.dump", *(f"{kind}.json" for kind in KINDS)}
FLAGS = ["--format=custom", "--no-owner", "--no-acl"]


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        common.require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def decode(raw):
    common.require(isinstance(raw, bytes), "JSON bytes required")
    try:
        return json.loads(raw, object_pairs_hook=_pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite JSON")))
    except (UnicodeError, json.JSONDecodeError):
        raise ValueError("invalid JSON bytes") from None


def _fields(obj, fields):
    common.require(isinstance(obj, dict) and set(obj) == set(fields.split()), "invalid fields")


def validate(manifest_bytes, files, completion, *, expected):
    """Validate a complete, pinned synthetic generation without mutating inputs.

    expected must be a separately retained reviewed pin, not values copied from
    the candidate during verification. completion models publish-last receipts;
    it is not independently authenticated remote-storage proof.
    """
    _fields(expected, "generation snapshot app_revision manifest_sha256")
    common.require(common.sha_ok(expected["manifest_sha256"]), "invalid trusted pin")
    common.require(common.digest(manifest_bytes) == expected["manifest_sha256"], "manifest pin mismatch")
    manifest = decode(manifest_bytes)
    common.validate(manifest, files, expected_service="school")
    common.require(manifest["artifact_role"] == "source-snapshot", "wrong role")
    common.require(manifest["payload"] == {
        "format": "synthetic-restore-generation", "version": "1", "entrypoint": "generation.json"
    }, "unsupported restore payload")
    common.require(set(files) == PATHS, "incomplete restore artifact set")
    common.require(bool(files["backup.dump"]), "empty dump")
    generation = decode(files["generation.json"])
    _fields(generation, "generation snapshot app_revision state dump_flags versions migrations baseline_sha256")
    common.require(generation["state"] == "complete", "incomplete capture")
    for key in ("generation", "snapshot", "app_revision"):
        common.require(common.nonempty(generation[key]) and generation[key] == expected[key], "generation identity mismatch")
    common.require(re.fullmatch(r"[0-9a-f]{40}", generation["app_revision"]) is not None, "invalid app revision")
    common.require(manifest["dataset_version"] == generation["generation"]
                   and manifest["source_version"] == generation["snapshot"], "envelope identity mismatch")
    common.require(generation["dump_flags"] == FLAGS, "unsupported dump flags")
    _fields(generation["versions"], "server pg_dump pg_restore")
    for version in generation["versions"].values():
        common.require(isinstance(version, str) and re.fullmatch(r"[1-9][0-9]*\.[0-9]+", version) is not None,
                       "exact numeric version required")
    major = {key: int(value.split(".")[0]) for key, value in generation["versions"].items()}
    common.require(major["server"] <= major["pg_dump"] <= major["pg_restore"], "unsupported version ordering")
    common.require(common.sha_ok(generation["baseline_sha256"]), "baseline identity missing")
    migrations = generation["migrations"]
    common.require(isinstance(migrations, list) and bool(migrations), "migration identities missing")
    ids = []
    for entry in migrations:
        _fields(entry, "id sha256")
        common.require(isinstance(entry["id"], str) and re.fullmatch(r"[0-9]{12}", entry["id"]) is not None
                       and common.sha_ok(entry["sha256"]), "invalid migration identity")
        ids.append(entry["id"])
    common.require(ids == sorted(set(ids)), "migrations must be sorted and unique")
    counts = {}
    for kind in KINDS:
        evidence = decode(files[f"{kind}.json"])
        _fields(evidence, "generation snapshot kind entries")
        common.require(evidence["generation"] == generation["generation"]
                       and evidence["snapshot"] == generation["snapshot"] and evidence["kind"] == kind,
                       "mixed evidence generation")
        common.require(isinstance(evidence["entries"], list) and bool(evidence["entries"]), "empty evidence")
        names = []
        for entry in evidence["entries"]:
            _fields(entry, "identity sha256 rows" if kind == "data" else "identity sha256")
            common.require(common.nonempty(entry["identity"]) and common.sha_ok(entry["sha256"]), "invalid evidence entry")
            names.append(entry["identity"])
            if kind == "data":
                common.require(type(entry["rows"]) is int and 0 <= entry["rows"] <= 9007199254740991, "invalid row count")
        common.require(names == sorted(set(names)), "evidence must be sorted and unique")
        counts[kind] = len(names)
    common.require(manifest["counts"] == counts, "evidence counts mismatch")
    _fields(completion, "state generation manifest_sha256 stored")
    common.require(completion["state"] == "complete" and completion["generation"] == generation["generation"]
                   and completion["manifest_sha256"] == expected["manifest_sha256"], "completion mismatch")
    stored = {name: common.digest(raw) for name, raw in files.items()}
    stored["manifest.json"] = expected["manifest_sha256"]
    common.require(completion["stored"] == stored, "incomplete or changed stored generation")
    return generation
