"""Read-only adapter: verified existing school bundle -> additive common envelope."""

import argparse
import copy
from decimal import Decimal
import json
from pathlib import Path
import sys

import source_manifest as common
import store
import store_school as school


def adapt(bundle):
    """Return manifest and exact bytes without changing the existing bundle."""
    bundle = Path(bundle)
    snapshot, original = school.verify_bundle(bundle)
    files = {name: (bundle / name).read_bytes() for name in ("manifest.json", "snapshot.json")}
    # The second read must describe the exact version checked by the old validator.
    reread = json.loads(files["manifest.json"], object_pairs_hook=store.reject_duplicate_keys)
    common.require(json.dumps(reread, sort_keys=True, allow_nan=False) == json.dumps(original, sort_keys=True, allow_nan=False),
                   "bundle changed during adaptation")
    common.require(common.digest(files["snapshot.json"]) == original["snapshot_sha256"], "bundle changed during adaptation")
    common.require(json.loads(files["snapshot.json"], parse_float=Decimal,
                              object_pairs_hook=store.reject_duplicate_keys) == snapshot, "bundle changed during adaptation")
    manifest = {
        "format": "local-source-manifest", "format_version": 1,
        "service": "school", "artifact_role": "source-snapshot", "synthetic": True,
        "dataset_version": original["dataset_version"], "source_version": original["source_version"],
        "created_at": original["created_at"],
        "payload": {"format": "school-source-snapshot", "version": str(school.SCHEMA_VERSION), "entrypoint": "snapshot.json"},
        "counts": copy.deepcopy(original["table_counts"]),
        "artifacts": [{"path": name, "media_type": "application/json", "sha256": common.digest(raw)}
                      for name, raw in sorted(files.items())],
        "code": copy.deepcopy(original["code"]),
    }
    # Old producer identity is retained; only the common representation is sorted.
    manifest["code"]["files"].sort(key=lambda entry: entry["path"])
    manifest["code"]["sha256"] = common.code_hash(manifest["code"]["files"])
    common.validate(manifest, files, expected_service="school")
    return manifest, files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    args = parser.parse_args()
    try:
        manifest, _ = adapt(args.bundle)
        print(json.dumps(manifest, ensure_ascii=True, sort_keys=True, indent=2))
    except (ValueError, OSError):
        print("school common manifest: invalid or unreadable bundle", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
