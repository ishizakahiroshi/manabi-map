"""Persistent, synthetic-only review/adoption/publication state-machine prototype.

This is a separate scratch queue, never an authenticated RPC.
Actor roles are test inputs, not proof of Supabase authorization/PIN/RLS. Adoption
records intent first; only verified source receipts advance the default queue tip.
The explicitly selected planning_stub mode retains the earlier projection tests.
Publication receipts are offline stub evidence, never real delivery evidence.
SQLite transactions preserve pending work across process restart. Power loss and
hostile filesystem replacement are outside this local prototype's guarantees.
"""

from contextlib import contextmanager, closing
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import sqlite3
import uuid

import school_id_index as index
import store


FORMAT = "synthetic-school-review-queue"
APP_ID = 0x53525131
IDENTITY_FIELDS = {"datasetVersion", "sourceVersion", "snapshotSha256", "contentSha256",
                   "candidateManifestSha256", "artifactsSha256"}
REPO = Path(__file__).resolve().parents[2]
require = store.require


def _text(value):
    require(type(value) is str and 0 < len(value) <= 200 and value.strip() == value,
            "nonempty bounded identifier required")


def _generation(value, source_mode="receipt"):
    fields = {"dataset_version", "snapshot_content_sha256"}
    if source_mode == "receipt":
        fields.add("source_content_sha256")
    require(type(value) is dict and set(value) == fields,
            "generation fields differ")
    _text(value["dataset_version"])
    index._hash(value["snapshot_content_sha256"])
    if source_mode == "receipt":
        index._hash(value["source_content_sha256"])
    return value


def candidate_identity(value):
    """Validate the shared six-field identity; does not validate candidate bytes."""
    require(type(value) is dict and set(value) == IDENTITY_FIELDS, "candidate identity fields differ")
    for key, item in value.items():
        if key.endswith("Sha256"):
            index._hash(item)
        else:
            _text(item)
    return value


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _path(value, *, missing=False):
    path = index._path(value, missing=missing)
    require(not path.is_relative_to(REPO), "queue must be outside the repository")
    return path


@dataclass(frozen=True)
class Actor:
    subject: str
    role: str
    synthetic: bool = True


def _actor(actor, *roles):
    require(type(actor) is Actor and actor.synthetic is True, "synthetic actor required")
    _text(actor.subject)
    require(actor.role in roles, "permission denied")


def _payload(value):
    # Minimal correction projection. No submitter identity or private comments.
    require(type(value) is dict and set(value) == {"school_id", "department_id", "field", "value"},
            "proposal projection fields differ")
    store.uuid_value(value["school_id"], "school_id")
    if value["department_id"] is not None:
        store.uuid_value(value["department_id"], "department_id")
    require(value["field"] == "deviation_value", "unsupported synthetic correction field")
    require(type(value["value"]) is int and 0 <= value["value"] <= 100, "invalid synthetic correction")


def create_queue(path, generation, *, synthetic=False, source_mode="receipt"):
    """Exclusively create a scratch DB. Existing files are never initialized."""
    require(synthetic is True, "explicit synthetic declaration required")
    require(source_mode in ("receipt", "planning_stub"), "unsupported source mode")
    _generation(generation, source_mode)
    path = _path(path, missing=True)
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    initial = {"format": FORMAT, "synthetic": True, "generation": generation,
               "source_mode": source_mode, "source_path": None, "tip_request": None,
               "items": {}, "events": [], "invalidated_candidates": [], "used_publication_requests": []}
    with closing(sqlite3.connect(path)) as db:
        with db:
            db.execute(f"PRAGMA application_id={APP_ID}")
            db.execute("CREATE TABLE queue_state (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)")
            db.execute("INSERT INTO queue_state VALUES(1, ?)", (_json(initial),))
    return Queue(path)


class Queue:
    def __init__(self, path):
        self.path = _path(path)
        self.snapshot()  # Reject foreign or incomplete databases without writing.

    def _connect(self, mode):
        path = _path(self.path)
        require(path.is_file(), "regular queue file required")
        db = sqlite3.connect(path.as_uri() + f"?mode={mode}", uri=True, timeout=5)
        try:
            require(db.execute("PRAGMA application_id").fetchone()[0] == APP_ID, "not a review queue")
            return db
        except BaseException:
            db.close()
            raise

    @staticmethod
    def _load(db):
        rows = db.execute("SELECT document FROM queue_state WHERE id=1").fetchall()
        require(len(rows) == 1, "missing queue state")
        state = json.loads(rows[0][0], object_pairs_hook=store.reject_duplicate_keys)
        require(state.get("format") == FORMAT and state.get("synthetic") is True,
                "not a synthetic review queue")
        require(state.get("source_mode") in ("receipt", "planning_stub"), "unsupported source mode")
        _generation(state["generation"], state["source_mode"])
        return state

    def snapshot(self):
        with closing(self._connect("ro")) as db:
            return self._load(db)

    def get(self, proposal_id):
        state = self.snapshot()
        require(proposal_id in state["items"], "unknown proposal")
        return state["items"][proposal_id]

    @contextmanager
    def _change(self):
        # Verify marker read-only before obtaining a write connection.
        self.snapshot()
        with closing(self._connect("rw")) as db:
            with db:
                db.execute("BEGIN IMMEDIATE")
                state = self._load(db)
                yield state
                db.execute("UPDATE queue_state SET document=? WHERE id=1", (_json(state),))

    @staticmethod
    def _item(state, proposal_id):
        require(proposal_id in state["items"], "unknown proposal")
        return state["items"][proposal_id]

    @staticmethod
    def _event(state, proposal_id, action):
        state["events"].append({"sequence": len(state["events"]) + 1,
                                "proposal_id": proposal_id, "action": action})

    @staticmethod
    def _consenting(item):
        require(not item.get("invalidated", False), "superseded review requires a new proposal")
        require(item["consent"] and not item["needs_reevaluation"], "consent requires reevaluation")
        require(item["reviewed_consent_revision"] == item["consent_revision"], "consent revision changed")

    @staticmethod
    def _source_ready(state):
        # The prototype has one cumulative source chain. A descendant still
        # contains every ancestor correction; another proposal cannot bypass a
        # withdrawn adopted ancestor. Only verified compensating application
        # may mark its contribution removed; renewed consent does not do so.
        require(not any(row["adoption_key"] is not None and row["needs_reevaluation"]
                        and not row.get("source_removed", False)
                        for row in state["items"].values()), "source chain requires reevaluation")
        require(not any(row["state"] == "application_pending" for row in state["items"].values()),
                "source application awaits reconciliation")
        if state.get("source_mode") == "receipt" and state.get("tip_request") is not None:
            from school_source_apply import SourceAdapter
            request = state["tip_request"]
            receipt = SourceAdapter(state["source_path"], synthetic=True).verify_receipt(**request)
            require(receipt["target"] == state["generation"], "source tip differs from queue")

    def submit(self, proposal_id, base, payload, actor, *, consent=True, legacy_status=None,
               school_consent=None):
        _actor(actor, "submitter", "reviewer")
        _text(proposal_id)
        _payload(payload)
        require(school_consent is None or type(school_consent) is bool, "invalid school consent")
        require(type(consent) is bool and legacy_status in (None, "pending", "applied"), "invalid submission")
        with self._change() as state:
            require(state["source_mode"] == "planning_stub", "receipt proposals require authenticated transfer")
            _generation(base, state["source_mode"])
            require(proposal_id not in state["items"], "duplicate proposal")
            state["items"][proposal_id] = {
                "state": "received", "base": base, "payload": payload, "owner": actor.subject,
                "consent": consent, "consent_revision": 1, "reviewed_consent_revision": None,
                "needs_reevaluation": False, "legacy_status": legacy_status,
                "target": None, "adoption_key": None, "candidate": None,
                "request_id": None, "publication": None, "failures": [],
                "application": None, "source_receipt": None, "invalidated": False,
                "source_removed": False, "history": [],
                "school_consent": school_consent,
            }
            self._event(state, proposal_id, "received")
        return self.get(proposal_id)

    @staticmethod
    def _revoke_permits(state, proposal_id):
        # Adopted ancestor corrections are contained in descendant candidates.
        # Revocation affects their publication permits, not their consent records.
        item = state["items"][proposal_id]
        for permit in state.get("publication_permits", {}).values():
            if permit["proposal_id"] == proposal_id or (item["adoption_key"] is not None
                                                        and not item.get("source_removed", False)):
                permit["state"] = "revoked"
                state["items"][permit["proposal_id"]]["publication_state"] = "revoked"

    def ingest_transfer(self, envelope, *, trusted_keys):
        """Verify the authenticated synthetic issuer before touching queue state.

        Receipt subject, school and department remain request-local. This is not
        an implementation of school-wide consent propagation or production auth.
        """
        from school_intake_transfer import verify_envelope
        event = verify_envelope(envelope, trusted_keys=trusted_keys)
        _payload(event["payload"])
        proposal_id = event["request_id"]
        with self._change() as state:
            events = state.setdefault("transfer_events", {})
            prior = events.get(event["event_id"])
            if prior is not None:
                require(prior == event, "transfer event replay differs")
                # Return current state, never the original successful state.
                return self._item(state, proposal_id)
            item = state["items"].get(proposal_id)
            scope = {key: event[key] for key in ("subject_ref", "school_id", "department_id")}
            if item is None:
                item = {
                    "state": "received", "base": state["generation"], "payload": event["payload"],
                    "owner": event["subject_ref"], "consent": False, "consent_revision": 0,
                    "reviewed_consent_revision": None, "needs_reevaluation": True,
                    "legacy_status": None, "target": None, "adoption_key": None,
                    "candidate": None, "request_id": None, "publication": None, "failures": [],
                    "application": None, "source_receipt": None, "invalidated": False,
                    "source_removed": False, "history": [], "transfer_scope": scope,
                    "transfer_revision": 0, "school_consent": None,
                }
                state["items"][proposal_id] = item
            require(item.get("transfer_scope") == scope, "transfer request scope differs")
            require(event["revision"] > item["transfer_revision"], "stale transfer revision")
            self._revoke_permits(state, proposal_id)
            item.update(transfer_revision=event["revision"], consent_revision=item["consent_revision"] + 1,
                        consent=event["consent"] is True and event["kind"] != "withdrawn",
                        school_consent=event["school_consent"], needs_reevaluation=True,
                        transfer_payload=event["payload"], transfer_kind=event["kind"])
            if item["adoption_key"] is None:
                item["payload"] = event["payload"]
                if event["kind"] == "reviewed" and item["consent"]:
                    item.update(state="reviewed", reviewed_consent_revision=item["consent_revision"],
                                needs_reevaluation=False)
            events[event["event_id"]] = event
            for dependent_id, dependent in state["items"].items():
                if proposal_id in dependent.get("transfer_dependencies", []):
                    dependent["needs_reevaluation"] = True
                    self._revoke_permits(state, dependent_id)
            self._event(state, proposal_id, "transfer_" + event["kind"])
        return self.get(proposal_id)

    def set_consent(self, proposal_id, consent, actor):
        _actor(actor, "submitter", "reviewer")
        require(type(consent) is bool, "consent must be boolean")
        with self._change() as state:
            item = self._item(state, proposal_id)
            require(item["owner"] == actor.subject, "only proposal owner may change consent")
            require("transfer_scope" not in item, "authenticated transfer required for consent")
            if item["consent"] != consent:
                self._revoke_permits(state, proposal_id)
                item["consent"] = consent
                item["consent_revision"] += 1
                item["needs_reevaluation"] = True
                self._event(state, proposal_id, "consent_changed")
        return self.get(proposal_id)

    def review(self, proposal_id, actor, *, approved=True):
        _actor(actor, "reviewer")
        require(type(approved) is bool, "review decision must be boolean")
        with self._change() as state:
            require(state["source_mode"] == "planning_stub", "receipt review requires authenticated transfer")
            item = self._item(state, proposal_id)
            require("transfer_scope" not in item, "authenticated transfer required for review")
            require(item["state"] in ("received", "reviewed"), "proposal cannot be reviewed")
            require(not approved or item["consent"], "consent withdrawn")
            item["state"] = "reviewed" if approved else "rejected"
            item["reviewed_consent_revision"] = item["consent_revision"]
            item["needs_reevaluation"] = False
            self._event(state, proposal_id, item["state"])
        return self.get(proposal_id)

    def adopt(self, proposal_id, target, adoption_key, actor):
        """Record synthetic adoption, atomically CAS-ing the queue's source tip."""
        _actor(actor, "reviewer")
        _generation(target, "planning_stub")
        _text(adoption_key)
        with self._change() as state:
            item = self._item(state, proposal_id)
            require(state.get("source_mode") == "planning_stub", "planned target is not source application evidence")
            self._consenting(item)
            self._source_ready(state)
            if item["adoption_key"] is not None:
                require(item["adoption_key"] == adoption_key and item["target"] == target,
                        "conflicting adoption replay")
            else:
                require(item["state"] == "reviewed", "review required")
                require(item["base"] == state["generation"], "stale source generation")
                require(target["dataset_version"] != item["base"]["dataset_version"], "new dataset version required")
                require(target["snapshot_content_sha256"] != item["base"]["snapshot_content_sha256"],
                        "changed source content required")
                used_versions = {generation["dataset_version"] for row in state["items"].values()
                                 if row["adoption_key"] is not None
                                 for generation in (row["base"], row["target"])}
                require(target["dataset_version"] not in used_versions, "dataset version already used")
                require(all(row["adoption_key"] != adoption_key for row in state["items"].values()),
                        "adoption key already used")
                item.update(state="adopted", target=target, adoption_key=adoption_key)
                state["generation"] = target
                self._event(state, proposal_id, "adopted")
        return self.get(proposal_id)

    def plan_adoption(self, proposal_id, request_id, actor):
        """Persist reviewed intent without inventing an actual target generation."""
        _actor(actor, "reviewer")
        _text(request_id)
        with self._change() as state:
            require(state.get("source_mode") == "receipt", "receipt source mode required")
            item = self._item(state, proposal_id)
            self._consenting(item)
            if item.get("application") is not None:
                require(item["application"]["request_id"] == request_id,
                        "conflicting application replay")
                return item
            self._source_ready(state)
            require(item["state"] == "reviewed", "review required")
            require(item["base"] == state["generation"], "stale source generation")
            require(all(row.get("application", {}).get("request_id") != request_id
                        for row in state["items"].values() if row.get("application")),
                    "source request ID already used")
            item.update(state="application_pending", adoption_key=request_id,
                        application={"request_id": request_id, "expected": item["base"],
                                     "changes": [item["payload"]]})
            self._event(state, proposal_id, "application_planned")
        return self.get(proposal_id)

    @staticmethod
    def _blockers(state):
        return {key: row["consent_revision"] for key, row in state["items"].items()
                if row["adoption_key"] is not None and row["needs_reevaluation"]
                and not row.get("source_removed", False)}

    def request_reevaluation(self, recovery_id, request_id, changes, evidence_ref, actor):
        """Review a new compensating correction; never reactivate an old review.

        Synthetic policy: every affected cell receives a different reviewed value.
        This is not a product decision on legal consent or commercial estimates.
        """
        _actor(actor, "reviewer")
        for value in (recovery_id, request_id, evidence_ref):
            _text(value)
        require(type(changes) is list and bool(changes), "recovery changes required")
        by_cell = {}
        for change in changes:
            _payload(change)
            cell = (change["school_id"], change["department_id"], change["field"])
            require(cell not in by_cell, "duplicate recovery cell")
            by_cell[cell] = change["value"]
        with self._change() as state:
            require(state.get("source_mode") == "receipt", "receipt source mode required")
            require(recovery_id not in state["items"], "duplicate recovery proposal")
            require(not any(row["state"] == "application_pending" for row in state["items"].values()),
                    "pending source application must be reconciled first")
            require(all(row["adoption_key"] != request_id for row in state["items"].values()),
                    "source request ID already used")
            blockers = self._blockers(state)
            require(bool(blockers), "no source reevaluation required")
            affected = set()
            transfer_dependencies = set()
            for key in blockers:
                row = state["items"][key]
                dependencies = set(row.get("transfer_dependencies", []))
                if "transfer_scope" in row:
                    dependencies.add(key)
                require(bool(dependencies), "authenticated correction source required")
                transfer_dependencies.update(dependencies)
                for dependency in dependencies:
                    transferred = state["items"][dependency]
                    require(transferred["transfer_kind"] == "reviewed" and transferred["consent"] is True
                            and transferred["school_consent"] is True, "authenticated correction review required")
                    correction = transferred["transfer_payload"]
                    cell = (correction["school_id"], correction["department_id"], correction["field"])
                    require(by_cell.get(cell) == correction["value"], "correction differs from reviewed transfer")
                for change in row["application"]["changes"]:
                    cell = (change["school_id"], change["department_id"], change["field"])
                    affected.add(cell)
                    require(cell in by_cell and by_cell[cell] != change["value"],
                            "withdrawn content must be corrected in source")
            require(set(by_cell) == affected, "recovery must cover exactly affected cells")
            state["items"][recovery_id] = {
                "state": "application_pending", "base": state["generation"], "payload": None,
                "owner": actor.subject, "consent": True, "consent_revision": 1,
                "reviewed_consent_revision": 1, "needs_reevaluation": False,
                "legacy_status": None, "target": None, "adoption_key": request_id,
                "candidate": None, "request_id": None, "publication": None, "failures": [],
                "application": {"request_id": request_id, "expected": state["generation"], "changes": changes},
                "source_receipt": None, "invalidated": False, "source_removed": False, "history": [],
                "school_consent": True,
                "transfer_dependencies": sorted(transfer_dependencies),
                "reevaluation": {"blockers": blockers, "evidence_ref": evidence_ref,
                                 "reviewer": actor.subject, "review_revision": 1},
            }
            self._event(state, recovery_id, "reevaluation_reviewed")
        return self.get(recovery_id)

    def application_request(self, proposal_id):
        """Return only the reviewed adapter contract, excluding private audit data."""
        state = self.snapshot()
        require(state.get("source_mode") == "receipt", "receipt source mode required")
        item = self._item(state, proposal_id)
        require(item["state"] == "application_pending", "pending source application required")
        self._consenting(item)
        if item.get("reevaluation"):
            require(self._blockers(state) == item["reevaluation"]["blockers"],
                    "reevaluation consent revisions changed")
        else:
            require(not self._blockers(state), "source chain requires reevaluation")
        return item["application"]

    def reconcile_application(self, proposal_id, source_path, actor):
        """Record a committed source transaction, including a withdrawn intent.

        Separate SQLite commits are intentional. A source-first interruption leaves
        a pending queue, which blocks publication until this idempotent readback.
        """
        _actor(actor, "worker")
        from school_source_apply import SourceAdapter
        source_path = str(_path(source_path))
        with self._change() as state:
            require(state.get("source_mode") == "receipt", "receipt source mode required")
            require(state["source_path"] in (None, source_path), "source database path changed")
            item = self._item(state, proposal_id)
            require(item.get("application") is not None, "application intent required")
            receipt = SourceAdapter(source_path, synthetic=True).verify_receipt(**item["application"])
            if item.get("source_receipt") is not None:
                require(item["source_receipt"] == receipt, "source receipt replay differs")
            else:
                require(item["state"] == "application_pending", "pending application required")
                require(state["generation"] == receipt["base"] == item["base"], "source receipt base mismatch")
                _generation(receipt["target"])
                if item.get("reevaluation"):
                    reviewed = item["reevaluation"]["blockers"]
                    current = self._blockers(state)
                    # A withdrawal during source commit still records the actual
                    # tip but does not release a stale recovery review.
                    fresh = current == reviewed and not item["needs_reevaluation"]
                    for key, old in state["items"].items():
                        if key == proposal_id or (old["adoption_key"] is None and old["state"] != "reviewed"):
                            continue
                        old["history"].append({"state": old["state"], "candidate": old["candidate"],
                                               "request_id": old["request_id"], "publication": old["publication"]})
                        if old["candidate"] is not None:
                            state["invalidated_candidates"].append(old["candidate"])
                        old.update(candidate=None, request_id=None, invalidated=True)
                        if old["publication"] is None:
                            old["state"] = "superseded"
                        if fresh and key in reviewed:
                            old.update(source_removed=True, resolved_by=proposal_id)
                    item["needs_reevaluation"] = not fresh
                item.update(state="adopted", target=receipt["target"], source_receipt=receipt)
                state.update(generation=receipt["target"], source_path=source_path,
                             tip_request=item["application"])
                self._event(state, proposal_id, "source_application_reconciled")
        return self.get(proposal_id)

    def cancel_pending(self, proposal_id, source_path, actor):
        """Tombstone the source request before cancelling queue intent.

        A source-first crash is retried against the same tombstone. Cached adapter
        requests remain rejected by the source journal after cancellation.
        """
        _actor(actor, "reviewer")
        from school_source_apply import SourceAdapter
        source_path = str(_path(source_path))
        with self._change() as state:
            require(state.get("source_mode") == "receipt", "receipt source mode required")
            require(state["source_path"] in (None, source_path), "source database path changed")
            item = self._item(state, proposal_id)
            require(item["state"] in ("application_pending", "cancelled"), "pending application required")
            receipt = SourceAdapter(source_path, synthetic=True).cancel(**item["application"])
            if item["state"] == "cancelled":
                require(item["cancellation"] == receipt, "cancellation replay differs")
            else:
                item.update(state="cancelled", cancellation=receipt, invalidated=True, source_removed=True)
                state["source_path"] = source_path
                self._event(state, proposal_id, "application_cancelled")
        return self.get(proposal_id)

    def generated(self, proposal_id, candidate, actor):
        """Accept an identity from an independently verified candidate producer."""
        _actor(actor, "worker")
        candidate_identity(candidate)
        with self._change() as state:
            item = self._item(state, proposal_id)
            self._consenting(item)
            self._source_ready(state)
            require(item["state"] in ("adopted", "generated"), "adoption required")
            require(candidate not in state.get("invalidated_candidates", []), "invalidated candidate cannot be reused")
            require(item["target"]["dataset_version"] == candidate["datasetVersion"] and
                    item["target"]["snapshot_content_sha256"] == candidate["contentSha256"],
                    "candidate target mismatch")
            require(item["candidate"] in (None, candidate), "candidate replay differs")
            if item["state"] != "generated":
                item.update(state="generated", candidate=candidate)
                self._event(state, proposal_id, "generated")
        return self.get(proposal_id)

    def request_publication(self, proposal_id, request_id, actor):
        _actor(actor, "worker")
        _text(request_id)
        with self._change() as state:
            item = self._item(state, proposal_id)
            self._consenting(item)
            self._source_ready(state)
            require(item["state"] in ("generated", "publish_requested"), "candidate generation required")
            require(item["target"] == state["generation"], "superseded candidate cannot be requested")
            require(item["request_id"] in (None, request_id), "publication replay differs")
            require(item["request_id"] == request_id or request_id not in state.get("used_publication_requests", []),
                    "publication request ID already used")
            require(all(key == proposal_id or row["request_id"] != request_id
                        for key, row in state["items"].items()), "publication request ID already used")
            if item["state"] != "publish_requested":
                item.update(state="publish_requested", request_id=request_id)
                state.setdefault("used_publication_requests", []).append(request_id)
                self._event(state, proposal_id, "publish_requested")
        return self.get(proposal_id)

    def fail(self, proposal_id, stage, code, actor):
        """Persist bounded failure codes, keep retryable work and prior evidence."""
        _actor(actor, "worker")
        require(stage in ("generation", "publication"), "unknown failure stage")
        require(type(code) is str and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", code), "failure code required")
        with self._change() as state:
            item = self._item(state, proposal_id)
            require(item["state"] == {"generation": "adopted", "publication": "publish_requested"}[stage],
                    "failure stage does not match work")
            item["failures"].append({"stage": stage, "code": code})
            self._event(state, proposal_id, stage + "_failed")
        return self.get(proposal_id)

    def _publication_ready(self, state, proposal_id, request_id, candidate):
        require(state.get("source_mode") == "receipt", "receipt source mode required")
        item = self._item(state, proposal_id)
        self._consenting(item)
        require(item.get("school_consent") is True, "explicit school consent required")
        self._source_ready(state)
        require(all(row.get("school_consent") is True for row in state["items"].values()
                    if row["adoption_key"] is not None and not row.get("source_removed", False)),
                "source ancestor requires explicit school consent")
        require(item["state"] in ("publish_requested", "publication_confirmed"),
                "publication request required")
        require(item["target"] == state["generation"], "superseded publication request")
        require(item["request_id"] == request_id and item["candidate"] == candidate,
                "publication generation or request mismatch")
        return item

    @staticmethod
    def _permit_result(permit):
        return {key: permit[key] for key in
                ("synthetic", "state", "permit_id", "proposal_id", "request_id", "candidate")}

    def issue_publication_permit(self, proposal_id, request_id, candidate, actor):
        """Issue one persisted capability bound to current reviewed consent."""
        _actor(actor, "worker")
        _text(request_id)
        candidate_identity(candidate)
        with self._change() as state:
            item = self._publication_ready(state, proposal_id, request_id, candidate)
            permits = state.setdefault("publication_permits", {})
            for permit in permits.values():
                if permit["proposal_id"] == proposal_id and permit["request_id"] == request_id:
                    require(permit["state"] != "revoked" and permit["candidate"] == candidate
                            and permit["consent_revision"] == item["consent_revision"],
                            "publication permit revoked or stale")
                    return self._permit_result(permit)
            permit_id = "synthetic-permit-" + uuid.uuid4().hex
            permit = {"synthetic": True, "state": "issued", "permit_id": permit_id,
                      "proposal_id": proposal_id, "request_id": request_id,
                      "candidate": candidate, "consent_revision": item["consent_revision"]}
            permits[permit_id] = permit
            self._event(state, proposal_id, "publication_permit_issued")
            return self._permit_result(permit)

    def consume_publication_permit(self, proposal_id, request_id, candidate, permit_id, actor):
        """Order consumption and withdrawal under this queue's write lock.

        The transaction does not cover actual remote delivery or JS memory.
        A repeated consumption rechecks current consent and source, never a
        cached success receipt. Revoked publications require a new review flow.
        """
        _actor(actor, "worker")
        _text(request_id)
        _text(permit_id)
        candidate_identity(candidate)
        with self._change() as state:
            item = self._publication_ready(state, proposal_id, request_id, candidate)
            permit = state.get("publication_permits", {}).get(permit_id)
            require(permit is not None, "unknown publication permit")
            require(permit["state"] in ("issued", "consumed")
                    and permit["proposal_id"] == proposal_id and permit["request_id"] == request_id
                    and permit["candidate"] == candidate
                    and permit["consent_revision"] == item["consent_revision"],
                    "publication permit revoked or mismatched")
            if permit["state"] == "issued":
                permit["state"] = "consumed"
                item["publication_state"] = "consumed"
                self._event(state, proposal_id, "publication_permit_consumed")
            return self._permit_result(permit)

    def assert_publication_ready(self, proposal_id, request_id, candidate, actor):
        """Read-only gate for the queue-bound offline publication stub.

        Holds a queue read transaction through source verification. The subsequent
        JS state change is not an atomic distributed commit; a real transport and
        simultaneous withdrawal after this check need a separate delivery design.
        """
        _actor(actor, "worker")
        _text(request_id)
        candidate_identity(candidate)
        with closing(self._connect("ro")) as db:
            db.execute("BEGIN")
            state = self._load(db)
            self._publication_ready(state, proposal_id, request_id, candidate)
            return {"synthetic": True, "state": "ready", "proposal_id": proposal_id,
                    "request_id": request_id, "candidate": candidate}

    def confirm_publication(self, proposal_id, receipt, actor):
        _actor(actor, "worker")
        fields = {"format", "formatVersion", "synthetic", "state", "requestId", "destination", "candidate"}
        require(type(receipt) is dict and set(receipt) in (fields, fields | {"permit_id"}),
            "publication receipt fields differ")
        require(receipt["format"] == "school-publication-stub-result" and type(receipt["formatVersion"]) is int
                and receipt["formatVersion"] == 1 and receipt["synthetic"] is True
                and receipt["state"] == "publication_confirmed"
                and receipt["destination"] == "stub://school-publication", "offline stub receipt required")
        candidate_identity(receipt["candidate"])
        with self._change() as state:
            item = self._item(state, proposal_id)
            self._consenting(item)
            if state["source_mode"] == "receipt":
                require(set(receipt) == fields | {"permit_id"}, "publication permit receipt required")
                _text(receipt["permit_id"])
                self._publication_ready(state, proposal_id, receipt["requestId"], receipt["candidate"])
                require(any(permit["permit_id"] == receipt["permit_id"] and permit["state"] == "consumed"
                            and permit["proposal_id"] == proposal_id
                            and permit["request_id"] == receipt["requestId"]
                            and permit["candidate"] == receipt["candidate"]
                            and permit["consent_revision"] == item["consent_revision"]
                            for permit in state.get("publication_permits", {}).values()),
                        "consumed publication permit required")
            else:
                require(set(receipt) == fields, "planning stub receipt fields differ")
            require(item["state"] in ("publish_requested", "publication_confirmed"), "publication request required")
            require(receipt["requestId"] == item["request_id"] and receipt["candidate"] == item["candidate"],
                    "publication generation or request mismatch")
            if item["state"] != "publication_confirmed":
                self._source_ready(state)
                require(item["target"] == state["generation"], "superseded publication requires reevaluation")
                item.update(state="publication_confirmed", publication=receipt)
                self._event(state, proposal_id, "publication_confirmed")
        return self.get(proposal_id)

    def adopted_change(self, proposal_id):
        """Allowlisted intended change; private queue fields never enter a source."""
        state = self.snapshot()
        item = self._item(state, proposal_id)
        self._source_ready(state)
        require(item["adoption_key"] is not None, "not adopted")
        self._consenting(item)
        return {"synthetic": True, "base": item["base"], "target": item["target"], "change": item["payload"]}
