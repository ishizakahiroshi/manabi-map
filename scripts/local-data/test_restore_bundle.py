"""Wholly invented bundle fixtures; no source DB, backup, credentials or I/O."""

import copy
import unittest

import restore_bundle as bundle


def fixture():
    descriptor = {
        "generation": "synthetic-generation-001", "snapshot": "synthetic-snapshot-001",
        "source": {"system": "synthetic-source-system", "database": "synthetic-source-db"},
        "app_revision": "a" * 40, "versions": {"server": "18.4", "pg_dump": "18.4", "pg_restore": "18.4"},
        "migrations": [{"id": "200001010001", "sha256": bundle.digest(b"invented migration")}],
        "baseline_sha256": bundle.digest(b"invented baseline"), "dump_flags": list(bundle.FLAGS),
        "scope": {"assurance": "partial", "targets": {
            "schema": ["public.synthetic_rows"], "data": ["public.synthetic_rows"],
            "acl": ["public.synthetic_rows"], "rls": ["public.synthetic_rows"],
            "rpc": ["public.synthetic_lookup()"], "provider": ["extension.synthetic_extension"],
        }, "exclusions": [{"identity": "provider.external-services", "reason": "Invented fixture has no external auth service."}]},
    }
    definitions = {
        "schema": [{"identity": "public.synthetic_rows", "definition": "CREATE TABLE public.synthetic_rows (id integer);"}],
        "data": [{"identity": "public.synthetic_rows", "rows": 1, "sha256": bundle.digest(b"[[1]]")}],
        "acl": [{"identity": "public.synthetic_rows", "definition": {"object_kind": "table", "owner": "synthetic_owner", "grants": [
            {"grantor": "synthetic_owner", "grantee": "synthetic_reader", "privilege": "SELECT", "grantable": False}]}}],
        "rls": [{"identity": "public.synthetic_rows", "definition": {"enabled": True, "forced": True, "policies": [
            {"identity": "synthetic_read_policy", "definition": "USING (id = 1)"}]}}],
        "rpc": [{"identity": "public.synthetic_lookup()", "definition": "SELECT 1; -- invented RPC definition"}],
        "provider": [{"identity": "extension.synthetic_extension", "definition": {"version": "1.0", "owner": "synthetic_owner"}}],
    }
    payloads = {kind: {"generation": descriptor["generation"], "snapshot": descriptor["snapshot"], "entries": entries}
                for kind, entries in definitions.items()}
    return descriptor, b"invented archive bytes, not pg_restore input", payloads


def sealed_fixture():
    descriptor, dump, payloads = fixture()
    raw = bundle.pack(descriptor, dump, payloads)
    return raw, bundle.pin_for(raw)


class BundleTests(unittest.TestCase):
    def test_complete_payload_roundtrip_and_no_mutation(self):
        descriptor, dump, payloads = fixture()
        original = copy.deepcopy((descriptor, payloads))
        raw = bundle.pack(descriptor, dump, payloads)
        value = bundle.validate(raw, expected=bundle.pin_for(raw))
        self.assertEqual(bundle.dump_bytes(value), dump)
        self.assertEqual({k: v["payload"] for k, v in value["artifacts"].items()}, payloads)
        self.assertEqual((descriptor, payloads), original)
        self.assertEqual(value["descriptor"]["scope"]["assurance"], "partial")

    def test_retained_pin_rejects_rehashed_definition(self):
        raw, pin = sealed_fixture()
        value = bundle.decode(raw)
        value["artifacts"]["rpc"]["payload"]["entries"][0]["definition"] = "SELECT 99"
        value["artifacts"]["rpc"]["sha256"] = bundle.digest(bundle.canonical(value["artifacts"]["rpc"]["payload"]))
        with self.assertRaisesRegex(ValueError, "pin mismatch"):
            bundle.validate(bundle.canonical(value), expected=pin)

    def test_internal_hash_required_even_with_new_pin(self):
        raw, _ = sealed_fixture()
        value = bundle.decode(raw)
        value["artifacts"]["schema"]["payload"]["entries"][0]["definition"] = "SELECT 99"
        altered = bundle.canonical(value)
        with self.assertRaisesRegex(ValueError, "definition hash"):
            bundle.validate(altered, expected=bundle.pin_for(altered))

    def test_exact_inventory_missing_extra_reordered_and_hash_only_rejected(self):
        for mutation in ("missing", "extra", "digest-only", "wrong-generation", "wrong-snapshot"):
            with self.subTest(mutation=mutation):
                descriptor, dump, payloads = fixture()
                payload = payloads["acl"]
                if mutation == "missing":
                    payload["entries"] = []
                elif mutation == "extra":
                    payload["entries"].append(copy.deepcopy(payload["entries"][0]))
                elif mutation == "digest-only":
                    payload["entries"][0] = {"identity": "public.synthetic_rows", "sha256": "a" * 64}
                elif mutation == "wrong-generation":
                    payload["generation"] = "other"
                else:
                    payload["snapshot"] = "other"
                with self.assertRaises(ValueError):
                    bundle.pack(descriptor, dump, payloads)

    def test_empty_declared_class_is_distinct_from_missing_class(self):
        descriptor, dump, payloads = fixture()
        descriptor["scope"]["targets"]["rpc"] = []
        payloads["rpc"]["entries"] = []
        raw = bundle.pack(descriptor, dump, payloads)
        bundle.validate(raw, expected=bundle.pin_for(raw))
        del payloads["rpc"]
        with self.assertRaises(ValueError):
            bundle.pack(descriptor, dump, payloads)

    def test_partial_scope_and_provider_exclusion_mandatory(self):
        for mutation in ("full", "no-exclusion", "wrong-exclusion", "unknown-field"):
            with self.subTest(mutation=mutation):
                descriptor, dump, payloads = fixture()
                if mutation == "full":
                    descriptor["scope"]["assurance"] = "full"
                elif mutation == "no-exclusion":
                    descriptor["scope"]["exclusions"] = []
                elif mutation == "wrong-exclusion":
                    descriptor["scope"]["exclusions"][0]["identity"] = "unrelated"
                else:
                    descriptor["live_enabled"] = True
                with self.assertRaises(ValueError):
                    bundle.pack(descriptor, dump, payloads)

    def test_generation_grammar_matches_immutable_transport_keys(self):
        for generation in ("latest", "current", "Uppercase", "a.b", "a:b", "a_b", "a" * 97):
            descriptor, dump, payloads = fixture()
            descriptor["generation"] = generation
            for payload in payloads.values():
                payload["generation"] = generation
            with self.assertRaises(ValueError):
                bundle.pack(descriptor, dump, payloads)

    def test_strict_types_acl_and_dump_integrity(self):
        descriptor, dump, payloads = fixture()
        payloads["data"]["entries"][0]["rows"] = True
        with self.assertRaises(ValueError):
            bundle.pack(descriptor, dump, payloads)
        raw, _ = sealed_fixture()
        for key, bad in (("size", True), ("sha256", "0" * 64), ("base64", "not-base64")):
            value = bundle.decode(raw)
            value["dump"][key] = bad
            altered = bundle.canonical(value)
            with self.assertRaises(ValueError):
                bundle.validate(altered, expected=bundle.pin_for(altered))

    def test_canonical_duplicate_unknown_format_and_untrusted_pin(self):
        with self.assertRaises(ValueError):
            bundle.decode(b'{"x":1,"x":2}')
        with self.assertRaises(ValueError):
            bundle.decode(b'{"x":NaN}')
        raw, pin = sealed_fixture()
        with self.assertRaises(ValueError):
            bundle.validate(raw + b"\n", expected={**pin, "sha256": bundle.digest(raw + b"\n")})
        for key, value in (("format", "other"), ("generation", "other"), ("sha256", "0" * 64)):
            with self.assertRaises(ValueError):
                bundle.validate(raw, expected={**pin, key: value})


if __name__ == "__main__":
    unittest.main()
