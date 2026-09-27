"""All-row candidate index checks using invented snapshots outside the repository."""

from contextlib import closing, redirect_stdout
import copy
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from school_fixture import synthetic_payload
import school_id_index as index
import store
import store_school as school


HERE = Path(__file__).resolve().parent
OLD_SCHOOL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
OLD_DEPT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


def resign(value):
    value["index_sha256"] = school.content_hash({key: item for key, item in value.items() if key != "index_sha256"})
    return value


class SchoolIdIndexTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="school-id-template-synthetic-")
        cls.template_root = Path(cls.temporary.name)
        cls.template = cls.template_root / "bundle"
        payload = synthetic_payload()
        payload["tables"] = school.normalize_tables(payload["tables"])
        dbfile = cls.template_root / "source.sqlite"
        with closing(store.connect(dbfile)) as db:
            school.import_rows(db, payload, fresh=True)
        with redirect_stdout(io.StringIO()):
            school.export_command(SimpleNamespace(db=dbfile, output=cls.template))

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="school-id-test-synthetic-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.assertFalse(self.root.is_relative_to(HERE.parents[1]))
        self.bundle = self.root / "bundle"
        shutil.copytree(self.template, self.bundle)
        self.output = self.root / "candidate.json"

    def inventory(self):
        return {str(path.relative_to(self.root)): path.read_bytes() if path.is_file() else None
                for path in self.root.rglob("*")}

    def mutate_snapshot(self, mutate):
        path = self.bundle / "snapshot.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        mutate(data)
        raw = (json.dumps(data, ensure_ascii=False) + "\n").encode()
        path.write_bytes(raw)
        manifest_path = self.bundle / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        for table, rows in data["tables"].items():
            manifest["table_counts"][table] = len(rows)
        manifest["snapshot_sha256"] = school.sha256(raw)
        manifest["content_sha256"] = school.content_hash(data)
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    def previous(self, candidate=None):
        path = self.root / "previous.json"
        path.write_text(json.dumps(candidate or index.build_index(self.bundle)), encoding="utf-8")
        return path

    def test_all_school_department_rows_including_inactive_are_projected(self):
        snapshot, manifest = school.verify_bundle(self.bundle)
        value = index.build_index(self.bundle)
        self.assertEqual(value["schools"], sorted(({"id": row["id"]} for row in snapshot["tables"]["schools"]), key=lambda row: row["id"]))
        self.assertEqual(value["departments"], sorted(({"id": row["id"], "school_id": row["school_id"]}
                                                     for row in snapshot["tables"]["school_departments"]), key=lambda row: row["id"]))
        self.assertTrue(any(not row["is_active"] for row in snapshot["tables"]["schools"]))
        self.assertEqual(value["source"]["snapshot_content_sha256"], manifest["content_sha256"])
        self.assertEqual(value["source"]["snapshot_sha256"], manifest["snapshot_sha256"])
        self.assertEqual(value["state"], "candidate")
        self.assertIsNone(value["previous_index_sha256"])
        self.assertEqual(index.validate_index(value), value)

    def test_business_values_and_source_paths_are_not_projected(self):
        def change(data):
            for row in data["tables"]["schools"]:
                row["name"] = "Synthetic value excluded from the ID artifact"
                row["address"] = "Synthetic address excluded from the ID artifact"
        self.mutate_snapshot(change)
        value = index.build_index(self.bundle)
        raw = json.dumps(value)
        self.assertNotIn("excluded from", raw)
        self.assertNotIn(str(self.root), raw)
        self.assertTrue(all(set(row) == {"id"} for row in value["schools"]))
        self.assertTrue(all(set(row) == {"id", "school_id"} for row in value["departments"]))

    def test_dry_run_writes_nothing_and_apply_creates_verifiable_candidate(self):
        before = self.inventory()
        dry = index.write_index(self.bundle, self.output)
        self.assertEqual(dry["status"], "dry_run")
        self.assertEqual(before, self.inventory())
        applied = index.write_index(self.bundle, self.output, apply=True)
        self.assertEqual(applied["status"], "candidate_written")
        self.assertEqual(dry["index"], index.verify_index(self.output))
        self.assertEqual(applied["index"], dry["index"])

    def test_previous_only_departments_and_parent_schools_are_retained(self):
        old = index.build_index(self.bundle)
        old["schools"].append({"id": OLD_SCHOOL})
        old["departments"].append({"id": OLD_DEPT, "school_id": OLD_SCHOOL})
        for name in ("schools", "departments"):
            old[name].sort(key=lambda row: row["id"])
            old["counts"][name] = len(old[name])
            old["diff"]["added"][name] = [row["id"] for row in old[name]]
        resign(old)
        previous = self.previous(old)
        value = index.build_index(self.bundle, previous)
        self.assertEqual(value["previous_index_sha256"], old["index_sha256"])
        self.assertIn({"id": OLD_SCHOOL}, value["schools"])
        self.assertIn({"id": OLD_DEPT, "school_id": OLD_SCHOOL}, value["departments"])
        self.assertEqual(value["diff"]["retained_absent"], {"schools": [OLD_SCHOOL], "departments": [OLD_DEPT]})
        self.assertEqual(value["diff"]["added"], {"schools": [], "departments": []})
        self.assertEqual(index.build_index(self.bundle, previous), value)

    def test_new_ids_are_reported_and_old_ids_are_not_deleted(self):
        previous = self.previous()
        def add(data):
            school_row = copy.deepcopy(data["tables"]["schools"][0])
            school_row["id"] = OLD_SCHOOL
            data["tables"]["schools"].append(school_row)
            dept = copy.deepcopy(data["tables"]["school_departments"][0])
            dept.update(id=OLD_DEPT, school_id=OLD_SCHOOL)
            data["tables"]["school_departments"].append(dept)
        self.mutate_snapshot(add)
        value = index.build_index(self.bundle, previous)
        self.assertEqual(value["diff"]["added"], {"schools": [OLD_SCHOOL], "departments": [OLD_DEPT]})
        self.assertEqual(value["diff"]["retained_absent"], {"schools": [], "departments": []})

    def test_department_reassignment_is_rejected_before_output(self):
        previous = self.previous()
        def change(data):
            department = data["tables"]["school_departments"][0]
            department["school_id"] = next(row["id"] for row in data["tables"]["schools"] if row["id"] != department["school_id"])
        self.mutate_snapshot(change)
        with self.assertRaisesRegex(ValueError, "membership changed"):
            index.write_index(self.bundle, self.output, previous, apply=True)
        self.assertFalse(self.output.exists())

    def test_duplicate_or_orphan_rows_and_noncanonical_uuid_are_rejected(self):
        for kind in ("school", "department", "orphan", "uuid"):
            shutil.copyfile(self.template / "snapshot.json", self.bundle / "snapshot.json")
            shutil.copyfile(self.template / "manifest.json", self.bundle / "manifest.json")
            def change(data):
                schools = data["tables"]["schools"]
                departments = data["tables"]["school_departments"]
                if kind == "school": schools.append(copy.deepcopy(schools[0]))
                if kind == "department": departments.append(copy.deepcopy(departments[0]))
                if kind == "orphan": departments[-1]["school_id"] = OLD_SCHOOL
                if kind == "uuid": schools[-1]["id"] = "synthetic-invalid-id"
            self.mutate_snapshot(change)
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                index.write_index(self.bundle, self.output, apply=True)
            self.assertFalse(self.output.exists())

    def test_corrupt_snapshot_pair_is_not_used(self):
        path = self.bundle / "snapshot.json"
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaises(ValueError): index.build_index(self.bundle)

    def test_unknown_column_on_last_snapshot_row_is_rejected(self):
        def extra(data):
            data["tables"]["schools"][-1]["synthetic_private_note"] = "never project"
        self.mutate_snapshot(extra)
        with self.assertRaises(ValueError): index.build_index(self.bundle)
        self.assertFalse(self.output.exists())

    def test_bundle_replaced_during_adapter_verification_is_rejected(self):
        adapt = index.school_common_manifest.adapt
        def replace(bundle):
            result = adapt(bundle)
            path = bundle / "snapshot.json"
            path.write_bytes(path.read_bytes() + b" ")
            return result
        with patch.object(index.school_common_manifest, "adapt", replace), self.assertRaisesRegex(ValueError, "changed"):
            index.write_index(self.bundle, self.output, apply=True)
        self.assertFalse(self.output.exists())

    def test_previous_shape_hash_counts_and_references_are_strict(self):
        valid = index.build_index(self.bundle)
        mutations = [
            lambda item: item.update(state="registered"),
            lambda item: item.update(format_version=True),
            lambda item: item.update(synthetic=False),
            lambda item: item.update(index_sha256="0" * 64),
            lambda item: item.update(index_sha256=True),
            lambda item: item.update(previous_index_sha256="bad"),
            lambda item: item["schools"][0].update(name="Synthetic extra business field"),
            lambda item: item["counts"].update(schools=True),
            lambda item: item["departments"][0].update(school_id=OLD_SCHOOL),
        ]
        for mutate in mutations:
            item = copy.deepcopy(valid)
            mutate(item)
            with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                index.build_index(self.bundle, self.previous(item))

    def test_recomputed_hash_cannot_hide_duplicate_or_extra_fields(self):
        valid = index.build_index(self.bundle)
        for kind in ("duplicate", "extra", "orphan", "diff"):
            value = copy.deepcopy(valid)
            if kind == "duplicate": value["schools"].append(copy.deepcopy(value["schools"][0]))
            if kind == "extra": value["departments"][0]["private_note"] = "Synthetic excluded field"
            if kind == "orphan": value["departments"][0]["school_id"] = OLD_SCHOOL
            if kind == "diff": value["diff"]["added"]["schools"] = []
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                index.build_index(self.bundle, self.previous(resign(value)))

    def test_duplicate_json_keys_in_previous_are_rejected(self):
        previous = self.previous()
        text = previous.read_text()
        previous.write_text('{"format_version":1,' + text[1:])
        with self.assertRaises(ValueError): index.build_index(self.bundle, previous)

    def test_existing_file_or_directory_and_bundle_output_are_not_touched(self):
        for existing in ("file", "directory"):
            if existing == "file": self.output.write_bytes(b"synthetic preexisting")
            else: self.output.mkdir()
            before = self.inventory()
            with self.subTest(existing=existing), self.assertRaises(ValueError):
                index.write_index(self.bundle, self.output, apply=True)
            self.assertEqual(before, self.inventory())
            if self.output.is_dir(): self.output.rmdir()
            else: self.output.unlink()
        with self.assertRaises(ValueError): index.write_index(self.bundle, self.bundle / "index.json", apply=True)

    def test_fsync_failure_leaves_no_output_or_temporary_directory(self):
        before = self.inventory()
        with patch.object(index.os, "fsync", side_effect=OSError("synthetic full disk")), self.assertRaises(OSError):
            index.write_index(self.bundle, self.output, apply=True)
        self.assertEqual(before, self.inventory())

    def test_racing_output_creator_is_preserved(self):
        def race(source, destination):
            destination.write_bytes(b"synthetic competing writer")
            raise FileExistsError("synthetic race")
        with patch.object(index.os, "link", race), self.assertRaises(FileExistsError):
            index.write_index(self.bundle, self.output, apply=True)
        self.assertEqual(self.output.read_bytes(), b"synthetic competing writer")
        self.assertFalse(any(path.name.startswith(".school-id-index-") for path in self.root.iterdir()))

    def test_input_changed_after_link_is_detected_and_own_output_removed(self):
        link = os.link
        def change(source, destination):
            link(source, destination)
            path = self.bundle / "manifest.json"
            path.write_bytes(path.read_bytes() + b" ")
        with patch.object(index.os, "link", change), self.assertRaisesRegex(ValueError, "changed"):
            index.write_index(self.bundle, self.output, apply=True)
        self.assertFalse(self.output.exists())

    def test_link_failure_and_keyboard_interrupt_preserve_inputs(self):
        before = self.inventory()
        for exception in (OSError("synthetic unsupported hardlink"), KeyboardInterrupt()):
            with self.subTest(exception=type(exception)), patch.object(index.os, "link", side_effect=exception), self.assertRaises(type(exception)):
                index.write_index(self.bundle, self.output, apply=True)
            self.assertEqual(before, self.inventory())

    def test_interrupt_after_successful_link_removes_only_owned_output(self):
        before = self.inventory()
        link = os.link
        def interrupt(source, destination):
            link(source, destination)
            raise KeyboardInterrupt()
        with patch.object(index.os, "link", interrupt), self.assertRaises(KeyboardInterrupt):
            index.write_index(self.bundle, self.output, apply=True)
        self.assertEqual(before, self.inventory())

    def test_explicit_boolean_hardlinks_and_linked_ancestors(self):
        for value in (1, "false", None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                index.write_index(self.bundle, self.output, apply=value)
        os.link(self.bundle / "snapshot.json", self.root / "alias.json")
        with self.assertRaises(ValueError): index.build_index(self.bundle)
        (self.root / "alias.json").unlink()
        original = Path.lstat
        def linked(path):
            info = original(path)
            if path == self.bundle:
                class Linked:
                    st_mode = info.st_mode
                    st_file_attributes = 0x400
                return Linked()
            return info
        if os.name == "nt":
            with patch.object(Path, "lstat", linked), self.assertRaises(ValueError): index.build_index(self.bundle)

    def test_cli_dry_run_apply_and_rejection_do_not_print_source_data(self):
        def run(*extra):
            return subprocess.run([sys.executable, "-B", str(HERE / "school_id_index.py"),
                                   "--bundle", str(self.bundle), "--output", str(self.output), *extra],
                                  cwd=self.root, capture_output=True, text=True, timeout=20)
        dry = run()
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertEqual(json.loads(dry.stdout)["status"], "dry_run")
        self.assertFalse(self.output.exists())
        applied = run("--apply")
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertEqual(json.loads(applied.stdout)["status"], "candidate_written")
        rejected = run("--apply")
        self.assertEqual(rejected.returncode, 1)
        self.assertEqual(rejected.stdout, "")
        self.assertNotIn(str(self.root), rejected.stderr)
        self.assertNotIn("Traceback", rejected.stderr)


if __name__ == "__main__":
    unittest.main()
