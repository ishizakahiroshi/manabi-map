"""Invented pinned observations, SQLite sources, owner RPC and publisher mocks.

The observation test records are fixtures, never claims of a real HTTP check.
"""
from contextlib import closing
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch

import school_live_controller as controller
import school_live_source as live
import store_school as school
from test_school_live_source import invented_capture


FIRST = "88888888-8888-4888-8888-888888888888"
SECOND = "99999999-9999-4999-8999-999999999999"
PUBLICATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


class MockPG:
    def __init__(self, requests):
        self.requests = {row["request_id"]: copy.deepcopy(row) for row in requests}
        self.calls, self.logs = [], []
        self.reject_preflight = False
        self.lost_ack = False
        self.reject_publication_ack = False

    def rpc(self, name, params, *, timeout_seconds):
        assert 0 < timeout_seconds <= 30
        self.calls.append(name)
        row = self.requests[params["p_request_id"]]
        if name == "school_change_worker_payload":
            return copy.deepcopy(row)
        if name in ("claim_school_change", "renew_school_change_lease"):
            if params["p_expected_revision"] != row["revision"]:
                raise ValueError("invented stale revision")
            if name == "claim_school_change":
                if row.get("lease_until") and datetime.fromisoformat(row["lease_until"]) > datetime.now(timezone.utc):
                    raise ValueError("invented busy claim")
                if row.get("claimed_source_sha256") not in (None, params["p_source_sha256"]):
                    raise ValueError("invented base mismatch")
                row["claimed_source_sha256"] = params["p_source_sha256"]
                row["lease_token"] = f"00000000-0000-4000-8000-{row['revision']:012d}"
                row["state"] = "generated" if row.get("snapshot_content_sha256") else "claimed"
            elif row["lease_token"] != params["p_lease_token"]:
                raise ValueError("invented lease mismatch")
            row["revision"] += 1
            row["lease_until"] = (datetime.now(timezone.utc) + timedelta(seconds=300)).isoformat()
        elif name == "ack_school_change":
            stage = params["p_stage"]
            if self.reject_publication_ack and stage == "publication_confirmed":
                raise ValueError("invented changed consent")
            if row["state"] != stage:
                row["state"] = stage
                row["revision"] += 1
                row["adopted_source_sha256"] = params["p_source_sha256"]
                self.logs.append((row["request_id"], stage))
                if stage != "adopted":
                    for key in ("snapshot_content_sha256", "manifest_sha256", "code_sha256", "application_receipts"):
                        row[key] = params["p_" + key]
                    row["application_receipts_sha256"] = school.content_hash(row["application_receipts"])
            if self.lost_ack:
                self.lost_ack = False
                raise OSError("invented lost ACK response")
        elif name == "school_publication_preflight":
            if self.reject_preflight:
                raise ValueError("invented consent withdrawal")
            now = datetime.now(timezone.utc)
            return {"request_id": row["request_id"], "revision": row["revision"], "advisory_only": True,
                    "checked_at": now.isoformat(), "valid_until": (now + timedelta(seconds=30)).isoformat(),
                    "source_sha256": row["adopted_source_sha256"], "snapshot_content_sha256": row["snapshot_content_sha256"],
                    "manifest_sha256": row["manifest_sha256"], "code_sha256": row["code_sha256"],
                    "application_receipts_sha256": row["application_receipts_sha256"]}
        elif name == "reject_school_change":
            if row["state"] != "rejected":
                if row["revision"] != params["p_expected_revision"]:
                    raise ValueError("invented stale rejection")
                row.update(state="rejected", revision=row["revision"] + 1, lease_until=None)
                self.logs.append((row["request_id"], "rejected"))
                if row["kind"] == "publish":
                    for identifier in row["included_request_ids"]:
                        self.requests[identifier]["publication_request_id"] = None
        else:
            raise AssertionError("unexpected invented RPC")
        return copy.deepcopy(row)


class MockPublisher:
    def __init__(self):
        self.calls = []
        self.lose_deploy = False
        self.heartbeat = False

    def generate(self, context, control):
        self.calls.append("generate")
        if self.heartbeat:
            control.last_renewed -= 61
            control.checkpoint()
        return {"source_sha256": context["tip"]["source_content_sha256"],
                "snapshot_content_sha256": context["tip"]["snapshot_content_sha256"],
                "manifest_sha256": "b" * 64, "code_sha256": "c" * 64,
                "generator_snapshot_sha256": "d" * 64, "artifacts_sha256": "e" * 64, "artifact_count": 2}

    def deploy(self, context, control):
        self.calls.append("deploy")
        if self.lose_deploy:
            self.lose_deploy = False
            raise OSError("invented ambiguous deploy response")
        return {"destination": "https://school.manabi-map.app", "deployment_id": "invented-deployment"}

    def recover(self, context, control):
        self.calls.append("recover")
        return {"destination": "https://school.manabi-map.app", "deployment_id": "invented-deployment"}

    def observe(self, context, control):
        self.calls.append("observe")
        return {**context["deployment"], "observed_at": datetime.now(timezone.utc).isoformat(),
                **{key: context["candidate"][key] for key in ("manifest_sha256", "artifacts_sha256", "artifact_count")},
                "application_receipts_sha256": control.queue["application_receipts_sha256"]}


class ControllerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="invented-school-controller-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.source = self.root / "source.sqlite"
        capture = invented_capture()
        department = copy.deepcopy(capture["tables"]["school_departments"][0])
        department.update(id="44444444-4444-4444-8444-444444444444", name="合成第二学科", record_key="invented-second-department")
        capture["tables"]["school_departments"].append(department)
        capture_ref = self.write("capture.json", capture)
        imported = live.import_capture(capture_ref["path"], self.source, input_sha256=capture_ref["sha256"], apply=True)
        bundle = self.root / "source-bundle"
        exported = live.export_snapshot(self.source, bundle, expected_source_sha256=imported["source_content_sha256"], apply=True)
        snapshot, manifest = live.verify_bundle(bundle)
        payload = self.write("payload.json", {"formatVersion": 2, "schools": [], "sourceCatalog": []})
        self.generation = payload["sha256"]
        artifacts = [{"path": "schools-manifest.json", "size": 2, "sha256": "1" * 64},
                     {"path": "schools.json", "size": 3, "sha256": "2" * 64}]
        generated = {"format": "observed-school-json", "evidence": "observed", "source": {
            "type": "sqlite-snapshot", "snapshotSha256": manifest["snapshot_sha256"],
            "manifestSha256": live._hash((bundle / "manifest.json").read_bytes()),
            "contentSha256": manifest["content_sha256"], "datasetVersion": snapshot["dataset_version"],
            "sourceVersion": snapshot["source_version"]}, "generatorSnapshotSha256": self.generation,
            "artifacts": artifacts, "artifactsSha256": school.content_hash(artifacts)}
        observation = {"format": "school-http-observation", "evidence": "observed", "http_verified": True,
            "destination": "https://school.manabi-map.app", "deployment_id": "invented-anchor",
            "observed_at": "2026-01-01T00:00:00Z", "generator_snapshot_sha256": self.generation,
            "manifest_sha256": "1" * 64, "artifacts_sha256": school.content_hash(artifacts), "artifact_count": 2}
        self.anchor = self.write("anchor.json", {"format": "school-live-observed-anchor", "version": 1,
            "snapshot": self.ref(bundle / "snapshot.json"), "manifest": self.ref(bundle / "manifest.json"),
            "export_receipt": self.write("export.json", exported), "generation": self.write("generation.json", generated),
            "payload": payload, "observation": self.write("observation.json", observation)})
        first = self.request(FIRST, capture["tables"]["school_departments"][0]["id"], 50)
        second = self.request(SECOND, department["id"], None)
        publish = self.request(PUBLICATION, None, None)
        publish.update(kind="publish", included_request_ids=[FIRST, SECOND], new_value=None, reason=None)
        self.pg = MockPG([first, second, publish])
        self.publisher = MockPublisher()

    def request(self, identifier, department, old):
        return {"request_id": identifier, "kind": "deviation", "school_id": "11111111-1111-4111-8111-111111111111",
                "department_id": department, "new_value": 61, "reason": "合成レビュー済み訂正", "expected_value": old,
                "expected_generation": self.generation, "submission_fingerprint": None, "state": "received", "revision": 1,
                "lease_token": None, "lease_until": None, "claimed_source_sha256": None, "adopted_source_sha256": None,
                "included_request_ids": [], "publication_request_id": None}

    def ref(self, path):
        return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}

    def write(self, name, value):
        path = self.root / name
        path.write_text(school.canonical_json(value) + "\n", encoding="utf-8")
        return self.ref(path)

    def run_job(self, identifier=FIRST, history=None, apply=True, **options):
        mutation = {"new_value_id": "77777777-7777-4777-8777-77777777777" + ("7" if identifier == FIRST else "8"),
                    "applied_at": datetime.now(timezone.utc).isoformat(), "dataset_version": "invented-" + identifier,
                    "source_version": "invented-source-" + identifier}
        return controller.run_request(source=self.source, anchor=self.anchor, history=history or [], request_id=identifier,
            job_dir=self.root / ("job-" + identifier), pg=self.pg, publisher=self.publisher,
            mutation=mutation, apply=apply, **options)

    def adopted(self):
        first = self.run_job()
        second = self.run_job(SECOND, [first["history_entry"]])
        return [first["history_entry"], second["history_entry"]]

    def test_dryrun_has_no_claim_local_write_or_publication(self):
        before = self.source.read_bytes()
        result = self.run_job(apply=False)
        self.assertEqual(result["state"], "dry-run")
        self.assertEqual(self.pg.calls, ["school_change_worker_payload"])
        self.assertEqual(self.publisher.calls, [])
        self.assertFalse((self.root / ("job-" + FIRST)).exists())
        self.assertEqual(self.source.read_bytes(), before)

    def test_stale_unadopted_request_can_only_be_explicitly_cancelled(self):
        self.pg.requests[FIRST]["expected_generation"] = "9" * 64
        with self.assertRaises(controller.ControllerError):
            self.run_job()
        # A pre-existing journal may belong to the prior observed generation.
        path = self.root / ("stale-job-" + FIRST)
        controller._Job(path, FIRST, "8" * 64, create=True)
        mutation = {"new_value_id": "77777777-7777-4777-8777-777777777777",
                    "applied_at": datetime.now(timezone.utc).isoformat(),
                    "dataset_version": "invented-cancel", "source_version": "invented-cancel"}
        initial = controller.anchor_generation(self.anchor, live.DEFAULT_MAX_BYTES)
        result = controller.reject_request(source=self.source, anchor=self.anchor, history=[], request_id=FIRST,
            job_dir=path, pg=self.pg, mutation=mutation, apply=True)
        self.assertEqual(result["state"], "rejected")
        self.assertEqual(result["evidence"]["local_source_sha256"], initial["source_content_sha256"])
        self.assertNotIn("claim_school_change", self.pg.calls)
        with closing(sqlite3.connect(self.source)) as db:
            receipt = json.loads(db.execute("SELECT document FROM source_apply_receipts").fetchone()[0])
            self.assertEqual(receipt["outcome"], "cancelled")
            self.assertEqual(receipt["base"], receipt["target"])

    def test_stale_cancellation_requires_current_anchor_chain_and_forbids_adoption(self):
        mutation = {"new_value_id": "77777777-7777-4777-8777-777777777777",
                    "applied_at": datetime.now(timezone.utc).isoformat(),
                    "dataset_version": "invented-cancel", "source_version": "invented-cancel"}
        self.pg.requests[FIRST]["expected_generation"] = "9" * 64
        with closing(sqlite3.connect(self.source)) as db:
            db.execute("UPDATE schools SET status_note='invented unmatched source'")
            db.commit()
        with self.assertRaises(controller.ControllerError):
            controller.reject_request(source=self.source, anchor=self.anchor, history=[], request_id=FIRST,
                job_dir=self.root / "stale-reject", pg=self.pg, mutation=mutation, apply=True)
        self.assertNotIn("reject_school_change", self.pg.calls)

    def test_two_edits_from_same_public_generation_require_complete_receipt_chain(self):
        first = self.run_job()
        with self.assertRaises(controller.ControllerError):
            self.run_job(SECOND)
        second = self.run_job(SECOND, [first["history_entry"]])
        self.assertEqual(second["state"], "adopted")
        self.assertEqual(self.publisher.calls, [])
        self.assertEqual(len(self.pg.logs), 2)
        with closing(sqlite3.connect(self.source)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM school_deviation_values WHERE value=61 AND is_active=1").fetchone()[0], 2)

    def test_tampered_anchor_payload_is_rejected_before_claim(self):
        (self.root / "payload.json").write_bytes(b"invented changed payload")
        with self.assertRaises(controller.ControllerError):
            self.run_job()
        self.assertNotIn("claim_school_change", self.pg.calls)

    def test_unrecorded_private_source_edit_cannot_be_rebased(self):
        with closing(sqlite3.connect(self.source)) as db:
            db.execute("UPDATE schools SET status_note='invented unrecorded edit'")
            db.commit()
        with self.assertRaises(controller.ControllerError):
            self.run_job()
        self.assertNotIn("claim_school_change", self.pg.calls)

    def test_lost_adopt_ack_is_idempotent_and_restart_keeps_fixed_mutation(self):
        self.pg.lost_ack = True
        first = self.run_job()
        before = self.source.read_bytes()
        second = self.run_job()
        self.assertEqual(first["receipt"], second["receipt"])
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(self.pg.logs, [(FIRST, "adopted")])

    def test_publication_requires_exact_adopted_cohort_then_observation_ack(self):
        history = self.adopted()
        result = self.run_job(PUBLICATION, history)
        self.assertEqual(result["state"], "publication_confirmed")
        self.assertEqual(self.publisher.calls, ["generate", "deploy", "observe"])
        self.assertLess(self.pg.calls.index("school_publication_preflight"), len(self.pg.calls) - 1)
        self.assertEqual(self.run_job(PUBLICATION, history)["state"], "publication_confirmed")
        self.assertEqual(self.publisher.calls, ["generate", "deploy", "observe"])

    def test_preflight_consent_rejection_prevents_external_deploy(self):
        history = self.adopted()
        self.pg.reject_preflight = True
        with self.assertRaises(controller.ControllerError):
            self.run_job(PUBLICATION, history)
        self.assertEqual(self.publisher.calls, ["generate"])

    def test_cooperative_long_generation_renews_lease(self):
        history = self.adopted()
        self.publisher.heartbeat = True
        self.run_job(PUBLICATION, history)
        self.assertIn("renew_school_change_lease", self.pg.calls)

    def test_ambiguous_deploy_uses_recovery_observation_never_second_deploy(self):
        history = self.adopted()
        self.publisher.lose_deploy = True
        with self.assertRaises(controller.ControllerError):
            self.run_job(PUBLICATION, history)
        result = self.run_job(PUBLICATION, history)
        self.assertEqual(result["state"], "publication_confirmed")
        self.assertEqual(self.publisher.calls, ["generate", "deploy", "recover", "observe"])

    def test_final_consent_ack_rejection_leaves_recovery_record_without_claiming_rollback(self):
        history = self.adopted()
        self.pg.reject_publication_ack = True
        with self.assertRaises(controller.ControllerError):
            self.run_job(PUBLICATION, history)
        self.assertEqual(self.pg.requests[PUBLICATION]["state"], "generated")
        self.assertEqual(self.publisher.calls, ["generate", "deploy", "observe"])
        records = list((self.root / ("job-" + PUBLICATION)).glob("*.json"))
        self.assertTrue(any(json.loads(path.read_text())["stage"] == "observation" for path in records))

    def reject_job(self, identifier=FIRST, history=None, apply=True):
        mutation = {"new_value_id": "77777777-7777-4777-8777-777777777777", "applied_at": datetime.now(timezone.utc).isoformat(),
                    "dataset_version": "invented-cancelled", "source_version": "invented-cancelled-source"}
        return controller.reject_request(source=self.source, anchor=self.anchor, history=history or [], request_id=identifier,
            job_dir=self.root / ("job-" + identifier), pg=self.pg, mutation=mutation, apply=apply)

    def test_unclaimed_edit_rejection_saves_tombstone_then_rejects_without_source_change(self):
        with closing(sqlite3.connect(self.source)) as db:
            before = db.execute("SELECT value FROM school_deviation_values").fetchall()
        result = self.reject_job()
        self.assertEqual(result["state"], "rejected")
        self.assertEqual(result["evidence"]["decision"], "cancelled_before_adoption")
        self.assertNotIn("claim_school_change", self.pg.calls)
        with closing(sqlite3.connect(self.source)) as db:
            self.assertEqual(db.execute("SELECT value FROM school_deviation_values").fetchall(), before)
            self.assertEqual(json.loads(db.execute("SELECT document FROM source_apply_receipts").fetchone()[0])["outcome"], "cancelled")
        self.assertTrue(self.reject_job()["reconciled"])

    def test_blocked_source_conflict_rejection_uses_original_intent_and_current_tip(self):
        with patch.object(controller.worker, "process_request", side_effect=RuntimeError("invented stopped worker")):
            with self.assertRaises(controller.ControllerError):
                self.run_job()
        self.pg.requests[FIRST].update(state="blocked", lease_until=None)
        with closing(sqlite3.connect(self.source)) as db:
            db.execute("UPDATE schools SET status_note='invented intervening edit'")
            db.commit()
        self.assertEqual(self.reject_job()["state"], "rejected")
        with closing(sqlite3.connect(self.source)) as db:
            self.assertEqual(db.execute("SELECT value FROM school_deviation_values").fetchone()[0], 50)

    def test_adopted_edit_and_generated_publication_cannot_be_silently_released(self):
        history = self.adopted()
        self.pg.requests[FIRST]["lease_until"] = None
        with self.assertRaises(controller.ControllerError):
            self.reject_job(FIRST)
        self.pg.reject_preflight = True
        with self.assertRaises(controller.ControllerError):
            self.run_job(PUBLICATION, history)
        self.pg.requests[PUBLICATION]["lease_until"] = None
        with self.assertRaises(controller.ControllerError):
            self.reject_job(PUBLICATION, history)
        self.assertNotIn("reject_school_change", self.pg.calls)

    def test_ungenerated_publication_release_preserves_adopted_children_and_values(self):
        history = self.adopted()
        for identifier in (FIRST, SECOND):
            self.pg.requests[identifier].update(lease_until=None, publication_request_id=PUBLICATION)
        before = self.source.read_bytes()
        result = self.reject_job(PUBLICATION, history)
        self.assertEqual(result["evidence"]["decision"], "release_unpublished_cohort")
        self.assertEqual(result["evidence"]["request_ids"], [FIRST, SECOND])
        self.assertEqual(self.source.read_bytes(), before)
        for identifier in (FIRST, SECOND):
            self.assertEqual(self.pg.requests[identifier]["state"], "adopted")
            self.assertIsNone(self.pg.requests[identifier]["publication_request_id"])


if __name__ == "__main__":
    unittest.main()
