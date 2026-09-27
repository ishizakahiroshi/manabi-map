"""Fake owned-target transactions test control flow, not PostgreSQL semantics."""

import copy
from contextlib import contextmanager
import unittest

import restore_bundle as bundle
from restore_drill import DrillError, DrillRunner
from test_restore_bundle import fixture, sealed_fixture


class FakeDrill:
    def __init__(self, fault=None):
        self.fault, self.events = fault, []
        self.descriptor, self.dump, self.payloads = fixture()
        self.toc = [{"kind": "table", "identity": "public.synthetic_rows"}]
        self.lease = {"identity": {"system": "synthetic-target-system", "database": "synthetic-target-db"}, "nonce": "synthetic-lease-001"}
        self.created = self.restored = self.acl = self.disposed = False
        self.in_transaction = False

    def inspect_archive(self, dump):
        self.events.append("toc")
        assert dump == self.dump
        if self.fault == "toc":
            return [{"kind": "table", "identity": "public.other_synthetic"}]
        return copy.deepcopy(self.toc)

    def create_target(self):
        self.events.append("create")
        self.created = True
        if self.fault == "source":
            return {**self.lease, "identity": copy.deepcopy(self.descriptor["source"])}
        return copy.deepcopy(self.lease)

    def inspect_target(self, lease):
        return {"lease": {**lease, "nonce": "different"} if self.fault == "ownership" and self.restored else copy.deepcopy(lease),
                "empty": not self.restored and self.fault != "nonempty", "isolated": self.fault != "shared",
                "atomic": self.fault != "non-atomic", "provider_ready": True}

    @contextmanager
    def transaction(self, lease):
        self.events.append("begin")
        before = self.restored, self.acl
        self.in_transaction = True
        try:
            yield
            if self.fault == "commit":
                raise RuntimeError("sensitive invented driver detail")
            self.events.append("commit")
        except Exception:
            self.restored, self.acl = before
            self.events.append("rollback")
            raise
        finally:
            self.in_transaction = False

    def restore(self, lease, dump, toc, *, flags):
        assert self.in_transaction and dump == self.dump and toc == self.toc
        assert "--no-acl" in flags and "--exit-on-error" in flags
        self.events.append("restore")
        self.restored = True
        if self.fault == "restore":
            raise RuntimeError("sensitive invented driver detail")

    def apply_acl(self, lease, payload, *, owner_mapping):
        assert self.in_transaction and payload == self.payloads["acl"] and owner_mapping == {}
        self.events.append("acl")
        self.acl = True
        if self.fault == "acl":
            raise RuntimeError("sensitive invented driver detail")

    def collect_restored(self, lease, descriptor):
        assert self.acl
        self.events.append("collect")
        result = copy.deepcopy(self.payloads)
        if self.fault == "data":
            result["data"]["entries"][0]["sha256"] = "0" * 64
        return result

    def probe_access(self, lease, probes):
        self.events.append("probe")
        return [{"id": p["id"], "allowed": True if self.fault == "access" else p["allowed"]} for p in probes]

    def quarantine(self, lease):
        self.events.append("quarantine")

    def dispose(self, lease):
        self.events.append("dispose")
        if self.fault == "dispose":
            raise RuntimeError("sensitive invented driver detail")
        self.disposed = True

    def is_absent(self, lease):
        return self.disposed and self.fault != "absence"


def review_for(adapter, raw, pin):
    value = bundle.validate(raw, expected=pin)
    return {"bundle_sha256": pin["sha256"], "toc_sha256": bundle.digest(bundle.canonical(adapter.toc)),
            "acl_sha256": value["artifacts"]["acl"]["sha256"], "owner_mapping": {},
            "probes": [{"id": "allow-read", "role": "synthetic_reader", "operation": "SELECT", "object": "public.synthetic_rows", "allowed": True},
                       {"id": "deny-write", "role": "synthetic_reader", "operation": "INSERT", "object": "public.synthetic_rows", "allowed": False}]}


class DrillTests(unittest.TestCase):
    def run_drill(self, adapter, runner=None, review=None):
        raw, pin = sealed_fixture()
        return (runner or DrillRunner()).run(raw, expected=pin, review=review or review_for(adapter, raw, pin), adapter=adapter)

    def test_atomic_acl_and_access_before_commit_partial_only(self):
        adapter = FakeDrill()
        result = self.run_drill(adapter)
        self.assertEqual(adapter.events, ["toc", "create", "begin", "restore", "acl", "collect", "probe", "commit", "collect", "probe"])
        self.assertEqual(result["state"], "verified-partial")
        self.assertEqual(result["retention"], "awaiting-owner-disposal")
        self.assertTrue(result["exclusions"])

    def test_toc_review_rejection_precedes_creation(self):
        adapter = FakeDrill("toc")
        with self.assertRaises(DrillError) as caught:
            self.run_drill(adapter)
        self.assertEqual(caught.exception.phase, "archive-review")
        self.assertEqual(adapter.events, ["toc"])

    def test_mid_transaction_failure_rolls_back_then_disposes(self):
        for fault in ("restore", "acl", "data", "access", "commit"):
            with self.subTest(fault=fault):
                adapter = FakeDrill(fault)
                with self.assertRaises(DrillError) as caught:
                    self.run_drill(adapter)
                self.assertEqual(caught.exception.disposal, "disposed")
                self.assertFalse(adapter.restored or adapter.acl)
                self.assertEqual(adapter.events[-3:], ["rollback", "quarantine", "dispose"])
                self.assertNotIn("sensitive", str(caught.exception))

    def test_source_nonempty_shared_or_nonatomic_target_never_restored(self):
        for fault in ("source", "nonempty", "shared", "non-atomic"):
            with self.subTest(fault=fault):
                adapter = FakeDrill(fault)
                with self.assertRaises(DrillError):
                    self.run_drill(adapter)
                self.assertNotIn("restore", adapter.events)
                if fault in ("source", "shared"):
                    self.assertNotIn("dispose", adapter.events)

    def test_consumed_target_cannot_be_retried_even_after_disposal(self):
        adapter, runner = FakeDrill("restore"), DrillRunner()
        with self.assertRaises(DrillError):
            self.run_drill(adapter, runner)
        adapter.fault = None
        adapter.events.clear()
        with self.assertRaises(DrillError) as caught:
            self.run_drill(adapter, runner)
        self.assertEqual(caught.exception.phase, "create-target")
        self.assertNotIn("restore", adapter.events)
        self.assertNotIn("dispose", adapter.events)

    def test_ownership_change_refuses_disposal(self):
        adapter = FakeDrill()
        original = adapter.inspect_target

        def changed(lease):
            result = original(lease)
            if "restore" in adapter.events:
                result["lease"]["nonce"] = "another-owner"
            return result
        adapter.inspect_target = changed
        with self.assertRaises(DrillError) as caught:
            self.run_drill(adapter)
        self.assertEqual(caught.exception.disposal, "quarantine-required")
        self.assertNotIn("dispose", adapter.events)

    def test_disposal_failure_not_reported_as_absence(self):
        for fault in ("dispose", "absence"):
            adapter = FakeDrill(fault)
            adapter.probe_access = lambda lease, probes: []
            with self.assertRaises(DrillError) as caught:
                self.run_drill(adapter)
            self.assertIn(caught.exception.disposal, ("quarantine-required", "disposal-unconfirmed"))

    def test_review_requires_positive_negative_and_exact_bundle_acl_pins(self):
        adapter = FakeDrill()
        raw, pin = sealed_fixture()
        for mutation in ("bundle", "acl", "positive-only", "owners"):
            review = review_for(adapter, raw, pin)
            if mutation == "bundle":
                review["bundle_sha256"] = "0" * 64
            elif mutation == "acl":
                review["acl_sha256"] = "0" * 64
            elif mutation == "positive-only":
                review["probes"][1]["allowed"] = True
            else:
                review["owner_mapping"] = {"synthetic_owner": "other"}
            with self.assertRaises(DrillError) as caught:
                self.run_drill(adapter, review=review)
            self.assertEqual(caught.exception.phase, "preflight")
        self.assertEqual(adapter.events, [])

    def test_probe_cannot_redefine_its_own_expected_denial(self):
        adapter = FakeDrill()

        def mutate(lease, probes):
            for probe in probes:
                probe["allowed"] = True
            return [{"id": p["id"], "allowed": p["allowed"]} for p in probes]
        adapter.probe_access = mutate
        with self.assertRaises(DrillError) as caught:
            self.run_drill(adapter)
        self.assertEqual(caught.exception.phase, "access")
        self.assertEqual(caught.exception.disposal, "disposed")

    def test_adapter_cannot_mutate_lease_or_expected_acl(self):
        adapter = FakeDrill()
        original = adapter.apply_acl

        def mutate(lease, payload, *, owner_mapping):
            original(lease, payload, owner_mapping=owner_mapping)
            lease["nonce"] = "mutated-lease"
            payload["entries"][0]["definition"]["grants"] = []
        adapter.apply_acl = mutate
        result = self.run_drill(adapter)
        self.assertEqual(result["target"], adapter.lease)

    def test_creation_side_effect_with_no_valid_lease_is_unconfirmed(self):
        for mode in ("raised", "malformed"):
            adapter = FakeDrill()

            def create():
                adapter.created = True
                if mode == "raised":
                    raise RuntimeError("synthetic factory fails after creating")
                return {"unexpected": True}
            adapter.create_target = create
            with self.assertRaises(DrillError) as caught:
                self.run_drill(adapter)
            self.assertEqual(caught.exception.disposal, "creation-unconfirmed")
            self.assertNotIn("dispose", adapter.events)

    def test_commit_time_mutation_fails_postcommit_validation(self):
        adapter = FakeDrill()
        original = adapter.transaction

        @contextmanager
        def mutate_at_commit(lease):
            with original(lease):
                yield
            adapter.payloads["data"]["entries"][0]["sha256"] = "0" * 64
        adapter.transaction = mutate_at_commit
        with self.assertRaises(DrillError) as caught:
            self.run_drill(adapter)
        self.assertEqual(caught.exception.phase, "postcommit")
        self.assertEqual(caught.exception.disposal, "disposed")

    def test_archive_adapter_cannot_change_reviewed_toc_after_inspection(self):
        adapter = FakeDrill()
        adapter.inspect_archive = lambda dump: adapter.toc
        original = adapter.create_target

        def mutate_toc():
            lease = original()
            adapter.toc[0]["identity"] = "public.unreviewed_synthetic"
            return lease
        adapter.create_target = mutate_toc
        with self.assertRaises(DrillError) as caught:
            self.run_drill(adapter)
        self.assertEqual(caught.exception.phase, "restore")
        self.assertEqual(caught.exception.disposal, "disposed")


if __name__ == "__main__":
    unittest.main()
