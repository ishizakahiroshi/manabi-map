"""Synthetic C1-c constraints. All databases live in memory, outside the repository."""

import copy
import json
from pathlib import Path
import re
import sqlite3
import unittest

import school_admission as admission
import store_core as core
from store import InputError, connect


HERE = Path(__file__).parent
NEW_ID = "99999999-9999-4999-8999-999999999999"


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.db = connect(Path(":memory:"))
        self.addCleanup(self.db.close)
        self.core = json.loads((HERE / "example.core.synthetic.json").read_text(encoding="utf-8"))["tables"]
        self.rows = admission.synthetic_rows(self.core)
        for filename in ("schema-core.sql", "schema-admission.sql"):
            self.db.executescript((HERE / filename).read_text(encoding="utf-8"))
        for table, columns in core.TABLES.items():
            for row in self.core[table]:
                self.insert(table, row, columns)
        for table in admission.TABLES:
            for row in self.rows[table]:
                self.insert(table, row)
        self.db.commit()

    def insert(self, table, row, columns=None):
        columns = columns or admission.TABLES[table]
        normalized = {key: core.value_for_storage(row[key], kind) for key, kind in columns.items()}
        admission.validate_row(table, normalized)
        self.db.execute(f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
                        tuple(normalized.values()))

    def altered(self, table, **changes):
        row = copy.deepcopy(self.rows[table][0])
        row.update(changes)
        return row

    def test_all_fifteen_tables_preserve_all_columns_and_values(self):
        self.assertEqual(len(admission.TABLES), 15)
        for table, columns in admission.TABLES.items():
            with self.subTest(table=table):
                self.assertEqual([r["name"] for r in self.db.execute(f"PRAGMA table_info({table})")], list(columns))
                expected = {key: core.value_for_storage(self.rows[table][0][key], kind) for key, kind in columns.items()}
                self.assertEqual(dict(self.db.execute(f"SELECT * FROM {table}").fetchone()), expected)
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])
        admission.check_consistency(self.db)

    def test_column_nullability_matches_contract(self):
        for table, columns in admission.TABLES.items():
            for info in self.db.execute(f"PRAGMA table_info({table})"):
                with self.subTest(table=table, column=info["name"]):
                    self.assertEqual(bool(info["notnull"]), not columns[info["name"]].endswith("?"))

    def test_columns_nullability_and_foreign_key_actions_match_baseline(self):
        baseline = (HERE.parents[1] / "web/supabase/baseline_schema.sql").read_text(encoding="utf-8")
        for table in admission.TABLES:
            with self.subTest(table=table):
                block = re.search(r"CREATE TABLE public\." + table + r" \(\n(.*?)\n\);", baseline, re.S).group(1)
                lines = [line.strip() for line in block.splitlines() if not line.strip().startswith("CONSTRAINT")]
                expected_columns = [(line.split()[0], "NOT NULL" in line) for line in lines]
                actual_columns = [(row["name"], bool(row["notnull"]))
                                  for row in self.db.execute(f"PRAGMA table_info({table})")]
                self.assertEqual(actual_columns, expected_columns)
                expected_fks = set()
                for constraint in re.finditer(r"ALTER TABLE ONLY public\." + table + r"\n(.*?);", baseline, re.S):
                    fk = re.search(r"FOREIGN KEY \((\w+)\) REFERENCES public\.(\w+)\((\w+)\)(.*)", constraint.group(1))
                    if fk is None:
                        continue
                    actions = {}
                    for event in ("UPDATE", "DELETE"):
                        action = re.search(r"ON " + event + r" (CASCADE|RESTRICT|SET NULL|NO ACTION|SET DEFAULT)", fk.group(4))
                        actions[event] = action.group(1) if action else "NO ACTION"
                    expected_fks.add((fk.group(1), fk.group(2), fk.group(3), actions["UPDATE"], actions["DELETE"]))
                actual_fks = {(row["from"], row["table"], row["to"], row["on_update"], row["on_delete"])
                              for row in self.db.execute(f"PRAGMA foreign_key_list({table})")}
                self.assertEqual(actual_fks, expected_fks)

    def test_master_rename_cascades_and_referenced_delete_restricts(self):
        self.db.execute("UPDATE admission_map_role_master SET code = 'synthetic_role'")
        self.assertEqual(self.db.execute("SELECT map_role_code FROM school_admission_selection_stats").fetchone()[0],
                         "synthetic_role")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM admission_map_role_master")

    def test_admission_cascades_delete_children_and_preserve_legacy(self):
        self.db.execute("DELETE FROM admission_recruitment_units")
        for table in ("admission_recruitment_unit_departments", "school_admission_selection_stats",
                      "school_admission_stat_exam_components", "school_admission_stat_quality_flags",
                      "school_admission_stat_sources", "school_admission_stat_legacy_links"):
            with self.subTest(table=table):
                self.assertEqual(self.db.execute(f"SELECT count(*) FROM {table}").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM school_admission_stats").fetchone()[0], 1)

    def test_legacy_null_department_uniqueness(self):
        table = "school_admission_stats"
        self.insert(table, self.altered(table, id=NEW_ID, department_id=None))
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(table, self.altered(table, id="88888888-8888-4888-8888-888888888888", department_id=None))

    def test_legacy_nonnull_department_uniqueness(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert("school_admission_stats", self.altered("school_admission_stats", id=NEW_ID))

    def test_quality_null_and_metric_uniqueness(self):
        table = "school_admission_stat_quality_flags"
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(table, self.rows[table][0])
        self.insert(table, self.altered(table, metric_code="capacity"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(table, self.altered(table, metric_code="capacity"))

    def test_active_deviation_uniqueness_preserves_inactive_history(self):
        table = "school_deviation_values"
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(table, self.altered(table, id=NEW_ID))
        self.insert(table, self.altered(table, id=NEW_ID, is_active=False))
        self.assertEqual(self.db.execute(f"SELECT count(*) FROM {table}").fetchone()[0], 2)

    def test_null_department_active_deviations_remain_distinct(self):
        table = "school_deviation_values"
        for ident in (NEW_ID, "88888888-8888-4888-8888-888888888888"):
            self.insert(table, self.altered(table, id=ident, department_id=None))

    def test_legacy_estimate_basis_cannot_be_active(self):
        table = "school_deviation_values"
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(table, self.altered(table, id=NEW_ID, department_id=None, estimate_basis="application_ratio_legacy"))
        self.insert(table, self.altered(table, id=NEW_ID, is_active=False, estimate_basis="application_ratio_legacy"))

    def test_deviation_has_no_invented_range_restriction(self):
        table = "school_deviation_values"
        self.insert(table, self.altered(table, id=NEW_ID, department_id=None, value=-1, year=1900))

    def test_ratio_requires_positive_capacity_and_known_applicants(self):
        for changes in ({"capacity": 0}, {"capacity": None}, {"applicants": None}):
            with self.subTest(changes=changes), self.assertRaises(sqlite3.IntegrityError):
                self.db.execute("UPDATE school_admission_selection_stats SET " +
                                ", ".join(f"{key} = ?" for key in changes), tuple(changes.values()))
        self.db.execute("UPDATE school_admission_selection_stats SET applicants = 0")

    def test_primary_total_requires_primary_comparable(self):
        table = "admission_selection_stage_master"
        self.insert(table, self.altered(table, code="secondary"))
        for assignment in ("selection_stage_code = 'secondary'", "is_ratio_comparable = 0"):
            with self.subTest(assignment=assignment), self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(f"UPDATE school_admission_selection_stats SET {assignment}")

    def test_year_and_counts_boundaries(self):
        for table in ("school_admission_stats", "school_admission_selection_stats"):
            for field, value in (("year", 1999), ("year", 2101), ("capacity", -1), ("applicants", -1),
                                 ("examinees", -1), ("admitted", -1)):
                with self.subTest(table=table, field=field), self.assertRaises(sqlite3.IntegrityError):
                    self.db.execute(f"UPDATE {table} SET {field} = ?", (value,))
            for year in (2000, 2100):
                self.db.execute(f"UPDATE {table} SET year = ?", (year,))

    def test_unit_year_order_course_and_school_scoped_key(self):
        table = "admission_recruitment_units"
        for changes in ({"valid_from_year": 1999}, {"valid_to_year": 2101},
                        {"valid_from_year": 2027, "valid_to_year": 2026}, {"course_time": "unknown"}):
            with self.subTest(changes=changes), self.assertRaises(sqlite3.IntegrityError):
                self.insert(table, self.altered(table, id=NEW_ID, unit_key="another", **changes))
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(table, self.altered(table, id=NEW_ID))
        self.insert(table, self.altered(table, id=NEW_ID, school_id=self.core["schools"][1]["id"]))

    def test_new_stats_scope_uniqueness(self):
        table = "school_admission_selection_stats"
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(table, self.altered(table, id=NEW_ID))
        self.insert(table, self.altered(table, id=NEW_ID, scope_key="different-scope"))

    def test_membership_mismatch_after_unit_parent_update(self):
        self.db.execute("UPDATE admission_recruitment_units SET school_id = ?", (self.core["schools"][1]["id"],))
        with self.assertRaises(InputError):
            admission.check_consistency(self.db)

    def test_membership_mismatch_after_department_parent_update(self):
        self.db.execute("UPDATE school_departments SET school_id = ?", (self.core["schools"][1]["id"],))
        with self.assertRaises(InputError):
            admission.check_consistency(self.db)

    def test_unknown_master_rejected_inactive_master_retained(self):
        self.assertEqual(self.db.execute("SELECT is_active FROM admission_map_role_master").fetchone()[0], 0)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE school_admission_selection_stats SET map_role_code = 'missing'")

    def test_source_pairs_http_status_and_evidence(self):
        table = "school_admission_stat_sources"
        for field, value in (("last_http_status", None), ("last_http_status", 99), ("last_http_status", 600),
                             ("last_verified_at", None), ("quoted_evidence", " "), ("quoted_evidence", "x" * 81)):
            with self.subTest(field=field, value=value), self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(f"UPDATE {table} SET {field} = ?", (value,))
        self.db.execute(f"UPDATE {table} SET quoted_evidence = ?", ("合" * 80,))
        self.assertEqual(self.db.execute(f"SELECT last_http_status FROM {table}").fetchone()[0], 404)
        self.db.execute(f"UPDATE {table} SET last_http_status = NULL, last_verified_at = NULL")

    def test_input_rejects_bad_url_date_timestamp_and_boolean(self):
        for value, kind in (("https://bad.example/ path", "url"), ("2026-02-30", "date"),
                            ("2026-01-01T00:00:00", "timestamp"), (1, "bool"), (True, "int")):
            with self.subTest(kind=kind), self.assertRaises((InputError, ValueError)):
                core.value_for_storage(value, kind)

    def test_projection_omits_private_and_legacy_link_fields(self):
        self.assertNotIn("school_admission_stat_legacy_links", admission.PROJECTION)
        self.assertFalse(any(name.endswith("_master") for name in admission.PROJECTION))
        for columns in admission.PROJECTION.values():
            self.assertNotIn("created_at", columns)
            self.assertNotIn("updated_at", columns)
        self.assertIn("note", admission.PROJECTION["school_admission_stats"])
        self.assertIn("quoted_evidence", admission.PROJECTION["school_admission_stat_sources"])
        self.assertNotIn("note", admission.PROJECTION["school_deviation_values"])

    def test_child_foreign_keys_and_legacy_links(self):
        for table, field in (("school_admission_stat_sources", "stat_id"),
                             ("school_admission_stat_exam_components", "component_code"),
                             ("school_admission_stat_quality_flags", "reason_code"),
                             ("school_admission_stat_legacy_links", "legacy_stat_id")):
            with self.subTest(table=table), self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(f"UPDATE {table} SET {field} = ?", (NEW_ID,))


if __name__ == "__main__":
    unittest.main()
