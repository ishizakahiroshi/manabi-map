"""Versioned restore evidence with embedded definitions; no filesystem or DB I/O.

Separate from the existing synthetic manifest. A valid bundle binds bytes and a
declared inventory, not the truth of a collector or external provider state.
Version 1 deliberately supports partial assurance only: provider services,
credentials and application authentication are outside this database contract.
Never put a bundle or decoded definitions into public artifacts or logs.
"""

import base64
import hashlib
import json
import re


KINDS = ("schema", "data", "acl", "rls", "rpc", "provider")
FLAGS = ["--format=custom", "--no-owner", "--no-acl"]
MAX_BYTES = 64 * 1024 * 1024  # In-memory candidate core, not a streaming large-DB collector.


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode("ascii")


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def fields(value, names):
    require(type(value) is dict and set(value) == set(names.split()), "invalid fields")


def text(value):
    return type(value) is str and bool(value.strip()) and "\x00" not in value


def sha(value):
    return type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def identifier(value):
    return type(value) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}", value) is not None


def generation_id(value):
    return (type(value) is str and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,95}", value) is not None
            and value not in ("latest", "current"))


def detached(value):
    """Do not let a mutable adapter argument become its own acceptance oracle."""
    return decode(canonical(value))


def identity(value):
    """Opaque inventory references, never connection URLs or credentials."""
    fields(value, "system database")
    require(all(identifier(item) for item in value.values()), "invalid database identity")


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def decode(raw):
    require(type(raw) is bytes and 0 < len(raw) <= MAX_BYTES, "invalid bundle bytes")
    try:
        result = json.loads(raw, object_pairs_hook=_pairs,
                            parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        require(canonical(result) == raw, "noncanonical JSON")
        return result
    except (UnicodeError, ValueError, TypeError, RecursionError):
        raise ValueError("invalid canonical JSON") from None


def validate_descriptor(value):
    fields(value, "generation source snapshot app_revision versions migrations baseline_sha256 dump_flags scope")
    require(generation_id(value["generation"]) and identifier(value["snapshot"]), "invalid generation identity")
    identity(value["source"])
    require(type(value["app_revision"]) is str and re.fullmatch(r"[0-9a-f]{40}", value["app_revision"]),
            "invalid application revision")
    fields(value["versions"], "server pg_dump pg_restore")
    require(all(type(v) is str and re.fullmatch(r"[1-9][0-9]*\.[0-9]+", v)
                for v in value["versions"].values()), "invalid versions")
    major = {k: int(v.split(".")[0]) for k, v in value["versions"].items()}
    require(major["server"] <= major["pg_dump"] <= major["pg_restore"], "unsupported version ordering")
    require(value["dump_flags"] == FLAGS and sha(value["baseline_sha256"]), "invalid dump contract")
    migrations = value["migrations"]
    require(type(migrations) is list and migrations, "missing migration ledger")
    for item in migrations:
        fields(item, "id sha256")
        require(type(item["id"]) is str and re.fullmatch(r"[0-9]{12}", item["id"])
                and sha(item["sha256"]), "invalid migration")
    ids = [item["id"] for item in migrations]
    require(ids == sorted(set(ids)), "invalid migration ordering")
    scope = value["scope"]
    fields(scope, "assurance targets exclusions")
    require(scope["assurance"] == "partial", "full provider recovery is unsupported")
    fields(scope["targets"], " ".join(KINDS))
    for targets in scope["targets"].values():
        require(type(targets) is list and all(text(v) for v in targets)
                and targets == sorted(set(targets)), "invalid inventory")
    require(scope["targets"]["schema"] and scope["targets"]["data"], "empty database inventory")
    exclusions = scope["exclusions"]
    require(type(exclusions) is list and exclusions, "explicit provider exclusions required")
    for item in exclusions:
        fields(item, "identity reason")
        require(identifier(item["identity"]) and text(item["reason"]), "invalid exclusion")
    names = [item["identity"] for item in exclusions]
    require(names == sorted(set(names)) and "provider.external-services" in names,
            "external provider exclusion required")


def validate_payloads(descriptor, payloads):
    """Reject missing definitions and undeclared objects, including empty inventories.

    SQL definition semantics and effective ACL expansion remain adapter-owned;
    this layer checks explicit structures and exact declared target closure.
    """
    fields(payloads, " ".join(KINDS))
    for kind in KINDS:
        payload = payloads[kind]
        fields(payload, "generation snapshot entries")
        require(payload["generation"] == descriptor["generation"]
                and payload["snapshot"] == descriptor["snapshot"], "mixed snapshot evidence")
        entries = payload["entries"]
        require(type(entries) is list, "invalid evidence entries")
        names = []
        for entry in entries:
            fields(entry, "identity rows sha256" if kind == "data" else "identity definition")
            require(text(entry["identity"]), "invalid object identity")
            names.append(entry["identity"])
            if kind == "data":
                require(type(entry["rows"]) is int and 0 <= entry["rows"] <= 9007199254740991
                        and sha(entry["sha256"]), "invalid data expectation")
            elif kind in ("schema", "rpc"):
                require(text(entry["definition"]), "definition body required")
            elif kind == "acl":
                definition = entry["definition"]
                fields(definition, "object_kind owner grants")
                require(definition["object_kind"] in ("table", "column", "sequence", "function", "schema", "default")
                        and text(definition["owner"]) and type(definition["grants"]) is list, "invalid ACL")
                grants = definition["grants"]
                for grant in grants:
                    fields(grant, "grantor grantee privilege grantable")
                    require(all(text(grant[k]) for k in ("grantor", "grantee", "privilege"))
                            and type(grant["grantable"]) is bool, "invalid grant")
                encoded = [canonical(grant) for grant in grants]
                require(encoded == sorted(set(encoded)), "ACL grants must be sorted and unique")
            elif kind == "rls":
                definition = entry["definition"]
                fields(definition, "enabled forced policies")
                require(type(definition["enabled"]) is bool and type(definition["forced"]) is bool
                        and type(definition["policies"]) is list, "invalid RLS")
                policies = definition["policies"]
                for policy in policies:
                    fields(policy, "identity definition")
                    require(text(policy["identity"]) and text(policy["definition"]), "invalid policy")
                policy_ids = [policy["identity"] for policy in policies]
                require(policy_ids == sorted(set(policy_ids)), "invalid policy ordering")
            elif kind == "provider":
                fields(entry["definition"], "version owner")
                require(all(text(v) for v in entry["definition"].values()), "invalid provider dependency")
        require(names == descriptor["scope"]["targets"][kind], "declared inventory mismatch")


def pack(descriptor, dump, payloads):
    validate_descriptor(descriptor)
    validate_payloads(descriptor, payloads)
    require(type(dump) is bytes and 0 < len(dump) <= MAX_BYTES // 2, "invalid dump bytes")
    artifacts = {kind: {"sha256": digest(canonical(payloads[kind])), "payload": payloads[kind]} for kind in KINDS}
    value = {"format": "restore-bundle-v1", "descriptor": descriptor, "artifacts": artifacts,
             "dump": {"sha256": digest(dump), "size": len(dump), "base64": base64.b64encode(dump).decode("ascii")}}
    raw = canonical(value)
    require(len(raw) <= MAX_BYTES, "bundle exceeds in-memory limit")
    return raw


def pin_for(raw):
    """Producer proposal only. Reviewer must retain/approve this separately.

    Never call on an untrusted downloaded candidate to create its expected pin.
    """
    value = decode(raw)
    return {"format": "restore-bundle-pin-v1", "generation": value["descriptor"]["generation"], "sha256": digest(raw)}


def validate(raw, *, expected):
    fields(expected, "format generation sha256")
    require(expected["format"] == "restore-bundle-pin-v1" and generation_id(expected["generation"])
            and sha(expected["sha256"]), "invalid trusted pin")
    require(type(raw) is bytes and digest(raw) == expected["sha256"], "bundle pin mismatch")
    value = decode(raw)
    fields(value, "format descriptor artifacts dump")
    require(value["format"] == "restore-bundle-v1", "unsupported bundle")
    descriptor = value["descriptor"]
    validate_descriptor(descriptor)
    require(descriptor["generation"] == expected["generation"], "generation pin mismatch")
    fields(value["artifacts"], " ".join(KINDS))
    payloads = {}
    for kind, artifact in value["artifacts"].items():
        fields(artifact, "sha256 payload")
        require(sha(artifact["sha256"]) and digest(canonical(artifact["payload"])) == artifact["sha256"],
                "definition hash mismatch")
        payloads[kind] = artifact["payload"]
    validate_payloads(descriptor, payloads)
    fields(value["dump"], "sha256 size base64")
    encoded = value["dump"]
    require(type(encoded["base64"]) is str and type(encoded["size"]) is int
            and sha(encoded["sha256"]), "invalid dump descriptor")
    try:
        dump = base64.b64decode(encoded["base64"], validate=True)
    except (ValueError, UnicodeError):
        raise ValueError("invalid dump encoding") from None
    require(0 < len(dump) == encoded["size"] <= MAX_BYTES // 2 and digest(dump) == encoded["sha256"]
            and base64.b64encode(dump).decode("ascii") == encoded["base64"], "dump hash or size mismatch")
    return value


def dump_bytes(validated):
    return base64.b64decode(validated["dump"]["base64"], validate=True)
