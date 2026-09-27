"""Explicit synthetic school backup operations; writes require --apply."""

import argparse
import json
from pathlib import Path
import sqlite3
import sys

import backup
import backup_replica


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="operation", required=True)
    create = sub.add_parser("create", help="inspect or create a new generation")
    create.add_argument("--source", type=Path, required=True)
    create.add_argument("--output", type=Path, required=True)
    create.add_argument("--apply", action="store_true")
    verify = sub.add_parser("verify", help="verify one completed generation")
    verify.add_argument("--generation", type=Path, required=True)
    for name in ("restore", "replicate"):
        command = sub.add_parser(name, help="inspect or write a separate new output")
        command.add_argument("--generation", type=Path, required=True)
        command.add_argument("--output", type=Path, required=True)
        command.add_argument("--apply", action="store_true")
    remote = sub.add_parser("replicate-remote", help="copy to an explicit UNC destination and verify local readback")
    remote.add_argument("--generation", type=Path, required=True)
    remote.add_argument("--output", required=True)
    remote.add_argument("--timeout-seconds", type=float, default=30.0)
    remote.add_argument("--rdp-drive", action="store_true", help="explicit tsclient drive mode for nonpersistent RDP file IDs")
    remote.add_argument("--apply", action="store_true")
    retain = sub.add_parser("retention", help="list retention candidates; never delete")
    retain.add_argument("--root", type=Path, required=True)
    retain.add_argument("--keep", type=int, required=True)
    args = parser.parse_args(argv)
    try:
        if args.operation == "create":
            manifest = backup.create_backup(args.source, args.output, apply=args.apply)
            result = {"status": "created" if args.apply else "dry_run", "manifest": manifest}
        elif args.operation == "verify":
            result = {"status": "verified", "manifest": backup.verify_backup(args.generation)}
        elif args.operation == "restore":
            manifest = backup.restore_backup(args.generation, args.output, apply=args.apply)
            result = {"status": "restored" if args.apply else "dry_run", "manifest": manifest}
        elif args.operation == "replicate":
            result = backup_replica.replicate_backup(args.generation, args.output, apply=args.apply)
        elif args.operation == "replicate-remote":
            import backup_transport
            result = backup_transport.copy_backup_to_unc(
                args.generation, args.output, apply=args.apply,
                timeout_seconds=args.timeout_seconds, rdp_drive=args.rdp_drive)
        else:
            result = backup_replica.retention_plan(args.root, args.keep)
    except (ValueError, OSError, sqlite3.Error, TimeoutError):
        print(json.dumps({"operation": args.operation, "status": "rejected",
                          "message": "Verify input, completed generation, destination and access. Remote failures can leave a partial copy; retain the local generation."}), file=sys.stderr)
        return 1
    try:
        print(json.dumps(result, sort_keys=True, ensure_ascii=True, allow_nan=False))
    except OSError:
        # Reporting can fail after a write is committed. Never delete the output
        # or describe it as rolled back; the caller can use verify to observe it.
        print("Result reporting failed; operation may have completed. Verify its output.", file=sys.stderr)
        return 1
    return 1 if result["status"] == "blocked" else 0


if __name__ == "__main__":
    raise SystemExit(main())
