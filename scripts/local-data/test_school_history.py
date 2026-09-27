"""Synthetic C1-b checks, isolated in memory with no production input."""

from pathlib import Path
import sqlite3
import unittest

import school_history as history
from store import InputError, connect
import store_core as core


HERE = Path(__file__).parent


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.db = connect(Path(":memory:"))
        self.addCleanup(self.db.close)
        self.core = core.load_input(HERE / "example.core.synthetic.json")
        core.import_rows(self.db, self.core, fresh=True)
        self.db.executescript((HERE / "schema-history.sql").read_text(encoding="utf-8"))
        self.rows = history.synthetic_rows(self.core["tables"])
        self.insert_all(self.rows)
        self.db.commit()

    def insert(self, table, raw):
        row = {column: core.value_for_storage(raw[column], kind)
               for column, kind in history.TABLES[table].items()}
        history.validate_row(table, row)
        self.db.execute(f"INSERT INTO {table} ({', '.join(row)}) VALUES ({', '.join('?' for _ in row)})",
                        tuple(row.values()))

    def insert_all(self, tables):
        for table, rows in tables.items():
            for row in rows:
                self.insert(table, row)

    def changed(self, table, **changes):
        return dict(self.rows[table][0], id="99999999-9999-4999-8999-999999999999", **changes)

    def test_all_columns_nullability_and_defaults_match_metadata(self):
        for table, columns in history.TABLES.items():
            actual = self.db.execute(f"PRAGMA table_info({table})").fetchall()
            self.assertEqual([r["name"] for r in actual], list(columns))
            self.assertEqual([bool(r["notnull"]) for r in actual],
                             [not kind.endswith("?") for kind in columns.values()])
            self.assertTrue(all(r["dflt_value"] is None for r in actual))

    def test_inactive_predecessor_and_ids_preserved(self):
        row = self.db.execute("""SELECT r.id, s.is_active, s.record_key FROM school_relationships r
            JOIN schools s ON s.id = r.predecessor_school_id""").fetchone()
        self.assertEqual(row["id"], self.rows["school_relationships"][0]["id"])
        self.assertEqual(row["is_active"], 0)
        self.assertEqual(row["record_key"], self.core["tables"]["schools"][1]["record_key"])
        history.check_consistency(self.db)

    def test_same_name_distinct_school_id_is_not_deduplicated(self):
        schools = self.core["tables"]["schools"]
        self.db.execute("UPDATE schools SET name = ? WHERE id = ?", (schools[0]["name"], schools[1]["id"]))
        self.insert("school_name_history", self.changed("school_name_history", school_id=schools[1]["id"]))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM schools WHERE name = ?", (schools[0]["name"],)).fetchone()[0], 2)

    def test_rename_boundaries_preserve_null_and_empty(self):
        rows = self.db.execute("SELECT * FROM school_name_history ORDER BY id").fetchall()
        self.assertIsNone(rows[0]["valid_from"])
        self.assertEqual(rows[0]["valid_to"], "2025-03-31")
        self.assertEqual(rows[1]["valid_from"], "2025-04-01")
        self.assertIsNone(rows[1]["valid_to"])
        self.assertIsNone(rows[0]["name_kana"])
        self.assertEqual(rows[1]["name_kana"], "")

    def test_equal_dates_are_allowed_but_reversed_dates_are_not(self):
        self.insert("school_name_history", self.changed("school_name_history", valid_from="2024-02-29", valid_to="2024-02-29"))
        with self.assertRaisesRegex(InputError, "date order"):
            self.insert("school_name_history", self.changed("school_name_history", valid_from="2025-04-01", valid_to="2025-03-31"))

    def test_invalid_calendar_date_rejected(self):
        with self.assertRaises(ValueError):
            self.insert("school_name_history", self.changed("school_name_history", valid_from="2025-02-29"))

    def test_name_history_null_safe_uniqueness(self):
        for boundary in (None, "0001-01-01"):
            with self.subTest(boundary=boundary), self.assertRaises(sqlite3.IntegrityError):
                self.insert("school_name_history", self.changed("school_name_history", valid_from=boundary))

    def test_relationship_null_safe_uniqueness(self):
        for boundary in (None, "0001-01-01"):
            with self.subTest(boundary=boundary), self.assertRaises(sqlite3.IntegrityError):
                self.insert("school_relationships", self.changed("school_relationships", effective_on=boundary))

    def test_relationship_date_only_boundary_and_year_limits(self):
        self.insert("school_relationships", self.changed("school_relationships", effective_on="2025-04-01", effective_admission_year=None))
        for year in (1899, 2101):
            with self.subTest(year=year), self.assertRaises(InputError):
                self.insert("school_relationships", self.changed("school_relationships", effective_admission_year=year))

    def test_missing_relationship_boundary_rejected(self):
        with self.assertRaisesRegex(InputError, "boundary"):
            self.insert("school_relationships", self.changed("school_relationships", effective_admission_year=None))

    def test_relationship_self_link_rejected(self):
        with self.assertRaisesRegex(InputError, "self-link"):
            self.insert("school_relationships", self.changed("school_relationships", predecessor_school_id=self.core["tables"]["schools"][0]["id"]))

    def test_unknown_evidence_and_master_rejected(self):
        with self.assertRaisesRegex(InputError, "evidence"):
            self.insert("school_relationships", self.changed("school_relationships", evidence_status="invented"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert("school_relationships", self.changed("school_relationships", relationship_type_code="missing"))

    def test_orphan_and_referenced_school_delete_rejected(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert("school_name_history", self.changed("school_name_history", school_id="88888888-8888-4888-8888-888888888888"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("DELETE FROM schools WHERE id = ?", (self.core["tables"]["schools"][1]["id"],))

    def test_explicit_projection_excludes_private_columns(self):
        for table, columns in history.PROJECTION.items():
            self.assertNotIn("created_at", columns)
            self.assertNotIn("updated_at", columns)
            self.assertTrue(set(columns) <= set(history.TABLES[table]))
        self.assertNotIn("effective_admission_year", history.PROJECTION["school_relationships"])
        self.assertNotIn("evidence_status", history.PROJECTION["school_relationships"])

    def test_late_failure_rolls_back_history_core_and_version(self):
        before = list(self.db.iterdump())
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self.db.execute("UPDATE source_metadata SET dataset_version = 'failed-candidate'")
            self.db.execute("UPDATE schools SET name = '合成失敗候補'")
            self.db.execute("UPDATE school_name_history SET notes = '合成失敗候補'")
            self.insert("school_relationships", self.changed("school_relationships"))
        except sqlite3.IntegrityError:
            self.db.rollback()
        else:
            self.fail("duplicate must fail")
        self.assertEqual(before, list(self.db.iterdump()))


if __name__ == "__main__":
    unittest.main()
