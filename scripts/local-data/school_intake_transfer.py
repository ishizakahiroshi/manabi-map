"""Synthetic authenticated intake transfer candidate; no production key handling.

The verifier's explicitly injected trust map is the authority. An Actor string,
an envelope-supplied key, or successful schema validation cannot grant authority.
Replay/order and consent authorization belong to the durable receiving queue.
"""
import hashlib
import hmac
import json
import re


class TransferError(ValueError):
    pass


EVENT_FIELDS = frozenset(("event_id", "request_id", "revision", "subject_ref",
                          "school_id", "department_id", "kind", "consent",
                          "school_consent", "payload"))
HEADER_FIELDS = frozenset(("version", "purpose", "issuer", "key_id"))
PURPOSE = "school-intake-transfer"


def _token(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", value) is not None


def _canonical(value):
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"),
                          ensure_ascii=True, allow_nan=False).encode("ascii")
    except (TypeError, ValueError, UnicodeError) as exc:
        raise TransferError("invalid transfer JSON") from exc


def _event(event):
    if not isinstance(event, dict) or set(event) != EVENT_FIELDS:
        raise TransferError("exact transfer event fields required")
    for name in ("event_id", "request_id", "subject_ref", "school_id", "department_id"):
        if not _token(event[name]):
            raise TransferError("invalid transfer scope identifier")
    if type(event["revision"]) is not int or not 1 <= event["revision"] <= 2147483647:
        raise TransferError("positive transfer revision required")
    if event["kind"] not in ("reviewed", "consent", "withdrawn"):
        raise TransferError("invalid transfer event kind")
    for name in ("consent", "school_consent"):
        if event[name] is not None and type(event[name]) is not bool:
            raise TransferError("explicit boolean or unknown consent required")
    if event["kind"] == "withdrawn" and event["consent"] is not False:
        raise TransferError("withdrawn event requires false consent")
    payload = event["payload"]
    if not isinstance(payload, dict) or set(payload) != {"school_id", "department_id", "field", "value"}:
        raise TransferError("minimal transfer payload required")
    if payload["school_id"] != event["school_id"] or payload["department_id"] != event["department_id"]:
        raise TransferError("transfer payload scope mismatch")
    if payload["field"] != "deviation_value" or type(payload["value"]) is not int or not 20 <= payload["value"] <= 80:
        raise TransferError("intake deviation must be integer 20..80")
    return json.loads(_canonical(event))


def _key(key):
    if not isinstance(key, bytes) or len(key) < 32:
        raise TransferError("explicit synthetic signing key of at least 32 bytes required")
    return key


def issue_envelope(event, *, issuer, key_id, key):
    """Issue using an externally authorized synthetic executor's secret key."""
    event = _event(event)
    if not _token(issuer) or not _token(key_id):
        raise TransferError("invalid issuer or key identifier")
    envelope = dict(event, version=1, purpose=PURPOSE, issuer=issuer, key_id=key_id)
    envelope["signature"] = hmac.new(_key(key), _canonical(envelope), hashlib.sha256).hexdigest()
    return envelope


def verify_envelope(envelope, *, trusted_keys):
    """Return a detached minimal event only after trust and MAC verification."""
    if not isinstance(envelope, dict) or set(envelope) != EVENT_FIELDS | HEADER_FIELDS | {"signature"}:
        raise TransferError("exact signed envelope fields required")
    if type(envelope["version"]) is not int or envelope["version"] != 1 or envelope["purpose"] != PURPOSE:
        raise TransferError("unsupported transfer version or purpose")
    if not _token(envelope["issuer"]) or not _token(envelope["key_id"]):
        raise TransferError("invalid issuer or key identifier")
    if not isinstance(trusted_keys, dict):
        raise TransferError("explicit trusted issuer map required")
    key = trusted_keys.get((envelope["issuer"], envelope["key_id"]))
    if key is None:
        raise TransferError("untrusted transfer issuer")
    signature = envelope["signature"]
    if not isinstance(signature, str) or re.fullmatch(r"[0-9a-f]{64}", signature) is None:
        raise TransferError("invalid transfer signature")
    signed = {k: v for k, v in envelope.items() if k != "signature"}
    expected = hmac.new(_key(key), _canonical(signed), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise TransferError("transfer signature mismatch")
    return _event({k: envelope[k] for k in EVENT_FIELDS})
