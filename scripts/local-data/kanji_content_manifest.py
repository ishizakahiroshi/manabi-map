"""Read-only JSON/stdin bridge to the existing common manifest validator.

The TypeScript adapter owns the content schema. This bridge independently checks
metadata against decoded artifact bytes; it does not reimplement that schema.
"""
import base64
import json
from pathlib import Path
import sys

import source_manifest as common


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        common.require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def read_json(raw):
    return json.loads(raw, object_pairs_hook=unique_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite JSON")))


def inspect_artifacts(artifacts):
    common.require(set(artifacts) in ({"dataset.json", "diff.json"},
                                     {"dataset.json", "diff.json", "previous.json"}), "unexpected artifacts")
    data = read_json(artifacts["dataset.json"].decode("utf-8"))
    common.require(set(data) == {"datasetVersion", "sourceVersion", "dataset"}, "invalid envelope")
    payload = data["dataset"]
    common.require(payload["format"] == "kanji-content-preparation"
                   and type(payload["schemaVersion"]) is int and payload["schemaVersion"] == 1
                   and payload["synthetic"] is True, "invalid content format")
    counts = {name: len(payload[name]) for name in ("sources", "characters", "collections")}
    counts.update({"facts_" + state: 0 for state in
                   ("available", "not_collected", "unverified", "not_applicable")})
    facts = [row[field] for row in payload["characters"]
             for field in ("readings", "strokeCount", "radical", "meanings", "strokes")]
    facts.extend(row["members"] for row in payload["collections"])
    for fact in facts:
        counts["facts_" + fact["state"]] += 1
    return data, counts


def run(request):
    common.require(isinstance(request, dict), "object required")
    operation = request.get("operation")
    fields = {"operation", "artifacts", "counts", "codeFiles", "createdAt"} if operation == "create" else {"operation", "artifacts", "manifest"}
    common.require(operation in ("create", "verify") and set(request) == fields, "invalid bridge request")
    artifacts = {path: base64.b64decode(raw, validate=True) for path, raw in request["artifacts"].items()}
    data, counts = inspect_artifacts(artifacts)
    if operation == "create":
        common.require(request["counts"] == counts, "adapter count mismatch")
        # Hash the code actually executing here, not just the caller's assertion.
        files = request["codeFiles"]
        for name in ("kanji_content_manifest.py", "source_manifest.py"):
            expected = {"path": "scripts/local-data/" + name,
                        "sha256": common.digest(Path(__file__).with_name(name).read_bytes())}
            common.require(expected in files, "bridge code identity mismatch")
        manifest = {
            "format": "local-source-manifest", "format_version": 1, "service": "kanji",
            "artifact_role": "published-dataset", "synthetic": True,
            "dataset_version": data["datasetVersion"], "source_version": data["sourceVersion"],
            "created_at": request["createdAt"],
            "payload": {"format": "kanji-content-preparation", "version": "1", "entrypoint": "dataset.json"},
            "counts": counts,
            "artifacts": [{"path": path, "media_type": "application/json", "sha256": common.digest(raw)}
                          for path, raw in sorted(artifacts.items())],
            "code": {"identity": "sha256", "files": files, "sha256": common.code_hash(files)},
        }
    else:
        manifest = request["manifest"]
    common.validate(manifest, artifacts, expected_service="kanji")
    common.require(manifest["artifact_role"] == "published-dataset", "wrong candidate role")
    common.require(manifest["counts"] == counts, "payload count mismatch")
    common.require(manifest["dataset_version"] == data["datasetVersion"]
                   and manifest["source_version"] == data["sourceVersion"], "payload version mismatch")
    common.require(manifest["payload"] == {"format": "kanji-content-preparation", "version": "1",
                                           "entrypoint": "dataset.json"}, "payload descriptor mismatch")
    common.require(all(entry["media_type"] == "application/json" for entry in manifest["artifacts"]), "media type mismatch")
    return manifest


if __name__ == "__main__":
    try:
        result = run(read_json(sys.stdin.buffer.read().decode("utf-8")))
        sys.stdout.buffer.write((json.dumps(result, ensure_ascii=True, sort_keys=True) + "\n").encode("ascii"))
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        print("Manifest validation failed: " + str(error), file=sys.stderr)
        sys.exit(1)
