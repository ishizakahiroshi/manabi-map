"""Synthetic registry receipts and SQL candidates; never connects to a database.

Receipts describe an in-memory simulation, not actual registry registration or
publication. The SQL is guarded for isolated synthetic PostgreSQL only. A future
production executor, credentials and publication policy are deliberately absent.
"""

import copy
from pathlib import Path

import school_id_index as index
import store_school as school


FIELDS = {"format", "format_version", "synthetic", "state", "source", "index_sha256",
          "registry_sha256", "schools", "departments", "receipt_sha256"}
TABLES = ("user_school_favorites", "user_school_notes", "user_school_deviations",
          "data_reports", "deviation_correction_logs")
SQL_ROOT = Path(__file__).parent / "sql-candidates"
require = index.require


def validate_receipt(receipt, candidate=None):
    """Check all rows, hashes and optional candidate coverage; this is not attestation."""
    index._object(receipt, FIELDS)
    require(receipt["format"] == "school-registry-receipt"
            and type(receipt["format_version"]) is int and receipt["format_version"] == 1
            and receipt["synthetic"] is True and receipt["state"] == "registered",
            "synthetic registered receipt required")
    schools = index._id_rows(receipt["schools"])
    departments = index._id_rows(receipt["departments"], departments=True)
    require(all(parent in schools for parent in departments.values()), "orphan registry department")
    # Reuse the candidate validator for the complete source envelope and ID types.
    envelope = {"format": "school-id-index-candidate", "format_version": 1,
                "state": "candidate", "synthetic": True, "source": receipt["source"],
                "previous_index_sha256": None, "schools": receipt["schools"],
                "departments": receipt["departments"],
                "counts": {"schools": len(schools), "departments": len(departments)},
                "diff": {"added": {"schools": list(schools), "departments": list(departments)},
                         "retained_absent": {"schools": [], "departments": []}}}
    envelope["index_sha256"] = school.content_hash(envelope)
    index.validate_index(envelope)
    for key in ("index_sha256", "registry_sha256", "receipt_sha256"):
        index._hash(receipt[key])
    require(receipt["registry_sha256"] == school.content_hash(
        {"schools": receipt["schools"], "departments": receipt["departments"]}),
        "registry content hash mismatch")
    require(receipt["receipt_sha256"] == school.content_hash(
        {key: value for key, value in receipt.items() if key != "receipt_sha256"}),
        "receipt content hash mismatch")
    if candidate is not None:
        index.validate_index(candidate)
        require(receipt["source"] == candidate["source"]
                and receipt["index_sha256"] == candidate["index_sha256"], "registry generation mismatch")
        require(all(row["id"] in schools for row in candidate["schools"]), "unregistered school ID")
        require(all(departments.get(row["id"]) == row["school_id"] for row in candidate["departments"]),
                "unregistered or reassigned department ID")
    return receipt


def simulate_registration(candidate, previous=None):
    """Append verified candidate IDs in memory, retaining even unreferenced history."""
    index.validate_index(candidate)
    if previous is not None:
        validate_receipt(previous)
    schools = index._id_rows(previous["schools"]) if previous else {}
    departments = index._id_rows(previous["departments"], departments=True) if previous else {}
    schools.update(index._id_rows(candidate["schools"]))
    for key, parent in index._id_rows(candidate["departments"], departments=True).items():
        require(key not in departments or departments[key] == parent, "department membership changed")
        departments[key] = parent
    receipt = {"format": "school-registry-receipt", "format_version": 1, "synthetic": True,
               "state": "registered", "source": copy.deepcopy(candidate["source"]),
               "index_sha256": candidate["index_sha256"],
               "schools": [{"id": key} for key in sorted(schools)],
               "departments": [{"id": key, "school_id": departments[key]} for key in sorted(departments)]}
    receipt["registry_sha256"] = school.content_hash(
        {"schools": receipt["schools"], "departments": receipt["departments"]})
    receipt["receipt_sha256"] = school.content_hash(receipt)
    return validate_receipt(receipt, candidate)


def render_registration_sql(candidate):
    """Render UUID-only append SQL. No actual registration receipt is manufactured."""
    index.validate_index(candidate)
    statements = ["BEGIN;", (SQL_ROOT / "synthetic_guard.sql").read_text(encoding="utf-8"),
                  "LOCK TABLE public.school_id_registry, public.department_id_registry IN SHARE ROW EXCLUSIVE MODE;"]
    for row in candidate["schools"]:
        statements.append("INSERT INTO public.school_id_registry (id) VALUES "
                          f"('{row['id']}') ON CONFLICT (id) DO NOTHING;")
    for row in candidate["departments"]:
        statements.append("DO $$ BEGIN IF EXISTS (SELECT 1 FROM public.department_id_registry "
                          f"WHERE id = '{row['id']}' AND school_id <> '{row['school_id']}') "
                          "THEN RAISE EXCEPTION 'department membership changed'; END IF; END $$;")
        statements.append("INSERT INTO public.department_id_registry (id, school_id) VALUES "
                          f"('{row['id']}', '{row['school_id']}') ON CONFLICT (id) DO NOTHING;")
    statements.append("COMMIT;")
    return "\n".join(statements) + "\n"
