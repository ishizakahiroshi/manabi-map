"""Service-neutral, synthetic-only artifact manifest. No I/O in validation."""

from datetime import datetime
import hashlib
import json
import re


SERVICES = {"school", "land", "kanji", "karuta"}
FIELDS = {"format", "format_version", "service", "artifact_role", "synthetic",
          "dataset_version", "source_version", "created_at", "payload", "counts", "artifacts", "code"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def code_hash(files):
    return digest(json.dumps(files, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii"))


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def path_ok(value):
    return (isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_./-]+", value) is not None
            and all(part not in ("", ".", "..") for part in value.split("/")))


def sha_ok(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def entries_ok(entries, fields):
    require(isinstance(entries, list) and bool(entries), "nonempty entries required")
    paths = []
    for entry in entries:
        require(isinstance(entry, dict) and set(entry) == fields, "invalid entry fields")
        require(path_ok(entry["path"]) and sha_ok(entry["sha256"]), "invalid path or hash")
        paths.append(entry["path"])
    require(paths == sorted(paths) and len(paths) == len(set(paths)), "paths must be sorted and unique")


def validate(manifest, artifact_bytes, *, expected_service):
    """Verify metadata and exact artifact bytes; service semantics remain adapter-owned.

    artifact_bytes is an explicit path->bytes mapping, never a filesystem root.
    Code hashes identify claimed producer files, not current checkout verification.
    """
    require(expected_service in SERVICES, "unsupported expected service")
    require(isinstance(manifest, dict) and set(manifest) == FIELDS, "invalid manifest fields")
    require(manifest["format"] == "local-source-manifest" and type(manifest["format_version"]) is int
            and manifest["format_version"] == 1, "unsupported manifest format")
    require(manifest["service"] == expected_service, "service mismatch")
    require(manifest["artifact_role"] in ("source-snapshot", "published-dataset"), "unsupported artifact role")
    require(manifest["synthetic"] is True, "only synthetic candidates supported")
    require(all(nonempty(manifest[key]) for key in ("dataset_version", "source_version", "created_at")),
            "versions and timestamp required")
    stamp = manifest["created_at"]
    require(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)", stamp) is not None,
            "timezone-qualified ISO timestamp required")
    try:
        datetime.fromisoformat(stamp)
    except ValueError:
        raise ValueError("invalid timestamp") from None
    payload = manifest["payload"]
    require(isinstance(payload, dict) and set(payload) == {"format", "version", "entrypoint"}, "invalid payload fields")
    require(nonempty(payload["format"]) and nonempty(payload["version"]) and path_ok(payload["entrypoint"]), "invalid payload")
    counts = manifest["counts"]
    require(isinstance(counts, dict) and bool(counts), "counts required")
    require(all(isinstance(key, str) and re.fullmatch(r"[a-z][a-z0-9_]*", key) and type(value) is int
                and 0 <= value <= 9007199254740991 for key, value in counts.items()), "invalid count")
    entries_ok(manifest["artifacts"], {"path", "media_type", "sha256"})
    paths = {entry["path"] for entry in manifest["artifacts"]}
    require(isinstance(artifact_bytes, dict) and set(artifact_bytes) == paths, "artifact set mismatch")
    require(payload["entrypoint"] in paths, "entrypoint missing from artifacts")
    for entry in manifest["artifacts"]:
        require(nonempty(entry["media_type"]), "media type required")
        raw = artifact_bytes[entry["path"]]
        require(isinstance(raw, bytes) and digest(raw) == entry["sha256"], "artifact hash mismatch")
    code = manifest["code"]
    require(isinstance(code, dict) and set(code) == {"identity", "files", "sha256"}
            and code["identity"] == "sha256", "invalid code identity")
    entries_ok(code["files"], {"path", "sha256"})
    require(sha_ok(code["sha256"]) and code_hash(code["files"]) == code["sha256"], "code identity hash mismatch")
    return manifest
