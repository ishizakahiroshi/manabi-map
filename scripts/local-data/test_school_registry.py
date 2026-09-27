"""Synthetic receipts are validated artifacts, never proof of actual registration."""

from contextlib import closing, redirect_stdout
import copy
import io
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from school_fixture import synthetic_payload
import school_id_index as index
import school_registry as registry
import store
import store_school as school


def resign(candidate):
    candidate["index_sha256"] = school.content_hash(
        {key: value for key, value in candidate.items() if key != "index_sha256"})
    return candidate


class RegistryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory(prefix="synthetic-registry-unit-") as directory:
            root = Path(directory)
            payload = synthetic_payload()
            payload["tables"] = school.normalize_tables(payload["tables"])
            with closing(store.connect(root / "source.sqlite")) as db:
                school.import_rows(db, payload, fresh=True)
            with redirect_stdout(io.StringIO()):
                school.export_command(SimpleNamespace(db=root / "source.sqlite", output=root / "bundle"))
            cls.candidate = index.build_index(root / "bundle")

    def test_receipt_is_explicitly_synthetic_registered_not_published(self):
        result = registry.simulate_registration(self.candidate)
        self.assertEqual(result["state"], "registered")
        self.assertIs(result["synthetic"], True)
        self.assertEqual(registry.validate_receipt(result, self.candidate), result)

    def test_previous_registry_keeps_all_absent_ids(self):
        previous = registry.simulate_registration(self.candidate)
        empty = copy.deepcopy(self.candidate)
        empty.update(schools=[], departments=[], counts={"schools": 0, "departments": 0},
                     diff={"added": {"schools": [], "departments": []},
                           "retained_absent": {"schools": [], "departments": []}})
        resign(empty)
        result = registry.simulate_registration(empty, previous)
        self.assertEqual(result["schools"], previous["schools"])
        self.assertEqual(result["departments"], previous["departments"])
        self.assertEqual(result["registry_sha256"], previous["registry_sha256"])

    def test_membership_change_rejected_even_when_candidate_is_rehashed(self):
        previous = registry.simulate_registration(self.candidate)
        changed = copy.deepcopy(self.candidate)
        department = changed["departments"][0]
        department["school_id"] = next(row["id"] for row in changed["schools"] if row["id"] != department["school_id"])
        resign(changed)
        with self.assertRaisesRegex(ValueError, "membership"):
            registry.simulate_registration(changed, previous)

    def test_wrong_generation_rejected(self):
        receipt = registry.simulate_registration(self.candidate)
        changed = copy.deepcopy(self.candidate)
        changed["source"]["dataset_version"] += "-later"
        resign(changed)
        with self.assertRaisesRegex(ValueError, "generation"):
            registry.validate_receipt(receipt, changed)

    def test_unregistered_id_rejected_even_if_receipt_rehashed(self):
        receipt = registry.simulate_registration(self.candidate)
        receipt["departments"].pop()
        receipt["registry_sha256"] = school.content_hash(
            {"schools": receipt["schools"], "departments": receipt["departments"]})
        receipt["receipt_sha256"] = school.content_hash(
            {key: value for key, value in receipt.items() if key != "receipt_sha256"})
        with self.assertRaisesRegex(ValueError, "unregistered"):
            registry.validate_receipt(receipt, self.candidate)

    def test_mutation_false_synthetic_extra_fields_rejected(self):
        for field, value in (("synthetic", False), ("format_version", True),
                             ("state", "published_confirmed"), ("private_note", "synthetic"),
                             ("registry_sha256", "0" * 64)):
            with self.subTest(field=field):
                receipt = registry.simulate_registration(self.candidate)
                receipt[field] = value
                with self.assertRaises(ValueError):
                    registry.validate_receipt(receipt)

    def test_returned_receipt_does_not_alias_source(self):
        candidate = copy.deepcopy(self.candidate)
        result = registry.simulate_registration(candidate)
        result["source"]["dataset_version"] = "different"
        self.assertEqual(candidate, self.candidate)

    def test_retry_is_identical(self):
        first = registry.simulate_registration(self.candidate)
        self.assertEqual(registry.simulate_registration(self.candidate, first), first)

    def test_sql_render_validates_candidate_and_is_guarded_uuid_only(self):
        sql = registry.render_registration_sql(self.candidate)
        self.assertIn("isolated synthetic registry database required", sql)
        self.assertIn("department membership changed", sql)
        self.assertNotIn(self.candidate["source"]["dataset_version"], sql)
        malformed = copy.deepcopy(self.candidate)
        malformed["schools"][0]["id"] = "'; DROP TABLE x; --"
        resign(malformed)
        with self.assertRaises(ValueError):
            registry.render_registration_sql(malformed)


if __name__ == "__main__":
    unittest.main()
