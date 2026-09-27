"""No real identity, credentials, filesystem output, or external dependencies."""
import secrets
import unittest

from school_intake_transfer import TransferError, issue_envelope, verify_envelope


def synthetic_event():
    return dict(event_id="event-1", request_id="request-1", revision=2,
                subject_ref="subject-opaque", school_id="school-1", department_id="department-1",
                kind="reviewed", consent=True, school_consent=True,
                payload=dict(school_id="school-1", department_id="department-1", field="deviation_value", value=61))


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.key = secrets.token_bytes(32)
        self.trust = {("synthetic-executor", "ephemeral-1"): self.key}

    def issue(self, event=None):
        return issue_envelope(event or synthetic_event(), issuer="synthetic-executor", key_id="ephemeral-1", key=self.key)

    def verify(self, envelope):
        return verify_envelope(envelope, trusted_keys=self.trust)

    def test_roundtrip_deterministic_replay_and_detached_result(self):
        event = synthetic_event()
        envelope = self.issue(event)
        self.assertEqual(self.issue(event), envelope)
        result = self.verify(envelope)
        self.assertEqual(result, event)
        result["payload"]["value"] = 52
        self.assertEqual(self.verify(envelope)["payload"]["value"], 61)

    def test_every_field_bound_to_signature(self):
        envelope = self.issue()
        for field, value in (("request_id", "other"), ("event_id", "other"), ("revision", 3),
                             ("subject_ref", "other"), ("school_id", "other"), ("department_id", "other"),
                             ("kind", "withdrawn"), ("consent", False), ("school_consent", False),
                             ("payload", dict(synthetic_event()["payload"], value=52))):
            with self.subTest(field=field), self.assertRaises(TransferError):
                self.verify(dict(envelope, **{field: value}))

    def test_unknown_issuer_wrong_key_and_self_asserted_actor_rejected(self):
        envelope = self.issue()
        for changed in (dict(envelope, issuer="attacker"), dict(envelope, key_id="other"),
                        dict(envelope, actor="admin"), dict(envelope, key="self-supplied"),
                        dict(envelope, version=True), dict(envelope, purpose="other")):
            with self.assertRaises(TransferError):
                self.verify(changed)
        with self.assertRaises(TransferError):
            verify_envelope(envelope, trusted_keys={})
        with self.assertRaises(TransferError):
            verify_envelope(envelope, trusted_keys={("synthetic-executor", "ephemeral-1"): secrets.token_bytes(32)})

    def test_no_sensitive_extra_fields_or_implicit_scope_conversion(self):
        for field, value in (("email", "synthetic-contact"), ("pin", "synthetic"),
                             ("audit", "synthetic"), ("revision", True), ("department_id", None),
                             ("consent", "true"), ("school_consent", 1), ("revision", 0)):
            with self.subTest(field=field), self.assertRaises(TransferError):
                self.issue(dict(synthetic_event(), **{field: value}))
        for value in (0, 19, 81, 100, 61.0, True, float("nan")):
            event = synthetic_event()
            event["payload"]["value"] = value
            with self.assertRaises(TransferError):
                self.issue(event)
        event = synthetic_event()
        event["payload"]["department_id"] = "other"
        with self.assertRaises(TransferError):
            self.issue(event)

    def test_unknown_consent_and_withdrawal_preserved_without_granting_authority(self):
        event = dict(synthetic_event(), consent=None, school_consent=None, kind="consent")
        self.assertEqual(self.verify(self.issue(event)), event)
        event.update(kind="withdrawn", consent=False)
        self.assertEqual(self.verify(self.issue(event)), event)
        event["consent"] = True
        with self.assertRaises(TransferError):
            self.issue(event)

    def test_weak_key_and_malformed_signature_rejected(self):
        with self.assertRaises(TransferError):
            issue_envelope(synthetic_event(), issuer="synthetic-executor", key_id="ephemeral-1", key=b"short")
        for signature in (None, "f" * 63, "z" * 64, "F" * 64):
            with self.assertRaises(TransferError):
                self.verify(dict(self.issue(), signature=signature))


if __name__ == "__main__":
    unittest.main()
