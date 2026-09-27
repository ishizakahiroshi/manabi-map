"""Explicit private configuration -> bounded school queue work.

Credentials arrive only as a bounded stdin JSON object from run-school-live.ps1.
No secret file parsing, ambient PG credentials, interactive login, queue request
creation, automatic rejection or unsolicited publication. Batch processes only
existing owner-validated requests. Public output contains IDs/kinds/states only.
"""

import argparse
from contextlib import contextmanager
import copy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import uuid

import school_live_controller as controller
import school_live_source as live
from school_live_pg import SchoolLivePg


HELPER_BASENAME = "get-serverpass.ps1"
PG_KEYS = {"PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSSLMODE", "PGSSLROOTCERT"}
CONFIG_KEYS = {"format", "version", "python_executable", "source", "anchor", "history", "state_root",
               "psql_executable", "pg_sslrootcert", "pg_credentials", "publisher_config", "publisher_auth",
               "publisher_credentials", "secret_helper", "allowed_request_ids", "max_bytes", "timeout_seconds"}
MAX_STATE = 8 * 1024 * 1024
STATES = {"received", "claimed", "adopted", "generated", "publication_confirmed", "blocked", "rejected", "dry-run", "skipped"}


class RunnerError(ValueError):
    """Fixed diagnostics only; no credential/config/request values."""


def need(ok):
    if not ok:
        raise RunnerError("school runner configuration or state rejected")


def _ref(value):
    need(type(value) is dict and set(value) == {"path", "sha256"} and live._sha(value["sha256"]))
    live._path(value["path"])
    return value


def _credential_ref(value, required):
    need(type(value) is dict and set(value) == {"file", "section", "keys"})
    # Existence/content of the secret file is intentionally not inspected here.
    need(Path(value["file"]).is_absolute() and type(value["section"]) is str and 0 < len(value["section"]) <= 256)
    need(type(value["keys"]) is dict and set(value["keys"]) == required)
    need(all(type(key) is str and 0 < len(key) <= 128 and "\0" not in key for key in value["keys"].values()))


def load_config(path, expected_sha256=None):
    raw = live._read(path, 65536)
    if expected_sha256 is not None:
        need(live._sha(expected_sha256) and live._hash(raw) == expected_sha256)
    value = live._json(raw)
    need(type(value) is dict and set(value) == CONFIG_KEYS and value["format"] == "school-live-runner"
         and type(value["version"]) is int and value["version"] == 1)
    # The trusted owner selects the canonical installed helper in private
    # configuration. Public code carries no machine-specific installation path.
    helper = live._path(value["secret_helper"])
    need(helper.name.casefold() == HELPER_BASENAME)
    for key in ("python_executable", "psql_executable", "pg_sslrootcert"):
        need(Path(value[key]).is_absolute() and Path(value[key]).is_file())
    live._path(value["source"])
    live._path(value["state_root"], directory=True)
    _ref(value["anchor"])
    _ref(value["history"])
    _credential_ref(value["pg_credentials"], PG_KEYS - {"PGSSLMODE", "PGSSLROOTCERT"})
    need(value["publisher_auth"] in ("wrangler", "explicit-token"))
    if value["publisher_credentials"] is not None:
        _credential_ref(value["publisher_credentials"], {"CLOUDFLARE_API_TOKEN"})
    need((value["publisher_credentials"] is not None) == (value["publisher_auth"] == "explicit-token"))
    if value["publisher_config"] is not None:
        _ref(value["publisher_config"])
    if value["allowed_request_ids"] is not None:
        need(type(value["allowed_request_ids"]) is list and 0 < len(value["allowed_request_ids"]) <= 100)
        for identifier in value["allowed_request_ids"]:
            need(type(identifier) is str and str(uuid.UUID(identifier)) == identifier)
    live._limits(value["max_bytes"], 1)
    need(type(value["timeout_seconds"]) is int and 1 <= value["timeout_seconds"] <= 3600)
    return value


def _state(value, source):
    need(type(value) is dict and set(value) == {"format", "version", "source", "anchor", "history", "completed"})
    need(value["format"] == "school-live-runner-state" and value["version"] == 1 and value["source"] == str(source))
    _ref(value["anchor"])
    need(type(value["history"]) is list and len(value["history"]) <= 1000)
    for reference in value["history"]:
        _ref(reference)
    need(type(value["completed"]) is dict and len(value["completed"]) <= 1000)
    for identifier, status in value["completed"].items():
        need(str(uuid.UUID(identifier)) == identifier and status in ("adopted", "publication_confirmed", "rejected"))
    return value


def read_state(config):
    root, source = Path(config["state_root"]), Path(config["source"])
    target = root / "state.json"
    if os.path.lexists(target):
        return _state(live._json(live._read(target, MAX_STATE)), source)
    history = live._json(controller.pinned(config["history"], MAX_STATE))
    return _state({"format": "school-live-runner-state", "version": 1, "source": str(source),
                   "anchor": config["anchor"], "history": history, "completed": {}}, source)


@contextmanager
def state_lock(root):
    root = live._path(root, directory=True)
    parent_id = live._identity(root)
    target = root / ".school-runner.lock"
    with target.open("xb") as lock:
        lock.write(b"school-live-runner\n")
        lock.flush()
        os.fsync(lock.fileno())
    identity = live._identity(target)
    try:
        yield
    finally:
        live._path(root, directory=True)
        need(live._identity(root) == parent_id and live._identity(target) == identity)
        target.unlink()  # Only this invocation's exclusive lock, never stale locks.


def atomic_state(root, value):
    """Stage+fsync+replace+readback. Restore the owned old bytes on readback failure."""
    root = live._path(root, directory=True)
    root_id = live._identity(root)
    target = root / "state.json"
    previous = live._read(target, MAX_STATE) if os.path.lexists(target) else None
    previous_id = live._identity(target) if previous is not None else None
    raw = (school_json(value) + "\n").encode()
    need(len(raw) <= MAX_STATE)
    staged = None
    identity = None
    replaced = False
    try:
        descriptor, name = tempfile.mkstemp(prefix=".school-state-", suffix=".json", dir=root)
        staged = Path(name)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        identity = live._identity(staged)
        need(live._read(staged, MAX_STATE) == raw)
        live._path(root, directory=True)
        need(live._identity(root) == root_id)
        if previous is None:
            need(not os.path.lexists(target))
        else:
            need(live._identity(target) == previous_id and live._read(target, MAX_STATE) == previous)
        os.replace(staged, target)
        replaced = True
        need(live._read(target, MAX_STATE) == raw)
    except BaseException:
        if replaced and os.path.lexists(target) and live._identity(target) == identity:
            live._path(root, directory=True)
            need(live._identity(root) == root_id)
            if previous is None:
                target.unlink()
            else:
                descriptor, name = tempfile.mkstemp(prefix=".school-state-recover-", suffix=".json", dir=root)
                recovery = Path(name)
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(previous)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(recovery, target)
                need(live._read(target, MAX_STATE) == previous)
        raise
    finally:
        if staged is not None and os.path.lexists(staged) and live._identity(staged) == identity:
            live._path(root, directory=True)
            need(live._identity(root) == root_id)
            staged.unlink()


def school_json(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":"))


def _safe_row(row, state=None):
    need(type(row) is dict and row.get("kind") in ("deviation", "publish"))
    need(type(row.get("request_id")) is str and str(uuid.UUID(row["request_id"])) == row["request_id"])
    status = row.get("state") if state is None else state
    need(status in STATES)
    return {"id": row["request_id"], "kind": row["kind"], "state": status}


def _publisher(config, secrets, factory):
    need(config["publisher_config"] is not None)
    value = live._json(controller.pinned(config["publisher_config"]))
    need(type(value) is dict and type(value.get("env", {})) is dict)
    # Config is explicitly non-secret. Tokens only enter from bounded stdin.
    need(set(value.get("env", {})) <= {"CLOUDFLARE_ACCOUNT_ID", "WRANGLER_SEND_METRICS"})
    explicit = secrets.get("publisher_environment", {})
    need(type(explicit) is dict and set(explicit) <= {"CLOUDFLARE_API_TOKEN"})
    need(bool(explicit) == (config["publisher_auth"] == "explicit-token"))
    value["env"] = {**value.get("env", {}), **explicit}
    if factory is None:
        from school_live_publish import SchoolLivePublisher
        factory = SchoolLivePublisher
    return factory(value)


def execute(config, command, secrets, *, request_id=None, limit=25, apply=False,
            pg_factory=SchoolLivePg, publisher_factory=None):
    need(command in ("list", "run-one", "reject", "batch") and type(apply) is bool)
    need(type(limit) is int and 1 <= limit <= 100)
    need(type(secrets) is dict and set(secrets) == {"pg_environment", "publisher_environment"})
    need(type(secrets["pg_environment"]) is dict and set(secrets["pg_environment"]) == PG_KEYS)
    need(secrets["pg_environment"]["PGSSLMODE"] == "verify-full"
         and secrets["pg_environment"]["PGSSLROOTCERT"] == config["pg_sslrootcert"])
    if command in ("run-one", "reject"):
        need(type(request_id) is str and str(uuid.UUID(request_id)) == request_id)
    else:
        need(request_id is None)
    root, deadline = Path(config["state_root"]), time.monotonic() + config["timeout_seconds"]
    pg = pg_factory(psql_executable=config["psql_executable"], pg_environment=secrets["pg_environment"],
                    allowed_request_ids=config["allowed_request_ids"])
    def remaining():
        seconds = deadline - time.monotonic()
        need(seconds > 0)
        return seconds
    with state_lock(root):
        state = read_state(config)
        if command == "list":
            rows = pg.rpc("list_school_changes", {"p_limit": limit}, timeout_seconds=min(30, remaining()))
            need(type(rows) is list and len(rows) <= limit)
        elif command == "batch":
            rows, cursor, seen = [], None, set()
            # The processing limit is distinct from pagination: completed and
            # blocked rows must not starve later explicit publication requests.
            for _ in range(100):
                page = pg.rpc("list_school_changes", {"p_limit": 100, "p_after_id": cursor},
                              timeout_seconds=min(30, remaining()))
                need(type(page) is list and len(page) <= 100)
                for row in page:
                    _safe_row(row)
                    identifier = row["request_id"]
                    need(identifier not in seen)
                    seen.add(identifier)
                    if row["state"] in ("blocked", "rejected") or state["completed"].get(identifier) == row["state"]:
                        continue
                    rows.append(row)
                    if len(rows) == limit:
                        break
                if len(rows) == limit or not page:
                    break
                cursor = page[-1]["request_id"]
            else:
                raise RunnerError("bounded queue scan exhausted; narrow explicit request scope")
        else:
            rows = [pg.rpc("school_change_worker_payload", {"p_request_id": request_id}, timeout_seconds=min(30, remaining()))]
        if command == "list":
            return {"status": "ok", "command": command, "count": len(rows), "items": [_safe_row(row) for row in rows]}
        results = []
        for row in rows:
            safe = _safe_row(row)
            identifier = row["request_id"]
            if command == "batch" and (row["state"] == "blocked" or
                    state["completed"].get(identifier) == row["state"]):
                results.append({**safe, "state": "skipped"})
                continue  # Never auto-reject blocked work, or repeat an adopted edit.
            common = {"source": config["source"], "anchor": state["anchor"], "history": state["history"],
                      "request_id": identifier, "job_dir": root / ("job-" + identifier), "pg": pg,
                      "mutation": {"new_value_id": str(uuid.uuid4()), "applied_at": datetime.now(timezone.utc).isoformat(),
                                   "dataset_version": "school-change-" + identifier, "source_version": "school-change-" + identifier},
                      "apply": apply, "max_bytes": config["max_bytes"], "timeout_seconds": min(remaining(), 300 if command == "reject" else 3600)}
            if command == "reject":
                outcome = controller.reject_request(**common)
            else:
                publisher = _publisher(config, secrets, publisher_factory) if row["kind"] == "publish" and apply else None
                outcome = controller.run_request(**common, publisher=publisher)
            need(type(outcome) is dict and outcome.get("state") in STATES)
            if apply:
                next_state = copy.deepcopy(state)
                if outcome["state"] == "adopted":
                    entry = _ref(outcome["history_entry"])
                    if entry not in next_state["history"]:
                        next_state["history"].append(entry)
                elif outcome["state"] == "publication_confirmed":
                    job = controller._Job(common["job_dir"], identifier, state["anchor"]["sha256"], create=False)
                    candidate = job.last("candidate")
                    need(candidate is not None and type(candidate.get("anchor_path")) is str)
                    anchor_path = live._path(candidate["anchor_path"])
                    new_anchor = {"path": str(anchor_path), "sha256": live._hash(live._read(anchor_path, MAX_STATE))}
                    generation = controller.anchor_generation(new_anchor, config["max_bytes"])
                    need(generation["source_content_sha256"] == candidate["source_sha256"]
                         and generation["snapshot_content_sha256"] == candidate["snapshot_content_sha256"]
                         and generation["generator_snapshot_sha256"] == candidate["generator_snapshot_sha256"])
                    next_state.update(anchor=new_anchor, history=[])
                    for child in row.get("included_request_ids", []):
                        next_state["completed"][child] = "publication_confirmed"
                need(outcome["state"] in ("adopted", "publication_confirmed", "rejected"))
                next_state["completed"][identifier] = outcome["state"]
                _state(next_state, Path(config["source"]))
                atomic_state(root, next_state)
                state = next_state
            results.append({**safe, "state": outcome["state"]})
            remaining()
        return {"status": "ok", "command": command, "count": len(results), "items": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("validate-config", "list", "run-one", "reject", "batch"))
    parser.add_argument("--config", required=True)
    parser.add_argument("--config-sha256")
    parser.add_argument("--request-id")
    parser.add_argument("--limit", type=int, default=25)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        config = load_config(args.config, args.config_sha256)
        if args.command == "validate-config":
            print('{"status":"ok","command":"validate-config","count":0,"items":[]}')
            return 0
        raw = sys.stdin.buffer.read(65537)
        need(0 < len(raw) <= 65536)
        result = execute(config, args.command, live._json(raw), request_id=args.request_id, limit=args.limit, apply=args.apply)
        print(school_json(result))
        return 0
    except Exception:
        print('{"status":"failed","error":"school runner stopped; reconcile queued work and retained local state"}')
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
