"""Inactive, owned-new-target restore runner with explicit reviewed inputs.

No connection implementation is shipped. Adapter receipts are attestations that
a future adapter must obtain from the actual target, not configuration flags.
transaction() must cover dump/ACL restoration and validation atomically. A target
which cannot do that is rejected; non-atomic provider restore is unsupported.
On failure, destruction is attempted only for the exact created ownership lease.
No object contents, driver errors or credentials are returned in diagnostic state.
"""

import restore_bundle as bundle


TOC_KINDS = {"schema", "table", "table-data", "sequence", "sequence-value", "function",
             "policy", "index", "constraint", "trigger", "extension"}


class DrillError(RuntimeError):
    def __init__(self, phase, disposal):
        self.phase, self.disposal = phase, disposal
        super().__init__("restore failed: " + phase + "; " + disposal)


def _review(review, value, pin):
    bundle.fields(review, "bundle_sha256 toc_sha256 acl_sha256 owner_mapping probes")
    bundle.require(review["bundle_sha256"] == pin["sha256"]
                   and bundle.sha(review["toc_sha256"])
                   and review["acl_sha256"] == value["artifacts"]["acl"]["sha256"], "review pin mismatch")
    # Remapping identifiers inside SQL requires a generation-specific adapter;
    # arbitrary string substitution would corrupt definitions and is not offered.
    bundle.require(review["owner_mapping"] == {}, "owner remapping unsupported")
    probes = review["probes"]
    bundle.require(type(probes) is list and len(probes) >= 2, "access probes required")
    for probe in probes:
        bundle.fields(probe, "id role operation object allowed")
        bundle.require(all(bundle.identifier(probe[k]) for k in ("id", "role"))
                       and all(bundle.text(probe[k]) for k in ("operation", "object"))
                       and type(probe["allowed"]) is bool, "invalid access probe")
    ids = [probe["id"] for probe in probes]
    bundle.require(ids == sorted(set(ids)) and {p["allowed"] for p in probes} == {True, False},
                   "positive and negative access probes required")


def _toc(value):
    bundle.require(type(value) is list and value, "empty archive TOC")
    for item in value:
        bundle.fields(item, "kind identity")
        bundle.require(item["kind"] in TOC_KINDS and bundle.text(item["identity"]), "unsupported TOC object")
    encoded = [bundle.canonical(item) for item in value]
    bundle.require(encoded == sorted(set(encoded)), "TOC must be sorted and unique")


def _lease(value):
    bundle.fields(value, "identity nonce")
    bundle.identity(value["identity"])
    bundle.require(bundle.identifier(value["nonce"]), "invalid ownership nonce")


def _owned(adapter, lease, source, *, fresh=False, cleanup=False):
    observed = adapter.inspect_target(bundle.detached(lease))
    bundle.fields(observed, "lease empty isolated atomic provider_ready")
    bundle.require(observed["lease"] == lease and lease["identity"] != source, "target ownership mismatch")
    bundle.require(all(type(observed[k]) is bool for k in ("empty", "isolated", "atomic", "provider_ready")),
                   "invalid target observation")
    if cleanup:
        bundle.require(observed["isolated"], "shared target cannot be disposed")
        return
    bundle.require(observed["isolated"] and observed["atomic"] and observed["provider_ready"],
                   "target prerequisites missing")
    if fresh:
        bundle.require(observed["empty"], "target is not empty")


class DrillRunner:
    """One coordinator, one record of consumed identities; never reuse a target.

    A future adapter must also enforce new/owned targets across process restarts.
    The in-memory registry alone does not prove durable novelty or isolation.
    """

    def __init__(self):
        self.used_targets = set()

    def run(self, raw, *, expected, review, adapter):
        phase, lease, source, creation_attempted = "preflight", None, None, False
        try:
            value = bundle.validate(raw, expected=expected)
            review = bundle.decode(bundle.canonical(review))
            _review(review, value, expected)
            source = value["descriptor"]["source"]
            dump = bundle.dump_bytes(value)
            phase = "archive-review"
            toc = bundle.detached(adapter.inspect_archive(dump))
            _toc(toc)
            bundle.require(bundle.digest(bundle.canonical(toc)) == review["toc_sha256"], "TOC review mismatch")
            phase = "create-target"
            creation_attempted = True
            candidate = adapter.create_target()
            _lease(candidate)
            candidate = bundle.decode(bundle.canonical(candidate))
            identity_key = bundle.canonical(candidate["identity"])
            bundle.require(identity_key not in self.used_targets and candidate["identity"] != source,
                           "target reused or source selected")
            # Only a validated new ownership lease may enter cleanup handling.
            lease = candidate
            self.used_targets.add(identity_key)
            phase = "target-guard"
            _owned(adapter, lease, source, fresh=True)
            phase = "restore"
            with adapter.transaction(bundle.detached(lease)):
                _owned(adapter, lease, source, fresh=True)
                adapter.restore(bundle.detached(lease), dump, bundle.detached(toc), flags=["--no-owner", "--no-acl", "--exit-on-error"])
                _owned(adapter, lease, source)
                phase = "acl"
                adapter.apply_acl(bundle.detached(lease), bundle.detached(value["artifacts"]["acl"]["payload"]), owner_mapping={})
                _owned(adapter, lease, source)
                phase = "expectations"
                observed = adapter.collect_restored(bundle.detached(lease), bundle.detached(value["descriptor"]))
                bundle.validate_payloads(value["descriptor"], observed)
                for kind in bundle.KINDS:
                    bundle.require(bundle.digest(bundle.canonical(observed[kind]))
                                   == value["artifacts"][kind]["sha256"], "restored expectation mismatch")
                phase = "access"
                wanted = [{"id": probe["id"], "allowed": probe["allowed"]} for probe in review["probes"]]
                actual = adapter.probe_access(bundle.detached(lease), bundle.detached(review["probes"]))
                bundle.require(actual == wanted, "access expectation mismatch")
                _owned(adapter, lease, source)
                phase = "commit"
            phase = "postcommit"
            _owned(adapter, lease, source)
            # Deferred triggers and commit-time adapter failures must not bypass
            # the acceptance checks performed inside the transaction.
            observed = adapter.collect_restored(bundle.detached(lease), bundle.detached(value["descriptor"]))
            bundle.validate_payloads(value["descriptor"], observed)
            for kind in bundle.KINDS:
                bundle.require(bundle.digest(bundle.canonical(observed[kind]))
                               == value["artifacts"][kind]["sha256"], "postcommit expectation mismatch")
            wanted = [{"id": probe["id"], "allowed": probe["allowed"]} for probe in review["probes"]]
            bundle.require(adapter.probe_access(bundle.detached(lease), bundle.detached(review["probes"])) == wanted,
                           "postcommit access mismatch")
            _owned(adapter, lease, source)
            return {"state": "verified-partial", "generation": value["descriptor"]["generation"],
                    "target": lease, "assurance": "partial", "exclusions": value["descriptor"]["scope"]["exclusions"],
                    "retention": "awaiting-owner-disposal"}
        except Exception:
            disposal = "creation-unconfirmed" if creation_attempted else "not-created"
            if lease is not None:
                disposal = "quarantine-required"
                try:
                    # Never destroy based on a stale receipt if ownership changed.
                    _owned(adapter, lease, source, cleanup=True)
                    adapter.quarantine(bundle.detached(lease))
                    _owned(adapter, lease, source, cleanup=True)
                    adapter.dispose(bundle.detached(lease))
                    disposal = "disposed" if adapter.is_absent(bundle.detached(lease)) is True else "disposal-unconfirmed"
                except Exception:
                    disposal = "quarantine-required"
            raise DrillError(phase, disposal) from None
