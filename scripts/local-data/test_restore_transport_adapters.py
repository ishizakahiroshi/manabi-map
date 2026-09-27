"""Synthetic offline adapter tests; no real keys, R2 requests or existing files."""

import hashlib
import io
from pathlib import Path
import ssl
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import restore_transport as transport
import restore_transport_adapters as adapters
from test_restore_transport import FakeCodec, package


def r2(**kwargs):
    return adapters.R2Store(account_id="a" * 32, bucket="invented-backups",
        prefix="synthetic-restore", access_key="A" * 32, secret_key="B" * 64, **kwargs)


class Response:
    status = 200

    def __init__(self, raw=b"invented", length=None):
        self.raw = io.BytesIO(raw)
        self.length = str(len(raw)) if length is None else length

    def getheader(self, name):
        return self.length

    def read1(self, size):
        return self.raw.read(size)


class Connection:
    response = None

    def __init__(self, host, *, timeout, context):
        self.host, self.timeout, self.context = host, timeout, context
        self.sock = self
        self.requests = []
        self.closed = False

    def connect(self):
        pass

    def settimeout(self, timeout):
        pass

    def request(self, *args, **kwargs):
        self.requests.append((args, kwargs))

    def getresponse(self):
        return self.response

    def shutdown(self, how):
        self.closed = True

    def close(self):
        self.closed = True


class AdapterTests(unittest.TestCase):
    def test_filesystem_roundtrip_reopen_immutable_and_complete_last(self):
        with tempfile.TemporaryDirectory() as root:
            store = adapters.FilesystemStore(root=root)
            candidate = package()
            transport.publish(candidate, expected=candidate["pin"], store=store)
            reopened = adapters.FilesystemStore(root=root)
            self.assertEqual(transport.recover(expected=candidate["pin"], store=reopened,
                             codec=FakeCodec(), max_bundle_bytes=4096), b"invented dump and semantic payloads")
            before = {path.name: path.read_bytes() for path in Path(root).iterdir()}
            with self.assertRaises(transport.TransportError):
                transport.publish(candidate, expected=candidate["pin"], store=reopened)
            self.assertEqual(before, {path.name: path.read_bytes() for path in Path(root).iterdir()})
            self.assertEqual(len(before), 4)

    def test_filesystem_concurrent_create_has_one_winner(self):
        with tempfile.TemporaryDirectory() as root:
            store = adapters.FilesystemStore(root=root)
            barrier = threading.Barrier(2)
            outcomes = []

            def write(value):
                barrier.wait()
                try:
                    store.put_if_absent("generations/synthetic-race/payload.enc", value)
                    outcomes.append(value)
                except transport.TransportError:
                    outcomes.append(None)

            threads = [threading.Thread(target=write, args=(value,)) for value in (b"one", b"two")]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            self.assertEqual(outcomes.count(None), 1)
            self.assertEqual(store.get("generations/synthetic-race/payload.enc"), next(v for v in outcomes if v))
            self.assertEqual(len(list(Path(root).iterdir())), 1)

    def test_local_limits_paths_and_unsupported_links_fail_closed(self):
        with tempfile.TemporaryDirectory() as root:
            store = adapters.FilesystemStore(root=root, max_bytes=8)
            for key in ("../outside", "generations/latest/payload.enc", "generations/a/../../secret", "nightly/a"):
                with self.assertRaises(transport.TransportError):
                    store.put_if_absent(key, b"ok")
            with self.assertRaises(transport.TransportError):
                store.put_if_absent("generations/synthetic/payload.enc", b"x" * 9)
            with patch.object(adapters.os, "link", side_effect=OSError("synthetic private detail")):
                with self.assertRaises(transport.TransportError) as caught:
                    store.put_if_absent("generations/synthetic/payload.enc", b"ok")
            self.assertNotIn("private", str(caught.exception))
            self.assertEqual(list(Path(root).iterdir()), [])

    def test_r2_signed_conditional_put_and_plain_get(self):
        calls = []

        def exchange(*args, **kwargs):
            calls.append((args, kwargs))
            return b"" if args[1] == "PUT" else b"invented"

        with patch.object(adapters, "_https_exchange", side_effect=exchange):
            store = r2()
            store.put_if_absent("generations/synthetic/payload.enc", b"invented")
            self.assertEqual(store.get("generations/synthetic/payload.enc"), b"invented")
        put, get = [call[0] for call in calls]
        self.assertEqual(put[0], "a" * 32 + ".r2.cloudflarestorage.com")
        self.assertEqual(put[2], "/invented-backups/synthetic-restore/generations/synthetic/payload.enc")
        self.assertEqual(put[3]["if-none-match"], "*")
        self.assertIn("SignedHeaders=host;if-none-match;x-amz-content-sha256;x-amz-date", put[3]["authorization"])
        self.assertIn("/auto/s3/aws4_request", put[3]["authorization"])
        self.assertEqual(put[3]["x-amz-content-sha256"], hashlib.sha256(b"invented").hexdigest())
        self.assertNotIn("if-none-match", get[3])
        self.assertNotIn("B" * 64, repr(put))

    def test_r2_timeout_never_retries_or_leaks_provider_exception(self):
        with patch.object(adapters, "_https_exchange", side_effect=TimeoutError("synthetic secret")) as call:
            with self.assertRaises(transport.TransportError) as caught:
                r2().put_if_absent("generations/synthetic/completion.json", b"invented")
        self.assertEqual(call.call_count, 1)
        self.assertIn("unknown", str(caught.exception))
        self.assertNotIn("secret", str(caught.exception))

    def test_https_tls_verification_size_and_status(self):
        connection = Connection("invented", timeout=1, context=None)
        connection.response = Response()
        with patch.object(adapters.http.client, "HTTPSConnection", return_value=connection) as factory:
            self.assertEqual(adapters._https_exchange("invented.example", "GET", "/x", {}, b"",
                             timeout=1, maximum=8), b"invented")
        context = factory.call_args.kwargs["context"]
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertGreaterEqual(context.minimum_version, ssl.TLSVersion.TLSv1_2)
        self.assertTrue(connection.closed)
        self.assertEqual(len(connection.requests), 1)
        for status, raw, length in ((302, b"secret redirect", None), (412, b"exists", None),
                                    (200, b"x" * 9, "9"), (200, b"x", "4"), (200, b"x", "bad")):
            with self.subTest(status=status, length=length):
                connection = Connection("invented", timeout=1, context=None)
                connection.response = Response(raw, length)
                connection.response.status = status
                with patch.object(adapters.http.client, "HTTPSConnection", return_value=connection):
                    with self.assertRaises(transport.TransportError):
                        adapters._https_exchange("invented.example", "GET", "/x", {}, b"", timeout=1, maximum=8)
                self.assertEqual(len(connection.requests), 1)
                self.assertTrue(connection.closed)

    def test_https_late_dns_connect_cannot_send_after_deadline(self):
        release = threading.Event()
        connection = Connection("invented", timeout=1, context=None)
        connection.connect = lambda: release.wait(2)
        with patch.object(adapters.http.client, "HTTPSConnection", return_value=connection):
            with self.assertRaisesRegex(transport.TransportError, "deadline"):
                adapters._https_exchange("invented.example", "PUT", "/x", {}, b"invented", timeout=0.02, maximum=8)
        release.set()
        time.sleep(0.03)
        self.assertEqual(connection.requests, [])

    def test_r2_publication_readback_failure_never_completes(self):
        objects, puts = {}, []

        def exchange(host, method, path, headers, body, **kwargs):
            if method == "PUT":
                self.assertEqual(headers["if-none-match"], "*")
                if path in objects:
                    raise RuntimeError("conflict")
                puts.append(path)
                objects[path] = body
                return b""
            return b"wrong ciphertext" if path.endswith("payload.enc") else objects[path]

        candidate = package()
        with patch.object(adapters, "_https_exchange", side_effect=exchange):
            with self.assertRaises(transport.TransportError):
                transport.publish(candidate, expected=candidate["pin"], store=r2())
        self.assertFalse(any(path.endswith("completion.json") for path in puts))

    def test_r2_roundtrip_matches_core_completion_order(self):
        objects, events = {}, []

        def exchange(host, method, path, headers, body, **kwargs):
            events.append((method, path.rsplit("/", 1)[1]))
            if method == "PUT":
                if path in objects:
                    raise RuntimeError("conflict")
                objects[path] = body
                return b""
            return objects[path]

        candidate = package()
        with patch.object(adapters, "_https_exchange", side_effect=exchange):
            store = r2()
            transport.publish(candidate, expected=candidate["pin"], store=store)
            self.assertEqual(transport.recover(expected=candidate["pin"], store=store,
                codec=FakeCodec(), max_bundle_bytes=4096), b"invented dump and semantic payloads")
        self.assertEqual([name for verb, name in events if verb == "PUT"],
            ["reservation.json", "payload.enc", "descriptor.json", "completion.json"])
        self.assertLess(events.index(("GET", "descriptor.json")), events.index(("PUT", "completion.json")))

    def test_age_runner_caps_output_and_suppresses_failure_details(self):
        with tempfile.TemporaryDirectory() as root:
            script = Path(root) / "invented_process.py"
            script.write_text("import sys\nsys.stdout.buffer.write(b'x' * 10000)\n", encoding="utf-8")
            with self.assertRaises(transport.TransportError):
                adapters._run_age(sys.executable, [str(script)], b"", timeout=2, maximum=8)
            script.write_text("import sys\nsys.stderr.write('synthetic private identity')\nsys.exit(3)\n", encoding="utf-8")
            with self.assertRaises(transport.TransportError) as caught:
                adapters._run_age(sys.executable, [str(script)], b"", timeout=2, maximum=8)
            self.assertNotIn("identity", str(caught.exception))

    def test_age_runner_kills_timeout_and_empty_environment(self):
        with tempfile.TemporaryDirectory() as root:
            script = Path(root) / "invented_process.py"
            script.write_text("import time\ntime.sleep(10)\n", encoding="utf-8")
            started = time.monotonic()
            with self.assertRaises(transport.TransportError):
                adapters._run_age(sys.executable, [str(script)], b"", timeout=0.1, maximum=8)
            self.assertLess(time.monotonic() - started, 3)
            script.write_text("import os,sys\nsys.stdout.write('bad' if 'SYNTHETIC_SECRET' in os.environ else 'ok')\n", encoding="utf-8")
            with patch.dict(adapters.os.environ, {"SYNTHETIC_SECRET": "invented"}):
                self.assertEqual(adapters._run_age(sys.executable, [str(script)], b"", timeout=2, maximum=8), b"ok")

    def test_age_runner_deadline_includes_pipe_drain_after_parent_exit(self):
        with tempfile.TemporaryDirectory() as root:
            parent = Path(root) / "invented_parent.py"
            child = Path(root) / "invented_child.py"
            release, finished = Path(root) / "release", Path(root) / "finished"
            child.write_text("from pathlib import Path\nimport sys,time\n"
                "while not Path(sys.argv[1]).exists(): time.sleep(.01)\n"
                "Path(sys.argv[2]).touch()\n", encoding="utf-8")
            parent.write_text("import subprocess,sys\n"
                "subprocess.Popen([sys.executable,sys.argv[1],sys.argv[2],sys.argv[3]])\n"
                "sys.stdout.write('ok')\n", encoding="utf-8")
            started = time.monotonic()
            try:
                with self.assertRaises(transport.TransportError):
                    adapters._run_age(sys.executable, [str(parent), str(child), str(release), str(finished)],
                                      b"", timeout=.2, maximum=8)
                self.assertLess(time.monotonic() - started, 1)
            finally:
                release.touch()
                deadline = time.monotonic() + 3
                while not finished.exists() and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue(finished.exists(), "owned synthetic child must finish")

    def test_age_missing_identity_and_plugin_identity_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            codec = adapters.AgeCodec(executable=sys.executable, recipient="age1" + "q" * 58, workspace=root)
            with self.assertRaises(transport.TransportError):
                codec.decrypt(b"invented")
            identity = Path(root) / "invented-identity"
            identity.write_text("AGE-PLUGIN-INVENTED-1XXX\n", encoding="ascii")
            codec = adapters.AgeCodec(executable=sys.executable, recipient="age1" + "q" * 58,
                workspace=root, identity_path=identity)
            with patch.object(adapters, "_run_age") as call:
                with self.assertRaises(transport.TransportError):
                    codec.decrypt(b"invented")
            call.assert_not_called()

    def test_constructor_limits_and_explicit_configuration(self):
        for timeout in (True, -1, 0, 301, float("nan"), float("inf")):
            with self.assertRaises(transport.TransportError):
                r2(timeout_seconds=timeout)
        for maximum in (True, 0, adapters.DEFAULT_MAX_BYTES + 1):
            with self.assertRaises(transport.TransportError):
                r2(max_bytes=maximum)


if __name__ == "__main__":
    unittest.main()
