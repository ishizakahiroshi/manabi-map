"""Inactive snapshot orchestration. No CLI or implicit credentials.

Adapter contract: protect(scope) owns a non-MVCC freeze until context exit;
snapshot() holds a READ ONLY/REPEATABLE READ export until context exit. collect
must import that snapshot before any read; dump must use the same snapshot.
check() raises on lost ownership/liveness. inventory() covers the agreed frozen
sequence/role/DDL/provider state. Every method receives a monotonic deadline.
The core checks elapsed time between calls, not a hard interrupt of a blocked
adapter. restore_pg_adapter supplies explicit PostgreSQL connections and hard
subprocess deadlines; its reviewed scope and external freeze remain prerequisites.
"""

from time import monotonic

import restore_bundle as bundle


class CaptureError(RuntimeError):
    def __init__(self, phase):
        self.phase = phase
        super().__init__("capture failed: " + phase)


def capture(adapter, descriptor, *, timeout=60, clock=monotonic):
    """Return bytes + proposed pin only after both owned contexts close cleanly.

    No completion/store publication is done here. Adapter errors are deliberately
    not copied to the result: drivers can include data or connection secrets.
    """
    phase = "preflight"
    try:
        bundle.require(type(timeout) in (int, float) and 0 < timeout <= 3600, "invalid deadline")
        descriptor = bundle.decode(bundle.canonical(descriptor))
        bundle.validate_descriptor(descriptor)
        deadline = clock() + timeout

        def check(*guards):
            bundle.require(clock() < deadline, "capture deadline exceeded")
            for guard in guards:
                guard.check(deadline=deadline)
            bundle.require(clock() < deadline, "capture deadline exceeded")

        phase = "source"
        bundle.require(adapter.source_identity(deadline=deadline) == descriptor["source"], "source mismatch")
        phase = "protection"
        with adapter.protect(bundle.detached(descriptor["scope"]), deadline=deadline) as protection:
            check(protection)
            before = bundle.canonical(protection.inventory(deadline=deadline))
            phase = "snapshot"
            with adapter.snapshot(deadline=deadline) as holder:
                check(protection, holder)
                snapshot = holder.snapshot
                bundle.require(bundle.identifier(snapshot), "invalid exported snapshot")
                descriptor["snapshot"] = snapshot
                phase = "expectations"
                payloads = adapter.collect(snapshot, bundle.detached(descriptor), deadline=deadline)
                bundle.validate_payloads(descriptor, payloads)
                # Snapshot adapter return values are copied before another call.
                payloads = bundle.decode(bundle.canonical(payloads))
                check(protection, holder)
                phase = "dump"
                dump = adapter.dump(snapshot, list(bundle.FLAGS), deadline=deadline)
                check(protection, holder)
                phase = "seal"
                raw = bundle.pack(descriptor, dump, payloads)
                pin = bundle.pin_for(raw)
                bundle.validate(raw, expected=pin)
                check(protection, holder)
                phase = "snapshot-close"
            phase = "non-mvcc"
            check(protection)
            bundle.require(bundle.canonical(protection.inventory(deadline=deadline)) == before,
                           "non-MVCC drift")
            bundle.require(adapter.source_identity(deadline=deadline) == descriptor["source"], "source changed")
            check(protection)
            phase = "protection-close"
        phase = "deadline"
        check()
        return {"bundle": raw, "proposed_pin": pin, "assurance": "partial"}
    except Exception:
        raise CaptureError(phase) from None
