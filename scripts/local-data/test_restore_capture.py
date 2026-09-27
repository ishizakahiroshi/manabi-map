"""Deterministic snapshot/freeze lifecycle tests; never starts PostgreSQL."""

import copy
from contextlib import contextmanager
import unittest

import restore_bundle as bundle
from restore_capture import CaptureError, capture
from test_restore_bundle import fixture


class FakeCapture:
    def __init__(self, fault=None):
        self.descriptor, self.dump_bytes, self.payloads = fixture()
        self.fault = fault
        self.events = []
        self.protected = self.held = False
        self.inventory_reads = 0
        self.snapshot_id = "exported-synthetic-snapshot"
        self.now = 0

    def source_identity(self, *, deadline):
        return copy.deepcopy(self.descriptor["source"])

    @contextmanager
    def protect(self, scope, *, deadline):
        self.events.append("protect")
        self.protected = True
        adapter = self

        class Protection:
            def check(self, *, deadline):
                if not adapter.protected or adapter.fault == "lost-freeze":
                    raise RuntimeError("invented sensitive driver detail")

            def inventory(self, *, deadline):
                adapter.inventory_reads += 1
                return {"synthetic-sequence": 20 if adapter.fault == "drift" and adapter.inventory_reads > 1 else 10,
                        "synthetic-role-owner": "synthetic_owner"}
        try:
            yield Protection()
        finally:
            self.protected = False
            self.events.append("unprotect")
            if self.fault == "unprotect":
                raise RuntimeError("invented sensitive driver detail")

    @contextmanager
    def snapshot(self, *, deadline):
        assert self.protected
        self.events.append("snapshot")
        self.held = True
        adapter = self

        class Holder:
            snapshot = adapter.snapshot_id

            def check(self, *, deadline):
                if not adapter.held or (adapter.fault == "holder" and "collect" in adapter.events):
                    raise RuntimeError("invented sensitive driver detail")
        try:
            self.holder = Holder()
            yield self.holder
        finally:
            self.held = False
            self.events.append("snapshot-close")
            if self.fault == "snapshot-close":
                raise RuntimeError("invented sensitive driver detail")

    def collect(self, snapshot, descriptor, *, deadline):
        assert self.held and self.protected and snapshot == self.snapshot_id
        self.events.append("collect")
        if self.fault == "collector":
            raise RuntimeError("invented sensitive driver detail")
        result = copy.deepcopy(self.payloads)
        for payload in result.values():
            payload["snapshot"] = snapshot
        if self.fault == "mixed":
            result["acl"]["snapshot"] = "other"
        if self.fault == "timeout":
            self.now = deadline + 1
        return result

    def dump(self, snapshot, flags, *, deadline):
        assert self.held and self.protected and snapshot == self.snapshot_id and flags == bundle.FLAGS
        self.events.append("dump")
        if self.fault == "dump":
            raise RuntimeError("invented sensitive driver detail")
        return self.dump_bytes


class CaptureTests(unittest.TestCase):
    def test_hold_snapshot_and_freeze_until_success_then_return(self):
        adapter = FakeCapture()
        original = copy.deepcopy(adapter.descriptor)
        result = capture(adapter, adapter.descriptor, clock=lambda: adapter.now)
        value = bundle.validate(result["bundle"], expected=result["proposed_pin"])
        self.assertEqual(value["descriptor"]["snapshot"], adapter.snapshot_id)
        self.assertEqual(adapter.events, ["protect", "snapshot", "collect", "dump", "snapshot-close", "unprotect"])
        self.assertFalse(adapter.held or adapter.protected)
        self.assertEqual(adapter.descriptor, original)

    def test_every_failure_unwinds_without_result_and_redacts_driver_error(self):
        for fault in ("lost-freeze", "holder", "collector", "dump", "mixed", "drift", "timeout", "snapshot-close", "unprotect"):
            with self.subTest(fault=fault):
                adapter = FakeCapture(fault)
                with self.assertRaises(CaptureError) as caught:
                    capture(adapter, adapter.descriptor, clock=lambda: adapter.now)
                self.assertFalse(adapter.held or adapter.protected)
                self.assertNotIn("sensitive", str(caught.exception))
                self.assertNotEqual(caught.exception.phase, "preflight")
                self.assertEqual(adapter.events[-1], "unprotect")

    def test_source_mismatch_before_protection(self):
        adapter = FakeCapture()
        descriptor = copy.deepcopy(adapter.descriptor)
        descriptor["source"]["database"] = "another-synthetic-db"
        with self.assertRaises(CaptureError) as caught:
            capture(adapter, descriptor)
        self.assertEqual(caught.exception.phase, "source")
        self.assertEqual(adapter.events, [])

    def test_previous_success_bytes_survive_failed_capture(self):
        adapter = FakeCapture()
        previous = capture(adapter, adapter.descriptor)
        digest = bundle.digest(previous["bundle"])
        bad = FakeCapture("drift")
        with self.assertRaises(CaptureError):
            capture(bad, bad.descriptor)
        self.assertEqual(bundle.digest(previous["bundle"]), digest)

    def test_collector_cannot_redefine_descriptor_source_or_scope(self):
        adapter = FakeCapture()
        original = adapter.collect

        def mutating(snapshot, descriptor, *, deadline):
            descriptor["source"]["system"] = "mutated-source"
            descriptor["scope"]["targets"]["acl"] = []
            return original(snapshot, descriptor, deadline=deadline)
        adapter.collect = mutating
        result = capture(adapter, adapter.descriptor)
        value = bundle.validate(result["bundle"], expected=result["proposed_pin"])
        self.assertEqual(value["descriptor"]["source"], adapter.descriptor["source"])
        self.assertEqual(value["descriptor"]["scope"], adapter.descriptor["scope"])

    def test_snapshot_identifier_is_pinned_before_collector_callback(self):
        adapter = FakeCapture()
        original = adapter.collect

        def mutate(snapshot, descriptor, *, deadline):
            result = original(snapshot, descriptor, deadline=deadline)
            adapter.holder.snapshot = "other-snapshot"
            return result
        adapter.collect = mutate
        result = capture(adapter, adapter.descriptor)
        value = bundle.validate(result["bundle"], expected=result["proposed_pin"])
        self.assertEqual(value["descriptor"]["snapshot"], adapter.snapshot_id)


if __name__ == "__main__":
    unittest.main()
