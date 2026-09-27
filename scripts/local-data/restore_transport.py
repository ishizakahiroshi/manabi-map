"""Inactive, injected transport for an explicitly selected restore generation.

There is no CLI, network, filesystem, environment lookup, key loading or built-in
encryption. A separately reviewed adapter must supply authenticated encryption
and atomic create-only storage. Codec identifiers are metadata, not proof that
the codec is secure. Test codecs must never be wired into an operational adapter.

Only ciphertext and metadata go to the store. Plaintext stays in caller-owned
Python memory; immutable bytes cannot be reliably erased. The caller owns any
decryption workspace, retention and cleanup. This module claims no secure erasure.
Provider timeouts must be enforced by adapters. In particular, a timeout during
the final completion PUT has an UNKNOWN outcome: retain the attempt and inspect
that exact generation with its independently retained pin. Never retry under the
same generation or delete an earlier success to make a failed attempt look clean.
"""

import gzip
import hashlib
import io
import json
import re
from typing import Protocol


DEFAULT_MAX_BYTES = 64 * 1024 * 1024


class Store(Protocol):
    def put_if_absent(self, key: str, value: bytes) -> None:
        """Atomically create; fail if key exists, including identical bytes."""

    def get(self, key: str) -> bytes:
        """Return exact bytes or raise; adapter owns bounded I/O and timeouts."""


class Codec(Protocol):
    identifier: str

    def encrypt(self, plaintext: bytes) -> bytes: ...

    def decrypt(self, ciphertext: bytes) -> bytes:
        """Authenticate before returning plaintext; wrong keys must fail."""


class TransportError(ValueError):
    """Sanitized failure; provider exception details may contain secrets."""


def _require(condition, message):
    if not condition:
        raise TransportError(message)


def _encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def _digest(value):
    return hashlib.sha256(value).hexdigest()


def _fields(value, fields):
    _require(isinstance(value, dict) and set(value) == set(fields.split()), "invalid descriptor fields")


def _decode(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            _require(key not in result, "duplicate metadata field")
            result[key] = value
        return result
    _require(type(raw) is bytes and len(raw) <= 16384, "invalid metadata bytes")
    try:
        return json.loads(raw, object_pairs_hook=unique,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeError):
        raise TransportError("invalid metadata JSON") from None


def _generation(value):
    _require(isinstance(value, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,95}", value)
             and value not in {"latest", "current"}, "explicit immutable generation required")
    return value


def _hash(value):
    _require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value), "invalid hash")


def _stage(value):
    _require(type(value) is bytes and bool(value), "nonempty stage bytes required")
    return {"sha256": _digest(value), "size": len(value)}


def _match(raw, stage):
    _fields(stage, "sha256 size")
    _hash(stage["sha256"])
    _require(type(stage["size"]) is int and stage["size"] > 0, "invalid stage size")
    _require(type(raw) is bytes and len(raw) == stage["size"]
             and _digest(raw) == stage["sha256"], "stage bytes differ")


def _call(action, *args):
    try:
        return action(*args)
    except Exception:
        raise TransportError("adapter operation failed; retain attempt and inspect explicit generation") from None


def prepare(bundle, *, bundle_pin, codec, max_bundle_bytes=DEFAULT_MAX_BYTES,
            max_compressed_bytes=DEFAULT_MAX_BYTES, max_ciphertext_bytes=DEFAULT_MAX_BYTES):
    """Seal already validated bundle bytes and return ciphertext/metadata/pin.

    bundle_pin is independently supplied from restore_bundle.pin_for. It must
    not be derived from an untrusted store during recovery. The resulting
    transport pin must likewise be retained independently BEFORE publication.
    Semantic bundle validation belongs to restore_bundle, not this byte layer.
    """
    _fields(bundle_pin, "format generation sha256")
    bundle_pin = _decode(_encode(bundle_pin))
    _budgets(max_bundle_bytes, max_compressed_bytes, max_ciphertext_bytes)
    _require(bundle_pin["format"] == "restore-bundle-pin-v1", "unsupported bundle pin")
    generation = _generation(bundle_pin["generation"])
    bundle_stage = _stage(bundle)
    _require(bundle_stage["size"] <= max_bundle_bytes, "bundle exceeds memory budget")
    _hash(bundle_pin["sha256"])
    _require(bundle_stage["sha256"] == bundle_pin["sha256"], "bundle pin mismatch")
    codec_id = codec.identifier
    _require(isinstance(codec_id, str)
             and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}", codec_id), "invalid codec identifier")
    compressed = gzip.compress(bundle, mtime=0)
    _require(len(compressed) <= max_compressed_bytes, "compressed payload exceeds memory budget")
    ciphertext = _call(codec.encrypt, compressed)
    cipher_stage = _stage(ciphertext)
    _require(cipher_stage["size"] <= max_ciphertext_bytes, "ciphertext exceeds memory budget")
    descriptor = _encode({"format": "restore-transport-v1", "generation": generation,
                          "compression": "gzip", "codec": codec_id,
                          "stages": {"bundle": bundle_stage, "compressed": _stage(compressed),
                                     "ciphertext": cipher_stage}})
    pin = {"format": "restore-transport-pin-v1", "generation": generation,
           "descriptor_sha256": _digest(descriptor), "bundle_sha256": bundle_stage["sha256"]}
    # No plaintext is returned in this publication package.
    return {"descriptor": descriptor, "ciphertext": ciphertext, "pin": pin}


def _descriptor(raw, expected):
    _fields(expected, "format generation descriptor_sha256 bundle_sha256")
    _require(expected["format"] == "restore-transport-pin-v1", "unsupported transport pin")
    _generation(expected["generation"])
    _hash(expected["descriptor_sha256"])
    _hash(expected["bundle_sha256"])
    _require(type(raw) is bytes and _digest(raw) == expected["descriptor_sha256"], "descriptor pin mismatch")
    value = _decode(raw)
    _fields(value, "format generation compression codec stages")
    _require(value["format"] == "restore-transport-v1" and value["generation"] == expected["generation"]
             and value["compression"] == "gzip", "descriptor identity mismatch")
    _require(isinstance(value["codec"], str), "invalid codec")
    _fields(value["stages"], "bundle compressed ciphertext")
    for stage in value["stages"].values():
        _fields(stage, "sha256 size")
        _hash(stage["sha256"])
        _require(type(stage["size"]) is int and stage["size"] > 0, "invalid stage size")
    _require(value["stages"]["bundle"]["sha256"] == expected["bundle_sha256"], "bundle pin mismatch")
    return value


def _completion(pin):
    return _encode({"format": "restore-completion-v1", "generation": pin["generation"],
                    "descriptor_sha256": pin["descriptor_sha256"], "state": "complete"})


def publish(package, *, expected, store):
    """Create a new immutable attempt, verify readback, then publish completion.

    Never lists keys, chooses latest, overwrites, or deletes. Failed attempts
    remain reserved. A completion marker is necessary but not sufficient;
    recover() always verifies all bytes against the independently held pin.
    """
    _fields(package, "descriptor ciphertext pin")
    _require(package["pin"] == expected, "package pin mismatch")
    expected = _decode(_encode(expected))
    package = {"descriptor": package["descriptor"], "ciphertext": package["ciphertext"]}
    descriptor = _descriptor(package["descriptor"], expected)
    _match(package["ciphertext"], descriptor["stages"]["ciphertext"])
    prefix = f"generations/{expected['generation']}/"
    reservation = _encode({"format": "restore-reservation-v1", "descriptor_sha256": expected["descriptor_sha256"]})
    _call(store.put_if_absent, prefix + "reservation.json", reservation)
    _require(_call(store.get, prefix + "reservation.json") == reservation, "reservation readback differs")
    for name, raw in (("payload.enc", package["ciphertext"]), ("descriptor.json", package["descriptor"])):
        _call(store.put_if_absent, prefix + name, raw)
        _require(_call(store.get, prefix + name) == raw, "published readback differs")
    completion = _completion(expected)
    _call(store.put_if_absent, prefix + "completion.json", completion)
    _require(_call(store.get, prefix + "completion.json") == completion, "completion readback differs")
    return {"generation": expected["generation"], "descriptor_sha256": expected["descriptor_sha256"],
            "state": "complete"}


def _budgets(*values):
    _require(all(type(value) is int and value > 0 for value in values), "positive memory budget required")


def recover(*, expected, store, codec, max_bundle_bytes,
            max_compressed_bytes=DEFAULT_MAX_BYTES, max_ciphertext_bytes=DEFAULT_MAX_BYTES):
    """Manual decryption boundary; return exact bundle bytes, never extract files.

    Caller supplies independently retained expected pin and memory budget. Check
    completion, descriptor, cipher hash/size BEFORE invoking the codec; check
    compressed hash/size BEFORE bounded gzip expansion. Caller must validate the
    returned semantic bundle before any restore or workspace write. Stage budgets
    are checked before the cipher GET/decrypt. Store adapters must also enforce
    response size limits during I/O; a byte-returning API cannot bound their
    internal allocation. Codec adapters own bounded output allocation as well.
    """
    _fields(expected, "format generation descriptor_sha256 bundle_sha256")
    expected = _decode(_encode(expected))
    generation = _generation(expected["generation"])
    _budgets(max_bundle_bytes, max_compressed_bytes, max_ciphertext_bytes)
    prefix = f"generations/{generation}/"
    # Validate all pin fields before any adapter call.
    _require(expected["format"] == "restore-transport-pin-v1", "unsupported transport pin")
    _hash(expected["descriptor_sha256"])
    _hash(expected["bundle_sha256"])
    completion = _call(store.get, prefix + "completion.json")
    _require(completion == _completion(expected), "completion mismatch")
    descriptor = _descriptor(_call(store.get, prefix + "descriptor.json"), expected)
    _require(descriptor["codec"] == codec.identifier, "codec mismatch")
    stages = descriptor["stages"]
    _require(stages["bundle"]["size"] <= max_bundle_bytes, "bundle exceeds memory budget")
    _require(stages["compressed"]["size"] <= max_compressed_bytes, "compressed payload exceeds memory budget")
    _require(stages["ciphertext"]["size"] <= max_ciphertext_bytes, "ciphertext exceeds memory budget")
    ciphertext = _call(store.get, prefix + "payload.enc")
    _match(ciphertext, stages["ciphertext"])
    compressed = _call(codec.decrypt, ciphertext)
    _match(compressed, stages["compressed"])
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(compressed), mode="rb") as stream:
            bundle = stream.read(stages["bundle"]["size"] + 1)
    except (OSError, EOFError, ValueError):
        raise TransportError("invalid compressed payload") from None
    _match(bundle, stages["bundle"])
    return bundle
