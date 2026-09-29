"""Explicit owner bridge: export -> observed build -> Wrangler -> HTTP evidence.

Inactive library. No credential-file parser, SQL, source mutation or implicit
deployment. Native processes and HTTPS GETs are injectable for invented tests.
Only the controller may authorize calls. A failed/ambiguous upload is recovered
by its immutable request marker; recover NEVER repeats an upload. HTTP evidence
does not make remote consent and Cloudflare deployment one atomic transaction.
"""

from datetime import datetime, timezone
import copy
import fnmatch
import hashlib
import http.client
import json
import os
from pathlib import Path
import queue
import re
import signal
import ssl
import subprocess
import threading
import time
import uuid
from urllib.parse import quote, urlsplit

import school_live_source as live
import store_school as school

CONTROLS = {"_headers", "_redirects", "_routes.json"}
SCHOOL_ORIGINS = {"https://school.manabi-map.app", "https://manabi-map-school.pages.dev"}
ORIGINS = {"https://manabi-map.app"} | SCHOOL_ORIGINS
OS_ENV = {"path", "systemroot", "windir", "temp", "tmp", "userprofile", "home", "localappdata", "appdata", "comspec", "pathext"}
EXPLICIT_ENV = {"CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "WRANGLER_SEND_METRICS"}
MAX_RECORD = 8 * 1024 * 1024


class PublishError(ValueError):
    """Only fixed, body-free errors cross the owner bridge."""


class TransportReadError(PublishError):
    """An HTTPS read failed before a complete bounded response was available."""


def need(ok, message="school publication rejected; reconcile saved evidence"):
    if not ok:
        raise PublishError(message)


def canonical_deployment_id(project):
    deployment = project.get("canonical_deployment")
    need(deployment is None or type(deployment) is dict)
    if deployment is None:
        return None
    identifier = deployment.get("id")
    need(type(identifier) is str and re.fullmatch(r"[A-Za-z0-9-]{1,200}", identifier))
    return identifier


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def stamp():
    return datetime.now(timezone.utc).isoformat()


def parse_time(value):
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    need(result.tzinfo is not None)
    return result


def environment(explicit, runtime=None):
    need(type(explicit) is dict and set(explicit) <= EXPLICIT_ENV)
    runtime = os.environ if runtime is None else runtime
    result = {key: value for key, value in runtime.items() if key.lower() in OS_ENV}
    need(all(type(value) is str and "\0" not in value for value in explicit.values()))
    return {**result, **explicit, "WRANGLER_SEND_METRICS": "false"}


def _kill(proc):
    if os.name == "nt":
        # Only the explicitly spawned process tree. No process-name/global kill.
        result = subprocess.run([str(Path(os.environ["SystemRoot"]) / "System32/taskkill.exe"),
                                 "/PID", str(proc.pid), "/T", "/F"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=10, creationflags=subprocess.CREATE_NO_WINDOW)
        need(result.returncode == 0 or proc.poll() is not None, "child termination unconfirmed")
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    proc.wait(timeout=10)


class _ProcessJob:
    """Windows descendants die when this explicit process job is closed."""
    def __init__(self, proc):
        self.handle = None
        if os.name != "nt":
            return
        import ctypes
        from ctypes import wintypes as w
        class Basic(ctypes.Structure):
            _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64), ("flags", w.DWORD),
                        ("minimum", ctypes.c_size_t), ("maximum", ctypes.c_size_t), ("active", w.DWORD),
                        ("affinity", ctypes.c_size_t), ("priority", w.DWORD), ("scheduling", w.DWORD)]
        class Counters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in ("read", "write", "other", "read_bytes", "write_bytes", "other_bytes")]
        class Limits(ctypes.Structure):
            _fields_ = [("basic", Basic), ("io", Counters), ("process_memory", ctypes.c_size_t),
                        ("job_memory", ctypes.c_size_t), ("peak_process", ctypes.c_size_t), ("peak_job", ctypes.c_size_t)]
        api = ctypes.WinDLL("kernel32", use_last_error=True)
        api.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]; api.CreateJobObjectW.restype = w.HANDLE
        api.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]; api.SetInformationJobObject.restype = w.BOOL
        api.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]; api.AssignProcessToJobObject.restype = w.BOOL
        api.CloseHandle.argtypes = [w.HANDLE]; api.CloseHandle.restype = w.BOOL
        self.api = api
        self.handle = api.CreateJobObjectW(None, None)
        need(self.handle, "child job creation failed")
        limits = Limits(); limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not api.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)) \
                or not api.AssignProcessToJobObject(self.handle, int(proc._handle)):
            self.close(); raise PublishError("child job assignment failed")

    def close(self):
        if self.handle:
            self.api.CloseHandle(self.handle); self.handle = None


def run_process(argv, *, cwd, env, control, maximum=MAX_RECORD, before_spawn=None):
    """Bounded in-memory output, periodic heartbeat; no child diagnostics escape."""
    proc, readers, job = None, [], None
    data = [bytearray(), bytearray()]
    failed = threading.Event()
    try:
        control.checkpoint()
        if before_spawn is not None:
            before_spawn()
        proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                                start_new_session=os.name != "nt")
        job = _ProcessJob(proc)
        def drain(index, stream):
            try:
                while True:
                    chunk = stream.read(65536)
                    if not chunk:
                        break
                    if len(data[index]) + len(chunk) > maximum:
                        failed.set()
                        break
                    data[index].extend(chunk)
            except Exception:
                failed.set()
            finally:
                stream.close()
        for index, stream in enumerate((proc.stdout, proc.stderr)):
            thread = threading.Thread(target=drain, args=(index, stream), daemon=True)
            thread.start(); readers.append(thread)
        last = time.monotonic()
        while proc.poll() is None or any(t.is_alive() for t in readers):
            need(not failed.is_set(), "child output limit exceeded")
            control.remaining()
            if time.monotonic() - last >= 20:
                control.checkpoint(); last = time.monotonic()
            time.sleep(min(0.1, control.remaining()))
        need(proc.returncode == 0 and not failed.is_set(), "school publication child failed")
        control.checkpoint()
        return bytes(data[0])
    except Exception:
        if job is not None:
            job.close()
        if proc is not None and (proc.poll() is None or any(t.is_alive() for t in readers)):
            _kill(proc)
        raise PublishError("school publication child failed; reconcile before retry") from None
    finally:
        if job is not None:
            job.close()


def https_get(url, *, headers, timeout, maximum):
    """TLS-only GET, no proxy, redirect or automatic content decoding."""
    parsed = urlsplit(url)
    need(parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password and not parsed.fragment)
    connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=timeout,
                                              context=ssl.create_default_context())
    try:
        connection.request("GET", parsed.path + ("?" + parsed.query if parsed.query else ""), headers=headers)
        response = connection.getresponse()
        body = response.read(maximum + 1)
        result = {"status": response.status, "headers": {k.lower(): v for k, v in response.getheaders()}, "body": body}
    except (OSError, http.client.HTTPException):
        raise TransportReadError("school publication HTTPS read failed") from None
    finally:
        connection.close()
    need(len(body) <= maximum, "school publication HTTP body limit exceeded")
    return result


def _read(path, maximum=MAX_RECORD):
    return live._read(path, maximum)


def _repo_site_sha(repo):
    """Read the fixed source-tree site control, not an external school source."""
    path = repo / "web/data/site.json"
    need(path.is_file() and not path.is_symlink() and not path.is_junction()
         and path.resolve().is_relative_to(repo.resolve()) and path.stat().st_size <= MAX_RECORD)
    return sha(path.read_bytes())


def _record(path, value):
    raw = (school.canonical_json(value) + "\n").encode()
    live._write(Path(path), raw, MAX_RECORD)
    return {"path": str(path), "sha256": sha(raw)}


def _same_record(path, value):
    if Path(path).exists():
        raw = _read(path)
        need(json.loads(raw) == value)
        return {"path": str(path), "sha256": sha(raw)}
    return _record(path, value)


def _pinned(reference, maximum=MAX_RECORD):
    need(type(reference) is dict and set(reference) == {"path", "sha256"})
    raw = _read(reference["path"], maximum)
    need(sha(raw) == reference["sha256"])
    return raw


def _path_name(value):
    need(type(value) is str and len(value) <= 2048 and "\\" not in value and not value.startswith("/")
         and all(part and part not in (".", "..") and not part.startswith(".") for part in value.split("/"))
         and not any(ord(char) < 32 or char in ':?*|<>"' for char in value))
    return value


def public_url(path):
    path = "/" + "/".join(quote(part, safe="") for part in _path_name(path).split("/"))
    if path.endswith("/index.html"):
        return path[:-10]
    return path[:-5] if path.endswith(".html") else path


def guarded(method):
    def call(*args, **kwargs):
        try:
            return method(*args, **kwargs)
        except PublishError:
            raise
        except Exception:
            raise PublishError("school publication stopped; reconcile saved evidence") from None
    return call


class SchoolLivePublisher:
    """Explicit config; all roots/binaries are chosen by the trusted local owner.

    config: repo_root,node,python,wrangler,output_root,public_config,account_id,
    project,origin,branch,revision,version. Optional env, max_bytes (256 MiB),
    max_total_bytes (1 GiB), http_probes, artifact_observations. A supplemental
    probe is {path,status,headers}, optionally location/body_sha256. Mandatory
    behavior probes are derived from pinned controls (not owner declarations).
    """
    def __init__(self, config, *, runner=run_process, fetch=https_get):
        self.config = copy.deepcopy(config)
        c = self.config
        required = {"repo_root", "node", "python", "wrangler", "output_root", "public_config", "account_id", "project", "origin", "branch", "revision", "version"}
        need(required <= c.keys() and c.keys() <= required | {"env", "max_bytes", "max_total_bytes", "http_probes", "artifact_observations"})
        need(c.get("origin") in ORIGINS and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", c.get("project", "")))
        need(re.fullmatch(r"[a-f0-9]{32}", c.get("account_id", "")) and re.fullmatch(r"[a-f0-9]{40}", c.get("revision", "")))
        need(type(c.get("branch")) is str and re.fullmatch(r"[A-Za-z0-9._/-]{1,100}", c["branch"]))
        need(type(c.get("version")) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.+_-]{0,99}", c["version"]))
        for key in ("repo_root", "node", "python", "wrangler", "output_root", "public_config"):
            need(Path(c[key]).is_absolute())
        self.root = live._path(c["output_root"], directory=True)
        self.root_identity = live._identity(self.root)
        self.repo = Path(c["repo_root"])
        self.runner, self.fetch = runner, fetch
        self.env = environment({**c.get("env", {}), "CLOUDFLARE_ACCOUNT_ID": c["account_id"]})
        self.maximum = c.get("max_bytes", 256 * 1024 * 1024)
        self.total = c.get("max_total_bytes", 1024 * 1024 * 1024)
        need(type(self.maximum) is int and 0 < self.maximum <= 256 * 1024 * 1024)
        need(type(self.total) is int and 0 < self.total <= 1024 * 1024 * 1024)
        self._token = None

    def _owned(self):
        live._path(self.root, directory=True)
        need(live._identity(self.root) == self.root_identity)

    def _run(self, args, cwd, control, *, credentials=False, maximum=MAX_RECORD, before_spawn=None):
        control.checkpoint()
        env = self.env if credentials else {k: v for k, v in self.env.items() if k.lower() in OS_ENV}
        options = {} if before_spawn is None else {"before_spawn": before_spawn}
        result = self.runner(args, cwd=str(cwd), env=dict(env), control=control, maximum=maximum, **options)
        need(type(result) is bytes and len(result) <= maximum)
        control.remaining()
        return result

    def _gets(self, requests, control):
        """At most eight concurrent read-only requests; heartbeat on caller thread.

        A stuck OS DNS resolution cannot be interrupted by Python. Such daemon
        GETs may finish after refusal, but never mutate a provider or return late
        evidence. No credentials are sent outside the explicit fixed API host.
        """
        results = []
        for start in range(0, len(requests), 8):
            batch = requests[start:start + 8]
            returned = queue.Queue()
            def one(index, request):
                for attempt in range(3):
                    try:
                        # Never start a late retry after the owner deadline.
                        remaining = control.remaining()
                        value = self.fetch(request[0], headers=request[1], timeout=min(request[2], remaining), maximum=request[3])
                        returned.put((index, value, False)); return
                    except (TransportReadError, OSError, http.client.HTTPException):
                        if attempt == 2: break
                        try: delay = min(0.15 * (attempt + 1), control.remaining())
                        except Exception: break
                        time.sleep(delay)
                    except Exception:
                        break
                returned.put((index, None, True))
            for index, request in enumerate(batch):
                threading.Thread(target=one, args=(index, request), daemon=True).start()
            done, last = {}, time.monotonic()
            while len(done) < len(batch):
                control.remaining()
                if time.monotonic() - last >= 20:
                    control.checkpoint(); last = time.monotonic()
                try:
                    index, value, failed = returned.get(timeout=min(0.2, control.remaining()))
                except queue.Empty:
                    continue
                need(not failed and type(value) is dict and type(value.get("body")) is bytes)
                need(len(value["body"]) <= batch[index][3])
                done[index] = value
            results.extend(done[index] for index in range(len(batch)))
            control.checkpoint()
        return results

    def _api(self, suffix, control):
        if self._token is None:
            auth = json.loads(self._run([self.config["node"], self.config["wrangler"], "auth", "token", "--json"],
                                       self.root, control, credentials=True, maximum=65536))
            need(auth.get("type") in ("oauth", "api_token") and type(auth.get("token")) is str and 0 < len(auth["token"]) <= 16384)
            self._token = auth["token"]
        prefix = f'https://api.cloudflare.com/client/v4/accounts/{self.config["account_id"]}/pages/projects/{self.config["project"]}'
        response = self._gets([(prefix + suffix, {"Authorization": "Bearer " + self._token, "Accept-Encoding": "identity"},
                               min(15, control.remaining()), MAX_RECORD)], control)[0]
        need(response["status"] == 200)
        value = json.loads(response["body"])
        need(value.get("success") is True)
        return value["result"]

    def _project(self, control):
        project = self._api("", control)
        need(project.get("name") == self.config["project"] and project.get("production_branch") == self.config["branch"])
        need(urlsplit(self.config["origin"]).hostname in project.get("domains", []))
        source = project.get("source")
        if source is None:
            need(self.config["project"] == "manabi-map-school" and self.config["origin"] in SCHOOL_ORIGINS,
                 "direct upload target must be the dedicated school project")
        else:
            need(type(source) is dict and source.get("type") in ("github", "gitlab")
                 and source.get("config", {}).get("production_deployments_enabled") is False,
                 "automatic production Git deployment must be disabled")
        canonical_deployment_id(project)
        # This digest detects binding/config changes without returning values.
        return project, sha(school.canonical_json(project.get("deployment_configs", {}).get("production")).encode())

    def _empty_school_project(self, project, control):
        need(self.config["project"] == "manabi-map-school" and project.get("source") is None
             and canonical_deployment_id(project) is None, "initial school project is no longer empty")
        for environment_name in ("production", "preview"):
            rows = self._api(f"/deployments?env={environment_name}&per_page=20&page=1", control)
            need(type(rows) is list and not rows, "initial school project has deployment history")

    @guarded
    def generate(self, context, control):
        self._owned()
        request_id = context["request"]["request_id"]
        need(re.fullmatch(r"[0-9a-f-]{36}", request_id))
        # Failed pre-publication attempts remain evidence; retries own a fresh
        # directory and never need to remove or overwrite an incomplete build.
        root = live._path(self.root / (request_id + "-" + uuid.uuid4().hex), existing=False, directory=True)
        root.mkdir()
        bundle, build = root / "bundle", root / "build"
        exported = json.loads(self._run([self.config["python"], "-B", str(self.repo / "scripts/local-data/school_live_source.py"),
            "export", "--db", context["source"], "--output", str(bundle), "--expected-source-sha256", context["tip"]["source_content_sha256"],
            "--max-bytes", str(self.maximum), "--timeout-seconds", str(min(300, control.remaining())), "--apply"], self.repo, control))
        need(exported.get("format") == "school-live-export-receipt" and exported.get("mode") == "applied"
             and exported.get("source_content_sha256") == context["tip"]["source_content_sha256"]
             and exported.get("content_sha256") == context["tip"]["snapshot_content_sha256"])
        exported_pin = _record(root / "export.json", exported)
        generated_at = stamp()
        self._run([self.config["node"], "--max-old-space-size=4096", str(self.repo / "web/scripts/build-school-observed.mjs"),
            f'--snapshot={bundle / "snapshot.json"}', f'--manifest={bundle / "manifest.json"}', f'--output-root={build}',
            f'--public-config={self.config["public_config"]}', f'--generation-time={generated_at}', f'--candidate-revision={self.config["revision"]}',
            f'--version={self.config["version"]}', f'--max-decoded-bytes={self.maximum}', f'--max-total-bytes={self.total}',
            '--node-heap-mib=4096', f'--timeout-seconds={min(3600, int(control.remaining()))}',
            *([f'--site-origin={self.config["origin"]}'] if self.config["origin"] in SCHOOL_ORIGINS else [])],
            self.repo / "web", control)
        return self._assemble(root, exported_pin, control)

    def _assemble(self, root, exported_pin, control, authorization=None):
        build = root / "build"
        exported = json.loads(_pinned(exported_pin))
        raw = _read(build / "observed-build.json")
        built = json.loads(raw)
        generation_raw = _read(build / "generation/observed-generation.json")
        generated = json.loads(generation_raw)
        need(built.get("format") == "observed-school-build" and built.get("evidence") == "observed"
             and built.get("origin") == self.config["origin"] and built.get("deploymentPerformed") is False
             and built.get("candidateRevision") == self.config["revision"] and built.get("appVersion") == self.config["version"]
             and built.get("generationReceiptSha256") == sha(generation_raw))
        need(generated.get("source", {}).get("snapshotSha256") == exported["snapshot_sha256"]
             and generated["source"].get("contentSha256") == exported["content_sha256"])
        # The inactive observed build does not include its Pages Functions
        # worker. Compile it from the pinned source tree, then bind the result
        # to the remote production configuration without exposing its values.
        _, bindings = self._project(control)
        completion_path = build / "school-release-completion.json"
        if not completion_path.exists():
            # The site origin was overlaid only in the observed source tree.
            # Validate its pinned bytes before executing the isolated finalizer.
            for entry in built["sourceFiles"]:
                need(sha(_read(build / "source" / _path_name(entry["path"]), 25 * 1024 * 1024)) == entry["sha256"])
                control.checkpoint()
            isolated_web = build / "source/web"
            wrangler_version_output = self._run([self.config["node"], self.config["wrangler"], "--version"],
                                                root / "build/source", control, maximum=65536)
            version_match = re.search(rb"(?<![0-9])([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)(?![0-9])",
                                      wrangler_version_output)
            need(version_match is not None)
            wrangler_version = version_match.group(1).decode("ascii")
            self._run([self.config["node"], str(isolated_web / "scripts/finalize-school-release.mjs"),
                f'--build-root={build}', f'--wrangler-path={self.config["wrangler"]}',
                f'--wrangler-version={wrangler_version}', f'--bindings-sha256={bindings}',
                f'--generation={sha(generation_raw)}'], isolated_web, control, maximum=65536)
        completion_raw = _read(completion_path)
        json.loads(completion_raw)
        completion_pin = {"path": str(completion_path), "sha256": sha(completion_raw)}
        worker_raw = _read(build / "dist/_worker.js", 25 * 1024 * 1024)
        artifacts = built["publicArtifacts"]
        need(0 < len(artifacts) <= 20000 and school.content_hash(artifacts) == built["publicArtifactsSha256"])
        manifest = next(entry for entry in artifacts if entry["path"] == "schools-manifest.json")
        candidate = {"source_sha256": exported["source_content_sha256"], "snapshot_content_sha256": exported["content_sha256"],
            "manifest_sha256": manifest["sha256"], "code_sha256": school.content_hash(built["sourceFiles"]),
            "generator_snapshot_sha256": generated["generatorSnapshotSha256"], "artifacts_sha256": built["publicArtifactsSha256"],
            "artifact_count": len(artifacts), "evidence_root": str(root), "build_receipt": {"path": str(build / "observed-build.json"), "sha256": sha(raw)},
            "generation_receipt": {"path": str(build / "generation/observed-generation.json"), "sha256": sha(generation_raw)}, "export_receipt": exported_pin,
            "functions_completion": completion_pin, "worker_sha256": sha(worker_raw), "bindings_sha256": bindings,
            "anchor_path": str(root / "anchor.json"),
            "observation_contract_sha256": school.content_hash({k: self.config.get(k, {} if k == "artifact_observations" else []) for k in ("http_probes", "artifact_observations")})}
        if authorization is not None:
            candidate["bootstrap_authorization"] = authorization
        self._candidate(candidate, control)
        _same_record(root / "candidate.json", candidate)
        return candidate

    def _candidate(self, candidate, control):
        self._owned()
        root = live._path(candidate["evidence_root"], directory=True)
        need(root.parent == self.root)
        need(candidate["anchor_path"] == str(root / "anchor.json"))
        need(candidate["observation_contract_sha256"] == school.content_hash({k: self.config.get(k, {} if k == "artifact_observations" else []) for k in ("http_probes", "artifact_observations")}))
        built = json.loads(_pinned(candidate["build_receipt"]))
        generated = json.loads(_pinned(candidate["generation_receipt"]))
        exported = json.loads(_pinned(candidate["export_receipt"]))
        completion_raw = _pinned(candidate["functions_completion"])
        completion = json.loads(completion_raw)
        need(Path(candidate["build_receipt"]["path"]) == root / "build/observed-build.json"
             and Path(candidate["generation_receipt"]["path"]) == root / "build/generation/observed-generation.json"
             and Path(candidate["export_receipt"]["path"]) == root / "export.json")
        need(built.get("origin") == self.config["origin"] and built.get("candidateRevision") == self.config["revision"]
             and built.get("appVersion") == self.config["version"]
             and built.get("generationReceiptSha256") == candidate["generation_receipt"]["sha256"])
        overlay = built.get("siteOriginOverlay")
        if self.config["origin"] in SCHOOL_ORIGINS:
            site_entry = next((entry for entry in built["sourceFiles"] if entry["path"] == "web/data/site.json"), None)
            need(type(overlay) is dict and set(overlay) == {"path", "originalSha256", "effectiveSha256", "origin"}
                 and overlay["path"] == "web/data/site.json" and overlay["origin"] == self.config["origin"]
                 and site_entry is not None and site_entry["sha256"] == overlay["effectiveSha256"]
                 and _repo_site_sha(self.repo) == overlay["originalSha256"]
                 and json.loads(_read(root / "build/source/web/data/site.json")) == {"origin": self.config["origin"]})
        else:
            need(overlay is None)
        need(exported.get("source_content_sha256") == candidate["source_sha256"]
             and exported.get("content_sha256") == candidate["snapshot_content_sha256"]
             and generated.get("source", {}).get("snapshotSha256") == exported.get("snapshot_sha256")
             and generated["source"].get("contentSha256") == candidate["snapshot_content_sha256"]
             and generated.get("generatorSnapshotSha256") == candidate["generator_snapshot_sha256"])
        need(sha(_read(root / "bundle/snapshot.json", self.maximum)) == exported["snapshot_sha256"]
             and sha(_read(root / "bundle/manifest.json")) == generated["source"]["manifestSha256"]
             and sha(_read(root / "build/generation/private-source/generator-payload.json", self.maximum)) == candidate["generator_snapshot_sha256"])
        need(candidate["artifact_count"] == len(built["publicArtifacts"]) and candidate["artifacts_sha256"] == school.content_hash(built["publicArtifacts"])
             and candidate["code_sha256"] == school.content_hash(built["sourceFiles"]))
        functions = completion.get("functions", {})
        compile_path = root / "build/functions-candidate/school-functions-compile-receipt.json"
        compile_raw = _read(compile_path)
        compile_record = json.loads(compile_raw)
        source_inventory = sorted((entry for entry in built["sourceFiles"] if entry["path"].startswith("functions/")),
                                  key=lambda entry: entry["path"])
        compiled_inventory = compile_record.get("sourceInventory")
        need(type(compiled_inventory) is list and len(compiled_inventory) == len(source_inventory)
             and all(type(entry) is dict and set(entry) == {"path", "size", "sha256"}
                     and type(entry["size"]) is int and entry["size"] > 0 for entry in compiled_inventory)
             and [{"path": entry["path"], "sha256": entry["sha256"]} for entry in compiled_inventory] == source_inventory
             and compile_record.get("sourceInventorySha256") == sha((school.canonical_json(compiled_inventory) + "\n").encode()))
        for entry in compiled_inventory:
            need(len(_read(root / "build/source" / _path_name(entry["path"]), 25 * 1024 * 1024)) == entry["size"])
        need(completion_raw == (school.canonical_json(completion) + "\n").encode()
             and completion.get("format") == "school-release-completion" and completion.get("version") == 1
             and completion.get("evidence") == "observed" and completion.get("deploymentPerformed") is False
             and completion.get("candidateRevision") == self.config["revision"]
             and completion.get("generationReceiptSha256") == candidate["generation_receipt"]["sha256"]
             and completion.get("observedBuildSha256") == sha((school.canonical_json(built) + "\n").encode())
             and functions.get("compileRecordStatus") == "success"
             and functions.get("sourceRevision") == self.config["revision"]
             and functions.get("compileRecordSha256") == sha(compile_raw)
             and functions.get("bindingsSha256") == candidate["bindings_sha256"]
             and candidate["bindings_sha256"] == candidate["bindings_sha256"].lower()
             and re.fullmatch(r"[a-f0-9]{64}", candidate["bindings_sha256"])
             and functions.get("workerSha256") == candidate["worker_sha256"]
             and functions.get("workerSha256") == sha(_read(root / "build/dist/_worker.js", 25 * 1024 * 1024))
             and functions.get("compiler") == "wrangler-pages"
             and re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?", functions.get("compilerVersion", ""))
             and functions.get("invocationSha256") == compile_record.get("invocationSha256")
             and functions.get("buildMetadataSha256") == compile_record.get("buildMetadataSha256")
             and functions.get("sourceInventorySha256") == compile_record.get("sourceInventorySha256")
             and compile_record.get("format") == "school-functions-compile-candidate"
             and compile_record.get("status") == "success" and compile_record.get("sourceRevision") == self.config["revision"]
             and compile_record.get("workerSha256") == candidate["worker_sha256"]
             and compile_record.get("bindingsSha256") == candidate["bindings_sha256"]
             and re.fullmatch(r"[a-f0-9]{64}", completion.get("packageMetadataSha256", ""))
             and re.fullmatch(r"[a-f0-9]{64}", completion.get("packagePin", "")))
        dist = root / "build/dist"
        seen, total = set(), 0
        for entry in built["publicArtifacts"]:
            path = _path_name(entry["path"])
            need(path not in seen and type(entry["size"]) is int and 0 < entry["size"] <= 25 * 1024 * 1024)
            seen.add(path); total += entry["size"]
            raw = _read(dist / path, 25 * 1024 * 1024)
            need(total <= self.total and len(raw) == entry["size"] and sha(raw) == entry["sha256"])
            control.checkpoint()
        actual = set()
        for directory, dirs, files in os.walk(dist, followlinks=False):
            for name in dirs:
                live._path(Path(directory) / name, directory=True)
            actual.update((Path(directory) / name).relative_to(dist).as_posix() for name in files)
        need(actual == seen | {"_worker.js"})
        need(next(e["sha256"] for e in built["publicArtifacts"] if e["path"] == "schools-manifest.json") == candidate["manifest_sha256"])
        for entry in built["sourceFiles"]:
            need(sha(_read(root / "build/source" / _path_name(entry["path"]), 25 * 1024 * 1024)) == entry["sha256"])
            control.checkpoint()
        need((root / "build/source/functions/_middleware.ts").is_file())
        cwd = root / "build/source"
        # Wrangler searches ancestors for project configuration. This path must
        # use the explicitly read remote project, not another local project.
        for ancestor in (cwd, *cwd.parents):
            need(not any((ancestor / name).exists() for name in ("wrangler.toml", "wrangler.json", "wrangler.jsonc")),
                 "ambient Wrangler project configuration rejected")
        need(not any(p.name in (".dev.vars", ".env") or p.name.startswith((".env.", ".dev.vars.")) for p in cwd.iterdir()),
             "ambient process environment file rejected")
        self._control_probes(root, built, candidate)
        return root, built

    def _find(self, marker, control):
        matched = []
        # Cloudflare Pages empirically rejects per_page=50/100 with 8000024;
        # 20 is accepted. Preserve the same bounded 1,000-row search window.
        for page in range(1, 51):
            rows = self._api(f"/deployments?env=production&per_page=20&page={page}", control)
            need(type(rows) is list)
            matched.extend(row for row in rows if row.get("deployment_trigger", {}).get("metadata", {}).get("commit_message") == marker)
            if len(rows) < 20:
                break
        need(len(matched) == 1, "deployment marker missing or ambiguous; do not redeploy")
        return matched[0]

    def _bootstrap_authorization(self, reference, control):
        """Owner-created, explicit first-publication authorization; never SQL."""
        value = json.loads(_pinned(reference))
        keys = {"format", "version", "request_id", "source", "source_file_sha256", "source_sha256", "snapshot_content_sha256",
                "code_sha256", "revision", "origin", "project", "expected_deployment_id", "build_receipt", "export_receipt"}
        need(set(value) == keys and value["format"] == "school-live-bootstrap-authorization" and value["version"] == 1)
        expected = value["expected_deployment_id"]
        need(re.fullmatch(r"[0-9a-f-]{36}", value["request_id"])
             and (expected is None or (type(expected) is str and re.fullmatch(r"[A-Za-z0-9-]{1,200}", expected))))
        if expected is None:
            need(value["project"] == "manabi-map-school", "empty baseline is restricted to the dedicated school project")
        need(all(value[key] == self.config[key] for key in ("revision", "origin", "project")))
        need(all(re.fullmatch(r"[a-f0-9]{64}", value[k]) for k in ("source_file_sha256", "source_sha256", "snapshot_content_sha256", "code_sha256")))
        need(not any(os.path.lexists(value["source"] + suffix) for suffix in ("-wal", "-shm", "-journal")),
             "bootstrap requires a closed checkpointed SQLite source")
        need(sha(_read(value["source"], self.maximum)) == value["source_file_sha256"])
        control.checkpoint()
        control.remaining()
        return value

    @guarded
    def bootstrap_candidate(self, authorization, control):
        """Adopt an already completed observed build, no rebuild or SQL bypass.

        Required layout: output_root/<owned-name>/build/{observed-build.json,
        generation/,source/,dist/}, sibling bundle/{snapshot.json,manifest.json}.
        Authorization pins the existing build and applied export receipt, raw
        SQLite bytes, semantic full-25/13 hashes, code hash and current canonical
        deployment. Caller creates/pins the authorization after explicit approval.
        """
        self._owned()
        value = self._bootstrap_authorization(authorization, control)
        raw = _pinned(value["build_receipt"])
        root = Path(value["build_receipt"]["path"]).parent.parent
        need(root.parent == self.root and Path(value["build_receipt"]["path"]) == root / "build/observed-build.json")
        built = json.loads(raw)
        exported = json.loads(_pinned(value["export_receipt"]))
        snapshot_raw, manifest_raw = _read(root / "bundle/snapshot.json", self.maximum), _read(root / "bundle/manifest.json")
        _, manifest = live._verify_bytes(snapshot_raw, manifest_raw)
        need(exported.get("format") == "school-live-export-receipt" and exported.get("mode") == "applied"
             and exported.get("source_content_sha256") == value["source_sha256"]
             and exported.get("content_sha256") == value["snapshot_content_sha256"] == manifest["content_sha256"]
             and exported.get("snapshot_sha256") == sha(snapshot_raw)
             and school.content_hash(built["sourceFiles"]) == value["code_sha256"])
        # Read-only semantic verification ties the pinned main database bytes
        # to both the full source and public projection, without a second build.
        checked = json.loads(self._run([self.config["python"], "-B", str(self.repo / "scripts/local-data/school_live_source.py"),
            "export", "--db", value["source"], "--output", str(root / ("verify-unused-" + uuid.uuid4().hex)),
            "--expected-source-sha256", value["source_sha256"], "--max-bytes", str(self.maximum),
            "--timeout-seconds", str(min(300, control.remaining()))], self.repo, control))
        need(checked.get("mode") == "dry-run" and checked.get("source_content_sha256") == value["source_sha256"]
             and checked.get("content_sha256") == value["snapshot_content_sha256"])
        self._bootstrap_authorization(authorization, control)
        exported_pin = _same_record(root / "export.json", exported)
        return self._assemble(root, exported_pin, control, copy.deepcopy(authorization))

    def _bootstrap_context(self, context, control):
        candidate = context["candidate"]
        value = self._bootstrap_authorization(candidate["bootstrap_authorization"], control)
        root, built = self._candidate(candidate, control)
        need(candidate["build_receipt"] == value["build_receipt"]
             and candidate["source_sha256"] == value["source_sha256"]
             and candidate["snapshot_content_sha256"] == value["snapshot_content_sha256"]
             and candidate["code_sha256"] == value["code_sha256"])
        return root, value, built

    @guarded
    def bootstrap_deploy(self, context, control):
        """Initial publication only; no queue, RPC or fabricated lease."""
        root, authorization, _ = self._bootstrap_context(context, control)
        need(not (root / "bootstrap-receipt.json").exists() and not (root / "upload-started.json").exists(),
             "bootstrap upload already started; recover and observe only")
        checked = time.monotonic()
        project, bindings = self._project(control)
        need(bindings == context["candidate"]["bindings_sha256"], "production bindings changed after Functions compilation")
        expected = authorization["expected_deployment_id"]
        need(canonical_deployment_id(project) == expected, "bootstrap production deployment changed")
        if expected is None:
            self._empty_school_project(project, control)
        marker = "school-bootstrap:" + authorization["request_id"] + ":" + context["candidate"]["artifacts_sha256"]
        intent = {"marker": marker, "candidate_sha256": school.content_hash(context["candidate"]), "bindings_sha256": bindings,
                  "previous_deployment_id": authorization["expected_deployment_id"], "created_at": stamp()}
        if (root / "bootstrap-intent.json").exists():
            previous = json.loads(_read(root / "bootstrap-intent.json"))
            need(all(previous[k] == intent[k] for k in intent if k != "created_at")); intent = previous
        else:
            _record(root / "bootstrap-intent.json", intent)
        def starting():
            need(time.monotonic() - checked < 30, "bootstrap project check expired before spawn")
            current, current_bindings = self._project(control)
            need(current_bindings == bindings and canonical_deployment_id(current) == expected,
                 "bootstrap project changed before spawn")
            if expected is None:
                self._empty_school_project(current, control)
            need(time.monotonic() - checked < 30, "bootstrap project check expired before spawn")
            _record(root / "upload-started.json", {"candidate_sha256": school.content_hash(context["candidate"]), "started_at": stamp(), "mode": "bootstrap"})
        self._run([self.config["node"], self.config["wrangler"], "pages", "deploy", str(root / "build/dist"),
                   "--project-name", self.config["project"], "--branch", self.config["branch"], "--commit-hash", self.config["revision"],
                   "--commit-message", marker, "--commit-dirty=true"], root / "build/source", control, credentials=True, before_spawn=starting)
        deployment = self._settled(intent, control)
        _record(root / "bootstrap-receipt.json", {"format": "school-live-bootstrap-receipt", "version": 1,
                 "authorization": context["candidate"]["bootstrap_authorization"], "candidate_sha256": school.content_hash(context["candidate"]), "deployment": deployment})
        return deployment

    @guarded
    def bootstrap_recover(self, context, control):
        root, authorization, _ = self._bootstrap_context(context, control)
        if not (root / "upload-started.json").exists():
            return self.bootstrap_deploy(context, control)
        intent = json.loads(_read(root / "bootstrap-intent.json"))
        need(intent["marker"] == "school-bootstrap:" + authorization["request_id"] + ":" + context["candidate"]["artifacts_sha256"]
             and intent["candidate_sha256"] == school.content_hash(context["candidate"])
             and intent["previous_deployment_id"] == authorization["expected_deployment_id"])
        deployment = self._settled(intent, control)
        _same_record(root / "bootstrap-receipt.json", {"format": "school-live-bootstrap-receipt", "version": 1,
                     "authorization": context["candidate"]["bootstrap_authorization"], "candidate_sha256": school.content_hash(context["candidate"]), "deployment": deployment})
        return deployment

    @guarded
    def bootstrap_observe(self, context, control):
        root, _, _ = self._bootstrap_context(context, control)
        receipt = json.loads(_read(root / "bootstrap-receipt.json"))
        need(receipt["candidate_sha256"] == school.content_hash(context["candidate"]) and receipt["deployment"] == context["deployment"])
        # Explicitly empty initial application set, no fabricated queue receipt.
        return self._observe(context, control, sha(b"[]"))

    def _control_probes(self, root, built, candidate):
        """Representative HTTP behavior plus every pinned control byte.

        Support current repository controls only. Unknown redirects/routes fail
        closed instead of silently declaring a locally hashed file operational.
        """
        inventory = {e["path"]: e for e in built["publicArtifacts"]}
        need(CONTROLS <= inventory.keys() and {"index.html", "404.html"} <= inventory.keys())
        probes = []
        blocks, current = [], None
        for line in _read(root / "build/dist/_headers").decode().splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            if not line[0].isspace():
                need(line.startswith("/") and ":" not in line and "?" not in line)
                current = {"pattern": line.strip(), "headers": {}}; blocks.append(current)
            else:
                need(current is not None and ":" in line)
                name, value = line.strip().split(":", 1)
                need(re.fullmatch(r"[A-Za-z0-9-]+", name) and value.strip())
                need(name.lower() not in current["headers"])
                current["headers"][name.lower()] = value.strip()
        need(blocks and all(block["headers"] for block in blocks))
        for block in blocks:
            matches = [e for e in built["publicArtifacts"] if e["path"] not in CONTROLS
                       and e["path"] != "404.html" and fnmatch.fnmatchcase(public_url(e["path"]), block["pattern"])]
            need(matches, "control header rule has no verifiable artifact")
            entry = matches[0]; path = public_url(entry["path"])
            merged = {}
            for rule in blocks:
                if fnmatch.fnmatchcase(path, rule["pattern"]):
                    merged.update(rule["headers"])
            probes.append({"path": path, "status": 200, "body_sha256": entry["sha256"], "headers": merged})
        redirects = [line.strip() for line in _read(root / "build/dist/_redirects").decode().splitlines()
                     if line.strip() and not line.lstrip().startswith("#")]
        for line in redirects:
            parts = line.split()
            need(len(parts) == 3 and parts[2] in ("301", "302", "307", "308")
                 and parts[0].startswith("/") and not any(c in parts[0] for c in "*:"), "unsupported redirect contract")
            probes.append({"path": parts[0], "status": int(parts[2]), "location": parts[1], "headers": {}})
        # Empty redirects must still preserve the true not-found behavior.
        probes.append({"path": "/__school_owner_missing_" + candidate["artifacts_sha256"], "status": 404,
                       "body_sha256": inventory["404.html"]["sha256"], "headers": {}})
        routes = json.loads(_read(root / "build/dist/_routes.json"))
        need(set(routes) == {"version", "include", "exclude"} and routes["version"] == 1 and routes["include"] == ["/*"]
             and type(routes["exclude"]) is list and all(type(v) is str and v.startswith("/") for v in routes["exclude"]))
        need(not any(fnmatch.fnmatchcase("/auth/callback", v) for v in routes["exclude"]))
        # Current-origin middleware fetches the ordinary '/' static shell and
        # preserves its headers. The no-store/no-referrer/noindex override belongs
        # solely to the separate LEGACY_SCHOOL_SHELL path, not this publication.
        shell_headers = {}
        for rule in blocks:
            if fnmatch.fnmatchcase("/", rule["pattern"]):
                shell_headers.update(rule["headers"])
        probes.append({"path": "/auth/callback", "status": 200, "body_sha256": inventory["index.html"]["sha256"],
                       "headers": shell_headers})
        excluded = [e for e in built["publicArtifacts"] if e["path"] not in CONTROLS
                    and any(fnmatch.fnmatchcase(public_url(e["path"]), v) for v in routes["exclude"])]
        need(excluded, "excluded static route requires HTTP evidence")
        probes.append({"path": public_url(excluded[0]["path"]), "status": 200,
                       "body_sha256": excluded[0]["sha256"], "headers": {}})
        return probes

    def _settled(self, intent, control):
        row = self._find(intent["marker"], control)
        identifier = row["id"]
        need(type(identifier) is str and re.fullmatch(r"[a-zA-Z0-9-]{1,200}", identifier))
        while True:
            current = self._api("/deployments/" + identifier, control)
            need(current.get("deployment_trigger", {}).get("metadata", {}).get("commit_hash") == self.config["revision"]
                 and current.get("deployment_trigger", {}).get("metadata", {}).get("commit_message") == intent["marker"]
                 and current.get("deployment_trigger", {}).get("metadata", {}).get("branch") == self.config["branch"]
                 and current.get("environment") == "production" and current.get("uses_functions") is True)
            stage = current.get("latest_stage", {})
            need(stage.get("status") not in ("failure", "canceled"), "deployment did not succeed")
            if stage.get("name") == "deploy" and stage.get("status") == "success":
                break
            time.sleep(min(0.5, control.remaining())); control.checkpoint()
        project, bindings = self._project(control)
        need(canonical_deployment_id(project) == identifier and bindings == intent["bindings_sha256"], "production changed during publication")
        return {"destination": self.config["origin"], "deployment_id": identifier}

    @guarded
    def deploy(self, context, control):
        need("bootstrap_authorization" not in context["candidate"])
        root, _ = self._candidate(context["candidate"], control)
        need(not (root / "upload-started.json").exists(), "upload already started; recover only")
        project, bindings = self._project(control)
        need(bindings == context["candidate"]["bindings_sha256"], "production bindings changed after Functions compilation")
        previous_id = canonical_deployment_id(project)
        need(previous_id is not None, "normal publication requires a verified baseline")
        marker = "school-live:" + context["request"]["request_id"] + ":" + context["candidate"]["artifacts_sha256"]
        intent = {"marker": marker, "candidate_sha256": school.content_hash(context["candidate"]), "bindings_sha256": bindings,
                  "previous_deployment_id": previous_id, "created_at": stamp()}
        if (root / "deploy-intent.json").exists():
            previous = json.loads(_read(root / "deploy-intent.json"))
            need(all(previous[k] == intent[k] for k in ("marker", "candidate_sha256", "bindings_sha256", "previous_deployment_id")))
            intent = previous
        else:
            _record(root / "deploy-intent.json", intent)
        control.checkpoint()
        candidate = context["candidate"]
        preflight = control.rpc("school_publication_preflight", {
            "p_request_id": context["request"]["request_id"], "p_lease_token": control.queue["lease_token"],
            "p_expected_revision": control.queue["revision"], "p_source_sha256": candidate["source_sha256"],
            "p_snapshot_content_sha256": candidate["snapshot_content_sha256"], "p_manifest_sha256": candidate["manifest_sha256"],
            "p_code_sha256": candidate["code_sha256"], "p_application_receipts": context["application_receipts"]})
        need(preflight.get("advisory_only") is True and preflight.get("request_id") == context["request"]["request_id"])
        need(all(preflight.get(key) == candidate[key] for key in ("source_sha256", "snapshot_content_sha256", "manifest_sha256", "code_sha256"))
             and preflight.get("revision") == control.queue["revision"])
        def fresh():
            now = datetime.now(timezone.utc)
            need(preflight["revision"] == control.queue["revision"] and parse_time(preflight["valid_until"]) > now
                 and 0 <= (now - parse_time(preflight["checked_at"])).total_seconds() < 30,
                 "publication preflight expired before spawn")
        fresh()
        def starting():
            fresh()
            _record(root / "upload-started.json", {"candidate_sha256": school.content_hash(candidate), "started_at": stamp()})
        self._run([self.config["node"], self.config["wrangler"], "pages", "deploy", str(root / "build/dist"),
            "--project-name", self.config["project"], "--branch", self.config["branch"], "--commit-hash", self.config["revision"],
            "--commit-message", marker, "--commit-dirty=true"], root / "build/source", control, credentials=True, before_spawn=starting)
        result = self._settled(intent, control)
        _record(root / "deployment.json", result)
        return result

    @guarded
    def recover(self, context, control):
        need("bootstrap_authorization" not in context["candidate"])
        root, _ = self._candidate(context["candidate"], control)
        if not (root / "upload-started.json").exists():
            # The exclusive marker is written immediately before Popen. Its
            # absence proves this bridge did not begin a mutating child.
            return self.deploy(context, control)
        intent = json.loads(_read(root / "deploy-intent.json"))
        need(set(intent) == {"marker", "candidate_sha256", "bindings_sha256", "previous_deployment_id", "created_at"}
             and intent["marker"] == "school-live:" + context["request"]["request_id"] + ":" + context["candidate"]["artifacts_sha256"]
             and intent["candidate_sha256"] == school.content_hash(context["candidate"]))
        return self._settled(intent, control)

    @guarded
    def observe(self, context, control):
        need("bootstrap_authorization" not in context["candidate"])
        return self._observe(context, control, control.queue["application_receipts_sha256"])

    def _observe(self, context, control, application_hash):
        root, built = self._candidate(context["candidate"], control)
        deployment, candidate = context["deployment"], context["candidate"]
        project, _ = self._project(control)
        need(deployment["destination"] == self.config["origin"] and canonical_deployment_id(project) == deployment["deployment_id"])
        probes = self._control_probes(root, built, candidate) + copy.deepcopy(self.config.get("http_probes", []))
        present_controls = {entry["path"] for entry in built["publicArtifacts"] if entry["path"] in CONTROLS}
        expected = []
        overrides = self.config.get("artifact_observations", {})
        need(type(overrides) is dict and set(overrides) <= {entry["path"] for entry in built["publicArtifacts"]} - CONTROLS)
        for entry in built["publicArtifacts"]:
            if entry["path"] in CONTROLS:
                continue
            path = public_url(entry["path"])
            if entry["path"] == "404.html":
                path = "/__school_owner_missing_" + candidate["artifacts_sha256"]
            observation = {"path": path, "status": 404 if entry["path"] == "404.html" else 200,
                           "body_sha256": entry["sha256"], "headers": {}}
            if entry["path"] in overrides:
                need(not entry["path"].endswith((".json", ".gz")), "school data cannot redirect")
                observation = copy.deepcopy(overrides[entry["path"]])
                need(observation.get("path") == path and observation.get("status") in (301, 302, 307, 308, 410))
                if observation["status"] == 410:
                    need(observation.get("body_sha256") == entry["sha256"])
                else:
                    need(type(observation.get("location")) is str)
            expected.append(observation)
        expected.extend(probes)
        requests = []
        for item in expected:
            need(type(item) is dict and set(item) <= {"path", "status", "body_sha256", "headers", "location"})
            parsed = urlsplit(item["path"])
            need(item["path"].startswith("/") and not item["path"].startswith("//") and not parsed.scheme and not parsed.netloc and not parsed.fragment)
            need(item["status"] in (200, 301, 302, 307, 308, 404, 410) and type(item.get("headers")) is dict)
            requests.append((self.config["origin"] + item["path"], {"Accept-Encoding": "identity", "Cache-Control": "no-cache", "User-Agent": "school-owner-observer/1"}, min(15, control.remaining()), 25 * 1024 * 1024))
        for start in range(0, len(requests), 8):
            responses = self._gets(requests[start:start + 8], control)
            for item, response in zip(expected[start:start + 8], responses):
                need(response["status"] == item["status"])
                need(response["headers"].get("content-encoding", "identity") == "identity")
                if "body_sha256" in item:
                    need(sha(response["body"]) == item["body_sha256"], "published bytes differ; no normalization allowed")
                if "location" in item:
                    need(response["headers"].get("location") == item["location"])
                need(all(response["headers"].get(name.lower()) == value for name, value in item["headers"].items()))
        project, _ = self._project(control)
        need(canonical_deployment_id(project) == deployment["deployment_id"], "production changed during observation")
        observation = {**deployment, "observed_at": stamp(), "manifest_sha256": candidate["manifest_sha256"],
            "artifacts_sha256": candidate["artifacts_sha256"], "artifact_count": candidate["artifact_count"],
            "application_receipts_sha256": application_hash}
        _record(root / ("observation-" + school.content_hash(observation) + ".json"), observation)
        generated = json.loads(_pinned(candidate["generation_receipt"]))
        anchor_observation = {**observation, "format": "school-http-observation", "evidence": "observed", "http_verified": True,
            "generator_snapshot_sha256": candidate["generator_snapshot_sha256"], "artifacts_sha256": generated["artifactsSha256"],
            "artifact_count": len(generated["artifacts"]), "distribution_artifacts_sha256": candidate["artifacts_sha256"],
            "http_artifact_count": candidate["artifact_count"] - len(present_controls), "control_verified_count": len(present_controls), "behavior_probe_count": len(probes)}
        observation_pin = _record(root / ("anchor-observation-" + school.content_hash(anchor_observation) + ".json"), anchor_observation)
        def reference(path, maximum):
            return {"path": str(path), "sha256": sha(_read(path, maximum))}
        anchor = {"format": "school-live-observed-anchor", "version": 1,
            "snapshot": reference(root / "bundle/snapshot.json", self.maximum), "manifest": reference(root / "bundle/manifest.json", MAX_RECORD),
            "export_receipt": candidate["export_receipt"], "generation": candidate["generation_receipt"],
            "payload": reference(root / "build/generation/private-source/generator-payload.json", self.maximum), "observation": observation_pin}
        anchor_path = Path(candidate["anchor_path"])
        if anchor_path.exists():
            previous = json.loads(_read(anchor_path))
            need(set(previous) == set(anchor) and all(previous[k] == anchor[k] for k in anchor if k != "observation"))
            old_observation = json.loads(_pinned(previous["observation"]))
            need(all(old_observation[k] == anchor_observation[k] for k in anchor_observation if k != "observed_at"))
        else:
            _record(anchor_path, anchor)
        return observation
