"""Synthetic school ID candidates only: no registry connection or publication.

Previous IDs are retained, including their original department membership. Hashes
detect corruption, not authorization. Checks cover every school/department row;
the reused bundle validator checks envelope, projected types and source hashes.
This is not a new validator for all relationships in the thirteen-table snapshot.
Filesystem checks cover ordinary replacement, not hostile ancestor races.
"""

import argparse
from decimal import Decimal
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

import school_common_manifest
import store
import store_core
import store_school as school


FIELDS = {"format", "format_version", "state", "synthetic", "source", "previous_index_sha256",
          "schools", "departments", "diff", "counts", "index_sha256"}
SOURCE_FIELDS = {"schema_version", "dataset_version", "source_version", "snapshot_content_sha256", "snapshot_sha256"}
require = store.require


def _object(value, fields):
    require(type(value) is dict and set(value) == set(fields), "invalid candidate fields")
    return value


def _hash(value):
    require(type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value), "invalid candidate hash")


def _path(value, *, missing=False):
    path = Path(value)
    require(".." not in path.parts and (not path.drive or path.is_absolute()), "ambiguous path")
    path = Path(os.path.abspath(path))
    require(not str(path).startswith(("\\\\", "//")), "network paths are not supported")
    for part in (*reversed(path.parents), path):
        if missing and part == path and not os.path.lexists(part):
            continue
        info = part.lstat()
        require(not stat.S_ISLNK(info.st_mode)
                and not (getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)),
                "linked paths are not supported")
        if part != path:
            require(stat.S_ISDIR(info.st_mode), "path ancestor must be a directory")
        elif stat.S_ISREG(info.st_mode):
            require(info.st_nlink == 1, "hardlinks are not supported")
    return path


def _identity(path):
    info = path.lstat()
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def _read(path):
    path = _path(path)
    before = _identity(path)
    require(path.is_file(), "regular input file required")
    raw = path.read_bytes()
    require(_identity(_path(path)) == before, "input changed while reading")
    return raw, before


def _parse(raw):
    return json.loads(raw, object_pairs_hook=store.reject_duplicate_keys,
                      parse_constant=store_core.reject_constant)


def _id_rows(rows, *, departments=False):
    require(type(rows) is list, "candidate rows must be lists")
    result = {}
    fields = {"id", "school_id"} if departments else {"id"}
    for raw in rows:
        row = _object(raw, fields)
        store.uuid_value(row["id"], "id")
        require(row["id"] not in result, "duplicate candidate ID")
        if departments:
            store.uuid_value(row["school_id"], "school_id")
        result[row["id"]] = row["school_id"] if departments else None
    require(list(result) == sorted(result), "candidate rows must be sorted by ID")
    return result


def _id_list(value, allowed):
    require(type(value) is list, "candidate difference must be a list")
    for item in value:
        store.uuid_value(item, "difference ID")
        require(item in allowed, "difference references an unknown ID")
    require(value == sorted(set(value)), "candidate difference must be sorted and unique")
    return set(value)


def validate_index(candidate):
    """Validate every candidate row; accept neither extra business fields nor real data declarations."""
    item = _object(candidate, FIELDS)
    require(item["format"] == "school-id-index-candidate" and type(item["format_version"]) is int
            and item["format_version"] == 1 and item["state"] == "candidate"
            and item["synthetic"] is True, "unsupported candidate format/state")
    source = _object(item["source"], SOURCE_FIELDS)
    require(type(source["schema_version"]) is int and source["schema_version"] == school.SCHEMA_VERSION,
            "unsupported source schema")
    for key in ("dataset_version", "source_version"):
        store_core.value_for_storage(source[key], "nonempty")
    for key in ("snapshot_content_sha256", "snapshot_sha256"):
        _hash(source[key])
    previous = item["previous_index_sha256"]
    if previous is not None:
        _hash(previous)
    schools = _id_rows(item["schools"])
    departments = _id_rows(item["departments"], departments=True)
    require(all(parent in schools for parent in departments.values()), "orphan candidate department")
    counts = _object(item["counts"], {"schools", "departments"})
    diff = _object(item["diff"], {"added", "retained_absent"})
    for value in diff.values():
        _object(value, {"schools", "departments"})
    for name, rows in (("schools", schools), ("departments", departments)):
        require(type(counts[name]) is int and counts[name] == len(rows), "candidate count mismatch")
        added = _id_list(diff["added"][name], rows)
        retained = _id_list(diff["retained_absent"][name], rows)
        require(not (added & retained), "candidate difference overlaps")
        if previous is None:
            require(added == set(rows) and not retained, "initial candidate difference mismatch")
    _hash(item["index_sha256"])
    require(item["index_sha256"] == school.content_hash({key: value for key, value in item.items() if key != "index_sha256"}),
            "candidate content hash mismatch")
    return candidate


def verify_index(path):
    """Read a strict previous candidate; never read a DB or configuration."""
    raw, _ = _read(path)
    return validate_index(_parse(raw))


def _prepare(bundle, previous):
    bundle = _path(bundle)
    require(bundle.is_dir(), "bundle directory required")
    identity = _identity(bundle)[:2]
    paths = [bundle / name for name in ("snapshot.json", "manifest.json")]
    before = {path: _read(path) for path in paths}
    _, verified = school_common_manifest.adapt(bundle)
    require(all(before[path][0] == verified[path.name] for path in paths), "bundle changed during verification")
    snapshot = json.loads(verified["snapshot.json"], parse_float=Decimal,
                          parse_constant=store_core.reject_constant, object_pairs_hook=store.reject_duplicate_keys)
    manifest = _parse(verified["manifest.json"])
    current_schools = {}
    current_departments = {}
    # Extract only permitted IDs from every row, including inactive schools.
    for row in snapshot["tables"]["schools"]:
        store.uuid_value(row["id"], "school ID")
        require(row["id"] not in current_schools, "duplicate snapshot school ID")
        current_schools[row["id"]] = None
    for row in snapshot["tables"]["school_departments"]:
        store.uuid_value(row["id"], "department ID")
        store.uuid_value(row["school_id"], "school ID")
        require(row["id"] not in current_departments, "duplicate snapshot department ID")
        require(row["school_id"] in current_schools, "orphan snapshot department")
        current_departments[row["id"]] = row["school_id"]
    old = None
    if previous is not None:
        previous = _path(previous)
        before[previous] = _read(previous)
        old = validate_index(_parse(before[previous][0]))
    old_schools = _id_rows(old["schools"]) if old else {}
    old_departments = _id_rows(old["departments"], departments=True) if old else {}
    for key, parent in current_departments.items():
        require(key not in old_departments or old_departments[key] == parent, "department membership changed")
    all_schools = old_schools | current_schools
    all_departments = old_departments | current_departments
    candidate = {
        "format": "school-id-index-candidate", "format_version": 1, "state": "candidate", "synthetic": True,
        "source": {"schema_version": snapshot["schema_version"], "dataset_version": snapshot["dataset_version"],
                   "source_version": snapshot["source_version"], "snapshot_content_sha256": manifest["content_sha256"],
                   "snapshot_sha256": manifest["snapshot_sha256"]},
        "previous_index_sha256": old["index_sha256"] if old else None,
        "schools": [{"id": key} for key in sorted(all_schools)],
        "departments": [{"id": key, "school_id": all_departments[key]} for key in sorted(all_departments)],
        "diff": {"added": {"schools": sorted(current_schools.keys() - old_schools.keys()),
                            "departments": sorted(current_departments.keys() - old_departments.keys())},
                 "retained_absent": {"schools": sorted(old_schools.keys() - current_schools.keys()),
                                     "departments": sorted(old_departments.keys() - current_departments.keys())}},
        "counts": {"schools": len(all_schools), "departments": len(all_departments)},
    }
    candidate["index_sha256"] = school.content_hash(candidate)
    validate_index(candidate)

    def unchanged():
        require(_identity(_path(bundle))[:2] == identity, "bundle directory replaced")
        for path, saved in before.items():
            require(_read(path) == saved, "candidate input changed")

    unchanged()
    return candidate, unchanged, bundle


def build_index(bundle, previous=None):
    """Build in memory, retaining all prior IDs and refusing department reassignment."""
    return _prepare(bundle, previous)[0]


def write_index(bundle, output, previous=None, *, apply=False):
    """Default is write-free. Apply exclusively publishes one complete new candidate file."""
    require(type(apply) is bool, "apply must be a boolean")
    output = _path(output, missing=True)
    require(not os.path.lexists(output), "candidate destination exists")
    candidate, unchanged, bundle = _prepare(bundle, previous)
    require(not output.is_relative_to(bundle), "candidate output must be outside input bundle")
    if not apply:
        return {"status": "dry_run", "index": candidate}
    raw = (json.dumps(candidate, sort_keys=True, ensure_ascii=True, indent=2, allow_nan=False) + "\n").encode()
    # Same-directory temporary file and exclusive hardlink avoid partial output names.
    parent_id = _identity(output.parent)[:2]
    with tempfile.TemporaryDirectory(prefix=".school-id-index-", dir=output.parent) as temporary:
        staged = Path(temporary) / "candidate.json"
        with staged.open("xb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        require(verify_index(staged) == candidate, "staged candidate mismatch")
        file_id = _identity(staged)[:2]
        unchanged()
        require(_identity(_path(output.parent))[:2] == parent_id, "destination parent changed")
        try:
            os.link(staged, output)
            staged.unlink()
            require(verify_index(output) == candidate, "published candidate mismatch")
            unchanged()
            require(_identity(_path(output.parent))[:2] == parent_id, "destination parent changed")
        except BaseException:
            # link may have succeeded even if interrupted before returning.
            # Ownership comes from the pre-link inode, never a completion flag.
            try:
                if staged.exists() and _identity(staged)[:2] == file_id:
                    staged.unlink()
                if _identity(_path(output))[:2] == file_id:
                    output.unlink()
            except (ValueError, OSError):
                pass
            raise
    return {"status": "candidate_written", "index": candidate}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--previous", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = write_index(args.bundle, args.output, args.previous, apply=args.apply)
    except (ValueError, OSError):
        print("school ID candidate rejected: check bundle, previous candidate and new local destination", file=sys.stderr)
        return 1
    try:
        print(json.dumps({"status": result["status"], "counts": result["index"]["counts"],
                          "index_sha256": result["index"]["index_sha256"]}, sort_keys=True))
    except OSError:
        print("Candidate reporting failed; verify the output before retrying.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
