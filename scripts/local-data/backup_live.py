"""Explicit backup runner: school SQLite outward, encrypted nightly dump inward.

No database connection, Google API, ambient credential discovery, or public output.
Dry-run is the default. Credentials enter via stdin only when --apply is requested.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import stat
import sys


def load_config(path):
    raw = Path(path).read_bytes()
    if len(raw) > 65536:
        raise ValueError("configuration too large")
    config = json.loads(raw)
    allowed = {"version", "local_root", "drive_root", "archive_root", "school_source",
               "age_executable", "recipient", "python_executable", "credential_file",
               "secret_helper", "max_bytes", "source_max_bytes", "timeout_seconds", "rdp_drive"}
    if not isinstance(config, dict) or set(config) - allowed or config.get("version") != 1:
        raise ValueError("unsupported configuration")
    for key in ("local_root", "drive_root"):
        if not isinstance(config.get(key), str) or not Path(config[key]).is_absolute():
            raise ValueError("absolute backup roots required")
    roots = [Path(config[k]) for k in ("local_root", "drive_root", "archive_root") if config.get(k)]
    for root in roots:
        if not root.is_absolute() or ".." in root.parts:
            raise ValueError("invalid backup root")
        for other in roots:
            if root != other and (root.is_relative_to(other) or other.is_relative_to(root)):
                raise ValueError("backup roots must be separate")
    if len({os.path.normcase(str(p)) for p in roots}) != len(roots):
        raise ValueError("backup roots must be distinct")
    for key in ("school_source", "age_executable"):
        if config.get(key) and (not isinstance(config[key], str) or not Path(config[key]).is_absolute()):
            raise ValueError("absolute source/tool path required")
    if config.get("school_source"):
        source = Path(config["school_source"])
        if any(source.is_relative_to(root) for root in roots):
            raise ValueError("working source cannot live in backup roots")
    maximum = config.get("max_bytes", 64 * 1024 * 1024)
    timeout = config.get("timeout_seconds", 60)
    if type(maximum) is not int or not 0 < maximum <= 64 * 1024 * 1024:
        raise ValueError("invalid byte limit")
    source_maximum = config.get("source_max_bytes", 64 * 1024 * 1024)
    if type(source_maximum) is not int or not 0 < source_maximum <= 256 * 1024 * 1024:
        raise ValueError("invalid school source byte limit")
    if type(timeout) is not int or not 1 <= timeout <= 300:
        raise ValueError("invalid timeout")
    if type(config.get("rdp_drive", False)) is not bool:
        raise ValueError("invalid redirected archive option")
    return config


def _ensure_root(value, *, allow_unc=False):
    path = Path(value)
    if str(path).startswith(("\\\\", "//")) and not allow_unc:
        raise ValueError("network root must be explicit")
    for part in (*reversed(path.parents), path):
        if part.is_symlink() or part.is_junction():
            raise ValueError("linked backup paths are not supported")
    path.mkdir(parents=True, exist_ok=True)
    return path


@contextmanager
def _run_lock(root):
    """Nonblocking OS lock, released even if the process is killed.

    The empty lock file persists; its existence never denotes ownership. Never
    unlink it: replacing the inode would let another process acquire a new lock.
    Callers must share one dedicated local root for this backup configuration.
    """
    path = root / ".backup-run.lock"
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("invalid backup run lock")
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_BINARY", 0), 0o600)
    locked = False
    try:
        opened, present = os.fstat(descriptor), path.lstat()
        if (not stat.S_ISREG(present.st_mode) or present.st_nlink != 1
                or getattr(present, "st_file_attributes", 0) & 0x400
                or (opened.st_dev, opened.st_ino) != (present.st_dev, present.st_ino)):
            raise ValueError("invalid backup run lock")
        try:
            if os.name == "nt":
                import msvcrt
                # Locking beyond EOF is supported; no write/truncate is needed.
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise ValueError("backup run already active or lock unavailable") from None
        locked = True
        yield
    finally:
        try:
            if locked:
                if os.name == "nt":
                    msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


def _write_report(root, report):
    stage = root / (".run-report-" + os.urandom(8).hex() + ".tmp")
    created = False
    try:
        with stage.open("x", encoding="utf-8") as stream:
            created = True
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(stage, root / "last-run.json")
    finally:
        if created:
            stage.unlink(missing_ok=True)


def run(config, credentials, *, only="all", prune=False):
    """Acquire before fetching/snapshotting; publish the report before release."""
    root = _ensure_root(config["local_root"])
    with _run_lock(root):
        report = _run_unlocked(config, credentials, only=only, prune=prune)
        _write_report(root, report)
        return report


def _run_unlocked(config, credentials, *, only="all", prune=False):
    from backup_local_store import save_latest, archive_generation, read_latest
    from backup_r2_live import BackupR2Client
    from backup_school_live import prepare_school_backup

    client = BackupR2Client(account_id=credentials["R2_ACCOUNT_ID"], bucket=credentials["R2_BUCKET"],
                            access_key=credentials["R2_ACCESS_KEY_ID"], secret_key=credentials["R2_SECRET_ACCESS_KEY"],
                            timeout_seconds=config.get("timeout_seconds", 60),
                            max_bytes=config.get("max_bytes", 64 * 1024 * 1024))
    report = {"format": "local-backup-run-v1", "started_at": datetime.now(timezone.utc).isoformat(),
              "school": {}, "supabase": {}, "cloud_sync": "unverified"}
    failed = False

    def attempt(group, stage, operation):
        nonlocal failed
        try:
            group[stage] = {"status": "ok", "receipt": operation()}
            return True
        except Exception:
            failed = True
            # Never echo provider bodies, credentials, data or arbitrary exception text.
            group[stage] = {"status": "failed", "error": "backup stage failed; previous copy retained where possible"}
            return False

    def copies(name, payload, metadata):
        group = report[name]
        for label, key in (("local", "local_root"), ("drive_copy", "drive_root")):
            attempt(group, label, lambda k=key: save_latest(_ensure_root(config[k]), name, payload, metadata))
        if config.get("archive_root"):
            attempt(group, "archive", lambda: archive_generation(
                _ensure_root(config["archive_root"], allow_unc=True), name, payload, metadata,
                apply_retention=prune, allow_unc=True, rdp_drive=config.get("rdp_drive", False)))
        else:
            group["archive"] = {"status": "not_configured"}

    if only in ("all", "supabase"):
        group = report["supabase"]
        try:
            payload, metadata = client.fetch_latest_nightly()
            metadata = dict(metadata, source_kind="supabase", format="postgres-custom-gzip-age",
                            created_at=datetime.now(timezone.utc).isoformat())
            group["r2_fetch"] = {"status": "ok", "bytes": len(payload),
                                 "sha256": hashlib.sha256(payload).hexdigest(), "key": metadata["key"]}
            copies("supabase", payload, metadata)
        except Exception:
            failed = True
            group["r2_fetch"] = {"status": "failed", "error": "nightly backup acquisition failed"}
    if only in ("all", "school"):
        group = report["school"]
        if not config.get("school_source"):
            group["snapshot"] = {"status": "pending_source", "reason": "school source not configured; no empty database created"}
        else:
            try:
                payload, metadata = prepare_school_backup(
                    config["school_source"], age_executable=config["age_executable"], recipient=config["recipient"],
                    max_bytes=config.get("max_bytes", 64 * 1024 * 1024),
                    source_max_bytes=config.get("source_max_bytes", 64 * 1024 * 1024),
                    timeout_seconds=config.get("timeout_seconds", 60))
                metadata = dict(metadata, source_kind="school")
                metadata["recipient_sha256"] = hashlib.sha256(config["recipient"].encode("ascii")).hexdigest()
                reused = False
                local_root = Path(config["local_root"])
                previous = read_latest(local_root, "school") if local_root.is_dir() else None
                reuse_keys = ("source_sha256", "source_bytes", "format", "compression",
                              "schema_version", "recipient_sha256")
                if previous and all(key in metadata and key in previous["metadata"]
                                    and previous["metadata"][key] == metadata[key] for key in reuse_keys):
                    # age encryption is randomized. Preserve the validated old
                    # ciphertext for an unchanged snapshot and recipient.
                    payload, metadata = previous["payload"], previous["metadata"]
                    reused = True
                group["snapshot"] = {"status": "ok", "bytes": len(payload),
                                     "sha256": hashlib.sha256(payload).hexdigest(), "reused": reused}
                copies("school", payload, metadata)
                attempt(group, "r2_upload", lambda: client.upload_school(payload, metadata))
            except Exception:
                failed = True
                group["snapshot"] = {"status": "failed", "error": "school snapshot preparation failed"}
    report["finished_at"] = datetime.now(timezone.utc).isoformat()
    report["status"] = "failed" if failed else ("partial" if report["school"].get("snapshot", {}).get("status") == "pending_source" else "ok")
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--only", choices=("all", "school", "supabase"), default="all")
    parser.add_argument("--prune", action="store_true", help="Prune only managed archive generations after verified copy")
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
        if not args.apply:
            print(json.dumps({"status": "dry_run", "network_requests": 0, "writes": 0,
                              "school_source_configured": bool(config.get("school_source")),
                              "archive_configured": bool(config.get("archive_root"))}))
            return 0
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ValueError("credential input too large")
        credentials = json.loads(raw)
        required = {"R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"}
        if not isinstance(credentials, dict) or set(credentials) != required:
            raise ValueError("explicit credentials required")
        report = run(config, credentials, only=args.only, prune=args.prune)
        print(json.dumps(report, ensure_ascii=False))
        return 1 if report["status"] == "failed" else 0
    except Exception:
        print(json.dumps({"status": "failed", "error": "backup runner failed; inspect configuration and stage receipt"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
