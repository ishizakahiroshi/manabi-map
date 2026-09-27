"""Invented SQLite/owner transport fixtures only; no credentials or live APIs."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
import uuid

import school_live_controller as controller
import school_live_runner as runner
import school_live_source as live
import store_school as school
import test_school_live_controller as fixtures


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.ControllerTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        f = self.fixture
        root = f.root / "runner-state"
        root.mkdir()
        certificate = f.root / "invented-ca.pem"
        certificate.write_text("invented fixture; not a certificate")
        helper = f.root / runner.HELPER_BASENAME
        helper.write_text("# Invented path-validation fixture; never executed.\n")
        self.config = {"format": "school-live-runner", "version": 1, "python_executable": sys.executable,
            "source": str(f.source), "anchor": f.anchor, "history": f.write("history.json", []),
            "state_root": str(root), "psql_executable": sys.executable, "pg_sslrootcert": str(certificate),
            "pg_credentials": {"file": str(f.root / "unused-invented-secrets.toml"), "section": "invented",
                "keys": {key: key.lower() for key in runner.PG_KEYS - {"PGSSLMODE", "PGSSLROOTCERT"}}},
            "publisher_config": None, "publisher_auth": "wrangler", "publisher_credentials": None,
            "secret_helper": str(helper), "allowed_request_ids": None,
            "max_bytes": live.DEFAULT_MAX_BYTES, "timeout_seconds": 30}
        self.secrets = {"pg_environment": {key: "invented-value" for key in runner.PG_KEYS}, "publisher_environment": {}}
        self.secrets["pg_environment"].update(PGSSLMODE="verify-full", PGSSLROOTCERT=str(certificate))
        self.root = root
        self.original_rpc = f.pg.rpc
        self.list_calls = []
        def rpc(name, params, *, timeout_seconds):
            if name != "list_school_changes":
                return self.original_rpc(name, params, timeout_seconds=timeout_seconds)
            self.list_calls.append(copy.deepcopy(params))
            rows = list(f.pg.requests.values())
            after = params.get("p_after_id")
            start = next(index + 1 for index, row in enumerate(rows) if row["request_id"] == after) if after else 0
            return copy.deepcopy(rows[start:start + params["p_limit"]])
        f.pg.rpc = rpc

    def execute(self, command="run-one", **kwargs):
        if command in ("run-one", "reject"):
            kwargs.setdefault("request_id", fixtures.FIRST)
        return runner.execute(self.config, command, self.secrets, pg_factory=lambda **_: self.fixture.pg, **kwargs)

    def test_config_pin_unknown_fields_and_helper_rejected_before_credentials(self):
        ref = self.fixture.write("runner.json", self.config)
        self.assertEqual(runner.load_config(ref["path"], ref["sha256"]), self.config)
        with self.assertRaises(runner.RunnerError):
            runner.load_config(ref["path"], "0" * 64)
        for key, value in (("unknown", True), ("secret_helper", "invented-unapproved-helper.ps1")):
            invalid = {**self.config, key: value}
            ref = self.fixture.write("invalid.json", invalid)
            with self.assertRaises(Exception):
                runner.load_config(ref["path"])
        wrong_name = self.fixture.root / "invented-other-helper.ps1"
        wrong_name.write_text("# Invented fixture; never executed.\n")
        for value in (str(wrong_name), str(self.fixture.root), str(self.fixture.root / "missing" / runner.HELPER_BASENAME)):
            ref = self.fixture.write("invalid-helper.json", {**self.config, "secret_helper": value})
            with self.assertRaises(Exception):
                runner.load_config(ref["path"])

    def test_list_has_no_reason_value_or_credentials(self):
        result = self.execute("list")
        self.assertEqual(result["count"], 3)
        for row in result["items"]:
            self.assertEqual(set(row), {"id", "kind", "state"})
        raw = json.dumps(result)
        for forbidden in ("reason", "expected_value", "invented-value", "PGPASSWORD"):
            self.assertNotIn(forbidden, raw)
        self.assertFalse((self.root / "state.json").exists())

    def test_default_dryrun_preserves_source_and_has_no_claim_or_publisher(self):
        before = self.fixture.source.read_bytes()
        result = self.execute()
        self.assertEqual(result["items"][0]["state"], "dry-run")
        self.assertEqual(self.fixture.source.read_bytes(), before)
        self.assertNotIn("claim_school_change", self.fixture.pg.calls)
        self.assertFalse((self.root / "state.json").exists())
        self.assertEqual(list(self.root.iterdir()), [])

    def test_adoption_persists_chain_and_second_request_reuses_it(self):
        self.execute(apply=True)
        first = runner.read_state(self.config)
        self.assertEqual(len(first["history"]), 1)
        self.execute(request_id=fixtures.SECOND, apply=True)
        state = runner.read_state(self.config)
        self.assertEqual(len(state["history"]), 2)
        self.assertEqual(state["anchor"], self.config["anchor"])
        self.assertEqual(state["completed"][fixtures.FIRST], "adopted")

    def test_state_commit_failure_retries_without_second_adoption(self):
        with patch.object(runner, "atomic_state", side_effect=OSError("invented commit failure")):
            with self.assertRaises(OSError):
                self.execute(apply=True)
        before = self.fixture.source.read_bytes()
        self.execute(apply=True)
        self.assertEqual(self.fixture.source.read_bytes(), before)
        self.assertEqual(self.fixture.pg.logs, [(fixtures.FIRST, "adopted")])
        self.assertEqual(len(runner.read_state(self.config)["history"]), 1)

    def test_lock_contention_keeps_existing_lock_and_state(self):
        lock = self.root / ".school-runner.lock"
        lock.write_bytes(b"invented existing owner")
        with self.assertRaises(FileExistsError):
            self.execute("list")
        self.assertEqual(lock.read_bytes(), b"invented existing owner")
        self.assertEqual(self.list_calls, [])

    def test_atomic_replace_failure_preserves_previous_bytes(self):
        initial = runner.read_state(self.config)
        runner.atomic_state(self.root, initial)
        before = (self.root / "state.json").read_bytes()
        changed = {**initial, "completed": {fixtures.FIRST: "adopted"}}
        with patch.object(runner.os, "replace", side_effect=OSError("invented rename failure")):
            with self.assertRaises(OSError):
                runner.atomic_state(self.root, changed)
        self.assertEqual((self.root / "state.json").read_bytes(), before)
        self.assertEqual([path.name for path in self.root.iterdir()], ["state.json"])

    def test_atomic_postreplace_readback_failure_restores_previous_bytes(self):
        initial = runner.read_state(self.config)
        runner.atomic_state(self.root, initial)
        before = (self.root / "state.json").read_bytes()
        original = live._read
        replaced = False
        failed = False
        real_replace = os.replace
        def replace(source, destination):
            nonlocal replaced
            real_replace(source, destination)
            replaced = True
        def read(path, maximum):
            nonlocal failed
            if replaced and not failed and Path(path).name == "state.json":
                failed = True
                raise OSError("invented readback failure")
            return original(path, maximum)
        with patch.object(runner.os, "replace", side_effect=replace), patch.object(live, "_read", side_effect=read):
            with self.assertRaises(OSError):
                runner.atomic_state(self.root, {**initial, "completed": {fixtures.FIRST: "adopted"}})
        self.assertTrue(failed)
        self.assertEqual((self.root / "state.json").read_bytes(), before)

    def test_batch_cursor_crosses_completed_and_blocked_page_without_reject(self):
        rows = {}
        state = runner.read_state(self.config)
        template = self.fixture.pg.requests[fixtures.FIRST]
        for index in range(105):
            identifier = str(uuid.UUID(int=index + 1))
            row = {**template, "request_id": identifier, "state": "adopted" if index % 2 else "blocked"}
            rows[identifier] = row
            if row["state"] == "adopted":
                state["completed"][identifier] = "adopted"
        rows[fixtures.FIRST] = template
        self.fixture.pg.requests = rows
        runner.atomic_state(self.root, state)
        result = self.execute("batch", limit=1)
        self.assertEqual(result["items"], [{"id": fixtures.FIRST, "kind": "deviation", "state": "dry-run"}])
        self.assertEqual(len(self.list_calls), 2)
        self.assertEqual(self.list_calls[1]["p_after_id"], list(rows)[99])
        self.assertNotIn("reject_school_change", self.fixture.pg.calls)

    def test_explicit_reject_persists_cancel_without_changing_public_source_hash(self):
        before = controller.anchor_generation(self.config["anchor"], self.config["max_bytes"])
        result = self.execute("reject", apply=True)
        self.assertEqual(result["items"][0]["state"], "rejected")
        state = runner.read_state(self.config)
        self.assertEqual(state["history"], [])
        tip, receipts = controller.verify_chain(self.fixture.source, before, [], live._limits(self.config["max_bytes"], 30), self.config["max_bytes"])
        self.assertEqual(tip["source_content_sha256"], before["source_content_sha256"])
        self.assertEqual(receipts, [])

    def test_publication_confirmation_rolls_anchor_and_history_atomically(self):
        self.execute(apply=True)
        self.execute(request_id=fixtures.SECOND, apply=True)
        f = self.fixture
        config_ref = f.write("publisher-config.json", {"env": {}})
        self.config["publisher_config"] = config_ref
        class Publisher(fixtures.MockPublisher):
            def generate(publisher, context, control):
                candidate = super().generate(context, control)
                bundle = f.root / "published-bundle"
                exported = live.export_snapshot(f.source, bundle, expected_source_sha256=context["tip"]["source_content_sha256"], apply=True)
                snapshot, manifest = live.verify_bundle(bundle)
                payload = f.write("new-payload.json", {"formatVersion": 2, "schools": [], "sourceCatalog": [], "invented": "new"})
                artifacts = [{"path": "schools-manifest.json", "size": 2, "sha256": "3" * 64}]
                generation = f.write("new-generation.json", {"format": "observed-school-json", "evidence": "observed", "source": {
                    "type": "sqlite-snapshot", "snapshotSha256": manifest["snapshot_sha256"], "manifestSha256": f.ref(bundle / "manifest.json")["sha256"],
                    "contentSha256": manifest["content_sha256"], "datasetVersion": snapshot["dataset_version"], "sourceVersion": snapshot["source_version"]},
                    "generatorSnapshotSha256": payload["sha256"], "artifacts": artifacts, "artifactsSha256": school.content_hash(artifacts)})
                publisher.anchor = {"format": "school-live-observed-anchor", "version": 1,
                    "snapshot": f.ref(bundle / "snapshot.json"), "manifest": f.ref(bundle / "manifest.json"),
                    "export_receipt": f.write("new-export.json", exported), "generation": generation, "payload": payload}
                publisher.artifacts = artifacts
                candidate.update(generator_snapshot_sha256=payload["sha256"], anchor_path=str(f.root / "new-anchor.json"))
                return candidate
            def observe(publisher, context, control):
                observed = super().observe(context, control)
                observation = {"format": "school-http-observation", "evidence": "observed", "http_verified": True,
                    **{key: observed[key] for key in ("destination", "deployment_id", "observed_at")},
                    "generator_snapshot_sha256": context["candidate"]["generator_snapshot_sha256"], "manifest_sha256": "3" * 64,
                    "artifacts_sha256": school.content_hash(publisher.artifacts), "artifact_count": 1}
                publisher.anchor["observation"] = f.write("new-observation.json", observation)
                f.write("new-anchor.json", publisher.anchor)
                return observed
        publisher = Publisher()
        result = self.execute(request_id=fixtures.PUBLICATION, apply=True, publisher_factory=lambda _: publisher)
        self.assertEqual(result["items"][0]["state"], "publication_confirmed")
        state = runner.read_state(self.config)
        self.assertEqual(state["history"], [])
        self.assertEqual(state["anchor"], f.ref(f.root / "new-anchor.json"))
        self.assertEqual(state["completed"][fixtures.PUBLICATION], "publication_confirmed")
        self.assertEqual(publisher.calls, ["generate", "deploy", "observe"])

    def test_cli_errors_do_not_echo_stdin_or_bad_config(self):
        config = self.fixture.write("runner.json", {**self.config, "unknown": "invented-sensitive-marker"})
        result = subprocess.run([sys.executable, "-B", str(Path(runner.__file__)), "list", "--config", config["path"]],
            input=b'{"invented-sensitive-marker":"not-a-real-secret"}', capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(b"invented-sensitive-marker", result.stdout + result.stderr)

    def test_real_publisher_adapter_mock_transports_complete_runner_anchor_rollover(self):
        import test_school_live_publish as publisher_fixtures
        self.execute(apply=True)
        self.execute(request_id=fixtures.SECOND, apply=True)
        bridge = publisher_fixtures.PublisherTests()
        bridge.setUp()
        self.addCleanup(bridge.doCleanups)
        bridge.db = self.fixture.source
        state = runner.read_state(self.config)
        initial = controller.anchor_generation(state["anchor"], self.config["max_bytes"])
        tip, _ = controller.verify_chain(bridge.db, initial, state["history"], live._limits(self.config["max_bytes"], 30), self.config["max_bytes"])
        bridge.context["tip"] = tip
        self.config["publisher_config"] = self.fixture.write("actual-publisher-config.json", bridge.config)
        result = self.execute(request_id=fixtures.PUBLICATION, apply=True, publisher_factory=lambda _: bridge.publisher)
        self.assertEqual(result["items"][0]["state"], "publication_confirmed")
        updated = runner.read_state(self.config)
        self.assertEqual(updated["history"], [])
        self.assertNotEqual(updated["anchor"], state["anchor"])
        current = controller.anchor_generation(updated["anchor"], self.config["max_bytes"])
        self.assertEqual(current["source_content_sha256"], tip["source_content_sha256"])
        self.assertEqual(bridge.uploads, 1)
        self.assertEqual(updated["completed"][fixtures.PUBLICATION], "publication_confirmed")

    def test_powershell_bounded_transport_uses_stdin_and_excludes_ambient_credentials(self):
        child = self.fixture.root / "invented-child.py"
        child.write_text("import os,sys,json\nvalue=sys.stdin.read()\n"
            "assert value == 'invented-stdin-value'\n"
            "assert 'PGPASSWORD' not in os.environ and 'CLOUDFLARE_API_TOKEN' not in os.environ\n"
            "assert 'invented-stdin-value' not in sys.argv\nprint('invented-transport-ok')\n")
        script = self.fixture.root / "transport-test.ps1"
        script.write_text("param($Wrapper,$Python,$Child)\n$ErrorActionPreference='Stop'\n"
            "$tokens=$null;$errors=$null\n$ast=[System.Management.Automation.Language.Parser]::ParseFile($Wrapper,[ref]$tokens,[ref]$errors)\n"
            "if($errors.Count){throw 'parse failure'}\n"
            "$function=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-BoundedPython'},$true)\n"
            ". ([scriptblock]::Create($function.Extent.Text))\n"
            "$env:PGPASSWORD='invented-ambient-marker';$env:CLOUDFLARE_API_TOKEN='invented-ambient-marker'\n"
            "$result=Invoke-BoundedPython -Executable $Python -Arguments @('-B',$Child) -InputText 'invented-stdin-value' -TimeoutSeconds 10\n"
            "if($result.Trim() -ne 'invented-transport-ok'){throw 'result differs'}\nWrite-Output 'transport-ok'\n", encoding="utf-8")
        result = subprocess.run(["pwsh", "-NoProfile", "-File", str(script), str(Path(runner.__file__).with_name("run-school-live.ps1")),
            sys.executable, str(child)], capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        self.assertEqual(result.stdout.strip(), b"transport-ok")

    def test_powershell_deadline_and_stream_caps_kill_and_reap_child(self):
        child = self.fixture.root / "invented-bounded-child.py"
        child.write_text("import os,sys,time,pathlib\npathlib.Path(sys.argv[2]).write_text(str(os.getpid()))\n"
            "if sys.argv[1]=='stdout': print('x'*200000,flush=True)\n"
            "if sys.argv[1]=='stderr': print('x'*200000,file=sys.stderr,flush=True)\n"
            "time.sleep(20)\n")
        script = self.fixture.root / "bounded-test.ps1"
        script.write_text("param($Wrapper,$Python,$Child,$PidFile)\n$ErrorActionPreference='Stop'\n"
            "$tokens=$null;$errors=$null\n$ast=[System.Management.Automation.Language.Parser]::ParseFile($Wrapper,[ref]$tokens,[ref]$errors)\n"
            "if($errors.Count){throw 'parse failure'}\n"
            "$function=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-BoundedPython'},$true)\n"
            ". ([scriptblock]::Create($function.Extent.Text))\n"
            "foreach($mode in @('timeout','stdout','stderr')) {\n$rejected=$false\ntry {\n"
            "Invoke-BoundedPython -Executable $Python -Arguments @('-B',$Child,$mode,$PidFile) -InputText '' -TimeoutSeconds 1 > $null\n"
            "} catch { $rejected=$true }\nif(-not $rejected){throw 'limit not enforced'}\n"
            "$childIdentifier=[int][IO.File]::ReadAllText($PidFile)\n"
            "if(Get-Process -Id $childIdentifier -ErrorAction SilentlyContinue){throw 'child still running'}\n}\n"
            "Write-Output 'bounds-ok'\n", encoding="utf-8")
        result = subprocess.run(["pwsh", "-NoProfile", "-File", str(script), str(Path(runner.__file__).with_name("run-school-live.ps1")),
            sys.executable, str(child), str(self.fixture.root / "child.pid")], capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        self.assertEqual(result.stdout.strip(), b"bounds-ok")


if __name__ == "__main__":
    unittest.main()
