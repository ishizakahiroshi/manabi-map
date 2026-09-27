"""Explicit R2 backup transport; no CLI, credential discovery, decryption or delete.

Nightly downloads retain the legacy age ciphertext unchanged. School uploads use
content-addressed create-only keys in a separate namespace. Readback/metadata
checks detect observed replacement, not authenticity of an age payload or future
provider durability. A failed PUT may have succeeded remotely; a later explicit
call with the same ciphertext can reconcile it by verified readback.
"""

from datetime import date, datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import hmac
import http.client
import json
import math
import re
import socket
import ssl
import threading
import time
from urllib.parse import quote, unquote
import xml.etree.ElementTree as ET


AGE_MAGIC = b"age-encryption.org/v1\n"
MAX_BYTES = 1024 * 1024 * 1024
LIST_LIMIT = 1024 * 1024
NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"


class BackupR2Error(RuntimeError):
    """Sanitized failure: never includes credentials or provider diagnostics."""


def _check(ok):
    if not ok:
        raise BackupR2Error("R2 backup operation refused")


def _remaining(deadline):
    value = deadline - time.monotonic()
    _check(value > 0)
    return value


def _sign(method, path, query, host, body, conditions, *, access_key, secret_key, timestamp):
    """SigV4 for fixed R2 host, including the exact encoded query/conditions."""
    digest = hashlib.sha256(body).hexdigest()
    headers = {"host": host, "x-amz-content-sha256": digest, "x-amz-date": timestamp, **conditions}
    names = ";".join(sorted(headers))
    canonical = "\n".join([method, path, query,
        "".join(f"{key}:{headers[key]}\n" for key in sorted(headers)), names, digest])
    day = timestamp[:8]
    scope = f"{day}/auto/s3/aws4_request"
    message = f"AWS4-HMAC-SHA256\n{timestamp}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}"
    key = ("AWS4" + secret_key).encode()
    for part in (day, "auto", "s3", "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, message.encode(), hashlib.sha256).hexdigest()
    headers["authorization"] = f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={names}, Signature={signature}"
    return headers


def _exchange(host, method, path, headers, body, *, timeout, maximum, accepted):
    """Deadline includes DNS/TLS/headers/body; no redirects, proxies or retries.

    A daemon blocked in OS DNS may finish late, but checks cancellation before
    sending a request. A PUT already sent cannot be undone by a local timeout.
    Only allowlisted success metadata leaves this function. Error bodies do not.
    """
    context = ssl.create_default_context()
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    connection = http.client.HTTPSConnection(host, timeout=timeout, context=context)
    deadline = time.monotonic() + timeout
    done, cancelled = threading.Event(), threading.Event()
    result = []

    def remaining():
        _check(not cancelled.is_set())
        return _remaining(deadline)

    def worker():
        try:
            connection.connect()
            connection.sock.settimeout(remaining())
            connection.request(method, path, body=body, headers=headers)
            connection.sock.settimeout(remaining())
            response = connection.getresponse()
            remaining()
            _check(response.status in accepted)
            if response.status != 200:
                # Only conditional-create conflict is accepted by a caller.
                result.append((response.status, {}, b""))
                return
            metadata = {name: response.getheader(name) for name in
                        ("Content-Length", "ETag", "Last-Modified")}
            length = metadata["Content-Length"]
            _check(length is None or (length.isascii() and length.isdigit() and int(length) <= maximum))
            output = bytearray()
            if method != "HEAD":
                while True:
                    remaining()
                    chunk = response.read1(min(65536, maximum + 1 - len(output)))
                    if not chunk:
                        break
                    output.extend(chunk)
                    _check(len(output) <= maximum)
                _check(length is None or len(output) == int(length))
            remaining()
            result.append((200, metadata, bytes(output)))
        except Exception:
            pass
        finally:
            connection.close()
            done.set()

    threading.Thread(target=worker, daemon=True).start()
    if not done.wait(max(0, deadline - time.monotonic())):
        cancelled.set()
        sock = connection.sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()
        raise BackupR2Error("R2 backup request failed; a PUT outcome may be unknown")
    _check(len(result) == 1)
    _remaining(deadline)
    return result[0]


def _age(ciphertext, maximum):
    _check(type(ciphertext) is bytes and len(AGE_MAGIC) + 32 < len(ciphertext) <= maximum
           and ciphertext.startswith(AGE_MAGIC))


def _head(metadata, maximum):
    size, etag, modified = (metadata.get(key) for key in ("Content-Length", "ETag", "Last-Modified"))
    _check(isinstance(size, str) and size.isascii() and size.isdigit() and 0 < int(size) <= maximum)
    _check(isinstance(etag, str) and re.fullmatch(r'"[A-Za-z0-9._:-]{1,128}"', etag))
    _check(isinstance(modified, str) and len(modified) <= 64)
    stamp = parsedate_to_datetime(modified)
    _check(stamp.tzinfo is not None)
    return {"bytes": int(size), "etag": etag, "last_modified": stamp.astimezone(timezone.utc).isoformat()}


def _listed_stamp(value):
    _check(isinstance(value, str) and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z", value))
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _text(element, name):
    entries = element.findall(NS + name)
    _check(len(entries) == 1 and entries[0].text is not None)
    return entries[0].text


class BackupR2Client:
    """No ambient configuration. timeout_seconds bounds each complete operation.

    metadata passed to upload_school is a small JSON object retained only in the
    returned receipt; it cannot choose a remote key or become an HTTP header.
    Caller must keep secrets out of that metadata and of its own receipt logs.
    """

    def __init__(self, account_id, bucket, access_key, secret_key, timeout_seconds=30,
                 max_bytes=256 * 1024 * 1024):
        _check(isinstance(account_id, str) and re.fullmatch(r"[0-9a-f]{32}", account_id))
        _check(isinstance(bucket, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", bucket))
        _check(isinstance(access_key, str) and re.fullmatch(r"[A-Za-z0-9]{16,128}", access_key))
        _check(isinstance(secret_key, str) and re.fullmatch(r"[A-Za-z0-9/+=]{16,128}", secret_key))
        _check(type(timeout_seconds) in (int, float) and math.isfinite(timeout_seconds) and 0 < timeout_seconds <= 3600)
        _check(type(max_bytes) is int and 0 < max_bytes <= MAX_BYTES)
        self._host, self._bucket = account_id + ".r2.cloudflarestorage.com", bucket
        self._access, self._secret = access_key, secret_key
        self._timeout, self._maximum = timeout_seconds, max_bytes

    def _request(self, method, key, *, deadline, query=None, body=b"", conditions=None, maximum=None, accepted=(200,)):
        # No caller path can select a different host, write nightly, or delete.
        _check(method in {"GET", "HEAD", "PUT"})
        _check((key == "" and method == "GET" and query is not None)
               or re.fullmatch(r"nightly/\d{4}-\d\d-\d\d\.dump\.gz\.age", key)
               or re.fullmatch(r"school-sqlite-backups/[0-9a-f]{64}\.age", key))
        _check(method != "PUT" or (key.startswith("school-sqlite-backups/") and conditions == {"if-none-match": "*"}))
        path = "/" + self._bucket + ("/" + key if key else "")
        canonical_query = "&".join(f"{quote(k, safe='')}={quote(v, safe='')}" for k, v in sorted((query or {}).items()))
        headers = _sign(method, path, canonical_query, self._host, body, conditions or {},
                        access_key=self._access, secret_key=self._secret,
                        timestamp=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
        response = _exchange(self._host, method, path + ("?" + canonical_query if canonical_query else ""),
                             headers, body, timeout=_remaining(deadline),
                             maximum=self._maximum if maximum is None else maximum, accepted=accepted)
        _remaining(deadline)
        return response

    def _verified_read(self, key, deadline):
        before = _head(self._request("HEAD", key, deadline=deadline)[1], self._maximum)
        _, headers, ciphertext = self._request("GET", key, deadline=deadline, conditions={"if-match": before["etag"]})
        _check(_head(headers, self._maximum) == before and len(ciphertext) == before["bytes"])
        _age(ciphertext, self._maximum)
        after = _head(self._request("HEAD", key, deadline=deadline)[1], self._maximum)
        _check(after == before)
        return ciphertext, {"key": key, **before, "sha256": hashlib.sha256(ciphertext).hexdigest()}

    def fetch_latest_nightly(self):
        """Select latest UTC date observed in listing, including same-date updates.

        Listing is not a transaction: another date may arrive after observation.
        The selected object's HEAD/GET/HEAD identity must nevertheless agree.
        """
        try:
            deadline = time.monotonic() + self._timeout
            token, seen_tokens, seen_keys, latest = None, set(), set(), None
            for _ in range(128):
                query = {"list-type": "2", "prefix": "nightly/", "max-keys": "1000", "encoding-type": "url"}
                if token is not None:
                    query["continuation-token"] = token
                raw = self._request("GET", "", deadline=deadline, query=query, maximum=LIST_LIMIT)[2]
                _check(b"<!DOCTYPE" not in raw and b"<!ENTITY" not in raw)
                root = ET.fromstring(raw)
                _check(root.tag == NS + "ListBucketResult" and _text(root, "Name") == self._bucket
                       and unquote(_text(root, "Prefix")) == "nightly/" and _text(root, "EncodingType") == "url")
                entries = root.findall(NS + "Contents")
                _check(len(entries) <= 1000)
                for item in entries:
                    key = unquote(_text(item, "Key"), errors="strict")
                    match = re.fullmatch(r"nightly/(\d{4}-\d\d-\d\d)\.dump\.gz\.age", key)
                    _check(match and key not in seen_keys and len(seen_keys) < 10000)
                    day = date.fromisoformat(match[1])
                    size, etag, stamp = _text(item, "Size"), _text(item, "ETag"), _text(item, "LastModified")
                    _check(size.isascii() and size.isdigit() and 0 < int(size) <= self._maximum
                           and re.fullmatch(r'"[A-Za-z0-9._:-]{1,128}"', etag))
                    modified = _listed_stamp(stamp)
                    seen_keys.add(key)
                    if latest is None or day > latest[0]:
                        latest = day, key, int(size), etag, modified
                truncated = _text(root, "IsTruncated")
                _check(truncated in {"true", "false"})
                if truncated == "false":
                    break
                token = _text(root, "NextContinuationToken")
                _check(0 < len(token) <= 4096 and token not in seen_tokens)
                seen_tokens.add(token)
            else:
                raise BackupR2Error("R2 nightly listing limit exceeded")
            _check(latest is not None)
            ciphertext, metadata = self._verified_read(latest[1], deadline)
            _check(metadata["bytes"] == latest[2] and metadata["etag"] == latest[3]
                   and datetime.fromisoformat(metadata["last_modified"]) == latest[4].replace(microsecond=0))
            _remaining(deadline)
            return ciphertext, metadata
        except Exception:
            raise BackupR2Error("R2 nightly backup fetch failed") from None

    def upload_school(self, ciphertext, metadata):
        """Create/reconcile only the ciphertext hash key, then verify exact readback."""
        try:
            deadline = time.monotonic() + self._timeout
            _age(ciphertext, self._maximum)
            _check(type(metadata) is dict and all(type(key) is str for key in metadata))
            encoded = json.dumps(metadata, ensure_ascii=True, allow_nan=False, sort_keys=True).encode()
            _check(len(encoded) <= 16384)
            metadata = json.loads(encoded)
            digest = hashlib.sha256(ciphertext).hexdigest()
            key = f"school-sqlite-backups/{digest}.age"
            status = self._request("PUT", key, deadline=deadline, body=ciphertext,
                                   conditions={"if-none-match": "*"}, maximum=16384, accepted=(200, 412))[0]
            readback, receipt = self._verified_read(key, deadline)
            _check(readback == ciphertext and receipt["sha256"] == digest)
            _remaining(deadline)
            return {**receipt, "reused": status == 412, "metadata": metadata}
        except Exception:
            raise BackupR2Error("R2 school backup upload failed; PUT outcome may be unknown") from None
