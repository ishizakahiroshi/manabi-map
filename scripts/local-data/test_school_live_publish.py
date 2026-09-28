"""Entirely invented SQLite / build / provider fixtures. No live HTTP or deploy."""

from datetime import datetime, timedelta, timezone
import copy
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from urllib.parse import urlsplit

import school_live_publish as pub
import school_live_source as live
import school_live_controller as controller
import store_school as school
from test_school_live_source import invented_capture


def encoded(value):
    return school.canonical_json(value).encode()


class Control:
    def __init__(self):
        self.end = time.monotonic() + 30
        self.calls = 0
        self.queue = {"lease_token": "invented-token", "revision": 7, "application_receipts_sha256": "e" * 64}
        self.expired = False

    def remaining(self):
        value = self.end - time.monotonic()
        pub.need(value > 0)
        return value

    def checkpoint(self):
        self.remaining(); self.calls += 1

    def rpc(self, name, params):
        assert name == "school_publication_preflight"
        now = datetime.now(timezone.utc)
        return {"advisory_only": True, "request_id": params["p_request_id"], "revision": self.queue["revision"],
                "checked_at": (now - timedelta(seconds=40 if self.expired else 0)).isoformat(),
                "valid_until": (now + timedelta(seconds=30)).isoformat(),
                **{k: params["p_" + k] for k in ("source_sha256", "snapshot_content_sha256", "manifest_sha256", "code_sha256")}}


class PublisherTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="invented-publisher-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.output = self.root / "output"; self.output.mkdir()
        capture = self.root / "capture.json"; capture.write_bytes(encoded(invented_capture()))
        self.db = self.root / "source.sqlite"
        taken = live.import_capture(capture, self.db, input_sha256=pub.sha(capture.read_bytes()), apply=True)
        initial = self.root / "initial"
        exported = live.export_snapshot(self.db, initial, expected_source_sha256=taken["source_content_sha256"], apply=True)
        self.context = {"request": {"request_id": "30000000-0000-4000-8000-000000000001"}, "source": str(self.db),
                        "tip": {"source_content_sha256": taken["source_content_sha256"], "snapshot_content_sha256": exported["content_sha256"]},
                        "application_receipts": []}
        self.config = {"repo_root": str(self.root), "node": sys.executable, "python": sys.executable,
                       "wrangler": str(self.root / "invented-wrangler.js"), "output_root": str(self.output),
                       "public_config": str(self.root / "public-config.json"), "account_id": "a" * 32,
                       "project": "invented-school", "origin": "https://manabi-map.app", "branch": "main",
                       "revision": "b" * 40, "version": "invented-1"}
        self.control = Control()
        self.project = {"name": "invented-school", "production_branch": "main", "domains": ["manabi-map.app"],
                        "source": {"type": "github", "config": {"production_deployments_enabled": False}},
                        "deployment_configs": {"production": {"env_vars": {"INVENTED_SECRET": {"value": "never-return-this"}}}},
                        "canonical_deployment": {"id": "old-invented"}}
        self.deployment = None
        self.uploads = 0
        self.calls = []
        self.tamper_path = None
        self.before_spawn_change = False
        self.publisher = pub.SchoolLivePublisher(self.config, runner=self.runner, fetch=self.fetch)

    def runner(self, argv, *, cwd, env, control, maximum, before_spawn=None):
        self.calls.append((argv, cwd, env))
        if before_spawn:
            if self.before_spawn_change:
                control.queue["revision"] += 1
            before_spawn()
        if "export" in argv:
            out = Path(argv[argv.index("--output") + 1])
            result = live.export_snapshot(self.db, out, expected_source_sha256=self.context["tip"]["source_content_sha256"], apply="--apply" in argv)
            return encoded(result)
        if "token" in argv:
            return encoded({"type": "oauth", "token": "invented-secret-token"})
        if argv[-1:] == ["--version"]:
            return b"Wrangler 4.31.0\n"
        if any(str(item).endswith("finalize-school-release.mjs") for item in argv):
            args = dict(item[2:].split("=", 1) for item in argv if item.startswith("--") and "=" in item)
            build = Path(args["build-root"])
            receipt = json.loads((build / "observed-build.json").read_bytes())
            functions_inventory = sorted((entry for entry in receipt["sourceFiles"] if entry["path"].startswith("functions/")),
                                         key=lambda entry: entry["path"])
            worker = b"// invented compiled Functions worker\n"
            worker_sha = pub.sha(worker)
            binding_sha = args["bindings-sha256"]
            source_inventory_sha = pub.sha((school.canonical_json(functions_inventory) + "\n").encode())
            metadata_raw = b'{"version":1}\n'
            invocation_sha = "c" * 64
            candidate = {"format": "school-functions-compile-candidate", "version": 1, "status": "success",
                         "compiler": "wrangler-pages", "compilerVersion": "4.31.0", "invocationSha256": invocation_sha,
                         "sourceRevision": self.config["revision"], "sourceInventory": functions_inventory,
                         "sourceInventorySha256": source_inventory_sha, "workerSha256": worker_sha,
                         "buildMetadataSha256": pub.sha(metadata_raw), "bindingsSha256": binding_sha}
            functions_root = build / "functions-candidate"; functions_root.mkdir()
            (build / "dist/_worker.js").write_bytes(worker)
            (functions_root / "wrangler-build-metadata.json").write_bytes(metadata_raw)
            compile_raw = (school.canonical_json(candidate) + "\n").encode()
            (functions_root / "school-functions-compile-receipt.json").write_bytes(compile_raw)
            generation_raw = (build / "generation/observed-generation.json").read_bytes()
            completion = {"format": "school-release-completion", "version": 1, "evidence": "observed",
                          "deploymentPerformed": False, "generation": args["generation"], "generatedAt": "2026-09-28T00:00:00.000Z",
                          "candidateRevision": self.config["revision"],
                          "generationReceiptSha256": pub.sha(generation_raw),
                          "observedBuildSha256": pub.sha((school.canonical_json(receipt) + "\n").encode()),
                          "producerReceiptSha256": "d" * 64, "projectionGateSha256": "e" * 64,
                          "functions": {"compileRecordStatus": "success", "sourceRevision": self.config["revision"],
                              "compileRecordSha256": pub.sha(compile_raw), "compiler": "wrangler-pages", "compilerVersion": "4.31.0",
                              "invocationSha256": invocation_sha, "buildMetadataSha256": pub.sha(metadata_raw),
                              "sourceInventorySha256": source_inventory_sha, "workerSha256": worker_sha,
                              "bindingsSha256": binding_sha}, "packagePin": "f" * 64,
                          "packageMetadataSha256": "a" * 64, "artifacts": []}
            (build / "school-release-completion.json").write_bytes((school.canonical_json(completion) + "\n").encode())
            return b'{"status":"packaged","deploymentPerformed":false}\n'
        if "deploy" in argv:
            self.uploads += 1
            self.assertTrue((Path(cwd) / "functions/_middleware.ts").is_file())
            marker = argv[argv.index("--commit-message") + 1]
            self.deployment = {"id": "invented-deployment-1", "environment": "production", "uses_functions": True,
                               "latest_stage": {"name": "deploy", "status": "success"},
                               "deployment_trigger": {"metadata": {"commit_hash": "b" * 40, "commit_message": marker, "branch": "main"}}}
            self.project["canonical_deployment"] = {"id": self.deployment["id"]}
            return b"never expose child diagnostics"
        args = dict(item[2:].split("=", 1) for item in argv if item.startswith("--") and "=" in item)
        build = Path(args["output-root"])
        dist = build / "dist"; dist.mkdir(parents=True)
        source = build / "source/functions"; source.mkdir(parents=True)
        middleware = b"export const onRequest = async c => c.next();"
        (source / "_middleware.ts").write_bytes(middleware)
        self.files = {"index.html": b"<!doctype html><p>invented school</p>", "404.html": b"<p>invented missing</p>",
                      "schools-manifest.json": b'{"invented":true}', "school-data/invented.json": b'{"name":"invented"}',
                      "assets/invented.js": b"console.log('invented');", "_headers": b"/*\n  X-Frame-Options: DENY\n  Referrer-Policy: strict-origin-when-cross-origin\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n",
                      "_redirects": b"# no active redirects\n", "_routes.json": encoded({"version": 1, "include": ["/*"], "exclude": ["/assets/*"]})}
        artifacts = []
        for path, raw in sorted(self.files.items()):
            target = dist / path; target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(raw)
            artifacts.append({"path": path, "size": len(raw), "sha256": pub.sha(raw)})
        snapshot_raw = Path(args["snapshot"]).read_bytes()
        manifest_raw = Path(args["manifest"]).read_bytes()
        snapshot = json.loads(snapshot_raw); manifest = json.loads(manifest_raw)
        generation = build / "generation"; (generation / "private-source").mkdir(parents=True)
        payload = b'{"invented_public_payload":true}'
        (generation / "private-source/generator-payload.json").write_bytes(payload)
        subset = [e for e in artifacts if e["path"].endswith(".json") and not e["path"].startswith("_")]
        generated = {"format": "observed-school-json", "evidence": "observed", "generatorSnapshotSha256": pub.sha(payload),
                     "source": {"type": "sqlite-snapshot", "snapshotSha256": pub.sha(snapshot_raw), "manifestSha256": pub.sha(manifest_raw),
                                "contentSha256": manifest["content_sha256"], "datasetVersion": snapshot["dataset_version"], "sourceVersion": snapshot["source_version"]},
                     "artifacts": subset, "artifactsSha256": school.content_hash(subset)}
        generated_raw = encoded(generated); (generation / "observed-generation.json").write_bytes(generated_raw)
        built = {"format": "observed-school-build", "evidence": "observed", "origin": self.config["origin"], "deploymentPerformed": False,
                 "candidateRevision": self.config["revision"], "appVersion": self.config["version"], "generationReceiptSha256": pub.sha(generated_raw),
                 "publicArtifacts": artifacts, "publicArtifactsSha256": school.content_hash(artifacts),
                 "sourceFiles": [{"path": "functions/_middleware.ts", "sha256": pub.sha(middleware)}]}
        (build / "observed-build.json").write_bytes(encoded(built))
        return b"{}"

    def fetch(self, url, *, headers, timeout, maximum):
        parsed = urlsplit(url)
        if parsed.hostname == "api.cloudflare.com":
            self.assertEqual(headers["Authorization"], "Bearer invented-secret-token")
            if parsed.path.endswith("/deployments"):
                result = [] if self.deployment is None else [self.deployment]
            elif "/deployments/" in parsed.path:
                result = self.deployment
            else:
                result = self.project
            return {"status": 200, "headers": {}, "body": encoded({"success": True, "result": result})}
        self.assertNotIn("Authorization", headers)
        path = parsed.path
        response_headers = {"x-frame-options": "DENY", "referrer-policy": "strict-origin-when-cross-origin"}
        if path.startswith("/assets/"):
            response_headers["cache-control"] = "public, max-age=31536000, immutable"
        if path.startswith("/__school_owner_missing_"):
            status, raw = 404, self.files["404.html"]
        elif path in ("/", "/auth/callback"):
            status, raw = 200, self.files["index.html"]
        else:
            status, raw = 200, self.files[path.lstrip("/")]
        if path == self.tamper_path:
            raw += b"<!-- injected -->"
        return {"status": status, "headers": response_headers, "body": raw}

    def generated(self):
        self.context["candidate"] = self.publisher.generate(self.context, self.control)
        return self.context["candidate"]

    def deployed(self):
        self.generated()
        self.context["deployment"] = self.publisher.deploy(self.context, self.control)

    def test_full_invented_pipeline_has_all_artifacts_and_usable_next_anchor(self):
        before = self.db.read_bytes()
        self.deployed()
        observation = self.publisher.observe(self.context, self.control)
        self.assertEqual(observation["artifact_count"], len(self.files))
        self.assertEqual(observation["application_receipts_sha256"], "e" * 64)
        root = Path(self.context["candidate"]["evidence_root"])
        anchors = list(root.glob("anchor.json"))
        self.assertEqual(len(anchors), 1)
        anchored = controller.anchor_generation({"path": str(anchors[0]), "sha256": pub.sha(anchors[0].read_bytes())}, self.publisher.maximum)
        self.assertEqual(anchored["source_content_sha256"], self.context["tip"]["source_content_sha256"])
        self.assertEqual(self.db.read_bytes(), before)
        self.assertEqual(self.uploads, 1)
        self.assertGreater(self.control.calls, 20)
        for path in root.rglob("*.json"):
            self.assertNotIn(b"invented-secret-token", path.read_bytes())
            self.assertNotIn(b"never-return-this", path.read_bytes())
        previous_anchor = anchors[0].read_bytes()
        self.publisher.observe(self.context, self.control)
        self.assertEqual(anchors[0].read_bytes(), previous_anchor)

    def test_git_auto_deploy_prevents_upload(self):
        self.generated(); self.project["source"]["config"]["production_deployments_enabled"] = True
        with self.assertRaises(pub.PublishError): self.publisher.deploy(self.context, self.control)
        self.assertEqual(self.uploads, 0)

    def test_expired_preflight_and_revision_changed_at_spawn_prevent_upload(self):
        self.generated(); self.control.expired = True
        with self.assertRaises(pub.PublishError): self.publisher.deploy(self.context, self.control)
        self.assertEqual(self.uploads, 0)
        (Path(self.context["candidate"]["evidence_root"]) / "deploy-intent.json").unlink()
        self.control.expired = False; self.before_spawn_change = True
        with self.assertRaises(pub.PublishError): self.publisher.deploy(self.context, self.control)
        self.assertEqual(self.uploads, 0)

    def test_recovery_never_repeats_upload_or_accepts_missing_marker(self):
        self.deployed()
        self.assertEqual(self.publisher.recover(self.context, self.control), self.context["deployment"])
        self.deployment = None
        with self.assertRaises(pub.PublishError): self.publisher.recover(self.context, self.control)
        self.assertEqual(self.uploads, 1)

    def test_deployment_marker_on_second_20_row_page(self):
        marker = "school-live:invented:" + "a" * 64
        queried = []
        def api(suffix, control):
            queried.append(suffix)
            if suffix.endswith("page=1"):
                return [{"deployment_trigger": {"metadata": {"commit_message": "other"}}} for _ in range(20)]
            if suffix.endswith("page=2"):
                return [{"deployment_trigger": {"metadata": {"commit_message": marker}}}]
            self.fail("unexpected page")
        self.publisher._api = api
        self.assertEqual(self.publisher._find(marker, self.control)["deployment_trigger"]["metadata"]["commit_message"], marker)
        self.assertEqual(queried, ["/deployments?env=production&per_page=20&page=1",
                                    "/deployments?env=production&per_page=20&page=2"])

    def test_changed_html_is_not_normalized_and_no_anchor_is_created(self):
        self.deployed(); self.tamper_path = "/"
        with self.assertRaises(pub.PublishError): self.publisher.observe(self.context, self.control)
        self.assertFalse(Path(self.context["candidate"]["anchor_path"]).exists())

    def test_pre_spawn_refusal_can_recover_without_ambiguous_reupload(self):
        self.generated(); self.control.expired = True
        with self.assertRaises(pub.PublishError): self.publisher.deploy(self.context, self.control)
        self.assertEqual(self.uploads, 0)
        self.control.expired = False
        result = self.publisher.recover(self.context, self.control)
        self.assertEqual(result["deployment_id"], "invented-deployment-1")
        self.assertEqual(self.uploads, 1)

    def test_failed_generation_retry_gets_fresh_owned_directory(self):
        original = self.publisher.runner
        def refuse(argv, **options):
            if any("build-school-observed.mjs" in a for a in argv):
                raise ValueError("invented sensitive child failure")
            return original(argv, **options)
        self.publisher.runner = refuse
        with self.assertRaises(pub.PublishError): self.publisher.generate(self.context, self.control)
        self.publisher.runner = original
        self.generated()
        self.assertEqual(len(list(self.output.iterdir())), 2)

    def bootstrap(self):
        candidate = self.generated()
        root = Path(candidate["evidence_root"])
        # This fixture build stands in for the owner's separately reviewed
        # prebuilt layout. Replace only the synthetic candidate registration.
        (root / "candidate.json").unlink()
        authorization = {"format": "school-live-bootstrap-authorization", "version": 1,
                         "request_id": self.context["request"]["request_id"], "source": str(self.db),
                         "source_file_sha256": pub.sha(self.db.read_bytes()), "source_sha256": candidate["source_sha256"],
                         "snapshot_content_sha256": candidate["snapshot_content_sha256"], "code_sha256": candidate["code_sha256"],
                         "revision": self.config["revision"], "origin": self.config["origin"], "project": self.config["project"],
                         "expected_deployment_id": "old-invented", "build_receipt": candidate["build_receipt"],
                         "export_receipt": candidate["export_receipt"]}
        pin = pub._record(self.root / "bootstrap-authorization.json", authorization)
        self.context["candidate"] = self.publisher.bootstrap_candidate(pin, self.control)
        return pin

    def test_bootstrap_pinned_existing_build_no_queue_and_no_reupload(self):
        self.bootstrap()
        del self.control.queue  # No fabricated RPC, lease, revision or SQL ACK.
        self.context["deployment"] = self.publisher.bootstrap_deploy(self.context, self.control)
        result = self.publisher.bootstrap_observe(self.context, self.control)
        self.assertEqual(result["application_receipts_sha256"], pub.sha(b"[]"))
        self.assertTrue(Path(self.context["candidate"]["anchor_path"]).is_file())
        with self.assertRaises(pub.PublishError): self.publisher.bootstrap_deploy(self.context, self.control)
        self.assertEqual(self.publisher.bootstrap_recover(self.context, self.control), self.context["deployment"])
        self.publisher.bootstrap_observe(self.context, self.control)
        self.assertEqual(self.uploads, 1)

    def test_bootstrap_rejects_source_change_expected_production_and_queue_entry(self):
        self.bootstrap()
        with self.assertRaises(pub.PublishError): self.publisher.deploy(self.context, self.control)
        self.project["canonical_deployment"] = {"id": "third-deployment"}
        with self.assertRaises(pub.PublishError): self.publisher.bootstrap_deploy(self.context, self.control)
        self.project["canonical_deployment"] = {"id": "old-invented"}
        with self.db.open("ab") as output: output.write(b"changed")
        with self.assertRaises(pub.PublishError): self.publisher.bootstrap_deploy(self.context, self.control)
        self.assertEqual(self.uploads, 0)

    def test_source_or_extra_public_file_tamper_prevents_upload(self):
        self.generated(); root = Path(self.context["candidate"]["evidence_root"])
        (root / "build/dist/private-capture.json").write_text("invented-private")
        with self.assertRaises(pub.PublishError): self.publisher.deploy(self.context, self.control)
        (root / "build/dist/private-capture.json").unlink()
        (root / "build/source/functions/_middleware.ts").write_text("modified")
        with self.assertRaises(pub.PublishError): self.publisher.deploy(self.context, self.control)
        self.assertEqual(self.uploads, 0)

    def test_third_deployment_and_missing_functions_fail(self):
        self.deployed(); self.project["canonical_deployment"] = {"id": "unrelated"}
        with self.assertRaises(pub.PublishError): self.publisher.observe(self.context, self.control)
        self.deployment["uses_functions"] = False
        with self.assertRaises(pub.PublishError): self.publisher.recover(self.context, self.control)

    def test_changed_observation_contract_cannot_recover(self):
        self.deployed(); self.publisher.config["http_probes"] = [{"path": "/", "status": 200, "headers": {}}]
        with self.assertRaises(pub.PublishError): self.publisher.recover(self.context, self.control)

    def test_native_process_is_bounded_and_diagnostics_private(self):
        self.assertEqual(pub.run_process([sys.executable, "-B", "-c", "print('invented')"], cwd=self.root,
                                        env=pub.environment({}), control=self.control), b"invented\r\n" if sys.platform == "win32" else b"invented\n")
        self.control.end = time.monotonic() + .3
        with self.assertRaises(pub.PublishError) as caught:
            pub.run_process([sys.executable, "-B", "-c", "import time; print('invented-sensitive'); time.sleep(5)"],
                            cwd=self.root, env=pub.environment({}), control=self.control)
        self.assertNotIn("sensitive", str(caught.exception))

    def test_environment_is_allowlisted(self):
        result = pub.environment({"CLOUDFLARE_API_TOKEN": "invented"}, {"PATH": "bin", "NODE_OPTIONS": "injected", "PGPASSWORD": "hidden"})
        self.assertEqual(set(result), {"PATH", "CLOUDFLARE_API_TOKEN", "WRANGLER_SEND_METRICS"})
        with self.assertRaises(pub.PublishError): pub.environment({"NODE_OPTIONS": "injected"})

    def test_inherited_child_pipes_respect_deadline_and_descendant_is_killed(self):
        marker = self.root / "must-not-appear.txt"
        child = "import time,pathlib;time.sleep(1.5);pathlib.Path(" + repr(str(marker)) + ").write_text('invented')"
        parent = "import subprocess,sys,time;subprocess.Popen([sys.executable,'-B','-c'," + repr(child) + "]);time.sleep(.15)"
        self.control.end = time.monotonic() + .4
        began = time.monotonic()
        with self.assertRaises(pub.PublishError):
            pub.run_process([sys.executable, "-B", "-c", parent], cwd=self.root,
                            env=pub.environment({}), control=self.control)
        self.assertLess(time.monotonic() - began, 2)
        time.sleep(1.6)
        self.assertFalse(marker.exists())

    def test_missing_control_behavior_and_ambient_config_are_rejected(self):
        self.generated()
        root = Path(self.context["candidate"]["evidence_root"])
        ambient = root / "wrangler.json"
        ambient.write_text('{"name":"invented-unrelated-project"}')
        with self.assertRaises(pub.PublishError): self.publisher.deploy(self.context, self.control)
        ambient.unlink()
        self.context["deployment"] = self.publisher.deploy(self.context, self.control)
        original = self.publisher.fetch
        def stripped(url, **options):
            result = original(url, **options)
            result["headers"].pop("x-frame-options", None)
            return result
        self.publisher.fetch = stripped
        with self.assertRaises(pub.PublishError): self.publisher.observe(self.context, self.control)
        self.assertFalse(Path(self.context["candidate"]["anchor_path"]).exists())

    def test_current_origin_callback_inherits_normal_shell_not_legacy_headers(self):
        self.deployed()
        root, built = self.publisher._candidate(self.context["candidate"], self.control)
        probes = self.publisher._control_probes(root, built, self.context["candidate"])
        callback = next(p for p in probes if p["path"] == "/auth/callback")
        self.assertEqual(callback["headers"], {"x-frame-options": "DENY", "referrer-policy": "strict-origin-when-cross-origin"})
        self.publisher.observe(self.context, self.control)
        original = self.publisher.fetch
        def legacy(url, **options):
            response = original(url, **options)
            if urlsplit(url).path == "/auth/callback":
                response["headers"]["referrer-policy"] = "no-referrer"
            return response
        self.publisher.fetch = legacy
        with self.assertRaises(pub.PublishError): self.publisher.observe(self.context, self.control)

    def test_bounded_get_retries_only_transient_transport_reads(self):
        calls = []
        def transient(url, **options):
            calls.append(options['timeout'])
            if len(calls) < 3:
                raise pub.TransportReadError('invented transient')
            return {'status': 200, 'headers': {}, 'body': b'invented'}
        self.publisher.fetch = transient
        result = self.publisher._gets([('https://invented.example/test', {}, 3, 20)], self.control)
        self.assertEqual(result[0]['body'], b'invented')
        self.assertEqual(len(calls), 3)
        self.assertTrue(all(0 < timeout <= 3 for timeout in calls))

    def test_bounded_get_does_not_retry_status_body_cap_or_other_failure(self):
        request = [('https://invented.example/test', {}, 3, 4)]
        for outcome in ('status', 'cap', 'other'):
            calls = []
            def fetch(url, **options):
                calls.append(url)
                if outcome == 'status': return {'status': 503, 'headers': {}, 'body': b'x'}
                if outcome == 'cap': return {'status': 200, 'headers': {}, 'body': b'oversize'}
                raise pub.PublishError('invented nontransport refusal')
            self.publisher.fetch = fetch
            if outcome == 'status':
                self.assertEqual(self.publisher._gets(request, self.control)[0]['status'], 503)
            else:
                with self.assertRaises(pub.PublishError): self.publisher._gets(request, self.control)
            self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
