"""Trusted local orchestration with explicit transports; no installed live adapter.

The caller pins a separately reviewed HTTP observation and its source/export/
generator files. Those pins are a trust root, not authentication manufactured by
this module. Every local adoption edge is verified against the SQLite receipt
and its immutable input before rebasing another request on the same public data.

pg.rpc(name, params, timeout_seconds=...) must be owner-authenticated, bounded,
thread-free and settled on return. publisher.generate/deploy/observe/recover
receive (context, control); long operations MUST call control.checkpoint() at
least every 60 seconds and stop when it raises. Deadlines reject late results;
Python cannot forcibly interrupt a noncooperative injected adapter. No real PG,
credential loader, Node build bridge, Cloudflare bridge or HTTP observer ships
in this file. Supplying mocks proves orchestration only.
"""

from contextlib import closing
from datetime import datetime, timezone
import copy
import json
import math
import os
from pathlib import Path
import time

import school_live_apply as worker
import school_live_source as live
import store
import store_school as school


MAX_RECORD = 8 * 1024 * 1024
MAX_JOURNAL_BYTES = 64 * 1024 * 1024
ORIGINS = {"https://manabi-map.app", "https://school.manabi-map.app"}


class ControllerError(ValueError):
    """Sanitized error; the durable job remains available for reconciliation."""


def need(ok, message="school controller rejected input"):
    if not ok:
        raise ControllerError(message)


def pinned(reference, maximum=MAX_RECORD):
    need(type(reference) is dict and set(reference) == {"path", "sha256"} and live._sha(reference["sha256"]))
    raw = live._read(reference["path"], maximum)
    need(live._hash(raw) == reference["sha256"], "local evidence pin mismatch")
    return raw


def anchor_generation(reference, maximum):
    """Validate all persisted links, anchored in separately trusted observed pins."""
    anchor = live._json(pinned(reference))
    need(type(anchor) is dict and set(anchor) == {"format", "version", "snapshot", "manifest", "export_receipt",
                                                  "generation", "payload", "observation"})
    need(anchor["format"] == "school-live-observed-anchor" and type(anchor["version"]) is int and anchor["version"] == 1)
    raw, manifest_raw = pinned(anchor["snapshot"], maximum), pinned(anchor["manifest"])
    snapshot, manifest = live._verify_bytes(raw, manifest_raw)
    exported, generated, observed = (live._json(pinned(anchor[key])) for key in ("export_receipt", "generation", "observation"))
    payload = pinned(anchor["payload"], maximum)
    need(exported.get("format") == "school-live-export-receipt" and exported.get("mode") == "applied")
    need(exported.get("content_sha256") == manifest["content_sha256"]
         and exported.get("snapshot_sha256") == live._hash(raw) and live._sha(exported.get("source_content_sha256")))
    need(generated.get("format") == "observed-school-json" and generated.get("evidence") == "observed"
         and generated.get("source", {}).get("type") == "sqlite-snapshot")
    origin = generated["source"]
    need(origin.get("snapshotSha256") == live._hash(raw) and origin.get("manifestSha256") == live._hash(manifest_raw)
         and origin.get("contentSha256") == manifest["content_sha256"]
         and origin.get("datasetVersion") == snapshot["dataset_version"] and origin.get("sourceVersion") == snapshot["source_version"])
    need(generated.get("generatorSnapshotSha256") == live._hash(payload))
    artifacts = generated.get("artifacts")
    need(type(artifacts) is list and 0 < len(artifacts) <= 20000
         and school.content_hash(artifacts) == generated.get("artifactsSha256"))
    manifests = [entry for entry in artifacts if entry.get("path") == "schools-manifest.json"]
    need(len(manifests) == 1 and live._sha(manifests[0].get("sha256")))
    need(observed.get("format") == "school-http-observation" and observed.get("evidence") == "observed"
         and observed.get("http_verified") is True and observed.get("destination") in ORIGINS)
    need(observed.get("generator_snapshot_sha256") == live._hash(payload)
         and observed.get("manifest_sha256") == manifests[0]["sha256"]
         and observed.get("artifacts_sha256") == generated["artifactsSha256"]
         and observed.get("artifact_count") == len(artifacts))
    need(type(observed.get("deployment_id")) is str and 0 < len(observed["deployment_id"]) <= 200)
    worker._timestamp(observed.get("observed_at"))
    return {"dataset_version": snapshot["dataset_version"], "source_version": snapshot["source_version"],
            "source_content_sha256": exported["source_content_sha256"], "snapshot_content_sha256": manifest["content_sha256"],
            "generator_snapshot_sha256": generated["generatorSnapshotSha256"]}


def verify_chain(source, anchor, history, deadline, maximum):
    need(type(history) is list and len(history) <= 1000, "bounded adoption history required")
    tip = {key: value for key, value in anchor.items() if key != "generator_snapshot_sha256"}
    receipts, seen = [], set()
    with closing(live._connect(worker._source(source), readonly=True, deadline=deadline)) as db:
        db.execute("BEGIN")
        current = worker._current(db, deadline, maximum)
        for reference in history:
            pinned(reference, worker.INPUT_MAX_BYTES)
            envelope, requested = worker._input(reference["path"], reference["sha256"], "reconcile")
            request_id = envelope["queue_request"]["request_id"]
            need(request_id not in seen, "duplicate history request")
            seen.add(request_id)
            need(envelope["base"]["generator_snapshot_sha256"] == anchor["generator_snapshot_sha256"], "history public generation differs")
            receipt = worker._read_receipt(db, request_id, requested)
            need(receipt is not None, "history receipt missing")
            need(receipt["base"] == {key: value for key, value in envelope["base"].items() if key != "generator_snapshot_sha256"})
            if receipt["outcome"] == "cancelled":
                continue  # A tombstone makes no source-content transition.
            need(receipt["outcome"] == "adopted" and receipt["base"] == tip, "broken adoption receipt chain")
            need(all(receipt["target"][key] == envelope["mutation"][key] for key in ("dataset_version", "source_version")))
            tip = receipt["target"]
            receipts.append({"request_id": request_id, "receipt_sha256": receipt["receipt_sha256"]})
        need(tip == current, "adoption history does not reach current source tip")
    return current, receipts


class _Job:
    """Exclusive local job directory, immutable append-only journal records."""
    def __init__(self, path, request_id, anchor_pin, *, create):
        self.path = Path(path)
        self.records = []
        if not os.path.lexists(self.path):
            live._path(self.path, existing=False, directory=True)
            if not create:
                return
            self.path.mkdir()
        live._path(self.path, directory=True)
        self.identity = live._identity(self.path)
        files = sorted(self.path.iterdir())
        need(len(files) <= 256)
        self.total_bytes = 0
        for index, file in enumerate(files):
            need(file.name == f"{index:04d}.json", "unexpected job file")
            raw = live._read(file, MAX_RECORD)
            self.total_bytes += len(raw)
            need(self.total_bytes <= MAX_JOURNAL_BYTES, "job journal exceeds byte limit")
            record = live._json(raw)
            need(set(record) == {"stage", "data", "previous_sha256"})
            need(record["previous_sha256"] == (school.content_hash(self.records[-1]) if self.records else None), "job journal chain differs")
            self.records.append(record)
        header = {"request_id": request_id, "anchor_sha256": anchor_pin}
        if self.records:
            need(self.records[0] == {"stage": "identity", "data": header, "previous_sha256": None}, "job ownership differs")
        elif create:
            self.add("identity", header)

    def add(self, stage, data):
        live._path(self.path, directory=True)
        need(live._identity(self.path) == self.identity and len(self.records) < 256)
        record = {"stage": stage, "data": copy.deepcopy(data),
                  "previous_sha256": school.content_hash(self.records[-1]) if self.records else None}
        raw = (school.canonical_json(record) + "\n").encode()
        need(self.total_bytes + len(raw) <= MAX_JOURNAL_BYTES, "job journal exceeds byte limit")
        live._write(self.path / f"{len(self.records):04d}.json", raw, MAX_RECORD)
        self.total_bytes += len(raw)
        self.records.append(record)

    def last(self, stage):
        return next((copy.deepcopy(item["data"]) for item in reversed(self.records) if item["stage"] == stage), None)


class _Control:
    def __init__(self, pg, queue, deadline, job, base_sha):
        self.pg, self.queue, self.deadline, self.job, self.base_sha = pg, queue, deadline, job, base_sha
        self.last_renewed = time.monotonic()

    def remaining(self):
        value = self.deadline - time.monotonic()
        need(value > 0, "controller deadline exceeded; reconcile saved job")
        return value

    def rpc(self, name, params):
        result = self.pg.rpc(name, copy.deepcopy(params), timeout_seconds=min(30, self.remaining()))
        self.remaining()
        need(type(result) is dict, "invalid owner transport response")
        return copy.deepcopy(result)

    def claim(self):
        fresh = self.rpc("school_change_worker_payload", {"p_request_id": self.queue["request_id"]})
        _same_request(self.queue, fresh)
        until = worker._timestamp(fresh["lease_until"]) if fresh.get("lease_until") else None
        if until and until > datetime.now(timezone.utc):
            prior = self.job.last("claim")
            need(prior is not None and prior["lease_token"] == fresh.get("lease_token"), "request already leased elsewhere")
            self.queue = fresh
            return
        self.queue = self.rpc("claim_school_change", {"p_request_id": fresh["request_id"],
            "p_expected_revision": fresh["revision"], "p_source_sha256": self.base_sha, "p_lease_seconds": 300})
        _same_request(fresh, self.queue)
        need(self.queue.get("claimed_source_sha256") == self.base_sha)
        self.job.add("claim", self.queue)
        self.last_renewed = time.monotonic()

    def checkpoint(self):
        self.remaining()
        until = worker._timestamp(self.queue["lease_until"]) if self.queue.get("lease_until") else None
        if not until or until <= datetime.now(timezone.utc):
            self.claim()
        elif time.monotonic() - self.last_renewed >= 60 or (until - datetime.now(timezone.utc)).total_seconds() < 120:
            prior = self.queue
            self.queue = self.rpc("renew_school_change_lease", {"p_request_id": prior["request_id"],
                "p_lease_token": prior["lease_token"], "p_expected_revision": prior["revision"], "p_lease_seconds": 300})
            _same_request(prior, self.queue)
            need(self.queue.get("lease_token") == prior["lease_token"])
            self.job.add("claim", self.queue)
            self.last_renewed = time.monotonic()


def _same_request(before, after):
    # publication_request_id on a correction may be assigned later when an
    # admin requests a publication cohort; it is not its immutable edit body.
    keys = (*worker.BODY, "included_request_ids")
    need(all(before.get(key) == after.get(key) for key in keys), "owner request body changed")


def _ack(control, stage, pins, publication=None, applications=None):
    params = {"p_request_id": control.queue["request_id"], "p_lease_token": control.queue["lease_token"],
              "p_stage": stage, "p_source_sha256": pins["source_sha256"]}
    if stage != "adopted":
        params.update({"p_snapshot_content_sha256": pins["snapshot_content_sha256"],
                       "p_manifest_sha256": pins["manifest_sha256"], "p_code_sha256": pins["code_sha256"],
                       "p_application_receipts": applications, "p_publication": publication})
    # One identical retry is safe even when the first response was lost. No new
    # source operation, generation or deployment is repeated here.
    try:
        result = control.rpc("ack_school_change", params)
    except Exception:
        result = control.rpc("ack_school_change", params)
    _same_request(control.queue, result)
    need(result.get("state") == stage and result.get("adopted_source_sha256") == pins["source_sha256"], "ACK receipt differs")
    if stage != "adopted":
        need(all(result.get(key) == pins[key] for key in ("snapshot_content_sha256", "manifest_sha256", "code_sha256"))
             and result.get("application_receipts") == applications, "ACK generation pins differ")
    control.queue = result
    control.job.add(stage, result)
    return result


def _candidate(value, tip):
    need(type(value) is dict and value.get("source_sha256") == tip["source_content_sha256"]
         and value.get("snapshot_content_sha256") == tip["snapshot_content_sha256"], "generated candidate source differs")
    for key in ("manifest_sha256", "code_sha256", "generator_snapshot_sha256", "artifacts_sha256"):
        need(live._sha(value.get(key)))
    need(type(value.get("artifact_count")) is int and 0 < value["artifact_count"] <= 20000)
    return value


def run_request(*, source, anchor, history, request_id, job_dir, pg, publisher=None, mutation=None,
                apply=False, max_bytes=live.DEFAULT_MAX_BYTES, timeout_seconds=1800):
    """Dry-run reads only; apply adopts one correction OR publishes a fixed cohort.

    Public observation/build/upload adapters are required explicit dependencies.
    A rejected final ACK does NOT prove deployment rolled back: the durable job
    requires observation/reconciliation before any subsequent external mutation.
    """
    need(type(apply) is bool and type(timeout_seconds) in (int, float) and math.isfinite(timeout_seconds)
         and 0 < timeout_seconds <= 3600)
    live._limits(max_bytes, 1)
    deadline = time.monotonic() + timeout_seconds
    store.uuid_value(request_id, "request_id")
    try:
        initial = anchor_generation(anchor, max_bytes)
        job = _Job(job_dir, request_id, anchor["sha256"], create=apply)
        queue = pg.rpc("school_change_worker_payload", {"p_request_id": request_id}, timeout_seconds=min(30, timeout_seconds))
        need(type(queue) is dict and queue.get("request_id") == request_id and queue.get("kind") in ("deviation", "publish"))
        need(queue.get("expected_generation") == initial["generator_snapshot_sha256"], "request public generation differs")
        intent = job.last("intent")
        local_history = copy.deepcopy(history)
        # The intent was saved BEFORE local commit. It permits recovery even if
        # process completion/PG ACK was lost and the caller has not added it yet.
        if intent and not any(ref == intent["reference"] for ref in local_history):
            with closing(live._connect(worker._source(source), readonly=True, deadline=deadline)) as db:
                has = db.execute("SELECT 1 FROM sqlite_master WHERE name='source_apply_receipts'").fetchone()
                found = has and db.execute("SELECT 1 FROM source_apply_receipts WHERE request_id=?", (request_id,)).fetchone()
            if found:
                local_history.append(intent["reference"])
        tip, applications = verify_chain(source, initial, local_history, deadline, max_bytes)
        if not apply:
            return {"state": "dry-run", "kind": queue["kind"], "tip": tip, "application_receipts": applications,
                    "checks": ["observed_anchor", "adoption_chain", "current_source_tip", "request_public_generation"],
                    "remote_claim_and_mutation": "not_executed"}
        base_sha = intent["base"]["source_content_sha256"] if intent else tip["source_content_sha256"]
        control = _Control(pg, queue, deadline, job, base_sha)
        if queue["kind"] == "deviation":
            if intent:
                _same_request(intent["queue"], queue)
                result = worker.process_request(source, intent["reference"]["path"], input_sha256=intent["reference"]["sha256"],
                    operation="reconcile", max_bytes=max_bytes, timeout_seconds=min(300, control.remaining())) if any(
                        entry["request_id"] == request_id for entry in applications) else None
                if result and queue.get("state") == "adopted":
                    need(queue.get("adopted_source_sha256") == result["receipt"]["target"]["source_content_sha256"])
                    return {"state": "adopted", "receipt": result["receipt"], "history_entry": intent["reference"]}
            else:
                result = None
            control.claim()
            control.checkpoint()
            base = intent["base"] if intent else {**tip, "generator_snapshot_sha256": initial["generator_snapshot_sha256"]}
            chosen = intent["mutation"] if intent else mutation
            need(type(chosen) is dict, "explicit fixed mutation required")
            envelope = {"format": worker.FORMAT, "format_version": 1, "synthetic": False,
                        "queue_request": control.queue, "base": base, "mutation": chosen, "withdrawal_confirmed": False}
            # Inputs live next to the journal, never in the repository or source.
            raw = (school.canonical_json(envelope) + "\n").encode()
            input_path = job.path.parent / f"{request_id}-{live._hash(raw)}.json"
            if os.path.lexists(input_path):
                need(live._read(input_path, worker.INPUT_MAX_BYTES) == raw)
            else:
                live._write(input_path, raw, worker.INPUT_MAX_BYTES)
            reference = {"path": str(input_path), "sha256": live._hash(raw)}
            if not intent:
                job.add("intent", {"queue": control.queue, "base": base, "mutation": chosen, "reference": reference})
            control.checkpoint()
            result = worker.process_request(source, input_path, input_sha256=reference["sha256"], apply=True,
                max_bytes=max_bytes, timeout_seconds=min(300, control.remaining()))
            receipt = result["receipt"]
            need(receipt["outcome"] == "adopted")
            job.add("local-adoption", receipt)
            control.checkpoint()
            _ack(control, "adopted", {"source_sha256": receipt["target"]["source_content_sha256"]})
            return {"state": "adopted", "receipt": receipt, "history_entry": intent["reference"] if intent else reference}

        need(publisher is not None, "explicit publisher/HTTP adapter required")
        included = queue.get("included_request_ids")
        need(type(included) is list and len(included) <= 100 and len(set(included)) == len(included))
        need(set(included) == {entry["request_id"] for entry in applications}, "publication cohort differs from source history")
        by_id = {entry["request_id"]: entry for entry in applications}
        applications = [by_id[identifier] for identifier in included]
        if queue.get("state") == "publication_confirmed":
            candidate, observation = job.last("candidate"), job.last("observation")
            need(candidate is not None and observation is not None, "confirmed publication needs local observation")
            _candidate(candidate, tip)
            need(all(queue.get(key) == candidate[key] for key in ("snapshot_content_sha256", "manifest_sha256", "code_sha256"))
                 and queue.get("application_receipts") == applications)
            return {"state": "publication_confirmed", "publication": observation, "reconciled": True}
        control.claim()
        context = {"request": copy.deepcopy(control.queue), "source": str(source), "tip": tip,
                   "application_receipts": applications, "job_dir": str(job.path)}
        candidate = job.last("candidate")
        if candidate is None:
            control.checkpoint()
            candidate = _candidate(publisher.generate(copy.deepcopy(context), control), tip)
            control.checkpoint()
            job.add("candidate", candidate)
        _candidate(candidate, tip)
        control.checkpoint()
        if control.queue.get("state") != "generated":
            _ack(control, "generated", candidate, applications=applications)
        else:
            need(all(control.queue.get(key) == candidate[key] for key in ("snapshot_content_sha256", "manifest_sha256", "code_sha256")))
            need(control.queue.get("application_receipts") == applications)
        verify_chain(source, initial, local_history, deadline, max_bytes)
        control.checkpoint()
        preflight = control.rpc("school_publication_preflight", {"p_request_id": request_id,
            "p_lease_token": control.queue["lease_token"], "p_expected_revision": control.queue["revision"],
            "p_source_sha256": candidate["source_sha256"], "p_snapshot_content_sha256": candidate["snapshot_content_sha256"],
            "p_manifest_sha256": candidate["manifest_sha256"], "p_code_sha256": candidate["code_sha256"],
            "p_application_receipts": applications})
        need(preflight.get("request_id") == request_id and preflight.get("revision") == control.queue["revision"]
             and preflight.get("advisory_only") is True
             and worker._timestamp(preflight.get("valid_until")) > datetime.now(timezone.utc), "publication preflight expired")
        checked, valid = worker._timestamp(preflight.get("checked_at")), worker._timestamp(preflight["valid_until"])
        need(0 < (valid - checked).total_seconds() <= 30
             and (checked - datetime.now(timezone.utc)).total_seconds() <= 5, "publication preflight time differs")
        need(all(preflight.get(key) == candidate[key] for key in ("source_sha256", "snapshot_content_sha256", "manifest_sha256", "code_sha256")))
        context.update(request=copy.deepcopy(control.queue), candidate=candidate, preflight=preflight)
        deployment = job.last("deployment")
        if deployment is None:
            if job.last("publishing"):
                deployment = publisher.recover(copy.deepcopy(context), control)
            else:
                job.add("publishing", {"candidate_sha256": school.content_hash(candidate)})
                deployment = publisher.deploy(copy.deepcopy(context), control)
            need(type(deployment) is dict and deployment.get("destination") in ORIGINS
                 and type(deployment.get("deployment_id")) is str and 0 < len(deployment["deployment_id"]) <= 200)
            control.checkpoint()
            job.add("deployment", deployment)
        context["deployment"] = deployment
        observation = publisher.observe(copy.deepcopy(context), control)
        need(type(observation) is dict and set(observation) == {"destination", "deployment_id", "observed_at",
            "manifest_sha256", "artifacts_sha256", "artifact_count", "application_receipts_sha256"})
        need(all(observation[key] == candidate[key] for key in ("manifest_sha256", "artifacts_sha256", "artifact_count")))
        need(all(observation[key] == deployment[key] for key in ("destination", "deployment_id")))
        need(observation["application_receipts_sha256"] == control.queue.get("application_receipts_sha256"))
        worker._timestamp(observation["observed_at"])
        job.add("observation", observation)
        control.checkpoint()
        verify_chain(source, initial, local_history, deadline, max_bytes)
        _ack(control, "publication_confirmed", candidate, publication=observation, applications=applications)
        return {"state": "publication_confirmed", "publication": observation}
    except ControllerError:
        raise
    except Exception:
        raise ControllerError("school controller stopped; reconcile the saved job before retrying external work") from None


def reject_request(*, source, anchor, history, request_id, job_dir, pg, mutation=None,
                   apply=False, max_bytes=live.DEFAULT_MAX_BYTES, timeout_seconds=120):
    """Cancel an unadopted edit, or release an ungenerated publication cohort.

    A source-conflict cancellation records CURRENT source identity but makes no
    source-content transition. It cannot be reused as an adoption lineage edge.
    Adopted edits and generated/publication-uncertain jobs are never rolled back
    or silently released. The owner SQL RPC independently rechecks these rules.
    """
    deadline = live._limits(max_bytes, timeout_seconds)
    need(type(apply) is bool)
    store.uuid_value(request_id, "request_id")
    try:
        initial = anchor_generation(anchor, max_bytes)
        queue = pg.rpc("school_change_worker_payload", {"p_request_id": request_id}, timeout_seconds=min(30, timeout_seconds))
        need(type(queue) is dict and queue.get("request_id") == request_id)
        stale = queue.get("expected_generation") != initial["generator_snapshot_sha256"]
        need(not stale or (queue.get("kind") == "deviation" and live._sha(queue.get("expected_generation"))),
             "publication generation differs")
        job_pin = anchor["sha256"]
        if stale:
            # Cancellation grants no adoption or publication permit. Verify the
            # CURRENT observed anchor/receipt chain before recording a tombstone
            # for an unadopted request from an older public generation.
            verify_chain(source, initial, history, deadline, max_bytes)
            header_path = Path(job_dir) / "0000.json"
            if os.path.lexists(header_path):
                header = live._json(live._read(header_path, MAX_RECORD))
                job_pin = header.get("data", {}).get("anchor_sha256")
                need(live._sha(job_pin))
        job = _Job(job_dir, request_id, job_pin, create=apply)
        need(not any(job.last(stage) for stage in ("candidate", "publishing", "deployment", "observation")),
             "local generation or publication needs reconciliation; cannot release")
        with closing(live._connect(worker._source(source), readonly=True, deadline=deadline)) as db:
            db.execute("BEGIN")
            tip = worker._current(db, deadline, max_bytes)
            has = db.execute("SELECT 1 FROM sqlite_master WHERE name='source_apply_receipts'").fetchone()
            local = db.execute("SELECT document FROM source_apply_receipts WHERE request_id=?", (request_id,)).fetchone() if has else None
        if queue.get("state") == "rejected":
            evidence = job.last("reject-evidence")
            need(evidence is not None and evidence["local_source_sha256"] == tip["source_content_sha256"], "rejected job tip differs")
            return {"state": "rejected", "evidence": evidence, "reconciled": True}
        until = worker._timestamp(queue["lease_until"]) if queue.get("lease_until") else None
        need(not until or until <= datetime.now(timezone.utc), "active worker cannot be rejected")
        need(queue.get("state") in ("received", "claimed", "blocked"), "already adopted or generated; new correction required")
        need(all(queue.get(key) is None for key in ("snapshot_content_sha256", "manifest_sha256", "code_sha256", "application_receipts")),
             "generated request cannot be released")
        intent = job.last("intent")
        if queue.get("kind") == "deviation":
            need(queue.get("adopted_source_sha256") is None)
            if local:
                document = live._json(local["document"])
                need(document.get("outcome") == "cancelled", "local adoption cannot be cancelled")
            if intent:
                _same_request(intent["queue"], queue)
                base, chosen = intent["base"], intent["mutation"]
            else:
                # There has been no local adoption. A current-tip tombstone is
                # safe even when conflict prevents a publishable receipt chain.
                # The old public digest identifies the request only. This base
                # is used exclusively for a cancellation receipt, never rebased
                # into an adoption or publication mapping.
                base = {**tip, "generator_snapshot_sha256": queue["expected_generation"]}
                chosen = mutation
                need(queue.get("claimed_source_sha256") in (None, tip["source_content_sha256"]),
                     "original claimed input is required to cancel a changed source")
            need(type(chosen) is dict, "fixed original mutation required")
            if not apply:
                return {"state": "dry-run", "decision": "cancelled_before_adoption", "tip": tip}
            envelope = {"format": worker.FORMAT, "format_version": 1, "synthetic": False,
                        "queue_request": queue, "base": base, "mutation": chosen, "withdrawal_confirmed": True}
            raw = (school.canonical_json(envelope) + "\n").encode()
            path = job.path.parent / f"{request_id}-{live._hash(raw)}.json"
            if os.path.lexists(path):
                need(live._read(path, worker.INPUT_MAX_BYTES) == raw)
            else:
                live._write(path, raw, worker.INPUT_MAX_BYTES)
            reference = {"path": str(path), "sha256": live._hash(raw)}
            if not intent:
                job.add("intent", {"queue": queue, "base": base, "mutation": chosen, "reference": reference})
            receipt = worker.process_request(source, path, input_sha256=reference["sha256"], operation="cancel", apply=True,
                max_bytes=max_bytes, timeout_seconds=min(300, deadline - time.monotonic()))["receipt"]
            need(receipt["outcome"] == "cancelled" and receipt["target"] == tip)
            job.add("local-cancellation", receipt)
            ids, receipts_hash, decision = [request_id], receipt["receipt_sha256"], "cancelled_before_adoption"
        else:
            need(queue.get("kind") == "publish")
            tip, applications = verify_chain(source, initial, history, deadline, max_bytes)
            ids = queue.get("included_request_ids")
            need(type(ids) is list and len(ids) <= 100 and len(set(ids)) == len(ids))
            applied = {item["request_id"]: item["receipt_sha256"] for item in applications}
            need(set(applied) <= set(ids), "publication cohort differs from local adopted history")
            report = []
            for identifier in ids:
                child = pg.rpc("school_change_worker_payload", {"p_request_id": identifier},
                               timeout_seconds=min(30, deadline - time.monotonic()))
                lease = worker._timestamp(child["lease_until"]) if child.get("lease_until") else None
                need(child.get("publication_request_id") == request_id and (not lease or lease <= datetime.now(timezone.utc))
                     and child.get("state") not in ("generated", "publication_confirmed")
                     and child.get("snapshot_content_sha256") is None, "cohort worker or generation still active")
                need(child.get("state") != "adopted" or identifier in applied, "adopted cohort receipt missing")
                report.append({"request_id": identifier, "state": child["state"], "receipt_sha256": applied.get(identifier)})
            receipts_hash, decision = school.content_hash({"tip": tip, "requests": report}), "release_unpublished_cohort"
            if not apply:
                return {"state": "dry-run", "decision": decision, "tip": tip, "requests": report}
            job.add("reject-review", {"tip": tip, "requests": report})
        previous = job.last("reject-evidence")
        evidence = {"decision": decision, "local_source_sha256": tip["source_content_sha256"],
                    "local_receipts_sha256": receipts_hash, "observed_at": datetime.now(timezone.utc).isoformat(), "request_ids": ids}
        if previous and all(previous[key] == evidence[key] for key in evidence if key != "observed_at") \
                and abs((datetime.now(timezone.utc) - worker._timestamp(previous["observed_at"])).total_seconds()) < 240:
            evidence = previous
        job.add("reject-evidence", evidence)
        control = _Control(pg, queue, deadline, job, tip["source_content_sha256"])
        params = {"p_request_id": request_id, "p_expected_revision": queue["revision"], "p_evidence": evidence}
        try:
            result = control.rpc("reject_school_change", params)
        except Exception:
            result = control.rpc("reject_school_change", params)
        _same_request(queue, result)
        need(result.get("state") == "rejected")
        job.add("rejected", result)
        return {"state": "rejected", "evidence": evidence}
    except ControllerError:
        raise
    except Exception:
        raise ControllerError("school rejection stopped; reconcile local tombstone and owner queue") from None
