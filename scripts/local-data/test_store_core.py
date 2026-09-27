"""C1-a synthetic tests; every writable DB/input/output is in OS temp outside Git."""

from contextlib import closing
import copy
from decimal import Decimal
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import store
import store_core as core


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="school-core-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.assertFalse(self.root.is_relative_to(REPO))
        self.db = self.root / "core.sqlite"
        self.input = self.root / "input.json"
        self.payload = json.loads((HERE / "example.core.synthetic.json").read_text(encoding="utf-8"))

    def ingest(self, payload=None, apply=True, ok=True):
        self.input.write_text(json.dumps(self.payload if payload is None else payload, ensure_ascii=False), encoding="utf-8")
        return self.cli(apply=apply, ok=ok)

    def cli(self, apply=True, ok=True):
        result = subprocess.run([sys.executable, "-B", str(HERE / "store_core.py"),
                                 "--input", str(self.input), "--db", str(self.db),
                                 *(["--apply"] if apply else [])],
                                cwd=self.root, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0 if ok else 1, result.stderr)
        if not ok:
            self.assertEqual(result.stdout, "")
            self.assertNotIn("Traceback", result.stderr)
            self.assertNotIn(str(self.root), result.stderr)
        return result

    def state(self):
        with closing(store.connect(self.db, readonly=True)) as db:
            return {table: [dict(r) for r in db.execute(f"SELECT * FROM {table} ORDER BY 1,2")]
                    for table in (*core.TABLES, "source_metadata")}

    def rows(self):
        with closing(store.connect(self.db, readonly=True)) as db:
            db.execute("BEGIN")
            return core.project_core_rows(db)

    def rejected(self, payload):
        before = self.db.read_bytes() if self.db.exists() else None
        self.ingest(payload, ok=False)
        if before is None:
            self.assertFalse(self.db.exists())
        else:
            self.assertEqual(before, self.db.read_bytes())
        self.assertFalse(list(self.root.glob("*-journal")))

    def public(self, rows):
        # Test the real existing gate, without importing the side-effectful generator.
        script = """
            import {readFileSync} from 'node:fs';
            const {buildPublicSchoolRecords} = await import(process.argv[1]);
            const rows = JSON.parse(readFileSync(0, 'utf8'));
            process.stdout.write(JSON.stringify(buildPublicSchoolRecords(rows, [], 'synthetic-test')));
        """
        result = subprocess.run(["node", "--input-type=module", "-e", script,
                                 (REPO / "web/scripts/lib/public-api.mjs").as_uri()],
                                input=json.dumps(rows), text=True, encoding="utf-8", capture_output=True,
                                cwd=self.root, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_all_columns_round_trip_and_reimport(self):
        self.ingest()
        before = self.state()
        self.ingest()
        self.assertEqual(before, self.state())
        normalized = core.load_input(self.input)["tables"]
        for table in core.TABLES:
            with self.subTest(table=table):
                self.assertCountEqual(before[table], normalized[table])
        self.assertEqual(len(before["schools"]), 2)  # inactive school retained
        self.assertEqual(before["schools"][0]["latitude"], "35.1234567")
        self.assertEqual(before["school_field_sources"][0]["last_http_status"], 404)

    def test_schema_columns_nullability_and_sql_constraints(self):
        # Independent source DDL guards against silently losing a source column.
        baseline = (REPO / "web/supabase/baseline_schema.sql").read_text(encoding="utf-8")
        self.ingest()
        with closing(store.connect(self.db)) as db:
            self.assertEqual(db.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            for table in core.TABLES:
                body = re.search(r"CREATE TABLE public\." + table + r" \((.*?)\n\);", baseline, re.S)[1]
                expected = {}
                for line in body.splitlines():
                    match = re.match(r"    ([a-z][a-z0-9_]*) (.+)", line)
                    if match:
                        expected[match[1]] = int("NOT NULL" in match[2])
                actual = {r["name"]: r["notnull"] for r in db.execute(f"PRAGMA table_info({table})")}
                self.assertEqual(actual, expected, table)
            for sql in ("UPDATE schools SET is_active=2", "UPDATE schools SET male_ratio=101",
                        "UPDATE school_departments SET school_id='missing'",
                        "UPDATE school_field_sources SET last_verified_at=NULL",
                        "UPDATE school_field_source_field_master SET code='mismatch'"):
                with self.subTest(sql=sql), self.assertRaises(sqlite3.IntegrityError):
                    db.execute(sql)
            core.check_consistency(db)

    def test_dry_run_new_existing_and_failed_does_not_write(self):
        self.ingest(apply=False)
        self.assertFalse(self.db.exists())
        self.ingest()
        before = self.db.read_bytes()
        files = set(self.root.iterdir())
        self.payload["tables"]["schools"][0]["name"] = "合成更新"
        self.ingest(apply=False)
        self.assertEqual(before, self.db.read_bytes())
        self.payload["tables"]["schools"][0]["is_active"] = False
        self.ingest(apply=False, ok=False)
        self.assertEqual(before, self.db.read_bytes())
        self.assertEqual(files, set(self.root.iterdir()))

    def test_upsert_omissions_and_timestamps_preserved(self):
        self.ingest()
        before = self.state()
        self.payload["dataset_version"] = "synthetic-core-002"
        self.payload["tables"]["schools"][0]["name"] = "合成更新"
        self.payload["tables"]["schools"] = self.payload["tables"]["schools"][:1]
        for table in core.TABLES:
            if table != "schools":
                self.payload["tables"][table] = []
        self.ingest()
        after = self.state()
        self.assertEqual(len(after["schools"]), 2)
        self.assertEqual(after["schools"][0]["name"], "合成更新")
        self.assertEqual(after["schools"][0]["created_at"], before["schools"][0]["created_at"])
        self.assertEqual(after["schools"][0]["updated_at"], before["schools"][0]["updated_at"])
        self.assertEqual(after["source_metadata"][0]["dataset_version"], "synthetic-core-002")
        self.assertEqual(after["school_field_sources"], before["school_field_sources"])

    def test_unknown_missing_columns_tables_and_versions_rejected(self):
        for table in core.TABLES:
            for change in ("unknown", "missing"):
                p = copy.deepcopy(self.payload)
                row = p["tables"][table][0]
                if change == "unknown":
                    row["synthetic_secret"] = "must-not-echo"
                else:
                    del row[next(iter(row))]
                with self.subTest(table=table, change=change):
                    self.rejected(p)
        for key, value in (("input_version", True), ("input_version", 2), ("schema_version", 1),
                           ("format", "other"), ("synthetic", False), ("dataset_version", "")):
            p = copy.deepcopy(self.payload)
            p[key] = value
            self.rejected(p)
        p = copy.deepcopy(self.payload)
        p["tables"]["user_school_notes"] = []
        self.rejected(p)
        del p["tables"]["user_school_notes"]
        del p["tables"]["course_type_master"]
        self.rejected(p)

    def test_duplicate_keys_and_identities_rejected(self):
        for table in core.TABLES:
            p = copy.deepcopy(self.payload)
            p["tables"][table].append(copy.deepcopy(p["tables"][table][0]))
            with self.subTest(table=table):
                self.rejected(p)
        for field in ("id", "record_key"):
            p = copy.deepcopy(self.payload)
            p["tables"]["schools"][1][field] = p["tables"]["schools"][0][field]
            self.rejected(p)
        self.input.write_text('{"synthetic":true,"synthetic":true}', encoding="utf-8")
        self.cli(ok=False)
        self.assertFalse(self.db.exists())

    def test_type_enum_date_and_range_errors(self):
        cases = {
            "is_active": [1, "true", None], "total_students": [True, -1, 2**31, 1.0],
            "enrollment_year": [1999, 2101], "male_ratio": [-1, 101],
            "recruitment_ended_year": [1899, 2101], "type": ["unknown"],
            "ownership": ["unknown"], "gender_type": ["unknown"], "campus_type": ["unknown"],
            "course_times": [[], None, [None], ["unknown"], "fulltime"],
            "opened_on": ["2025-02-29", "20260101", "2026-01-01T00:00:00Z", "1899-01-01"],
            "closed_on": ["1800-01-01"], "official_url": ["ftp://school.example", "https://school.example:bad"],
            "updated_at": ["2026-01-01T00:00:00", "2026-02-30T00:00:00Z", "2026-01-01T00:00:00+01:60"],
            "name": [None, 1, "nul\u0000text"], "id": ["bad-uuid"],
            "record_key": [None, 1, "nul\u0000key"],
        }
        for field, values in cases.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    p = copy.deepcopy(self.payload)
                    p["tables"]["schools"][0][field] = value
                    self.rejected(p)

    def test_nullable_empty_and_boundary_values(self):
        p = copy.deepcopy(self.payload)
        s = p["tables"]["schools"][0]
        s.update(enrollment_year=2000, recruitment_ended_year=1900, total_students=2**31-1,
                 male_ratio=100, name="", status_note=None, status_official_url="",
                 latitude="-999.9999999", longitude="999.9999999", closed_on="2100-12-31")
        p["tables"]["school_departments"][0].update(course_type=None, ui_group=None, name="")
        self.ingest(p)
        after = self.state()
        self.assertEqual(after["schools"][0]["name"], "")
        self.assertIsNone(after["school_departments"][0]["course_type"])
        self.assertEqual(after["schools"][0]["total_students"], 2**31-1)
        p["tables"]["schools"][0].update(enrollment_year=2100, recruitment_ended_year=2100)
        self.ingest(p)

    def test_record_keys_follow_text_contract_without_prefix_or_uuid_coercion(self):
        for index, key in enumerate(("invented-school-key-A", "department-invented-school-key", "", " 合成学校 / キー ")):
            with self.subTest(key=key):
                db = self.db
                self.db = self.root / f"key-{index}.sqlite"
                try:
                    payload = copy.deepcopy(self.payload)
                    payload["tables"]["schools"][0]["record_key"] = key
                    department_key = "合成学科-任意キー" if not key else key
                    payload["tables"]["school_departments"][0]["record_key"] = department_key
                    self.ingest(payload)
                    after = self.state()
                    self.assertEqual(after["schools"][0]["record_key"], key)
                    self.assertEqual(after["school_departments"][0]["record_key"], department_key)
                    changed = copy.deepcopy(payload)
                    changed["tables"]["schools"][0]["record_key"] = "invented-replacement"
                    self.rejected(changed)
                finally:
                    self.db = db

    def test_decimal_json_number_exactness_and_js_roundtrip(self):
        self.input.write_text(json.dumps(self.payload).replace('"35.1234567"', '35.1234567'), encoding="utf-8")
        self.cli()
        self.assertEqual(self.state()["schools"][0]["latitude"], "35.1234567")
        for value in ("0.0000001", "-0.0000001", "999.9999999", "-999.9999999"):
            p = copy.deepcopy(self.payload)
            p["tables"]["schools"][0]["latitude"] = value
            self.ingest(p)
            rows = self.rows()
            self.assertEqual(Decimal(str(self.public(rows)[0]["latitude"])), Decimal(value))
        for value in ("35.12345678", "1000", "-1000", "NaN", "Infinity", True, ""):
            p = copy.deepcopy(self.payload)
            p["tables"]["schools"][0]["latitude"] = value
            self.rejected(p)
        self.input.write_text(json.dumps(self.payload).replace('"35.1234567"', 'NaN'), encoding="utf-8")
        self.cli(ok=False)

    def test_state_group_and_foreign_key_mismatch(self):
        cases = [("schools", "is_active", False), ("schools", "is_recruiting", False),
                 ("schools", "lifecycle_status_code", "missing"),
                 ("schools", "recruitment_status_code", "missing"),
                 ("school_departments", "ui_group", "other"),
                 ("school_departments", "course_type", "missing"),
                 ("school_departments", "course_type", None),
                 ("school_departments", "school_id", "99999999-9999-4999-8999-999999999999"),
                 ("school_field_sources", "field_name", "schools.unknown")]
        for table, column, value in cases:
            with self.subTest(table=table, column=column):
                p = copy.deepcopy(self.payload)
                p["tables"][table][0][column] = value
                self.rejected(p)
        p = copy.deepcopy(self.payload)
        p["tables"]["schools"][1].update(is_recruiting=True, recruitment_status_code="recruiting")
        self.rejected(p)
        p = copy.deepcopy(self.payload)
        p["tables"]["school_lifecycle_status_master"][0]["code"] = "closing"
        p["tables"]["schools"][0]["lifecycle_status_code"] = "closing"
        self.rejected(p)

    def test_master_update_checks_omitted_children_and_can_be_coordinated(self):
        self.ingest()
        for table, field, value in (("course_type_master", "ui_group", "other"),
                                     ("school_lifecycle_status_master", "is_map_active", False),
                                     ("school_recruitment_status_master", "is_recruiting_compat", False)):
            p = copy.deepcopy(self.payload)
            p["tables"][table][0][field] = value
            p["tables"]["schools"] = []
            p["tables"]["school_departments"] = []
            self.rejected(p)
        self.payload["tables"]["course_type_master"][0]["ui_group"] = "other"
        self.payload["tables"]["school_departments"][0]["ui_group"] = "other"
        self.ingest()
        self.assertEqual(self.state()["school_departments"][0]["ui_group"], "other")

    def test_source_and_master_constraints(self):
        for field, values in {"doc_title": ["", "  "], "note": [""], "source_page_or_table": [" "],
                              "last_http_status": [99, 600, True, None],
                              "last_verified_at": [None], "published_at": ["2025-02-29"],
                              "official_url": ["", "https://school.example:65536"],
                              "is_official_source": [0]}.items():
            for value in values:
                p = copy.deepcopy(self.payload)
                p["tables"]["school_field_sources"][0][field] = value
                self.rejected(p)
        for status in (100, 599, None):
            p = copy.deepcopy(self.payload)
            p["tables"]["school_field_sources"][0]["last_http_status"] = status
            if status is None:
                p["tables"]["school_field_sources"][0]["last_verified_at"] = None
            self.ingest(p)
        for table, field, value in (("course_type_master", "mext_category", "unknown"),
                                     ("course_type_master", "ui_group", "unknown"),
                                     ("school_field_source_field_master", "code", "schools.mismatch"),
                                     ("school_field_source_field_master", "table_name", "Bad-name"),
                                     ("school_field_source_field_master", "label_ja", " "),
                                     ("school_lifecycle_status_master", "code", " ")):
            p = copy.deepcopy(self.payload)
            p["tables"][table][0][field] = value
            self.rejected(p)

    def test_late_failure_restores_all_tables_and_version(self):
        self.ingest()
        before = self.state()
        p = copy.deepcopy(self.payload)
        p["dataset_version"] = "must-rollback"
        for table in core.TABLES:
            row = p["tables"][table][0]
            field = "label_ja" if "label_ja" in row else "name" if "name" in row else "doc_title"
            row[field] = "合成変更後"
        p["tables"]["school_field_sources"][0]["field_name"] = "schools.missing"
        self.rejected(p)
        self.assertEqual(before, self.state())
        self.db = self.root / "new-failure.sqlite"
        self.rejected(p)

    def test_existing_identity_changes_roll_back(self):
        self.ingest()
        for table, field, value in (("schools", "record_key", "school-dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
                                     ("school_departments", "record_key", "department-dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
                                     ("school_departments", "school_id", self.payload["tables"]["schools"][1]["id"])):
            p = copy.deepcopy(self.payload)
            p["tables"]["schools"][0]["name"] = "合成途中更新"
            p["tables"][table][0][field] = value
            self.rejected(p)

    def test_wrong_database_and_legacy_are_never_upgraded(self):
        with closing(sqlite3.connect(self.db)):
            pass
        self.rejected(self.payload)
        legacy_input = HERE / "example.synthetic.json"
        self.db = self.root / "legacy.sqlite"
        with patch("builtins.print"):
            store.import_command(SimpleNamespace(input=legacy_input, db=self.db, apply=True))
        self.rejected(self.payload)
        self.db = self.root / "new.sqlite"
        self.ingest()
        for column, value in (("purpose", "other"), ("schema_version", 99)):
            with closing(sqlite3.connect(self.db)) as db:
                db.execute(f"UPDATE source_metadata SET {column} = ?", (value,))
                db.commit()
            self.rejected(self.payload)

    def test_commit_failure_and_interrupt_roll_back(self):
        self.ingest()
        before = self.state()
        self.payload["dataset_version"] = "must-rollback"
        self.payload["tables"]["schools"][0]["name"] = "合成途中更新"
        self.input.write_text(json.dumps(self.payload), encoding="utf-8")
        payload = core.load_input(self.input)

        class FailedCommit(sqlite3.Connection):
            def commit(self):
                raise sqlite3.OperationalError("synthetic commit failure")

        with closing(sqlite3.connect(self.db, isolation_level=None, factory=FailedCommit)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys = ON")
            with self.assertRaises(sqlite3.OperationalError):
                core.import_rows(db, payload, fresh=False)
        self.assertEqual(before, self.state())
        with closing(store.connect(self.db)) as db, patch.object(core, "check_consistency", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                core.import_rows(db, payload, fresh=False)
        self.assertEqual(before, self.state())

    def test_writer_lock_and_postcommit_reporting(self):
        self.ingest()
        before = self.state()
        with closing(store.connect(self.db)) as lock:
            lock.execute("BEGIN IMMEDIATE")
            # Do not use rejected(): its raw read_bytes open/close releases
            # this process's POSIX advisory lock on the same SQLite file.
            # Compare state only after the lock has been rolled back below.
            self.ingest(self.payload, ok=False)
            lock.rollback()
        self.assertEqual(before, self.state())
        self.payload["dataset_version"] = "committed-before-report"
        self.input.write_text(json.dumps(self.payload), encoding="utf-8")
        with patch("builtins.print", side_effect=BrokenPipeError):
            with self.assertRaises(BrokenPipeError):
                core.import_command(SimpleNamespace(input=self.input, db=self.db, apply=True))
        self.assertEqual(self.state()["source_metadata"][0]["dataset_version"], "committed-before-report")

    def test_new_database_race_is_not_overwritten(self):
        self.input.write_text(json.dumps(self.payload), encoding="utf-8")
        real_open = core.os.open

        def competing_create(path, flags, mode):
            self.db.write_bytes(b"synthetic competing database")
            return real_open(path, flags, mode)

        with patch.object(core.os, "open", side_effect=competing_create), self.assertRaises(FileExistsError):
            core.import_command(SimpleNamespace(input=self.input, db=self.db, apply=True))
        self.assertEqual(self.db.read_bytes(), b"synthetic competing database")

    def test_projection_and_existing_public_gate_sources(self):
        for mode in ("absent", "nonofficial", "official", "both"):
            p = copy.deepcopy(self.payload)
            p["tables"]["school_field_sources"] = []
            for field in ("schools.latitude", "schools.total_students", "school_departments.name", "school_departments.course_type"):
                for official in ({"absent": [], "nonofficial": [False], "official": [True], "both": [False, True]}[mode]):
                    source = copy.deepcopy(self.payload["tables"]["school_field_sources"][0])
                    source.update(field_name=field, is_official_source=official,
                                  official_url=f"https://school.example/{field}/{official}")
                    p["tables"]["school_field_sources"].append(source)
            self.db = self.root / f"{mode}.sqlite"
            self.ingest(p)
            rows = self.rows()
            self.assertEqual(len(rows), 1)
            self.assertEqual(set(rows[0]), set(core.SCHOOL_COLUMNS) | {"school_departments", "school_field_sources"})
            self.assertEqual(rows[0]["course_times"], ["parttime", "fulltime"])
            serialized = json.dumps(rows)
            self.assertNotIn("SYNTHETIC_PRIVATE", serialized)
            self.assertNotIn("created_at", serialized)
            public = self.public(rows)[0]
            with self.subTest(mode=mode):
                self.assertEqual("latitude" in public, mode != "nonofficial")
                self.assertIn("longitude", public)  # absent evidence is not nonofficial evidence
                self.assertEqual("total_students" in public, mode in ("official", "both"))
                self.assertEqual("departments" in public, mode in ("official", "both"))
                self.assertNotIn("status_description", public)
                self.assertNotIn("status_note", public.get("lifecycle", {}))
                if mode in ("official", "both"):
                    self.assertEqual(public["departments"][0]["course_type"], "synthetic_general")
                    self.assertEqual(public["total_students"], 0)
                    self.assertEqual(public["provenance"]["field_sources"][0]["last_http_status"], 404)

    def test_active_without_url_kept_in_projection_and_empty_children(self):
        p = copy.deepcopy(self.payload)
        p["tables"]["schools"][0]["official_url"] = None
        p["tables"]["school_departments"] = []
        p["tables"]["school_field_sources"] = []
        self.ingest(p)
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["school_departments"], [])
        self.assertEqual(rows[0]["school_field_sources"], [])
        self.assertEqual(self.public(rows), [])


if __name__ == "__main__":
    unittest.main()
