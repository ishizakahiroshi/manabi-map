"""Synthetic HTTP fixtures only; never contact R2 or load credentials."""

import hashlib
import ssl
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
from xml.sax.saxutils import escape

import backup_r2_live as r2
import restore_transport_adapters as existing


CIPHER = r2.AGE_MAGIC + b"synthetic-ciphertext-not-real-encryption-" * 3
MODIFIED = "Mon, 28 Sep 2026 00:00:00 GMT"
STAMP = "2026-09-28T00:00:00.123Z"
ETAG = '"0123456789abcdef0123456789abcdef-2"'
KEY = "nightly/2026-09-28.dump.gz.age"


def client(**kwargs):
    return r2.BackupR2Client("a" * 32, "invented-backups", "A" * 32, "B" * 64, **kwargs)


def headers(raw=CIPHER, etag=ETAG, modified=MODIFIED):
    return {"Content-Length": str(len(raw)), "ETag": etag, "Last-Modified": modified}


def listing(keys=(KEY,), token=None, stamp=STAMP):
    objects = "".join(f"<Contents><Key>{escape(key)}</Key><Size>{len(CIPHER)}</Size>"
                      f"<ETag>{escape(ETAG)}</ETag><LastModified>{stamp}</LastModified></Contents>" for key in keys)
    return (f'<ListBucketResult xmlns="{r2.NS[1:-1]}"><Name>invented-backups</Name>'
            f'<Prefix>nightly/</Prefix><EncodingType>url</EncodingType>{objects}'
            f'<IsTruncated>{"true" if token else "false"}</IsTruncated>'
            f'{"<NextContinuationToken>" + escape(token) + "</NextContinuationToken>" if token else ""}'
            '</ListBucketResult>').encode()


class FakeHTTP:
    def __init__(self, pages=None, put_status=200):
        self.pages = list(pages or [listing()])
        self.calls = []
        self.put_status = put_status
        self.raw = CIPHER
        self.head_count = 0
        self.change_after = False

    def __call__(self, host, method, path, signed, body, **limits):
        self.calls.append((method, path, signed, body, limits))
        if "?" in path:
            return 200, {}, self.pages.pop(0)
        if method == "PUT":
            return self.put_status, {}, b""
        self.head_count += method == "HEAD"
        etag = '"changed"' if self.change_after and self.head_count == 2 else ETAG
        return 200, headers(self.raw, etag), self.raw if method == "GET" else b""


class Response:
    def __init__(self, status=200, raw=CIPHER, metadata=None):
        self.status, self.raw = status, raw
        self.metadata = headers(raw) if metadata is None else metadata
        self.reads = 0

    def getheader(self, name):
        return self.metadata.get(name)

    def read1(self, count):
        self.reads += 1
        chunk, self.raw = self.raw[:count], self.raw[count:]
        return chunk


class Socket:
    def settimeout(self, value):
        pass

    def shutdown(self, how):
        pass

    def close(self):
        pass


class Connection:
    def __init__(self, response):
        self.response, self.sock, self.calls = response, Socket(), []
        self.closed = False

    def connect(self):
        pass

    def request(self, method, path, **kwargs):
        self.calls.append((method, path, kwargs))

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


class BackupR2Tests(unittest.TestCase):
    def test_pagination_selects_latest_date_and_pins_every_read(self):
        token = "synthetic+/= token"
        fake = FakeHTTP([listing(["nightly/2026-09-27.dump.gz.age"], token), listing()])
        with patch.object(r2, "_exchange", side_effect=fake):
            raw, metadata = client().fetch_latest_nightly()
        self.assertEqual(raw, CIPHER)
        self.assertEqual(metadata, {"key": KEY, "bytes": len(CIPHER), "etag": ETAG,
                                   "last_modified": "2026-09-28T00:00:00+00:00",
                                   "sha256": hashlib.sha256(CIPHER).hexdigest()})
        self.assertEqual([call[0] for call in fake.calls], ["GET", "GET", "HEAD", "GET", "HEAD"])
        self.assertEqual(parse_qs(urlsplit(fake.calls[1][1]).query)["continuation-token"], [token])
        self.assertIn("%2B%2F%3D%20", fake.calls[1][1])
        self.assertEqual(fake.calls[3][2]["if-match"], ETAG)
        self.assertIn("SignedHeaders=host;if-match;", fake.calls[3][2]["authorization"])
        self.assertTrue(all(call[4]["timeout"] <= 30 for call in fake.calls))

    def test_same_date_is_fetched_again_and_never_skipped(self):
        fake = FakeHTTP([listing(), listing()])
        with patch.object(r2, "_exchange", side_effect=fake):
            c = client()
            c.fetch_latest_nightly()
            c.fetch_latest_nightly()
        self.assertEqual(sum(call[0] == "GET" and "?" not in call[1] for call in fake.calls), 2)

    def test_listing_rejects_bad_dates_paths_duplicate_pages_and_xml_entities(self):
        bad = [listing(["nightly/2026-02-30.dump.gz.age"]), listing(["nightly/../secret"]),
               listing([KEY, KEY]), listing([]), listing().replace(b"invented-backups", b"other-backups"),
               b'<!DOCTYPE x [<!ENTITY x "synthetic">]><x>&x;</x>']
        for raw in bad:
            with self.subTest(raw=raw[:20]), patch.object(r2, "_exchange", side_effect=FakeHTTP([raw])):
                with self.assertRaisesRegex(r2.BackupR2Error, "fetch failed"):
                    client().fetch_latest_nightly()
        fake = FakeHTTP([listing([], "repeat"), listing([], "repeat")])
        with patch.object(r2, "_exchange", side_effect=fake), self.assertRaises(r2.BackupR2Error):
            client().fetch_latest_nightly()
        self.assertEqual(len(fake.calls), 2)

    def test_changed_after_read_and_list_head_disagreement_fail_closed(self):
        fake = FakeHTTP()
        fake.change_after = True
        with patch.object(r2, "_exchange", side_effect=fake), self.assertRaises(r2.BackupR2Error):
            client().fetch_latest_nightly()
        fake = FakeHTTP([listing(stamp="2026-09-27T00:00:00Z")])
        with patch.object(r2, "_exchange", side_effect=fake), self.assertRaises(r2.BackupR2Error):
            client().fetch_latest_nightly()

    def test_conditional_get_failure_and_age_magic_rejected_without_body_diagnostics(self):
        fake = FakeHTTP()

        def reject(*args, **kwargs):
            if args[1] == "GET" and "?" not in args[2]:
                raise RuntimeError("synthetic credential/provider details")
            return fake(*args, **kwargs)

        with patch.object(r2, "_exchange", side_effect=reject):
            with self.assertRaises(r2.BackupR2Error) as error:
                client().fetch_latest_nightly()
        self.assertEqual(str(error.exception), "R2 nightly backup fetch failed")
        fake = FakeHTTP()
        fake.raw = b"not-an-age-file" * 9
        with patch.object(r2, "_exchange", side_effect=fake), self.assertRaises(r2.BackupR2Error):
            client().fetch_latest_nightly()

    def test_school_put_content_address_and_existing_identical_readback(self):
        for status in (200, 412):
            fake = FakeHTTP(put_status=status)
            original = {"source_sha256": "c" * 64, "created_at": "2026-09-28T00:00:00Z"}
            with patch.object(r2, "_exchange", side_effect=fake):
                receipt = client().upload_school(CIPHER, original)
            self.assertEqual(receipt["reused"], status == 412)
            self.assertEqual(receipt["metadata"], original)
            original["created_at"] = "changed"
            self.assertNotEqual(receipt["metadata"], original)
            self.assertEqual([call[0] for call in fake.calls], ["PUT", "HEAD", "GET", "HEAD"])
            put = fake.calls[0]
            self.assertEqual(put[1], "/invented-backups/school-sqlite-backups/" + hashlib.sha256(CIPHER).hexdigest() + ".age")
            self.assertEqual(put[2]["if-none-match"], "*")
            self.assertIn("SignedHeaders=host;if-none-match;", put[2]["authorization"])
            self.assertNotIn("metadata", put[2])

    def test_school_collision_readback_mismatch_and_invalid_input(self):
        fake = FakeHTTP(put_status=412)
        fake.raw = CIPHER + b"changed"
        with patch.object(r2, "_exchange", side_effect=fake), self.assertRaises(r2.BackupR2Error):
            client().upload_school(CIPHER, {})
        for raw, metadata in ((b"plain sqlite", {}), (CIPHER, {"x": float("nan")}),
                              (CIPHER, {"x": "x" * 16384}), (CIPHER, {1: "x"})):
            with patch.object(r2, "_exchange") as request, self.assertRaises(r2.BackupR2Error):
                client().upload_school(raw, metadata)
            request.assert_not_called()

    def test_mutation_scope_and_constructor_guards(self):
        c = client()
        for method, key in (("DELETE", KEY), ("PUT", KEY), ("GET", "../secret")):
            with patch.object(r2, "_exchange") as request, self.assertRaises(r2.BackupR2Error):
                c._request(method, key, deadline=time.monotonic() + 1)
            request.assert_not_called()
        for options in ({"timeout_seconds": 0}, {"timeout_seconds": float("inf")},
                        {"max_bytes": True}, {"max_bytes": r2.MAX_BYTES + 1}):
            with self.assertRaises(r2.BackupR2Error):
                client(**options)

    def test_signing_preserves_existing_empty_query_protocol_and_covers_query(self):
        args = dict(access_key="A" * 32, secret_key="B" * 64, timestamp="20260928T000000Z")
        for method, condition in (("GET", {}), ("PUT", {"if-none-match": "*"})):
            signed = r2._sign(method, "/invented/x", "", "a.r2.cloudflarestorage.com", b"synthetic", condition, **args)
            self.assertEqual(signed, existing._sign(method, "/invented/x", "a.r2.cloudflarestorage.com", b"synthetic", **args))
        one = r2._sign("GET", "/invented", "prefix=nightly%2F", "a.r2.cloudflarestorage.com", b"", {}, **args)
        two = r2._sign("GET", "/invented", "prefix=other%2F", "a.r2.cloudflarestorage.com", b"", {}, **args)
        self.assertNotEqual(one["authorization"], two["authorization"])

    def test_https_success_tls_head_and_error_body_never_read(self):
        for method in ("GET", "HEAD"):
            conn = Connection(Response())
            with patch.object(r2.http.client, "HTTPSConnection", return_value=conn) as factory:
                status, metadata, raw = r2._exchange("synthetic.invalid", method, "/x", {}, b"",
                                                    timeout=1, maximum=1024, accepted=(200,))
            self.assertEqual(status, 200)
            self.assertEqual(raw, CIPHER if method == "GET" else b"")
            self.assertEqual(metadata, headers())
            context = factory.call_args.kwargs["context"]
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
            self.assertTrue(context.check_hostname)
            self.assertGreaterEqual(context.minimum_version, ssl.TLSVersion.TLSv1_2)
            self.assertTrue(conn.closed)
        for status in (302, 403, 412):
            conn = Connection(Response(status, b"synthetic private error body"))
            with patch.object(r2.http.client, "HTTPSConnection", return_value=conn):
                if status == 412:
                    self.assertEqual(r2._exchange("synthetic.invalid", "PUT", "/x", {}, b"",
                                                 timeout=1, maximum=1024, accepted=(200, 412)), (412, {}, b""))
                else:
                    with self.assertRaises(r2.BackupR2Error):
                        r2._exchange("synthetic.invalid", "GET", "/x", {}, b"", timeout=1, maximum=1024, accepted=(200,))
            self.assertEqual(conn.response.reads, 0)

    def test_https_stream_limits_truncation_and_late_dns(self):
        for raw, metadata in ((b"x" * 9, {}), (b"x", {"Content-Length": "9"}),
                              (b"x", {"Content-Length": "4"}), (b"x", {"Content-Length": "invalid"})):
            conn = Connection(Response(raw=raw, metadata=metadata))
            with patch.object(r2.http.client, "HTTPSConnection", return_value=conn), self.assertRaises(r2.BackupR2Error):
                r2._exchange("synthetic.invalid", "GET", "/x", {}, b"", timeout=1, maximum=8, accepted=(200,))
        release, finished = threading.Event(), threading.Event()
        conn = Connection(Response())
        conn.connect = lambda: release.wait(1)
        original_close = conn.close
        conn.close = lambda: (original_close(), finished.set())
        try:
            with patch.object(r2.http.client, "HTTPSConnection", return_value=conn), self.assertRaises(r2.BackupR2Error):
                r2._exchange("synthetic.invalid", "PUT", "/x", {}, CIPHER, timeout=.02, maximum=1024, accepted=(200,))
        finally:
            release.set()
            self.assertTrue(finished.wait(1))
        self.assertEqual(conn.calls, [])

    def test_late_operation_result_and_put_timeout_are_not_success_or_retried(self):
        def late(*args, **kwargs):
            time.sleep(.03)
            return 200, {}, listing()

        with patch.object(r2, "_exchange", side_effect=late), self.assertRaises(r2.BackupR2Error):
            client(timeout_seconds=.01).fetch_latest_nightly()
        with patch.object(r2, "_exchange", side_effect=TimeoutError("synthetic secret")) as request:
            with self.assertRaisesRegex(r2.BackupR2Error, "unknown") as error:
                client().upload_school(CIPHER, {})
        self.assertEqual(request.call_count, 1)
        self.assertNotIn("secret", str(error.exception))

    def test_headers_and_body_stalls_obey_deadline_without_background_retry(self):
        for phase in ("headers", "body"):
            release, finished = threading.Event(), threading.Event()
            conn = Connection(Response())
            if phase == "headers":
                conn.getresponse = lambda: (release.wait(1), conn.response)[1]
            else:
                read = conn.response.read1
                conn.response.read1 = lambda size: (release.wait(1), read(size))[1]
            close = conn.close
            conn.close = lambda: (close(), finished.set())
            try:
                started = time.monotonic()
                with patch.object(r2.http.client, "HTTPSConnection", return_value=conn), self.assertRaises(r2.BackupR2Error):
                    r2._exchange("synthetic.invalid", "GET", "/x", {}, b"", timeout=.02, maximum=1024, accepted=(200,))
                self.assertLess(time.monotonic() - started, .5)
            finally:
                release.set()
                self.assertTrue(finished.wait(1))
            self.assertEqual(len(conn.calls), 1)


if __name__ == "__main__":
    unittest.main()
