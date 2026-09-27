"""25-table integration, migration and snapshot failures, in external temp only."""

from contextlib import closing
import copy
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
import store_core
import store_school as full
from school_fixture import synthetic_payload


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


class FullSchoolTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="school-full-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.assertFalse(self.root.is_relative_to(REPO))
        self.db = self.root / "schools.sqlite"
        self.input = self.root / "input.json"
        self.payload = synthetic_payload()
        self.write_input()

    def write_input(self, payload=None):
        self.input.write_text(json.dumps(self.payload if payload is None else payload, ensure_ascii=False), encoding="utf-8")

    def cli(self, *args, ok=True):
        result = subprocess.run([sys.executable, "-B", str(HERE / "store_school.py"), *map(str, args)],
                                cwd=self.root, capture_output=True, text=True, encoding="utf-8", timeout=25)
        self.assertEqual(result.returncode, 0 if ok else 1, result.stderr)
        if not ok:
            self.assertEqual(result.stdout, "")
            self.assertNotIn("Traceback", result.stderr)
            self.assertNotIn(str(self.root), result.stderr)
        return result

    def ingest(self, payload=None, apply=True, ok=True, from_core=None):
        self.write_input(payload)
        return self.cli("import", "--input", self.input, "--db", self.db,
                        *(["--apply"] if apply else []), *(["--from-core", from_core] if from_core else []), ok=ok)

    def state(self):
        with closing(store.connect(self.db, readonly=True)) as db:
            return {t: [dict(r) for r in db.execute(f"SELECT * FROM {t} ORDER BY 1,2")]
                    for t in (*full.TABLES, "source_metadata")}

    def export(self, name="bundle"):
        output = self.root / name
        self.cli("export", "--db", self.db, "--output", output)
        self.cli("verify", "--bundle", output)
        return output, full.verify_bundle(output)

    def test_all_25_columns_and_nullability_match_source_ddl(self):
        self.assertEqual(len(full.TABLES), 25)
        self.assertEqual(len(full.PROJECTION), 13)
        self.assertEqual(self.payload, json.loads((HERE / "example.school.synthetic.json").read_text(encoding="utf-8")))
        self.ingest()
        baseline = (REPO / "web/supabase/baseline_schema.sql").read_text(encoding="utf-8")
        with closing(store.connect(self.db, readonly=True)) as db:
            for table in full.TABLES:
                body = re.search(r"CREATE TABLE public\." + table + r" \((.*?)\n\);", baseline, re.S)[1]
                expected = {}
                for line in body.splitlines():
                    match = re.match(r"    ([a-z][a-z0-9_]*) (.+)", line)
                    if match:
                        expected[match[1]] = int("NOT NULL" in match[2])
                actual = {r["name"]: r["notnull"] for r in db.execute(f"PRAGMA table_info({table})")}
                self.assertEqual(actual, expected, table)

    def test_round_trip_reimport_all_rows_and_null_key_update(self):
        self.ingest()
        before = self.state()
        self.ingest()
        self.assertEqual(before, self.state())
        for table, rows in full.load_input(self.input)["tables"].items():
            self.assertCountEqual(before[table], rows, table)
        self.payload["tables"]["school_admission_stat_quality_flags"][0]["note"] = "合成更新"
        self.ingest()
        flags = self.state()["school_admission_stat_quality_flags"]
        self.assertEqual(len(flags), 1)
        self.assertIsNone(flags[0]["metric_code"])
        self.assertEqual(flags[0]["note"], "合成更新")

    def test_dry_run_and_omitted_rows_preserved(self):
        self.ingest(apply=False)
        self.assertFalse(self.db.exists())
        self.ingest()
        before = self.db.read_bytes()
        files = set(self.root.iterdir())
        self.ingest(apply=False)
        self.assertEqual(before, self.db.read_bytes())
        self.assertEqual(files, set(self.root.iterdir()))
        self.payload["tables"] = {t: [] for t in full.TABLES}
        state = self.state()
        self.ingest()
        self.assertEqual(state, self.state())

    def test_unknown_columns_every_table_fail_before_writing(self):
        for table in full.TABLES:
            p = copy.deepcopy(self.payload)
            p["tables"][table][0]["synthetic_unknown"] = "never-retain"
            with self.subTest(table=table):
                self.ingest(p, ok=False)
                self.assertFalse(self.db.exists())
        p = copy.deepcopy(self.payload)
        p["tables"]["user_school_notes"] = []
        self.ingest(p, ok=False)

    def test_late_25_table_failure_preserves_bytes_and_both_versions(self):
        self.ingest()
        before, content = self.state(), self.db.read_bytes()
        p = copy.deepcopy(self.payload)
        p.update(dataset_version="new-dataset", source_version="new-source")
        p["tables"]["schools"][0]["name"] = "合成変更"
        p["tables"]["course_type_master"][0]["label_ja"] = "合成変更"
        p["tables"]["school_name_history"][0]["notes"] = "合成変更"
        p["tables"]["school_admission_stat_legacy_links"][0]["legacy_stat_id"] = "99999999-9999-4999-8999-999999999999"
        self.ingest(p, ok=False)
        self.assertEqual(before, self.state())
        self.assertEqual(content, self.db.read_bytes())
        self.db = self.root / "new-failure.sqlite"
        self.ingest(p, ok=False)
        self.assertFalse(self.db.exists())
        self.assertFalse(list(self.root.glob("*-journal")))

    def test_membership_rechecked_after_parent_update(self):
        self.ingest()
        before = self.db.read_bytes()
        self.payload["tables"]["admission_recruitment_units"][0]["school_id"] = self.payload["tables"]["schools"][1]["id"]
        self.payload["tables"]["admission_recruitment_unit_departments"] = []
        self.ingest(ok=False)
        self.assertEqual(before, self.db.read_bytes())

    def test_commit_failure_and_interrupt_restore_all_tables(self):
        self.ingest()
        before = self.state()
        self.payload.update(dataset_version="new-dataset", source_version="new-source")
        self.payload["tables"]["schools"][0]["name"] = "合成変更"
        self.write_input()
        payload = full.load_input(self.input)

        class FailedCommit(sqlite3.Connection):
            def commit(self):
                raise sqlite3.OperationalError("synthetic commit failure")

        with closing(sqlite3.connect(self.db, isolation_level=None, factory=FailedCommit)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            with self.assertRaises(sqlite3.OperationalError):
                full.import_rows(db, payload, fresh=False)
        self.assertEqual(before, self.state())
        with closing(store.connect(self.db)) as db, patch.object(full, "check_consistency", side_effect=[None, KeyboardInterrupt]):
            with self.assertRaises(KeyboardInterrupt):
                full.import_rows(db, payload, fresh=False)
        self.assertEqual(before, self.state())

    def make_core(self):
        source = self.root / "core.sqlite"
        with patch("builtins.print"):
            store_core.import_command(SimpleNamespace(db=source, input=HERE / "example.core.synthetic.json", apply=True))
        return source

    def test_explicit_migration_preserves_core_and_rejects_in_place(self):
        source = self.make_core()
        before = source.read_bytes()
        self.ingest(from_core=source, apply=False)
        self.assertFalse(self.db.exists())
        self.ingest(from_core=source)
        self.assertEqual(before, source.read_bytes())
        self.assertEqual(len(self.state()), 26)
        self.ingest(from_core=source, ok=False)  # destination must be new
        self.db = source
        self.ingest(from_core=source, ok=False)
        self.ingest(ok=False)  # no implicit upgrade
        self.assertEqual(before, source.read_bytes())

    def test_migration_rejects_changed_missing_and_unknown_core_data(self):
        source = self.make_core()
        for change in ("changed", "missing"):
            p = copy.deepcopy(self.payload)
            if change == "changed":
                p["tables"]["schools"][0]["name"] = "合成別値"
            else:
                p["tables"]["schools"].pop()
            self.ingest(p, from_core=source, ok=False)
            self.assertFalse(self.db.exists())
        with closing(store.connect(source)) as db:
            db.execute("ALTER TABLE schools ADD COLUMN synthetic_unknown TEXT")
            db.execute("UPDATE schools SET synthetic_unknown='must-not-lose'")
        before = source.read_bytes()
        self.ingest(from_core=source, ok=False)
        self.assertEqual(before, source.read_bytes())
        self.assertFalse(self.db.exists())

    def test_snapshot_hashes_metadata_projection_and_readonly(self):
        self.ingest()
        before = self.db.read_bytes()
        first, (snapshot, manifest) = self.export("bundle1")
        second, (again, repeated) = self.export("bundle2")
        self.assertEqual(before, self.db.read_bytes())
        self.assertEqual(snapshot, again)
        self.assertEqual(manifest["content_sha256"], repeated["content_sha256"])
        self.assertEqual(manifest["snapshot_sha256"], repeated["snapshot_sha256"])
        self.assertEqual(set(manifest["table_counts"]), set(full.TABLES))
        self.assertEqual(len(snapshot["tables"]), 13)
        data = (first / "snapshot.json").read_text(encoding="utf-8")
        self.assertNotIn("SYNTHETIC_PRIVATE", data)
        self.assertNotIn("created_at", data)
        self.assertNotIn("school_admission_stat_legacy_links", data)
        self.assertNotIn(str(REPO), (first / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["code"]["sha256"], full.content_hash(manifest["code"]["files"]))
        self.cli("export", "--db", self.db, "--output", second, ok=False)

    def test_snapshot_corruption_versions_and_unknown_projection_rejected(self):
        self.ingest()
        output, (snapshot, manifest) = self.export()
        original_snapshot = (output / "snapshot.json").read_bytes()
        original_manifest = (output / "manifest.json").read_bytes()
        for mutation in ("hash", "version", "column", "count", "code", "missing", "null-manifest", "null-tables"):
            (output / "snapshot.json").write_bytes(original_snapshot)
            (output / "manifest.json").write_bytes(original_manifest)
            if mutation == "missing":
                (output / "manifest.json").unlink()
            elif mutation == "null-manifest":
                (output / "manifest.json").write_text("null", encoding="utf-8")
            elif mutation == "hash":
                (output / "snapshot.json").write_bytes(original_snapshot + b" ")
            else:
                p, m = copy.deepcopy(snapshot), copy.deepcopy(manifest)
                if mutation == "version":
                    m["schema_version"] = 999
                elif mutation == "column":
                    p["tables"]["schools"][0]["status_note"] = "must-not-export"
                elif mutation == "count":
                    m["table_counts"]["schools"] += 1
                elif mutation == "code":
                    m["code"]["files"][0]["path"] = "../outside"
                    m["code"]["sha256"] = full.content_hash(m["code"]["files"])
                elif mutation == "null-tables":
                    p["tables"] = None
                raw = (json.dumps(p, ensure_ascii=False, default=float) + "\n").encode("utf-8")
                m["snapshot_sha256"], m["content_sha256"] = full.sha256(raw), full.content_hash(p)
                (output / "snapshot.json").write_bytes(raw)
                (output / "manifest.json").write_text(json.dumps(m), encoding="utf-8")
            with self.subTest(mutation=mutation):
                self.cli("verify", "--bundle", output, ok=False)

    def test_source_corruption_is_not_exported_or_updated(self):
        self.ingest()
        with closing(store.connect(self.db)) as db:
            db.execute("UPDATE schools SET updated_at='no-timezone'")
        before = self.db.read_bytes()
        self.cli("export", "--db", self.db, "--output", self.root / "bad", ok=False)
        self.ingest(ok=False)
        self.assertEqual(before, self.db.read_bytes())
        self.assertFalse((self.root / "bad").exists())

    def test_bundle_failure_cleanup_and_complete_manifest_last(self):
        self.ingest()
        real_link = full.os.link
        output = self.root / "failed"
        args = SimpleNamespace(db=self.db, output=output)

        def failed_write(path, value):
            path.write_bytes(b"partial")
            raise OSError("synthetic write failure")

        def fail_manifest_link(src, dst):
            self.assertFalse((output / "manifest.json").exists())
            if Path(src).name == "manifest.json":
                self.assertTrue((output / "snapshot.json").exists())
                raise KeyboardInterrupt
            return real_link(src, dst)

        for target, failure in (("write_json", failed_write), ("os.fsync", OSError("synthetic fsync")),
                                ("os.link", fail_manifest_link)):
            manager = patch.object(full, target, side_effect=failure) if "." not in target else patch(
                "store_school." + target, side_effect=failure)
            with manager, self.assertRaises((OSError, KeyboardInterrupt)):
                full.export_command(args)
            self.assertFalse(output.exists())
            self.assertFalse(list(self.root.glob(".school-snapshot-*")))
        output.mkdir()  # even an empty destination is never replaced
        with self.assertRaises(store.InputError):
            full.export_command(args)
        self.assertEqual(list(output.iterdir()), [])

    def test_export_reporting_failure_preserves_verified_bundle(self):
        self.ingest()
        output = self.root / "complete"
        with patch("builtins.print", side_effect=BrokenPipeError), self.assertRaises(BrokenPipeError):
            full.export_command(SimpleNamespace(db=self.db, output=output))
        full.verify_bundle(output)

    def test_python_snapshot_consumed_by_actual_js_adapter(self):
        self.payload["tables"]["schools"][0]["latitude"] = "0.0000001"
        self.payload["tables"]["schools"][0]["longitude"] = "-999.9999999"
        self.ingest()
        output, (_, manifest) = self.export()
        script = """
            const {loadSchoolSource,buildSchoolPayload,REQUIRED_CODE_FILES} = await import(process.argv[1]);
            const rows = await loadSchoolSource({source:'snapshot',snapshotPath:process.argv[2],manifestPath:process.argv[3],
              fetchSupabase:()=>{throw Error('must never connect')}});
            process.stdout.write(JSON.stringify({rows,payload:buildSchoolPayload(rows),codeFiles:REQUIRED_CODE_FILES}));
        """
        result = subprocess.run(["node", "--input-type=module", "-e", script,
                                 (REPO / "web/scripts/lib/school-source.mjs").as_uri(),
                                 str(output / "snapshot.json"), str(output / "manifest.json")],
                                capture_output=True, text=True, encoding="utf-8", cwd=self.root, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = json.loads(result.stdout)
        self.assertEqual(len(result["rows"]), 1)
        row = result["rows"][0]
        self.assertEqual(row["latitude"], 0.0000001)
        self.assertEqual(row["longitude"], -999.9999999)
        self.assertEqual(set(result["codeFiles"]), set(full.CODE_FILES))
        self.assertEqual(row["course_times"], ["parttime", "fulltime"])
        self.assertEqual(row["predecessor_relationships"][0]["predecessor"]["id"], self.payload["tables"]["schools"][1]["id"])
        self.assertEqual(len(row["school_name_history"]), 2)
        self.assertEqual(len(result["payload"]["sourceCatalog"]), 1)
        self.assertEqual(manifest["table_counts"]["school_admission_stat_quality_flags"], 1)


if __name__ == "__main__":
    unittest.main()
