"""Synthetic integration/regression tests. All writable data lives outside the repo."""

from contextlib import closing, contextmanager
import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import store


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
PUBLIC_FIELDS = {
    "id", "record_key", "name", "type", "ownership", "gender_type",
    "prefecture", "address", "official_url", "is_integrated", "updated_at",
}
NEW_ID = "44444444-4444-4444-8444-444444444444"
NEW_KEY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"


@contextmanager
def database(path, **kwargs):
    # Connection's own context manager commits/rolls back, but does not close it.
    with closing(sqlite3.connect(path, **kwargs)) as db, db:
        yield db


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="school-store-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.assertFalse(self.root.is_relative_to(REPO))
        self.db = self.root / "schools.sqlite"
        self.input = self.root / "input.json"
        self.payload = json.loads((HERE / "example.synthetic.json").read_text(encoding="utf-8"))

    def cli(self, *args, ok=True):
        result = subprocess.run(
            [sys.executable, "-B", str(HERE / "store.py"), *map(str, args)],
            cwd=self.root, capture_output=True, text=True, encoding="utf-8", timeout=20,
        )
        self.assertEqual(result.returncode, 0 if ok else 1, result.stderr)
        if not ok:
            self.assertEqual(result.stdout, "")
            self.assertNotIn("Traceback", result.stderr)
        return result

    def write_input(self, payload):
        self.input.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    def ingest(self, payload=None, apply=True, ok=True, db=None):
        self.write_input(self.payload if payload is None else payload)
        return self.cli("import", "--input", self.input, "--db", db or self.db,
                        *(["--apply"] if apply else []), ok=ok)

    def export(self, name="public.json"):
        output = self.root / name
        self.cli("export", "--db", self.db, "--output", output)
        return json.loads(output.read_text(encoding="utf-8"))

    def state(self):
        with database(self.db) as db:
            return {table: db.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall()
                    for table in ("schools", "school_departments", "prototype_metadata")}

    def assert_rollback(self, payload):
        before = self.state()
        digest = hashlib.sha256(self.db.read_bytes()).hexdigest()
        self.ingest(payload, ok=False)
        self.assertEqual(self.state(), before)
        self.assertEqual(hashlib.sha256(self.db.read_bytes()).hexdigest(), digest)

    def test_readme_round_trip_and_independent_ids(self):
        result = self.ingest(apply=False)
        self.assertEqual(json.loads(result.stdout)["mode"], "dry-run")
        self.assertFalse(self.db.exists())
        self.assertEqual(json.loads(self.ingest().stdout)["ignored_columns"], 1)
        before = self.state()
        self.ingest()
        self.assertEqual(self.state(), before)
        self.assertEqual([len(before[t]) for t in ("schools", "school_departments")], [2, 1])
        with database(self.db) as db:
            for table in ("schools", "school_departments"):
                actual = db.execute(f"SELECT id, record_key FROM {table} ORDER BY id").fetchall()
                self.assertEqual(actual, sorted((r["id"], r["record_key"]) for r in self.payload[table]))
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchall(), [("ok",)])
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
        first = self.export()
        second = self.export("public-2.json")
        self.assertEqual(first["content_sha256"], second["content_sha256"])
        self.assertEqual(first["school_count"], 1)
        self.assertEqual(first["schools"], [{key: self.payload["schools"][0][key] for key in PUBLIC_FIELDS}])
        self.assertIs(type(first["schools"][0]["is_integrated"]), bool)
        content = {k: first[k] for k in ("format", "schema_version", "synthetic", "dataset_version", "schools")}
        canonical = json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        self.assertEqual(first["content_sha256"], hashlib.sha256(canonical).hexdigest())

    def test_existing_dry_run_preserves_bytes_and_files(self):
        self.ingest()
        changed = copy.deepcopy(self.payload)
        changed["schools"][0]["name"] = "合成変更校"
        changed["dataset_version"] = "synthetic-next"
        before = self.db.read_bytes()
        paths = set(self.root.iterdir())
        self.ingest(changed, apply=False)
        self.assertEqual(self.db.read_bytes(), before)
        self.assertEqual(set(self.root.iterdir()), paths)

    def test_update_and_omitted_rows_are_retained(self):
        self.ingest()
        changed = copy.deepcopy(self.payload)
        changed["schools"] = changed["schools"][:1]
        changed["schools"][0]["name"] = "合成変更校"
        changed["schools"][0]["is_integrated"] = True
        changed["school_departments"] = []
        changed["dataset_version"] = "synthetic-next"
        self.ingest(changed)
        self.assertEqual(len(self.state()["schools"]), 2)
        self.assertEqual(len(self.state()["school_departments"]), 1)
        output = self.export()
        self.assertEqual(output["dataset_version"], "synthetic-next")
        self.assertEqual(output["schools"][0]["name"], "合成変更校")
        self.assertIs(output["schools"][0]["is_integrated"], True)

    def test_public_gates_independent_and_unknown_columns_discarded(self):
        for index, (active, url, count) in enumerate([
            (False, "https://school.example.org/", 0), (True, None, 0),
            (True, "http://school.example.org/", 1), (True, "https://school.example.org:8443/", 1),
        ]):
            with self.subTest(active=active, url=url):
                payload = copy.deepcopy(self.payload)
                payload["schools"][0].update(is_active=active, official_url=url,
                                             internal_fixture="SYNTHETIC_PRIVATE_MARKER")
                payload["school_departments"][0]["internal_fixture"] = "SYNTHETIC_PRIVATE_MARKER"
                result = self.ingest(payload)
                self.assertEqual(json.loads(result.stdout)["ignored_columns"], 3)
                self.assertNotIn("internal_fixture", result.stdout)
                output = self.export(f"gate-{index}.json")
                self.assertEqual(output["school_count"], count)
                self.assertNotIn("SYNTHETIC_PRIVATE_MARKER", json.dumps(output))
                for school in output["schools"]:
                    self.assertEqual(set(school), PUBLIC_FIELDS)
                self.assertNotIn("school_departments", output)
                self.assertNotIn(b"SYNTHETIC_PRIVATE_MARKER", self.db.read_bytes())

    def test_rollback_existing_identity_failure_after_school_update(self):
        self.ingest()
        before = self.export()
        payload = copy.deepcopy(self.payload)
        payload["schools"][0]["name"] = "合成失敗校"
        payload["dataset_version"] = "must-rollback"
        payload["school_departments"][0]["school_id"] = NEW_ID
        self.assert_rollback(payload)
        after = self.export("after.json")
        for key in ("schools", "dataset_version", "content_sha256"):
            self.assertEqual(after[key], before[key])

    def test_fk_failure_rolls_back_existing_and_removes_new_db(self):
        self.ingest()
        payload = copy.deepcopy(self.payload)
        payload["schools"][0]["name"] = "合成失敗校"
        payload["dataset_version"] = "must-rollback"
        payload["school_departments"][0].update(id=NEW_ID, record_key="department-" + NEW_KEY, school_id=NEW_ID)
        self.assert_rollback(payload)
        fresh = self.root / "failed.sqlite"
        self.ingest(payload, db=fresh, ok=False)
        self.assertEqual(list(self.root.glob("failed.sqlite*")), [])
        self.ingest(payload, db=fresh, apply=False, ok=False)
        self.assertFalse(fresh.exists())

    def test_commit_failure_restores_rows_and_dataset_version(self):
        self.ingest()
        before = self.state()
        payload, _ = store.load_input(self.input)
        payload["dataset_version"] = "must-rollback"
        payload["schools"][0]["name"] = "合成失敗校"
        with closing(store.connect(self.db)) as db:
            class FailingCommit:
                def __getattr__(self, name):
                    return getattr(db, name)

                def commit(self):
                    raise sqlite3.OperationalError("synthetic commit failure")

            with self.assertRaises(sqlite3.OperationalError):
                store.import_rows(FailingCommit(), payload, fresh=False)
        self.assertEqual(self.state(), before)

    def test_identity_mutations_rejected(self):
        self.ingest()
        for table in ("schools", "school_departments"):
            for field in ("id", "record_key"):
                with self.subTest(table=table, field=field):
                    payload = copy.deepcopy(self.payload)
                    prefix = "school-" if table == "schools" else "department-"
                    payload[table][0][field] = NEW_ID if field == "id" else prefix + NEW_KEY
                    self.assert_rollback(payload)
        payload = copy.deepcopy(self.payload)
        payload["school_departments"][0]["school_id"] = payload["schools"][1]["id"]
        self.assert_rollback(payload)

    def test_duplicate_ids_and_keys_rejected(self):
        for table in ("schools", "school_departments"):
            for duplicate in ("id", "record_key"):
                with self.subTest(table=table, duplicate=duplicate):
                    payload = copy.deepcopy(self.payload)
                    row = copy.deepcopy(payload[table][0])
                    if duplicate == "id":
                        row["record_key"] = ("school-" if table == "schools" else "department-") + NEW_KEY
                    else:
                        row["id"] = NEW_ID
                    payload[table].append(row)
                    self.ingest(payload, ok=False)
                    self.assertFalse(self.db.exists())

    def test_invalid_types_and_values_rejected(self):
        cases = [("type", "unknown"), ("ownership", "unknown"), ("gender_type", "unknown"),
                 ("is_active", 1), ("is_integrated", 0), ("updated_at", "2026-09-27T00:00:00"),
                 ("updated_at", "bad"), ("id", "bad"), ("name", "  "),
                 ("official_url", ""), ("official_url", "javascript:alert(1)"),
                 ("official_url", "https://"), ("official_url", "https://school.example.org/a b")]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                payload = copy.deepcopy(self.payload)
                payload["schools"][0][field] = value
                self.ingest(payload, ok=False)
                self.assertFalse(self.db.exists())
        payload = copy.deepcopy(self.payload)
        payload["school_departments"][0]["course_type"] = "unknown"
        self.ingest(payload, ok=False)
        self.assertFalse(self.db.exists())

    def test_invalid_url_ports_rejected_on_import_and_export(self):
        self.ingest()
        for index, url in enumerate(["https://school.example.org:invalid/", "https://school.example.org:65536/"]):
            with self.subTest(url=url):
                payload = copy.deepcopy(self.payload)
                payload["schools"][0]["official_url"] = url
                self.ingest(payload, ok=False)
                # A malformed value already in the synthetic DB must also be filtered.
                with database(self.db) as db:
                    db.execute("UPDATE schools SET official_url = ?", (url,))
                self.assertEqual(self.export(f"bad-port-{index}.json")["school_count"], 0)

    def test_null_course_type_and_timestamp_preserved(self):
        self.payload["school_departments"][0]["course_type"] = None
        self.ingest()
        with database(self.db) as db:
            self.assertIsNone(db.execute("SELECT course_type FROM school_departments").fetchone()[0])
            self.assertEqual(db.execute("SELECT updated_at FROM schools ORDER BY id").fetchall(),
                             [(r["updated_at"],) for r in self.payload["schools"]])

    def test_top_level_and_duplicate_json_keys_rejected(self):
        for field, value in [("users", []), ("synthetic", False), ("schema_version", True)]:
            with self.subTest(field=field):
                payload = copy.deepcopy(self.payload)
                payload[field] = value
                self.ingest(payload, ok=False)
                self.assertFalse(self.db.exists())
        raw = json.dumps(self.payload).replace('"synthetic": true', '"synthetic": true, "synthetic": true')
        self.input.write_text(raw, encoding="utf-8")
        self.cli("import", "--input", self.input, "--db", self.db, "--apply", ok=False)
        self.assertFalse(self.db.exists())

    def test_other_database_and_metadata_mismatch_unchanged(self):
        for index, (version, purpose) in enumerate([(1, "other"), (2, store.PURPOSE)]):
            other = self.root / f"other-{index}.sqlite"
            with database(other) as db:
                db.execute("CREATE TABLE prototype_metadata(singleton, schema_version, purpose)")
                db.execute("INSERT INTO prototype_metadata VALUES (1, ?, ?)", (version, purpose))
            before = other.read_bytes()
            for apply in (False, True):
                self.ingest(db=other, apply=apply, ok=False)
                self.assertEqual(other.read_bytes(), before)
            self.cli("export", "--db", other, "--output", self.root / "invalid.json", ok=False)
            self.assertFalse((self.root / "invalid.json").exists())
        empty = self.root / "empty.sqlite"
        empty.touch()
        self.ingest(db=empty, ok=False)
        self.assertEqual(empty.read_bytes(), b"")

    def test_existing_output_and_database_cannot_be_overwritten(self):
        self.ingest()
        self.export()
        for output in (self.root / "public.json", self.db):
            before = output.read_bytes()
            self.cli("export", "--db", self.db, "--output", output, ok=False)
            self.assertEqual(output.read_bytes(), before)
        self.assertEqual(list(self.root.glob(".school-export-*")), [])

    def test_missing_database_export_does_not_create_files(self):
        self.cli("export", "--db", self.db, "--output", self.root / "public.json", ok=False)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_real_writer_lock_refuses_second_writer_without_changes(self):
        self.ingest()
        before = self.state()
        with database(self.db, isolation_level=None) as writer:
            writer.execute("BEGIN IMMEDIATE")
            try:
                self.payload["schools"][0]["name"] = "合成競合校"
                self.ingest(ok=False)
            finally:
                writer.rollback()
        self.assertEqual(self.state(), before)

    def test_partial_export_write_fsync_and_link_failures_leave_no_final(self):
        self.ingest()
        args = SimpleNamespace(db=self.db, output=self.root / "public.json")

        def partial_dump(value, stream, **kwargs):
            stream.write('{"incomplete":')
            raise OSError("synthetic write failure")

        def interrupted_dump(value, stream, **kwargs):
            stream.write('{"incomplete":')
            raise KeyboardInterrupt

        for target, failure in [("json.dump", partial_dump), ("os.fsync", OSError("synthetic fsync failure")),
                                ("os.link", OSError("synthetic unsupported hard link")),
                                ("json.dump", interrupted_dump)]:
            with self.subTest(target=target), patch("store." + target, side_effect=failure):
                with self.assertRaises((OSError, KeyboardInterrupt)):
                    store.export_command(args)
            self.assertFalse(args.output.exists())
            self.assertEqual(list(self.root.glob(".school-export-*")), [])

    def test_racing_export_destination_is_not_overwritten(self):
        self.ingest()
        args = SimpleNamespace(db=self.db, output=self.root / "public.json")
        real_link = store.os.link

        def racing_link(source, destination):
            destination.write_bytes(b"synthetic competing output")
            return real_link(source, destination)

        with patch("store.os.link", side_effect=racing_link), self.assertRaises(FileExistsError):
            store.export_command(args)
        self.assertEqual(args.output.read_bytes(), b"synthetic competing output")
        self.assertEqual(list(self.root.glob(".school-export-*")), [])

    def test_result_reporting_failure_keeps_committed_results(self):
        self.write_input(self.payload)
        args = SimpleNamespace(db=self.db, input=self.input, apply=True, output=self.root / "public.json")
        with patch("builtins.print", side_effect=BrokenPipeError), self.assertRaises(BrokenPipeError):
            store.import_command(args)
        self.assertEqual(len(self.state()["schools"]), 2)
        with patch("builtins.print", side_effect=BrokenPipeError), self.assertRaises(BrokenPipeError):
            store.export_command(args)
        self.assertEqual(json.loads(args.output.read_text(encoding="utf-8"))["school_count"], 1)
        self.assertEqual(list(self.root.glob(".school-export-*")), [])


if __name__ == "__main__":
    unittest.main()
