"""Scratch-only workflow tests: these do not exercise real authentication or DBs."""

from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
import copy
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from threading import Barrier
import unittest
from unittest.mock import patch

import school_review_queue as queue
import store
import store_school
from school_fixture import synthetic_payload
from school_source_apply import SourceAdapter


BASE = {"dataset_version": "synthetic-1", "snapshot_content_sha256": "1" * 64}
TARGET = {"dataset_version": "synthetic-2", "snapshot_content_sha256": "2" * 64}
PAYLOAD = {"school_id": "11111111-1111-4111-8111-111111111111", "department_id": None,
           "field": "deviation_value", "value": 55}
OWNER = queue.Actor("synthetic-owner", "submitter")
REVIEWER = queue.Actor("synthetic-reviewer", "reviewer")
WORKER = queue.Actor("synthetic-worker", "worker")
CANDIDATE = {"datasetVersion": "synthetic-2", "sourceVersion": "synthetic-source",
             "snapshotSha256": "3" * 64, "contentSha256": "2" * 64,
             "candidateManifestSha256": "4" * 64, "artifactsSha256": "5" * 64}
RECEIPT = {"format": "school-publication-stub-result", "formatVersion": 1,
           "synthetic": True, "state": "publication_confirmed", "requestId": "synthetic-request",
           "destination": "stub://school-publication", "candidate": CANDIDATE}


class ReviewQueueTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix="synthetic-review-queue-")
        self.addCleanup(scratch.cleanup)
        self.path = Path(scratch.name) / "queue.sqlite"
        self.queue = queue.create_queue(self.path, BASE, synthetic=True, source_mode="planning_stub")

    def submit(self, name="proposal", **kwargs):
        return self.queue.submit(name, BASE, PAYLOAD, OWNER, **kwargs)

    def adopt(self):
        self.submit()
        self.queue.review("proposal", REVIEWER)
        return self.queue.adopt("proposal", TARGET, "synthetic-adoption", REVIEWER)

    def request(self):
        self.adopt()
        self.queue.generated("proposal", CANDIDATE, WORKER)
        return self.queue.request_publication("proposal", "synthetic-request", WORKER)

    def rejected_without_change(self, action):
        before = self.queue.snapshot()
        with self.assertRaises((store.InputError, sqlite3.Error)):
            action()
        self.assertEqual(self.queue.snapshot(), before)

    def test_end_to_end_states_are_distinct_and_persistent(self):
        self.assertEqual(self.submit()["state"], "received")
        self.assertEqual(self.queue.review("proposal", REVIEWER)["state"], "reviewed")
        self.assertEqual(self.queue.adopt("proposal", TARGET, "synthetic-adoption", REVIEWER)["state"], "adopted")
        self.assertEqual(self.queue.generated("proposal", CANDIDATE, WORKER)["state"], "generated")
        self.assertEqual(self.queue.request_publication("proposal", "synthetic-request", WORKER)["state"], "publish_requested")
        result = self.queue.confirm_publication("proposal", RECEIPT, WORKER)
        self.assertEqual(result["state"], "publication_confirmed")
        self.assertEqual(queue.Queue(self.path).get("proposal"), result)
        self.assertTrue(result["publication"]["synthetic"])

    def test_legacy_applied_is_received_without_adoption_or_publication(self):
        row = self.submit(legacy_status="applied")
        self.assertEqual(row["state"], "received")
        self.assertEqual(row["legacy_status"], "applied")
        self.assertIsNone(row["target"])
        self.assertIsNone(row["publication"])

    def test_stale_base_after_another_adoption_is_rejected(self):
        self.submit("stale")
        self.queue.review("stale", REVIEWER)
        self.adopt()
        self.rejected_without_change(lambda: self.queue.adopt("stale", TARGET, "other", REVIEWER))

    def test_same_version_changed_hash_is_stale(self):
        base = dict(BASE, snapshot_content_sha256="f" * 64)
        self.queue.submit("proposal", base, PAYLOAD, OWNER)
        self.queue.review("proposal", REVIEWER)
        self.rejected_without_change(lambda: self.queue.adopt("proposal", TARGET, "a", REVIEWER))

    def test_adoption_replay_is_idempotent_but_conflicts_fail(self):
        self.adopt()
        before = self.queue.snapshot()
        self.queue.adopt("proposal", TARGET, "synthetic-adoption", REVIEWER)
        self.assertEqual(before, self.queue.snapshot())
        self.rejected_without_change(lambda: self.queue.adopt("proposal", TARGET, "other", REVIEWER))
        self.rejected_without_change(lambda: self.queue.adopt("proposal", BASE, "synthetic-adoption", REVIEWER))

    def test_adoption_key_cannot_be_reused_for_another_proposal(self):
        self.adopt()
        self.queue.submit("next", TARGET, PAYLOAD, OWNER)
        self.queue.review("next", REVIEWER)
        target = {"dataset_version": "synthetic-3", "snapshot_content_sha256": "6" * 64}
        self.rejected_without_change(lambda: self.queue.adopt("next", target, "synthetic-adoption", REVIEWER))

    def test_historical_dataset_version_cannot_be_reused(self):
        self.adopt()
        self.queue.submit("next", TARGET, PAYLOAD, OWNER)
        self.queue.review("next", REVIEWER)
        self.rejected_without_change(lambda: self.queue.adopt("next", BASE, "next-adoption", REVIEWER))

    def test_two_concurrent_adoptions_only_one_advances_source_tip(self):
        for proposal in ("first", "second"):
            self.submit(proposal)
            self.queue.review(proposal, REVIEWER)
        barrier = Barrier(2)

        def adopt(proposal):
            instance = queue.Queue(self.path)
            barrier.wait(timeout=5)
            try:
                instance.adopt(proposal, TARGET, proposal, REVIEWER)
                return "adopted"
            except store.InputError:
                return "rejected"

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(adopt, ("first", "second")))
        self.assertCountEqual(results, ["adopted", "rejected"])
        self.assertEqual(sum(row["state"] == "adopted" for row in self.queue.snapshot()["items"].values()), 1)

    def test_superseded_publication_is_retained_but_cannot_confirm(self):
        self.request()
        self.queue.submit("newer", TARGET, PAYLOAD, OWNER)
        self.queue.review("newer", REVIEWER)
        newer = {"dataset_version": "synthetic-3", "snapshot_content_sha256": "6" * 64}
        self.queue.adopt("newer", newer, "newer-adoption", REVIEWER)
        self.rejected_without_change(lambda: self.queue.confirm_publication("proposal", RECEIPT, WORKER))
        self.rejected_without_change(lambda: self.queue.request_publication("proposal", "synthetic-request", WORKER))
        self.assertEqual(self.queue.get("proposal")["state"], "publish_requested")

    def test_withdraw_then_reconsent_requires_new_review(self):
        self.submit()
        self.queue.review("proposal", REVIEWER)
        self.queue.set_consent("proposal", False, OWNER)
        self.rejected_without_change(lambda: self.queue.adopt("proposal", TARGET, "a", REVIEWER))
        self.queue.set_consent("proposal", True, OWNER)
        self.rejected_without_change(lambda: self.queue.adopt("proposal", TARGET, "a", REVIEWER))
        self.queue.review("proposal", REVIEWER)
        self.assertEqual(self.queue.adopt("proposal", TARGET, "a", REVIEWER)["state"], "adopted")

    def test_withdraw_after_adoption_keeps_history_and_blocks_generation(self):
        self.adopt()
        self.queue.set_consent("proposal", False, OWNER)
        self.assertEqual(self.queue.snapshot()["generation"], TARGET)
        self.assertEqual(self.queue.get("proposal")["state"], "adopted")
        self.rejected_without_change(lambda: self.queue.generated("proposal", CANDIDATE, WORKER))
        self.rejected_without_change(lambda: self.queue.adopted_change("proposal"))

    def descendant(self):
        self.adopt()
        target = {"dataset_version": "synthetic-3", "snapshot_content_sha256": "6" * 64}
        candidate = dict(CANDIDATE, datasetVersion=target["dataset_version"], contentSha256="6" * 64)
        self.queue.submit("descendant", TARGET, PAYLOAD, OWNER)
        self.queue.review("descendant", REVIEWER)
        return target, candidate

    def test_withdrawn_adopted_ancestor_blocks_descendant_adoption(self):
        target, _ = self.descendant()
        self.queue.set_consent("proposal", False, OWNER)
        self.rejected_without_change(lambda: self.queue.adopt("descendant", target, "descendant-key", REVIEWER))
        self.assertEqual(self.queue.get("descendant")["state"], "reviewed")

    def test_ancestor_withdrawal_blocks_already_adopted_descendant_generation_and_projection(self):
        target, candidate = self.descendant()
        self.queue.adopt("descendant", target, "descendant-key", REVIEWER)
        self.queue.set_consent("proposal", False, OWNER)
        self.rejected_without_change(lambda: self.queue.generated("descendant", candidate, WORKER))
        self.rejected_without_change(lambda: self.queue.adopted_change("descendant"))
        self.assertEqual(self.queue.get("descendant")["state"], "adopted")
        self.assertEqual(self.queue.snapshot()["generation"], target)

    def test_ancestor_withdrawal_blocks_generated_descendant_publication_request(self):
        target, candidate = self.descendant()
        self.queue.adopt("descendant", target, "descendant-key", REVIEWER)
        self.queue.generated("descendant", candidate, WORKER)
        self.queue.set_consent("proposal", False, OWNER)
        self.rejected_without_change(lambda: self.queue.request_publication("descendant", "descendant-request", WORKER))
        self.assertEqual(self.queue.get("descendant")["state"], "generated")

    def test_ancestor_withdrawal_blocks_requested_descendant_confirmation_after_restart(self):
        target, candidate = self.descendant()
        self.queue.adopt("descendant", target, "descendant-key", REVIEWER)
        self.queue.generated("descendant", candidate, WORKER)
        self.queue.request_publication("descendant", "descendant-request", WORKER)
        self.queue.set_consent("proposal", False, OWNER)
        self.queue = queue.Queue(self.path)
        receipt = dict(RECEIPT, requestId="descendant-request", candidate=candidate)
        self.rejected_without_change(lambda: self.queue.confirm_publication("descendant", receipt, WORKER))
        self.assertEqual(self.queue.get("descendant")["state"], "publish_requested")
        self.assertTrue(self.queue.get("proposal")["needs_reevaluation"])

    def test_withdrawn_unadopted_proposal_does_not_block_other_adoption(self):
        self.submit("unadopted")
        self.queue.set_consent("unadopted", False, OWNER)
        self.assertEqual(self.adopt()["state"], "adopted")

    def test_withdraw_after_request_blocks_confirmation_but_preserves_queue(self):
        self.request()
        self.queue.set_consent("proposal", False, OWNER)
        self.rejected_without_change(lambda: self.queue.confirm_publication("proposal", RECEIPT, WORKER))
        row = queue.Queue(self.path).get("proposal")
        self.assertEqual(row["request_id"], "synthetic-request")
        self.assertTrue(row["needs_reevaluation"])

    def test_withdraw_after_confirmation_does_not_erase_publication_fact(self):
        self.request()
        self.queue.confirm_publication("proposal", RECEIPT, WORKER)
        self.queue.set_consent("proposal", False, OWNER)
        row = self.queue.get("proposal")
        self.assertEqual(row["state"], "publication_confirmed")
        self.assertEqual(row["publication"], RECEIPT)
        self.assertTrue(row["needs_reevaluation"])

    def test_role_denial_on_review_adoption_generation_and_confirmation(self):
        self.submit()
        self.rejected_without_change(lambda: self.queue.review("proposal", OWNER))
        self.queue.review("proposal", REVIEWER)
        self.rejected_without_change(lambda: self.queue.adopt("proposal", TARGET, "a", OWNER))
        self.queue.adopt("proposal", TARGET, "a", REVIEWER)
        self.rejected_without_change(lambda: self.queue.generated("proposal", CANDIDATE, REVIEWER))
        self.queue.generated("proposal", CANDIDATE, WORKER)
        self.rejected_without_change(lambda: self.queue.request_publication("proposal", "synthetic-request", OWNER))
        self.queue.request_publication("proposal", "synthetic-request", WORKER)
        self.rejected_without_change(lambda: self.queue.confirm_publication("proposal", RECEIPT, OWNER))

    def test_owners_only_may_change_consent(self):
        self.submit()
        self.rejected_without_change(lambda: self.queue.set_consent("proposal", False, REVIEWER))

    def test_generation_failure_survives_restart_and_retry(self):
        self.adopt()
        self.queue.fail("proposal", "generation", "synthetic_failure", WORKER)
        self.queue = queue.Queue(self.path)
        self.assertEqual(self.queue.get("proposal")["state"], "adopted")
        self.queue.generated("proposal", CANDIDATE, WORKER)
        self.assertEqual(len(self.queue.get("proposal")["failures"]), 1)

    def test_publication_failure_survives_restart_and_retry(self):
        self.request()
        self.queue.fail("proposal", "publication", "synthetic_failure", WORKER)
        self.queue = queue.Queue(self.path)
        before = self.queue.snapshot()
        self.queue.request_publication("proposal", "synthetic-request", WORKER)
        self.assertEqual(before, self.queue.snapshot())
        self.queue.confirm_publication("proposal", RECEIPT, WORKER)
        self.assertEqual(len(self.queue.get("proposal")["failures"]), 1)

    def test_process_exit_with_open_transaction_retains_pending_work(self):
        self.request()
        code = "import sqlite3,os,sys; d=sqlite3.connect(sys.argv[1]); d.execute('BEGIN IMMEDIATE'); d.execute('DELETE FROM queue_state'); os._exit(0)"
        result = subprocess.run([sys.executable, "-B", "-c", code, str(self.path)], check=False)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(queue.Queue(self.path).get("proposal")["state"], "publish_requested")
        self.queue.confirm_publication("proposal", RECEIPT, WORKER)

    def test_generation_identity_mismatch_rejected(self):
        self.adopt()
        for key in ("datasetVersion", "contentSha256"):
            with self.subTest(key=key):
                candidate = dict(CANDIDATE, **{key: "f" * 64})
                self.rejected_without_change(lambda: self.queue.generated("proposal", candidate, WORKER))

    def test_publication_receipt_requires_every_identity_field_and_request(self):
        self.request()
        for key in CANDIDATE:
            with self.subTest(key=key):
                receipt = copy.deepcopy(RECEIPT)
                receipt["candidate"][key] = "f" * 64
                self.rejected_without_change(lambda: self.queue.confirm_publication("proposal", receipt, WORKER))
        for key, value in (("synthetic", False), ("requestId", "other"), ("state", "accepted"),
                           ("destination", "https://example.invalid"), ("formatVersion", True)):
            with self.subTest(key=key):
                receipt = dict(RECEIPT, **{key: value})
                self.rejected_without_change(lambda: self.queue.confirm_publication("proposal", receipt, WORKER))

    def test_no_skipping_states_or_republication(self):
        self.submit()
        self.rejected_without_change(lambda: self.queue.generated("proposal", CANDIDATE, WORKER))
        self.rejected_without_change(lambda: self.queue.confirm_publication("proposal", RECEIPT, WORKER))
        self.queue.review("proposal", REVIEWER)
        self.queue.adopt("proposal", TARGET, "a", REVIEWER)
        self.queue.generated("proposal", CANDIDATE, WORKER)
        self.queue.request_publication("proposal", "synthetic-request", WORKER)
        self.queue.confirm_publication("proposal", RECEIPT, WORKER)
        before = self.queue.snapshot()
        self.queue.confirm_publication("proposal", RECEIPT, WORKER)
        self.assertEqual(before, self.queue.snapshot())
        self.rejected_without_change(lambda: self.queue.request_publication("proposal", "other", WORKER))

    def test_rejection_and_private_fields_are_not_adoptable(self):
        self.submit()
        self.queue.review("proposal", REVIEWER, approved=False)
        self.rejected_without_change(lambda: self.queue.adopt("proposal", TARGET, "a", REVIEWER))
        for extra in ("reporter_id", "private_comment"):
            self.rejected_without_change(lambda: self.queue.submit("extra", BASE, dict(PAYLOAD, **{extra: "synthetic"}), OWNER))

    def test_adopted_projection_excludes_submitter_and_private_state(self):
        self.adopt()
        result = self.queue.adopted_change("proposal")
        self.assertEqual(set(result), {"synthetic", "base", "target", "change"})
        self.assertNotIn(OWNER.subject, json.dumps(result))
        self.assertEqual(result["change"], PAYLOAD)

    def test_existing_or_foreign_database_and_non_synthetic_actor_rejected(self):
        original = self.path.read_bytes()
        with self.assertRaises(FileExistsError):
            queue.create_queue(self.path, BASE, synthetic=True, source_mode="planning_stub")
        self.assertEqual(original, self.path.read_bytes())
        foreign = self.path.parent / "foreign.sqlite"
        with closing(sqlite3.connect(foreign)) as db:
            db.execute("CREATE TABLE unrelated(value TEXT)")
        before = foreign.read_bytes()
        with self.assertRaises(store.InputError):
            queue.Queue(foreign)
        self.assertEqual(before, foreign.read_bytes())
        actor = queue.Actor("synthetic-owner", "submitter", synthetic=False)
        self.rejected_without_change(lambda: self.queue.submit("proposal", BASE, PAYLOAD, actor))


class ReceiptQueueTests(unittest.TestCase):
    """Actual schema-3 scratch writes, journal readback and compensation."""

    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix="synthetic-receipt-queue-")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name).resolve()
        self.source = self.root / "source.sqlite"
        payload = synthetic_payload()
        payload["tables"] = store_school.normalize_tables(payload["tables"])
        with closing(store.connect(self.source)) as db:
            store_school.import_rows(db, payload, fresh=True)
        row = payload["tables"]["school_deviation_values"][0]
        self.payload = {"school_id": row["school_id"], "department_id": row["department_id"],
                        "field": "deviation_value", "value": 61}
        self.adapter = SourceAdapter(self.source, synthetic=True)
        self.base = self.adapter.generation()
        self.path = self.root / "queue.sqlite"
        self.queue = queue.create_queue(self.path, self.base, synthetic=True)

    def plan(self, name="p", value=61):
        self.submit(name, value)
        self.queue.plan_adoption(name, "apply-" + name, REVIEWER)
        return self.queue.application_request(name)

    def submit(self, name="p", value=61, *, school_consent=True):
        return self.ingest(self.transfer(name=name, value=value, school_consent=school_consent))

    def consent(self, name, consent):
        row = self.queue.get(name)
        return self.ingest(self.transfer(row["transfer_revision"] + 1,
                    "consent" if consent else "withdrawn", name=name,
                    value=row["transfer_payload"]["value"], consent=consent,
                    school_consent=row["school_consent"]))

    def authorize_recovery(self, value=49):
        for name, row in self.queue.snapshot()["items"].items():
            if "transfer_scope" in row and row["needs_reevaluation"] and not row["source_removed"]:
                self.ingest(self.transfer(row["transfer_revision"] + 1, name=name, value=value))

    def apply(self, name="p", value=61):
        self.adapter.apply(**self.plan(name, value))
        return self.queue.reconcile_application(name, self.source, WORKER)

    def candidate(self, name="p"):
        receipt = self.queue.get(name)["source_receipt"]
        return dict(CANDIDATE, datasetVersion=receipt["target"]["dataset_version"],
                    contentSha256=receipt["target"]["snapshot_content_sha256"],
                    sourceVersion=receipt["source_version"])

    def request(self, name="p"):
        self.queue.generated(name, self.candidate(name), WORKER)
        return self.queue.request_publication(name, "publish-" + name, WORKER)

    def consume(self, name="p"):
        candidate = self.candidate(name)
        permit = self.queue.issue_publication_permit(name, "publish-" + name, candidate, WORKER)
        return self.queue.consume_publication_permit(name, "publish-" + name, candidate,
                                                     permit["permit_id"], WORKER)

    def recover(self, name="recovery", value=49):
        return self.queue.request_reevaluation(name, "apply-" + name,
                    [dict(self.payload, value=value)], "synthetic-reviewed-source", REVIEWER)

    def reject(self, fn):
        before = self.queue.snapshot()
        with self.assertRaises(store.InputError):
            fn()
        self.assertEqual(self.queue.snapshot(), before)

    def test_default_queue_does_not_accept_an_invented_target(self):
        self.reject(lambda: self.queue.submit("p", self.base, self.payload, OWNER, school_consent=True))
        self.submit()
        self.reject(lambda: self.queue.adopt("p", TARGET, "invented", REVIEWER))
        self.queue.plan_adoption("p", "apply-p", REVIEWER)
        self.assertEqual(self.queue.snapshot()["generation"], self.base)
        self.assertIsNone(self.queue.get("p")["target"])
        self.reject(lambda: self.queue.generated("p", CANDIDATE, WORKER))
        self.reject(lambda: self.queue.reconcile_application("p", self.source, WORKER))

    def test_source_commit_gap_blocks_generation_and_reconciles_idempotently(self):
        request = self.plan()
        with self.assertRaises(RuntimeError):
            self.adapter.apply(**request, fail_at="after_commit")
        self.queue = queue.Queue(self.path)
        self.assertEqual(self.queue.get("p")["state"], "application_pending")
        self.reject(lambda: self.queue.generated("p", CANDIDATE, WORKER))
        result = self.queue.reconcile_application("p", self.source, WORKER)
        self.assertEqual(result["target"], self.adapter.generation())
        before = self.queue.snapshot()
        self.queue.reconcile_application("p", self.source, WORKER)
        self.assertEqual(self.queue.snapshot(), before)
        self.assertEqual(self.adapter.apply(**request), result["source_receipt"])
        self.request()

    def test_precommit_failure_preserves_pending_and_can_retry(self):
        request = self.plan()
        with self.assertRaises(RuntimeError):
            self.adapter.apply(**request, fail_at="before_commit")
        self.assertEqual(self.adapter.generation(), self.base)
        self.reject(lambda: self.queue.reconcile_application("p", self.source, WORKER))
        self.adapter.apply(**request)
        self.queue.reconcile_application("p", self.source, WORKER)
        self.request()

    def test_pending_request_replay_conflict_and_competing_plan(self):
        self.plan()
        before = self.queue.snapshot()
        self.queue.plan_adoption("p", "apply-p", REVIEWER)
        self.assertEqual(self.queue.snapshot(), before)
        self.reject(lambda: self.queue.plan_adoption("p", "other", REVIEWER))
        self.submit("next")
        self.reject(lambda: self.queue.plan_adoption("next", "apply-next", REVIEWER))

    def test_pending_withdrawal_after_source_commit_records_tip_but_blocks(self):
        request = self.plan()
        self.adapter.apply(**request)
        self.consent("p", False)
        self.queue.reconcile_application("p", self.source, WORKER)
        self.assertEqual(self.queue.snapshot()["generation"], self.adapter.generation())
        self.reject(lambda: self.queue.generated("p", self.candidate(), WORKER))
        self.consent("p", True)
        self.reject(lambda: self.queue.generated("p", self.candidate(), WORKER))
        self.reject(lambda: self.queue.review("p", REVIEWER))

    def test_cancel_tombstone_survives_gap_and_rejects_cached_request(self):
        request = self.plan()
        self.consent("p", False)
        self.adapter.cancel(**request)  # Source commit, before queue update.
        self.queue = queue.Queue(self.path)
        self.queue.cancel_pending("p", self.source, REVIEWER)
        before = self.queue.snapshot()
        self.queue.cancel_pending("p", self.source, REVIEWER)
        self.assertEqual(self.queue.snapshot(), before)
        with self.assertRaises(store.InputError):
            self.adapter.apply(**request)
        self.assertEqual(self.adapter.generation(), self.base)
        self.apply("new", 62)

    def test_cancel_queue_rollback_can_retry_source_tombstone(self):
        request = self.plan()
        before = self.queue.snapshot()
        with patch.object(queue.Queue, "_event", side_effect=RuntimeError("synthetic queue stop")):
            with self.assertRaises(RuntimeError):
                self.queue.cancel_pending("p", self.source, REVIEWER)
        self.assertEqual(self.queue.snapshot(), before)
        self.assertIsNotNone(self.adapter.read_cancellation(request["request_id"]))
        self.queue = queue.Queue(self.path)
        self.queue.cancel_pending("p", self.source, REVIEWER)
        self.assertEqual(self.queue.get("p")["state"], "cancelled")

    def test_cannot_cancel_committed_application(self):
        request = self.plan()
        self.adapter.apply(**request)
        self.reject(lambda: self.queue.cancel_pending("p", self.source, REVIEWER))
        self.queue.reconcile_application("p", self.source, WORKER)

    def test_compensation_requires_changed_values_and_source_receipt(self):
        self.apply()
        self.consent("p", False)
        self.reject(lambda: self.recover(value=61))
        self.authorize_recovery()
        self.recover()
        self.reject(lambda: self.queue.reconcile_application("recovery", self.source, WORKER))
        self.adapter.apply(**self.queue.application_request("recovery"))
        self.queue.reconcile_application("recovery", self.source, WORKER)
        self.assertTrue(self.queue.get("p")["source_removed"])
        self.assertTrue(self.queue.get("p")["needs_reevaluation"])
        self.request("recovery")

    def test_compensation_covers_every_withdrawn_ancestor_value(self):
        self.apply()
        self.apply("descendant", 62)
        self.consent("p", False)
        self.consent("descendant", False)
        self.reject(lambda: self.recover(value=61))
        self.reject(lambda: self.recover(value=62))
        self.authorize_recovery()
        self.recover(value=49)
        self.assertEqual(set(self.queue.get("recovery")["reevaluation"]["blockers"]), {"p", "descendant"})
        self.adapter.apply(**self.queue.application_request("recovery"))
        before = self.queue.snapshot()
        with patch.object(queue.Queue, "_event", side_effect=RuntimeError("synthetic queue stop")):
            with self.assertRaises(RuntimeError):
                self.queue.reconcile_application("recovery", self.source, WORKER)
        self.assertEqual(self.queue.snapshot(), before)
        self.queue = queue.Queue(self.path)
        self.queue.reconcile_application("recovery", self.source, WORKER)
        self.assertTrue(self.queue.get("p")["source_removed"])
        self.assertTrue(self.queue.get("descendant")["source_removed"])
        self.request("recovery")

    def test_recovery_requires_reviewer_and_evidence_and_exact_coverage(self):
        self.apply()
        self.consent("p", False)
        self.reject(lambda: self.queue.request_reevaluation("r", "apply-r", [dict(self.payload, value=49)],
                                                          "evidence", OWNER))
        self.reject(lambda: self.queue.request_reevaluation("r", "apply-r", [dict(self.payload, value=49)],
                                                          "", REVIEWER))
        self.reject(lambda: self.queue.request_reevaluation("r", "apply-r", [], "evidence", REVIEWER))
        extra = dict(self.payload, department_id=None, value=48)
        self.reject(lambda: self.queue.request_reevaluation("r", "apply-r", [dict(self.payload, value=49), extra],
                                                          "evidence", REVIEWER))

    def test_recovery_preserves_publication_history_and_burns_old_requests(self):
        self.apply()
        self.request()
        old_candidate = self.candidate()
        publication = dict(RECEIPT, requestId="publish-p", candidate=old_candidate)
        publication["permit_id"] = self.consume()["permit_id"]
        self.queue.confirm_publication("p", publication, WORKER)
        self.consent("p", False)
        self.authorize_recovery()
        self.recover()
        self.adapter.apply(**self.queue.application_request("recovery"))
        self.queue.reconcile_application("recovery", self.source, WORKER)
        old = self.queue.get("p")
        self.assertEqual(old["publication"], publication)
        self.assertEqual(old["state"], "publication_confirmed")
        self.assertIsNone(old["candidate"])
        self.assertEqual(old["history"][0]["candidate"], old_candidate)
        self.reject(lambda: self.queue.confirm_publication("p", publication, WORKER))
        self.reject(lambda: self.queue.generated("recovery", old_candidate, WORKER))
        self.queue.generated("recovery", self.candidate("recovery"), WORKER)
        self.reject(lambda: self.queue.request_publication("recovery", "publish-p", WORKER))
        self.queue.request_publication("recovery", "publish-recovery", WORKER)
        consumed = self.consume("recovery")
        self.queue.confirm_publication("recovery", dict(RECEIPT, requestId="publish-recovery",
                                       candidate=self.candidate("recovery"), permit_id=consumed["permit_id"]), WORKER)
        self.consent("p", True)
        self.reject(lambda: self.queue.plan_adoption("p", "apply-p", REVIEWER))
        self.reject(lambda: self.consume("recovery"))

    def test_return_to_old_content_does_not_reuse_candidate_or_old_review(self):
        self.apply()
        self.request()
        old_candidate = self.candidate()
        self.submit("old-reviewed", 65)
        self.consent("p", False)
        self.authorize_recovery()
        self.recover()
        self.adapter.apply(**self.queue.application_request("recovery"))
        self.queue.reconcile_application("recovery", self.source, WORKER)
        self.apply("fresh-review", 61)
        self.assertEqual(self.candidate("fresh-review"), old_candidate)
        self.reject(lambda: self.queue.generated("fresh-review", old_candidate, WORKER))
        self.reject(lambda: self.queue.plan_adoption("old-reviewed", "stale-review", REVIEWER))
        self.assertTrue(self.queue.get("old-reviewed")["invalidated"])

    def test_reconsent_during_recovery_does_not_release_stale_review(self):
        self.apply()
        self.consent("p", False)
        self.authorize_recovery()
        self.recover()
        request = self.queue.application_request("recovery")
        self.adapter.apply(**request)
        self.consent("p", True)
        self.queue.reconcile_application("recovery", self.source, WORKER)
        self.assertTrue(self.queue.get("recovery")["needs_reevaluation"])
        self.reject(lambda: self.queue.generated("recovery", self.candidate("recovery"), WORKER))
        self.assertFalse(self.queue.get("p")["source_removed"])

    def test_unrelated_withdrawn_unadopted_proposal_does_not_block_receipts(self):
        self.submit("unrelated")
        self.consent("unrelated", False)
        self.apply()
        self.request()

    def test_out_of_band_source_change_blocks_publication(self):
        self.apply()
        self.queue.generated("p", self.candidate(), WORKER)
        with closing(store.connect(self.source)) as db:
            db.execute("UPDATE school_deviation_values SET value=66 WHERE is_active=1")
        self.reject(lambda: self.queue.request_publication("p", "publish-p", WORKER))

    def test_read_only_publication_gate_rechecks_consent_requests_and_source(self):
        self.apply()
        candidate = self.candidate()
        self.reject(lambda: self.queue.assert_publication_ready("p", "publish-p", candidate, WORKER))
        self.request()
        before = self.queue.snapshot()
        ready = self.queue.assert_publication_ready("p", "publish-p", candidate, WORKER)
        self.assertEqual(ready["state"], "ready")
        self.assertEqual(self.queue.snapshot(), before)
        self.reject(lambda: self.queue.assert_publication_ready("p", "other", candidate, WORKER))
        self.reject(lambda: self.queue.assert_publication_ready("p", "publish-p", candidate, OWNER))
        self.reject(lambda: self.queue.assert_publication_ready("p", "publish-p",
                    dict(candidate, artifactsSha256="f" * 64), WORKER))
        consumed = self.consume()
        self.queue.confirm_publication("p", dict(RECEIPT, requestId="publish-p", candidate=candidate,
                                                permit_id=consumed["permit_id"]), WORKER)
        self.queue.assert_publication_ready("p", "publish-p", candidate, WORKER)
        self.consent("p", False)
        self.reject(lambda: self.queue.assert_publication_ready("p", "publish-p", candidate, WORKER))

    def test_read_only_publication_gate_blocks_source_commit_gap(self):
        self.apply()
        self.request()
        candidate = self.candidate()
        request = self.plan("next", 62)
        self.reject(lambda: self.queue.assert_publication_ready("p", "publish-p", candidate, WORKER))
        self.adapter.apply(**request)
        self.reject(lambda: self.queue.assert_publication_ready("p", "publish-p", candidate, WORKER))
        self.queue.reconcile_application("next", self.source, WORKER)
        self.reject(lambda: self.queue.assert_publication_ready("p", "publish-p", candidate, WORKER))

    def test_descendant_is_invalidated_and_new_review_resumes(self):
        self.apply()
        self.apply("descendant", 62)
        self.request("descendant")
        self.consent("p", False)
        self.reject(lambda: self.queue.request_publication("descendant", "publish-descendant", WORKER))
        self.authorize_recovery()
        self.recover()
        self.adapter.apply(**self.queue.application_request("recovery"))
        self.queue.reconcile_application("recovery", self.source, WORKER)
        self.assertEqual(self.queue.get("descendant")["state"], "superseded")
        self.assertEqual(self.queue.get("descendant")["history"][0]["request_id"], "publish-descendant")
        self.reject(lambda: self.queue.request_publication("descendant", "publish-descendant", WORKER))
        self.request("recovery")

    def transfer(self, revision=1, kind="reviewed", *, name="transfer", value=61,
                 consent=True, school_consent=True, **overrides):
        from school_intake_transfer import issue_envelope
        event = {"event_id": name + "-event-" + str(revision), "request_id": name,
                 "revision": revision, "subject_ref": "synthetic-transfer-owner",
                 "school_id": self.payload["school_id"], "department_id": self.payload["department_id"],
                 "kind": kind, "consent": consent, "school_consent": school_consent,
                 "payload": dict(self.payload, value=value)}
        event.update(overrides)
        key = b"synthetic-test-signing-key-only-32"
        return issue_envelope(event, issuer="synthetic-intake", key_id="test", key=key)

    def ingest(self, envelope):
        return self.queue.ingest_transfer(envelope, trusted_keys={
            ("synthetic-intake", "test"): b"synthetic-test-signing-key-only-32"})

    def test_transfer_authenticated_replay_scope_order_and_reconsent(self):
        envelope = self.transfer()
        self.assertEqual(self.ingest(envelope)["state"], "reviewed")
        before = self.queue.snapshot()
        self.ingest(envelope)
        self.assertEqual(before, self.queue.snapshot())
        with self.assertRaises(ValueError):
            self.ingest(dict(envelope, signature="0" * 64))
        self.assertEqual(before, self.queue.snapshot())
        self.reject(lambda: self.ingest(self.transfer(value=62)))
        self.reject(lambda: self.ingest(self.transfer(2, subject_ref="synthetic-other-owner")))
        self.reject(lambda: self.queue.set_consent("transfer", False,
                    queue.Actor("synthetic-transfer-owner", "submitter")))
        self.reject(lambda: self.queue.review("transfer", REVIEWER))
        self.ingest(self.transfer(3, "withdrawn", consent=False))
        self.reject(lambda: self.ingest(self.transfer(2, "consent")))
        self.ingest(envelope)  # Old duplicate is an acknowledgement of current withdrawal.
        self.assertFalse(self.queue.get("transfer")["consent"])
        self.ingest(self.transfer(4, "consent"))
        self.reject(lambda: self.queue.plan_adoption("transfer", "apply-transfer", REVIEWER))
        self.ingest(self.transfer(5))
        self.queue.plan_adoption("transfer", "apply-transfer", REVIEWER)

    def test_transfer_withdrawal_before_first_review_survives_restart(self):
        self.ingest(self.transfer(4, "withdrawn", consent=False))
        self.queue = queue.Queue(self.path)
        self.reject(lambda: self.ingest(self.transfer(3)))
        self.assertTrue(self.queue.get("transfer")["needs_reevaluation"])

    def test_transfer_scope_and_withdrawal_do_not_modify_unrelated_consent(self):
        self.ingest(self.transfer(name="one"))
        self.ingest(self.transfer(name="two", subject_ref="synthetic-other-subject"))
        other = self.queue.get("two")
        for field in ("school_id", "department_id"):
            changed = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            payload = dict(self.payload, **{field: changed})
            self.reject(lambda: self.ingest(self.transfer(2, name="one", **{field: changed, "payload": payload})))
        self.ingest(self.transfer(2, "withdrawn", name="one", consent=False))
        self.assertEqual(self.queue.get("two"), other)

    def test_transfer_unknown_and_false_school_consent_do_not_issue_permits(self):
        for school_consent in (None, False):
            with self.subTest(school_consent=school_consent):
                # Separate scratch queues isolate each source/consent case.
                queue_path = self.root / (str(school_consent) + ".sqlite")
                self.queue = queue.create_queue(queue_path, self.adapter.generation(), synthetic=True)
                value = 61 if school_consent is None else 62
                self.ingest(self.transfer(value=value, school_consent=school_consent))
                self.queue.plan_adoption("transfer", "apply-" + str(school_consent), REVIEWER)
                self.adapter.apply(**self.queue.application_request("transfer"))
                self.queue.reconcile_application("transfer", self.source, WORKER)
                self.request("transfer")
                self.reject(lambda: self.queue.issue_publication_permit("transfer", "publish-transfer",
                            self.candidate("transfer"), WORKER))

    def test_transfer_and_permit_rollback_leave_retryable_work(self):
        envelope = self.transfer()
        before = self.queue.snapshot()
        with patch.object(queue.Queue, "_event", side_effect=RuntimeError("synthetic queue stop")):
            with self.assertRaises(RuntimeError):
                self.ingest(envelope)
        self.assertEqual(self.queue.snapshot(), before)
        self.ingest(envelope)
        self.queue.plan_adoption("transfer", "apply-transfer", REVIEWER)
        self.adapter.apply(**self.queue.application_request("transfer"))
        self.queue.reconcile_application("transfer", self.source, WORKER)
        self.request("transfer")
        permit = self.queue.issue_publication_permit("transfer", "publish-transfer", self.candidate("transfer"), WORKER)
        before = self.queue.snapshot()
        with patch.object(queue.Queue, "_event", side_effect=RuntimeError("synthetic queue stop")):
            with self.assertRaises(RuntimeError):
                self.consume("transfer")
        self.assertEqual(self.queue.snapshot(), before)
        self.queue = queue.Queue(self.path)
        self.assertEqual(self.consume("transfer")["permit_id"], permit["permit_id"])

    def test_transfer_correction_requires_new_authenticated_review_and_tracks_later_withdrawal(self):
        self.ingest(self.transfer())
        self.queue.plan_adoption("transfer", "apply-transfer", REVIEWER)
        self.adapter.apply(**self.queue.application_request("transfer"))
        self.queue.reconcile_application("transfer", self.source, WORKER)
        self.request("transfer")
        self.consume("transfer")
        self.ingest(self.transfer(2, "withdrawn", consent=False))
        self.ingest(self.transfer(3, "withdrawn", consent=False, value=49))
        self.reject(lambda: self.recover())
        self.ingest(self.transfer(4, "consent", value=49))
        self.reject(lambda: self.recover())
        self.ingest(self.transfer(5, value=49))
        self.reject(lambda: self.recover(value=48))
        self.recover()
        self.adapter.apply(**self.queue.application_request("recovery"))
        self.queue.reconcile_application("recovery", self.source, WORKER)
        self.request("recovery")
        consumed = self.consume("recovery")
        self.assertEqual(self.queue.get("transfer")["payload"]["value"], 61)
        self.ingest(self.transfer(6, "withdrawn", consent=False, value=49))
        self.assertTrue(self.queue.get("recovery")["needs_reevaluation"])
        self.assertEqual(self.queue.snapshot()["publication_permits"][consumed["permit_id"]]["state"], "revoked")
        self.reject(lambda: self.queue.consume_publication_permit("recovery", "publish-recovery",
                    consumed["candidate"], consumed["permit_id"], WORKER))

    def test_missing_false_or_unknown_school_consent_prevents_permit(self):
        self.submit(school_consent=None)
        self.queue.plan_adoption("p", "apply-p", REVIEWER)
        self.adapter.apply(**self.queue.application_request("p"))
        self.queue.reconcile_application("p", self.source, WORKER)
        self.request()
        self.reject(lambda: self.queue.issue_publication_permit("p", "publish-p", self.candidate(), WORKER))

    def test_permit_wrong_binding_replay_withdrawal_and_confirmation_bypass(self):
        self.apply()
        self.request()
        candidate = self.candidate()
        receipt = dict(RECEIPT, requestId="publish-p", candidate=candidate)
        self.reject(lambda: self.queue.confirm_publication("p", receipt, WORKER))
        permit = self.queue.issue_publication_permit("p", "publish-p", candidate, WORKER)
        self.reject(lambda: self.queue.consume_publication_permit("p", "other", candidate, permit["permit_id"], WORKER))
        self.reject(lambda: self.queue.consume_publication_permit("p", "publish-p", candidate, "unknown", WORKER))
        result = self.consume()
        self.assertEqual(result["state"], "consumed")
        before = self.queue.snapshot()
        self.assertEqual(self.consume(), result)
        self.assertEqual(before, self.queue.snapshot())
        receipt["permit_id"] = result["permit_id"]
        self.queue.confirm_publication("p", receipt, WORKER)
        self.consent("p", False)
        self.queue = queue.Queue(self.path)
        self.assertEqual(self.queue.get("p")["publication_state"], "revoked")
        self.reject(lambda: self.queue.consume_publication_permit("p", "publish-p", candidate, permit["permit_id"], WORKER))
        self.reject(lambda: self.queue.confirm_publication("p", receipt, WORKER))

    def test_withdrawal_between_permit_issue_and_consume_rejects(self):
        self.apply()
        self.request()
        candidate = self.candidate()
        permit = self.queue.issue_publication_permit("p", "publish-p", candidate, WORKER)
        self.consent("p", False)
        self.reject(lambda: self.queue.consume_publication_permit("p", "publish-p", candidate, permit["permit_id"], WORKER))
        self.assertEqual(self.queue.snapshot()["publication_permits"][permit["permit_id"]]["state"], "revoked")

    def test_concurrent_withdrawal_and_consume_has_serial_outcome(self):
        self.apply()
        self.request()
        candidate = self.candidate()
        permit = self.queue.issue_publication_permit("p", "publish-p", candidate, WORKER)
        barrier = Barrier(2)

        def action(kind):
            instance = queue.Queue(self.path)
            barrier.wait(timeout=5)
            if kind == "withdraw":
                self.consent("p", False)
                return "withdrawn"
            try:
                instance.consume_publication_permit("p", "publish-p", candidate, permit["permit_id"], WORKER)
                return "consumed"
            except store.InputError:
                return "rejected"

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(action, ("withdraw", "consume")))
        self.assertEqual(results[0], "withdrawn")
        self.assertIn(results[1], ("consumed", "rejected"))
        self.assertEqual(self.queue.snapshot()["publication_permits"][permit["permit_id"]]["state"], "revoked")

    def test_receipt_generation_rejects_legacy_projection(self):
        with self.assertRaises(store.InputError):
            queue.create_queue(self.root / "weak.sqlite", BASE, synthetic=True)
        self.reject(lambda: self.queue.submit("weak", BASE, self.payload, OWNER))


if __name__ == "__main__":
    unittest.main()
