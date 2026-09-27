"""Explicit local replicas and read-only retention plans for synthetic backups.

Local verification never establishes cloud synchronization. Callers must use a
controlled local directory; these checks detect ordinary concurrent replacement,
not an attacker continuously replacing filesystem ancestors during system calls.
There is deliberately no deletion API or default retention count.
"""

import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
from datetime import datetime

import backup
import store


FILES = ("database.sqlite", "manifest.json")
ERRORS = (ValueError, OSError, sqlite3.Error, TimeoutError)


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _canonical(value):
    # JSON equality must distinguish bool/int/float metadata values.
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _path(value):
    path = Path(value)
    _require(".." not in path.parts, "parent traversal is not allowed")
    _require(not path.drive or path.is_absolute(), "drive-relative paths are not supported")
    path = Path(os.path.abspath(path))
    _require(not str(path).startswith(("\\\\", "//")), "network paths are not supported")
    for part in (*reversed(path.parents), path):
        _require(not part.is_symlink() and not part.is_junction(), "linked paths are not supported")
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        _require(not (getattr(info, "st_file_attributes", 0)
                      & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)), "reparse paths are not supported")
    return path


def _identity(path, *, directory=False):
    _path(path)
    info = path.lstat()
    if directory:
        _require(stat.S_ISDIR(info.st_mode), "expected a directory")
        return info.st_dev, info.st_ino
    _require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "expected an unlinked regular file")
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def _names(directory):
    return sorted(p.name for p in directory.iterdir())


def _snapshot(generation):
    generation = _path(generation)
    directory_id = _identity(generation, directory=True)
    _require(_names(generation) == sorted(FILES), "incomplete or unexpected generation files")
    before = {name: _identity(generation / name) for name in FILES}
    manifest = backup.verify_backup(generation)
    data = {name: (generation / name).read_bytes() for name in FILES}
    # verify_backup rejects duplicate keys, wrong types and unsupported metadata.
    _require(_canonical(json.loads(data["manifest.json"], object_pairs_hook=store.reject_duplicate_keys)) == _canonical(manifest),
             "generation metadata changed during verification")
    _require(hashlib.sha256(data["database.sqlite"]).hexdigest() == manifest["database_sha256"],
             "generation database changed during verification")
    _require(_canonical(backup.verify_backup(generation)) == _canonical(manifest),
             "generation metadata changed during verification")
    after = {name: _identity(generation / name) for name in FILES}
    _require(before == after and directory_id == _identity(generation, directory=True)
             and _names(generation) == sorted(FILES), "generation changed during verification")
    return manifest, data, (directory_id, after)


def _unchanged(generation, snapshot):
    current = _snapshot(generation)
    _require(current[2] == snapshot[2] and _canonical(current[0]) == _canonical(snapshot[0])
             and current[1] == snapshot[1], "generation changed during operation")


def _write_new(path, data, owned):
    with path.open("xb") as stream:
        info = os.fstat(stream.fileno())
        owned[path.name] = (info.st_dev, info.st_ino)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def _cleanup(destination, directory_id, owned):
    """Remove only this attempt's files, never a replacement or unrelated file."""
    try:
        if _identity(destination, directory=True) != directory_id:
            return
        for name, file_id in reversed(list(owned.items())):
            path = destination / name
            if _identity(path)[:2] == file_id:
                path.unlink()
        destination.rmdir()  # Refuses a nonempty directory; no recursive removal.
    except ERRORS:
        # Preserve the original error. A replaced/nonempty directory is retained.
        pass


def replicate_backup(generation, destination, *, apply=False):
    """Verify and copy a generation locally; default is a write-free dry run.

    The destination's parent must exist. A completed identical destination is
    idempotent; a partial or different destination is refused, never overwritten.
    """
    _require(type(apply) is bool, "apply must be a boolean")
    generation, destination = _path(generation), _path(destination)
    _require(generation != destination and not destination.is_relative_to(generation),
             "destination must be separate from the source generation")
    parent_id = _identity(destination.parent, directory=True)
    source = _snapshot(generation)
    if destination.exists():
        existing = _snapshot(destination)
        _require(_canonical(existing[0]) == _canonical(source[0])
                 and existing[1]["database.sqlite"] == source[1]["database.sqlite"],
                 "destination contains a different generation")
        _unchanged(generation, source)
        _unchanged(destination, existing)
        return {"status": "already_present", "cloud_sync": "unverified", "manifest": source[0]}
    _unchanged(generation, source)
    _require(_identity(destination.parent, directory=True) == parent_id, "destination parent changed")
    if not apply:
        return {"status": "dry_run", "cloud_sync": "unverified", "manifest": source[0]}

    _path(destination)
    destination.mkdir()  # Exclusive: a racing creator cannot be overwritten.
    directory_id = _identity(destination, directory=True)
    owned = {}
    try:
        for name in FILES:  # manifest is the last file written.
            _require(_identity(destination, directory=True) == directory_id, "destination changed")
            _write_new(destination / name, source[1][name], owned)
        copied = _snapshot(destination)
        _require(_canonical(copied[0]) == _canonical(source[0]) and copied[1] == source[1],
                 "replica does not match source")
        _unchanged(generation, source)
        _unchanged(destination, copied)
        _require(_identity(destination.parent, directory=True) == parent_id, "destination parent changed")
    except BaseException:
        _cleanup(destination, directory_id, owned)
        raise
    return {"status": "copied", "cloud_sync": "unverified", "manifest": source[0]}


def retention_plan(root, keep):
    """Inspect direct child generations without creating or deleting anything.

    Any invalid child or concurrent change blocks *all* deletion candidates.
    Keep is an explicit positive integer; timestamps (not directory names) order
    candidates, with directory names breaking ties deterministically.
    """
    _require(type(keep) is int and keep >= 1, "keep must be an explicit positive integer")
    root = _path(root)
    root_id = _identity(root, directory=True)
    names = _names(root)
    snapshots, rows, blocked = {}, [], []
    for name in names:
        try:
            child = _path(root / name)
            _require(child.parent == root, "generation must be a direct child")
            snapshot = _snapshot(child)
            stamp = datetime.fromisoformat(snapshot[0]["created_at"].replace("Z", "+00:00"))
            _require(stamp.utcoffset() is not None, "generation timestamp must include a timezone")
            snapshots[name] = snapshot
            rows.append((name, stamp))
        except ERRORS:
            blocked.append(name)
    for name, snapshot in snapshots.items():
        try:
            _unchanged(root / name, snapshot)
        except ERRORS:
            blocked.append(name)
    try:
        _require(root_id == _identity(root, directory=True) and names == _names(root), "root changed")
    except ERRORS:
        blocked.append(".")
    rows.sort(key=lambda row: row[0])
    rows.sort(key=lambda row: row[1], reverse=True)
    return {"status": "blocked" if blocked else "planned", "keep": keep,
            "keep_candidates": [name for name, _ in rows[:keep]],
            "delete_candidates": [] if blocked else [name for name, _ in rows[keep:]],
            "blocked_generations": sorted(set(blocked)), "deletion_performed": False,
            "cloud_sync": "unverified"}
