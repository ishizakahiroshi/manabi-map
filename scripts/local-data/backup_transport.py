"""Explicit UNC file transport; SQLite is opened only in local readback storage.

Use a controlled destination directory. This is not an authenticated transport or
a defense against a hostile process continually replacing filesystem ancestors.
Remote metadata must expose regular files, link counts and non-reparse ancestors;
metadata/bytes are checked again after copying. A successful readback establishes
the bytes observed now, not cloud sync, physical media independence or durability
after disconnect/power loss. Failed remote attempts are deliberately never removed.

The timeout is checked between operations, including verification and readback.
Python cannot interrupt a blocking OS/network filesystem call: this is not a hard
wall-clock timeout, and no background writer is started to fake such a guarantee.

The explicit rdp_drive mode is limited to the RDP redirected-drive namespace.
That provider can change file IDs on every stat/open. This mode compares file
size/mtime and full verified bytes, but cannot establish directory identity or
detect replacement by equal content. It therefore requires a controlled directory.
"""

import math
import os
from pathlib import Path, PureWindowsPath
import re
import stat
import tempfile
import time

import backup
import backup_replica as replica


FILES = backup.GENERATION_FILES
CHUNK_SIZE = 1024 * 1024
require = replica._require


def _unc_destination(value):
    """Validate the original spelling before pathlib can erase dot segments."""
    raw = os.fspath(value)
    require(isinstance(raw, str), "UNC destination must be a text path")
    raw = raw.replace("/", "\\")
    require(raw.startswith("\\\\"), "explicit UNC destination required")
    parts = raw[2:].split("\\")
    require(len(parts) >= 3, "destination must be below a UNC share")
    for part in parts:
        require(part not in ("", ".", "..") and not part.endswith((".", " ")),
                "UNC path must not contain empty, dot or trailing-dot/space segments")
        require(not re.search(r'[<>:"|?*\x00-\x1f]', part), "device namespaces and reserved path syntax are not supported")
        stem = part.split(".", 1)[0].rstrip(" ")
        require(not re.fullmatch(r"(?i:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])", stem),
                "device names are not supported")
    parsed = PureWindowsPath(raw)
    require(parsed.is_absolute() and parsed.drive.startswith("\\\\"), "explicit UNC destination required")
    return parsed


def _native_unc(parsed):
    require(os.name == "nt", "UNC transport requires Windows")
    return Path(parsed)


def _deadline(end):
    if time.monotonic() >= end:
        raise TimeoutError("UNC transport deadline exceeded; retain the remote attempt")


def _remote_guard(path, end, *, missing=False, directory=None):
    info = None
    for part in (*reversed(path.parents), path):
        _deadline(end)
        try:
            info = part.lstat()
        except FileNotFoundError:
            require(missing and part == path, "UNC parent must already exist")
            _deadline(end)
            return None
        _deadline(end)
        require(not stat.S_ISLNK(info.st_mode)
                and not (getattr(info, "st_file_attributes", 0)
                         & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)),
                "linked/reparse UNC paths are not supported")
        if part != path or directory is True:
            require(stat.S_ISDIR(info.st_mode), "UNC directory required")
        elif directory is False:
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                    "UNC file must report a regular file with exactly one link")
    return info


def _token(info, *, directory=False, rdp_drive=False):
    if directory:
        return None if rdp_drive else (info.st_dev, info.st_ino)
    if rdp_drive:
        return info.st_size, info.st_mtime_ns
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def _handle_token(info, rdp_drive):
    return _token(info, rdp_drive=True) if rdp_drive else _token(info)[:4]


def _state(destination, end, *, rdp_drive=False):
    info = _remote_guard(destination, end, directory=True)
    _deadline(end)
    names = sorted(path.name for path in destination.iterdir())
    _deadline(end)
    require(names == sorted(FILES), "incomplete or unexpected remote generation; choose a new attempt path")
    files = {name: _token(_remote_guard(destination / name, end, directory=False), rdp_drive=rdp_drive) for name in FILES}
    return _token(info, directory=True, rdp_drive=rdp_drive), files


def _write_remote(path, data, end, *, rdp_drive=False):
    require(_remote_guard(path, end, missing=True) is None, "remote destination file already exists")
    _deadline(end)
    # Exclusive creation, never truncate. Do not unlink even on partial writes.
    with path.open("xb") as outgoing:
        opened = os.fstat(outgoing.fileno())
        require(stat.S_ISREG(opened.st_mode) and opened.st_nlink == 1,
                "UNC file link metadata is unsupported")
        for offset in range(0, len(data), CHUNK_SIZE):
            _deadline(end)
            outgoing.write(data[offset:offset + CHUNK_SIZE])
            _deadline(end)
        outgoing.flush()
        _deadline(end)
        os.fsync(outgoing.fileno())
        _deadline(end)
    after = _remote_guard(path, end, directory=False)
    require(_token(opened, directory=True, rdp_drive=rdp_drive) == _token(after, directory=True, rdp_drive=rdp_drive)
            and after.st_size == len(data), "remote file changed during write")


def _read_remote(remote, local, end, *, limit, exact_size=None, rdp_drive=False):
    before = _remote_guard(remote, end, directory=False)
    require(before.st_size <= limit and (exact_size is None or before.st_size == exact_size),
            "remote file size differs from the verified source")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    _deadline(end)
    descriptor = os.open(remote, flags)
    try:
        opened = os.fstat(descriptor)
        # Windows stat/fstat can expose different ctime meanings. Compare ctime
        # only between path observations; handle identity/size/mtime still agree.
        require(_handle_token(opened, rdp_drive) == _handle_token(before, rdp_drive) and opened.st_nlink == 1,
                "remote file changed while opening")
        incoming = os.fdopen(descriptor, "rb")
    except BaseException:
        os.close(descriptor)
        raise
    total = 0
    with incoming, local.open("xb") as outgoing:
        while True:
            _deadline(end)
            block = incoming.read(CHUNK_SIZE)
            _deadline(end)
            if not block:
                break
            total += len(block)
            require(total <= limit, "remote file grew during readback")
            outgoing.write(block)
        require(_handle_token(os.fstat(incoming.fileno()), rdp_drive) == _handle_token(before, rdp_drive),
                "remote file changed during readback")
    require(total == before.st_size
            and _token(_remote_guard(remote, end, directory=False), rdp_drive=rdp_drive) == _token(before, rdp_drive=rdp_drive),
            "remote file changed during readback")


def _readback(destination, source, end, *, rdp_drive=False):
    state = _state(destination, end, rdp_drive=rdp_drive)
    # Only this local directory is handed to the SQLite verifier.
    temporary_root = replica._path(tempfile.gettempdir())
    with tempfile.TemporaryDirectory(prefix="unc-readback-synthetic-", dir=temporary_root) as temporary:
        local = replica._path(temporary)
        size = len(source[1]["database.sqlite"])
        _read_remote(destination / "database.sqlite", local / "database.sqlite", end, limit=size, exact_size=size, rdp_drive=rdp_drive)
        _read_remote(destination / "manifest.json", local / "manifest.json", end, limit=CHUNK_SIZE, rdp_drive=rdp_drive)
        _deadline(end)
        manifest = backup.verify_backup(local)
        _deadline(end)
        require(replica._canonical(manifest) == replica._canonical(source[0]),
                "remote generation differs from the verified source")
    require(_state(destination, end, rdp_drive=rdp_drive) == state, "remote generation changed during verification")
    return state


def copy_backup_to_unc(generation, destination, *, apply=False, timeout_seconds=30.0, rdp_drive=False):
    """Copy a local verified synthetic generation to an explicit UNC directory.

    The UNC parent must already exist. New destinations are exclusively created;
    completed equal destinations are idempotent only after local readback. Partial
    attempts are retained and refused: a retry must name a new destination.
    Dry-run performs no remote writes. Source files are never written or removed.
    """
    require(type(apply) is bool, "apply must be a boolean")
    require(type(rdp_drive) is bool, "rdp_drive must be a boolean")
    try:
        valid_timeout = type(timeout_seconds) in (int, float) and math.isfinite(timeout_seconds) and timeout_seconds > 0
    except OverflowError:
        valid_timeout = False
    require(valid_timeout,
            "timeout_seconds must be a finite positive number")
    parsed = _unc_destination(destination)
    if rdp_drive:
        require(re.fullmatch(r"\\\\tsclient\\[A-Za-z]", parsed.drive, re.IGNORECASE),
                "rdp_drive mode requires an RDP redirected single-letter drive share")
    observation = {"metadata_mode": "rdp-drive" if rdp_drive else "strict",
                   "directory_identity_check": "unavailable" if rdp_drive else "stat-identity"}
    end = time.monotonic() + timeout_seconds
    generation = replica._path(generation)  # Existing local guard stays in force.
    source = replica._snapshot(generation)
    _deadline(end)
    destination = _native_unc(parsed)
    parent = _token(_remote_guard(destination.parent, end, directory=True), directory=True, rdp_drive=rdp_drive)
    existing = _remote_guard(destination, end, missing=True, directory=True)
    if existing is None:
        replica._unchanged(generation, source)
        _deadline(end)
        require(_token(_remote_guard(destination.parent, end, directory=True), directory=True, rdp_drive=rdp_drive) == parent,
                "remote parent changed")
        if not apply:
            return {"status": "dry_run", "cloud_sync": "unverified", "readback_verified": False, "manifest": source[0], **observation}
        _deadline(end)
        destination.mkdir()  # EEXIST wins over a concurrent writer; never replace.
        _deadline(end)
        created = _token(_remote_guard(destination, end, directory=True), directory=True, rdp_drive=rdp_drive)
        for name in FILES:  # database first, manifest last; never clean up remotely.
            require(_token(_remote_guard(destination, end, directory=True), directory=True, rdp_drive=rdp_drive) == created,
                    "remote destination changed")
            _write_remote(destination / name, source[1][name], end, rdp_drive=rdp_drive)
        status = "copied"
    else:
        status = "already_present"
    state = _readback(destination, source, end, rdp_drive=rdp_drive)
    _deadline(end)
    replica._unchanged(generation, source)
    _deadline(end)
    require(_state(destination, end, rdp_drive=rdp_drive) == state
            and _token(_remote_guard(destination.parent, end, directory=True), directory=True, rdp_drive=rdp_drive) == parent,
            "remote generation or parent changed")
    _deadline(end)
    return {"status": status, "cloud_sync": "unverified", "readback_verified": True, "manifest": source[0], **observation}
