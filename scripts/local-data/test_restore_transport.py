"""Invented bytes and adapters only. FakeCodec is NOT encryption or production code."""

import copy
import hashlib
import unittest

import restore_bundle
import restore_transport as transport


class FakeCodec:
    """Transparent test framing ONLY; no cryptographic security is claimed."""
    identifier = "synthetic-test-frame"

    def __init__(self, key=b"invented-key"):
        self.key = key
        self.decrypt_calls = 0

    def encrypt(self, raw):
        return b"TEST-ONLY:" + self.key + b":" + raw

    def decrypt(self, raw):
        self.decrypt_calls += 1
        prefix = b"TEST-ONLY:" + self.key + b":"
        if not raw.startswith(prefix):
            raise ValueError("synthetic secret failure detail must not escape")
        return raw[len(prefix):]


class FakeStore:
    def __init__(self):
        self.objects = {}
        self.events = []
        self.fail = None

    def put_if_absent(self, key, raw):
        self.events.append(("put", key))
        if self.fail == ("put", key):
            raise TimeoutError("synthetic private adapter detail")
        if key in self.objects:
            raise FileExistsError("immutable key")
        self.objects[key] = raw

    def get(self, key):
        self.events.append(("get", key))
        if self.fail == ("get", key):
            raise TimeoutError("synthetic private adapter detail")
        return self.objects[key]


def package(generation="synthetic-001", raw=b"invented dump and semantic payloads"):
    return transport.prepare(raw, bundle_pin={"format": "restore-bundle-pin-v1",
        "generation": generation, "sha256": hashlib.sha256(raw).hexdigest()}, codec=FakeCodec())


def published(generation="synthetic-001", raw=b"invented dump and semantic payloads"):
    candidate, store = package(generation, raw), FakeStore()
    transport.publish(candidate, expected=candidate["pin"], store=store)
    return candidate, store


class RestoreTransportTests(unittest.TestCase):
    def recover(self, candidate, store, codec=None, maximum=4096):
        return transport.recover(expected=candidate["pin"], store=store,
                                 codec=codec or FakeCodec(), max_bundle_bytes=maximum)

    def test_round_trip_exact_bytes_and_completion_last(self):
        raw = b"\x00invented binary dump\xff\nsemantic payload\r\n"
        candidate, store = published(raw=raw)
        before = copy.deepcopy(candidate)
        self.assertEqual(self.recover(candidate, store), raw)
        self.assertEqual(candidate, before)
        puts = [key for action, key in store.events if action == "put"]
        self.assertEqual([key.rsplit("/", 1)[-1] for key in puts],
                         ["reservation.json", "payload.enc", "descriptor.json", "completion.json"])
        complete = store.events.index(("put", "generations/synthetic-001/completion.json"))
        for name in ("reservation.json", "payload.enc", "descriptor.json"):
            self.assertLess(store.events.index(("get", "generations/synthetic-001/" + name)), complete)
        self.assertEqual(set(store.objects), set(puts))

    def test_actual_semantic_bundle_survives_transport_and_independent_validation(self):
        generation, snapshot = "synthetic-integration", "invented-snapshot"
        dump = b"invented archive bytes; never pg_restore input"
        targets = {kind: (["public.synthetic_rows"] if kind in ("schema", "data") else [])
                   for kind in restore_bundle.KINDS}
        descriptor = {"generation": generation, "snapshot": snapshot,
            "source": {"system": "synthetic-system", "database": "synthetic-source"},
            "app_revision": "a" * 40, "versions": {"server": "17.6", "pg_dump": "18.4", "pg_restore": "18.4"},
            "migrations": [{"id": "200001010001", "sha256": "b" * 64}],
            "baseline_sha256": "c" * 64, "dump_flags": list(restore_bundle.FLAGS),
            "scope": {"assurance": "partial", "targets": targets,
                      "exclusions": [{"identity": "provider.external-services", "reason": "synthetic integration only"}]}}
        payloads = {kind: {"generation": generation, "snapshot": snapshot, "entries": []}
                    for kind in restore_bundle.KINDS}
        payloads["schema"]["entries"] = [{"identity": "public.synthetic_rows",
            "definition": "CREATE TABLE public.synthetic_rows (id integer);"}]
        payloads["data"]["entries"] = [{"identity": "public.synthetic_rows", "rows": 0,
                                       "sha256": hashlib.sha256(b"[]").hexdigest()}]
        raw = restore_bundle.pack(descriptor, dump, payloads)
        trusted_bundle_pin = restore_bundle.pin_for(raw)
        candidate = transport.prepare(raw, bundle_pin=trusted_bundle_pin, codec=FakeCodec())
        trusted_transport_pin = copy.deepcopy(candidate["pin"])
        store = FakeStore()
        transport.publish(candidate, expected=trusted_transport_pin, store=store)
        restored = transport.recover(expected=trusted_transport_pin, store=store,
                                     codec=FakeCodec(), max_bundle_bytes=restore_bundle.MAX_BYTES)
        verified = restore_bundle.validate(restored, expected=trusted_bundle_pin)
        self.assertEqual(restored, raw)
        self.assertEqual(restore_bundle.dump_bytes(verified), dump)
        self.assertEqual(verified["artifacts"]["schema"]["payload"], payloads["schema"])
        self.assertEqual(verified["descriptor"]["scope"]["assurance"], "partial")

    def test_every_precompletion_timeout_preserves_prior_success(self):
        for action, name in (("put", "reservation.json"), ("get", "reservation.json"),
                             ("put", "payload.enc"), ("get", "payload.enc"),
                             ("put", "descriptor.json"), ("get", "descriptor.json"),
                             ("put", "completion.json")):
            with self.subTest(action=action, name=name):
                previous, store = published()
                old = copy.deepcopy(store.objects)
                candidate = package("synthetic-002", b"new invented payload")
                store.fail = (action, "generations/synthetic-002/" + name)
                with self.assertRaises(transport.TransportError) as caught:
                    transport.publish(candidate, expected=candidate["pin"], store=store)
                self.assertNotIn("private", str(caught.exception))
                self.assertNotIn("generations/synthetic-002/completion.json", store.objects)
                self.assertEqual({key: store.objects[key] for key in old}, old)
                self.assertEqual(self.recover(previous, store), b"invented dump and semantic payloads")

    def test_completion_timeout_after_write_is_unknown_without_cleanup(self):
        candidate, store = package(), FakeStore()
        original = store.put_if_absent
        def put(key, raw):
            original(key, raw)
            if key.endswith("completion.json"):
                raise TimeoutError("response lost after successful write")
        store.put_if_absent = put
        with self.assertRaises(transport.TransportError):
            transport.publish(candidate, expected=candidate["pin"], store=store)
        self.assertEqual(self.recover(candidate, store), b"invented dump and semantic payloads")
        with self.assertRaises(transport.TransportError):
            transport.publish(candidate, expected=candidate["pin"], store=store)

    def test_existing_generation_is_never_overwritten_even_identical(self):
        candidate, store = published()
        old = copy.deepcopy(store.objects)
        for attempt in (candidate, package(raw=b"other bytes")):
            with self.assertRaises(transport.TransportError):
                transport.publish(attempt, expected=attempt["pin"], store=store)
            self.assertEqual(store.objects, old)

    def test_readback_corruption_prevents_completion(self):
        for name in ("reservation.json", "payload.enc", "descriptor.json"):
            with self.subTest(name=name):
                candidate, store = package(), FakeStore()
                original = store.get
                store.get = lambda key: original(key) + (b"changed" if key.endswith(name) else b"")
                with self.assertRaises(transport.TransportError):
                    transport.publish(candidate, expected=candidate["pin"], store=store)
                self.assertNotIn("generations/synthetic-001/completion.json", store.objects)

    def test_missing_corrupt_or_swapped_objects_rejected_before_decryption(self):
        for name in ("completion.json", "descriptor.json", "payload.enc"):
            for fault in ("missing", "changed", "swapped"):
                with self.subTest(name=name, fault=fault):
                    candidate, store = published()
                    other, other_store = published("synthetic-002", b"other payload")
                    key = "generations/synthetic-001/" + name
                    if fault == "missing":
                        del store.objects[key]
                    elif fault == "changed":
                        store.objects[key] += b"changed"
                    else:
                        store.objects[key] = other_store.objects["generations/synthetic-002/" + name]
                    codec = FakeCodec()
                    with self.assertRaises(transport.TransportError):
                        self.recover(candidate, store, codec)
                    self.assertEqual(codec.decrypt_calls, 0)

    def test_wrong_key_and_wrong_codec_are_rejected_without_payload_disclosure(self):
        candidate, store = published()
        codec = FakeCodec(b"wrong-key")
        with self.assertRaises(transport.TransportError) as caught:
            self.recover(candidate, store, codec)
        self.assertNotIn("secret", str(caught.exception))
        codec.identifier = "other-codec"
        codec.decrypt_calls = 0
        with self.assertRaises(transport.TransportError):
            self.recover(candidate, store, codec)
        self.assertEqual(codec.decrypt_calls, 0)

    def test_decrypted_stage_must_match_before_expansion(self):
        candidate, store = published()
        codec = FakeCodec()
        codec.decrypt = lambda raw: b"bad compressed payload"
        with self.assertRaisesRegex(transport.TransportError, "stage bytes"):
            self.recover(candidate, store, codec)

    def test_expansion_bound_and_bundle_hash_are_verified(self):
        candidate, store = published(raw=b"x" * 10000)
        codec = FakeCodec()
        with self.assertRaisesRegex(transport.TransportError, "memory budget"):
            self.recover(candidate, store, codec)
        self.assertEqual(codec.decrypt_calls, 0)
        # Newly reviewed but internally incorrect descriptor must still fail.
        for size in (1, 9999, 10001):
            altered = copy.deepcopy(candidate)
            descriptor = transport._decode(altered["descriptor"])
            descriptor["stages"]["bundle"]["size"] = size
            altered["descriptor"] = transport._encode(descriptor)
            altered["pin"]["descriptor_sha256"] = transport._digest(altered["descriptor"])
            target = FakeStore()
            transport.publish(altered, expected=altered["pin"], store=target)
            with self.assertRaises(transport.TransportError):
                self.recover(altered, target, maximum=20000)

    def test_explicit_selection_and_input_pin_checked_before_adapters(self):
        for generation in ("latest", "current", "../other", "other/path", "", "UPPER", None):
            with self.subTest(generation=generation), self.assertRaises(transport.TransportError):
                package(generation)
        candidate, store = published()
        for field, value in (("generation", "latest"), ("descriptor_sha256", "bad"),
                             ("bundle_sha256", "bad"), ("format", "unknown")):
            altered = copy.deepcopy(candidate)
            altered["pin"][field] = value
            store.events.clear()
            with self.assertRaises(transport.TransportError):
                self.recover(altered, store)
            self.assertEqual(store.events, [])
        with self.assertRaisesRegex(transport.TransportError, "bundle pin mismatch"):
            transport.prepare(b"wrong", bundle_pin={"format": "restore-bundle-pin-v1",
                              "generation": "synthetic-001", "sha256": "a" * 64}, codec=FakeCodec())

    def test_recovery_timeout_at_each_read_never_calls_decrypt(self):
        for name in ("completion.json", "descriptor.json", "payload.enc"):
            candidate, store = published()
            store.fail = ("get", "generations/synthetic-001/" + name)
            codec = FakeCodec()
            with self.assertRaises(transport.TransportError):
                self.recover(candidate, store, codec)
            self.assertEqual(codec.decrypt_calls, 0)

    def test_callbacks_cannot_mutate_retained_publication_or_recovery_inputs(self):
        candidate, store = package(), FakeStore()
        trusted = copy.deepcopy(candidate["pin"])
        original = store.put_if_absent
        def put(key, raw):
            original(key, raw)
            candidate["pin"]["generation"] = "synthetic-mutated"
            candidate["descriptor"] = b"changed"
            candidate["ciphertext"] = b"changed"
        store.put_if_absent = put
        receipt = transport.publish(candidate, expected=candidate["pin"], store=store)
        self.assertEqual(receipt["generation"], "synthetic-001")
        original_get = store.get
        def get(key):
            trusted["generation"] = "synthetic-mutated"
            trusted["bundle_sha256"] = "f" * 64
            return original_get(key)
        store.get = get
        self.assertEqual(transport.recover(expected=trusted, store=store, codec=FakeCodec(), max_bundle_bytes=4096),
                         b"invented dump and semantic payloads")
        self.assertFalse(any("mutated" in key for _, key in store.events))

    def test_stage_budgets_stop_before_cipher_read_or_codec(self):
        for budget in ("max_compressed_bytes", "max_ciphertext_bytes"):
            candidate, store = published()
            store.events.clear()
            codec = FakeCodec()
            with self.assertRaisesRegex(transport.TransportError, "memory budget"):
                transport.recover(expected=candidate["pin"], store=store, codec=codec,
                                  max_bundle_bytes=4096, **{budget: 1})
            self.assertEqual(codec.decrypt_calls, 0)
            self.assertNotIn(("get", "generations/synthetic-001/payload.enc"), store.events)
        codec = FakeCodec()
        codec.encrypt = lambda _: self.fail("must reject before encrypt")
        with self.assertRaisesRegex(transport.TransportError, "memory budget"):
            transport.prepare(b"invented", bundle_pin={"format": "restore-bundle-pin-v1",
                "generation": "synthetic-001", "sha256": hashlib.sha256(b"invented").hexdigest()},
                codec=codec, max_compressed_bytes=1)


if __name__ == "__main__":
    unittest.main()
