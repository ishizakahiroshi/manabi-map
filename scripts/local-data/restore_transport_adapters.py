"""Inactive age/R2 adapters for restore_transport (no CLI or ambient credentials).

The caller supplies every path, recipient, identity and R2 credential explicitly.
Only native X25519 age identities are supported; no plugins or passphrases. The
identity is sent on stdin, ciphertext uses a caller-owned temporary directory,
and authenticated plaintext is returned only after age exits successfully.
Python buffers cannot promise secure erasure. Nothing here enables a workflow.

R2 uses signed HTTPS PutObject with If-None-Match: *, never retries/redirects or
deletes. A timeout after PUT starts is indeterminate; retain the generation.
TLS, response limits and an overall request deadline apply. On DNS timeout a
daemon resolver/request thread may finish later, but checks cancellation before
sending the signed request. Callers must not retry an indeterminate generation.
Remote policy/retention and provider conditional-write behavior need live
acceptance; the filesystem store is only a local adapter, not R2 evidence.
"""

from datetime import datetime, timezone
import hashlib
import hmac
import http.client
import math
import os
from pathlib import Path
import re
import socket
import ssl
import stat
import subprocess
import tempfile
import threading
import time

from restore_transport import DEFAULT_MAX_BYTES, TransportError


def _require(ok, message):
    if not ok:
        raise TransportError(message)


def _limits(timeout, maximum):
    _require(type(timeout) in (int, float) and math.isfinite(timeout) and 0 < timeout <= 300,
             "timeout must be between zero and 300 seconds")
    _require(type(maximum) is int and 0 < maximum <= DEFAULT_MAX_BYTES,
             "invalid adapter byte limit")


def _path(value, *, directory=False):
    path = Path(value)
    _require(path.is_absolute(), "absolute explicit path required")
    _require(path.is_dir() if directory else path.is_file(), "explicit path unavailable")
    return path.resolve()


def _key(key):
    _require(isinstance(key, str) and re.fullmatch(
        r"generations/[a-z0-9][a-z0-9-]{0,95}/(?:reservation\.json|payload\.enc|descriptor\.json|completion\.json)", key),
        "invalid transport object key")
    _require(key.split("/")[1] not in {"latest", "current"}, "immutable generation required")
    return key


def _run_age(executable, arguments, raw, *, timeout, maximum):
    """Drain all pipes concurrently, cap output, kill/reap on failure/deadline."""
    proc = None
    output = bytearray()
    failed = threading.Event()
    threads = []
    deadline = time.monotonic() + timeout

    def remaining():
        return max(0, deadline - time.monotonic())

    try:
        proc = subprocess.Popen([str(executable), *arguments], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={}, shell=False, bufsize=0,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

        def read(stream, cap, keep):
            count = 0
            try:
                while chunk := stream.read(65536):
                    count += len(chunk)
                    if count > cap:
                        failed.set()
                        proc.kill()
                        return
                    if keep:
                        output.extend(chunk)
            except Exception:
                failed.set()
            finally:
                stream.close()

        def write():
            try:
                offset = 0
                while offset < len(raw):
                    written = proc.stdin.write(memoryview(raw)[offset:offset + 65536])
                    if not written:
                        raise OSError()
                    offset += written
            except Exception:
                failed.set()
            finally:
                try:
                    proc.stdin.close()
                except OSError:
                    pass

        threads = [threading.Thread(target=read, args=(proc.stdout, maximum, True), daemon=True),
                   threading.Thread(target=read, args=(proc.stderr, 65536, False), daemon=True),
                   threading.Thread(target=write, daemon=True)]
        for thread in threads:
            thread.start()
        status = proc.wait(timeout=remaining())
        for thread in threads:
            thread.join(timeout=remaining())
        _require(status == 0 and not any(t.is_alive() for t in threads)
                 and not failed.is_set() and output, "age operation failed")
        return bytes(output)
    except Exception:
        raise TransportError("age operation failed") from None
    finally:
        if proc is not None:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=1)
            # On Windows even raw CloseHandle can wait for a pending pipe read.
            # A reader owns its close. Unexpected inherited handles may leave a
            # daemon drain thread until that descendant closes them; the trusted
            # native age binary does not spawn such descendants. Never block the
            # caller, or accept unauthenticated partial output, on that drain.
            for index, stream in enumerate((proc.stdout, proc.stderr, proc.stdin)):
                if stream and not stream.closed and (index >= len(threads) or not threads[index].is_alive()):
                    try:
                        stream.close()
                    except OSError:
                        pass


class AgeCodec:
    """Explicit public-key encryption and manual native identity-file decryption.

    For encryption-only use omit identity_path. workspace is an existing private
    directory owned by the caller; only temporary ciphertext files are written.
    Pin checking before decrypt remains restore_transport.recover's obligation.
    """
    identifier = "age-x25519-v1"

    def __init__(self, *, executable, recipient, workspace, identity_path=None,
                 timeout_seconds=30, max_bytes=DEFAULT_MAX_BYTES):
        _limits(timeout_seconds, max_bytes)
        _require(isinstance(recipient, str) and re.fullmatch(r"age1[023456789acdefghjklmnpqrstuvwxyz]{58}", recipient),
                 "native age recipient required")
        self._executable = _path(executable)
        self._workspace = _path(workspace, directory=True)
        self._identity = _path(identity_path) if identity_path is not None else None
        self._recipient = recipient
        self._timeout = timeout_seconds
        self._maximum = max_bytes

    def encrypt(self, plaintext):
        _require(type(plaintext) is bytes and 0 < len(plaintext) <= self._maximum, "invalid age input size")
        return _run_age(self._executable, ["--encrypt", "--recipient", self._recipient], plaintext,
                        timeout=self._timeout, maximum=self._maximum)

    def decrypt(self, ciphertext):
        _require(type(ciphertext) is bytes and 0 < len(ciphertext) <= self._maximum, "invalid age input size")
        _require(self._identity is not None, "manual identity required for decryption")
        try:
            with self._identity.open("rb") as stream:
                identity = stream.read(4097)
            _require(len(identity) <= 4096, "invalid native age identity")
            lines = [line.strip() for line in identity.decode("ascii").splitlines()
                     if line.strip() and not line.lstrip().startswith("#")]
            _require(len(lines) == 1 and re.fullmatch(r"AGE-SECRET-KEY-1[023456789ACDEFGHJKLMNPQRSTUVWXYZ]{58}", lines[0]),
                     "invalid native age identity")
            # Never pass secret material as argv/environment or write it to a new file.
            with tempfile.TemporaryDirectory(prefix="restore-age-", dir=self._workspace) as directory:
                cipher_path = Path(directory) / "payload.age"
                cipher_path.write_bytes(ciphertext)
                return _run_age(self._executable, ["--decrypt", "--identity", "-", str(cipher_path)],
                    (lines[0] + "\n").encode("ascii"), timeout=self._timeout, maximum=self._maximum)
        except Exception:
            raise TransportError("age decryption failed") from None


class FilesystemStore:
    """Create-only local store; caller exclusively owns a trusted directory.

    Staged bytes are flushed before atomic hard-link publication. Never fall back
    to overwrite if hard links are unsupported. Reopening the adapter preserves
    objects. Directory durability across power loss is filesystem/OS dependent;
    this is not a remote-store or secure-erasure guarantee.
    """
    def __init__(self, *, root, max_bytes=DEFAULT_MAX_BYTES):
        _limits(30, max_bytes)
        self._root = _path(root, directory=True)
        self._maximum = max_bytes

    def _object(self, key):
        return self._root / (hashlib.sha256(_key(key).encode("ascii")).hexdigest() + ".object")

    def put_if_absent(self, key, value):
        target = self._object(key)
        _require(type(value) is bytes and 0 < len(value) <= self._maximum, "invalid object size")
        staging = None
        try:
            with tempfile.NamedTemporaryFile(dir=self._root, prefix=".staging-", delete=False) as stream:
                staging = Path(stream.name)
                stream.write(value)
                stream.flush()
                os.fsync(stream.fileno())
            os.link(staging, target)
        except Exception:
            raise TransportError("local create-only write failed; retain generation") from None
        finally:
            if staging is not None:
                staging.unlink(missing_ok=True)

    def get(self, key):
        target = self._object(key)
        try:
            _require(not target.is_symlink() and not target.is_junction(), "invalid stored object")
            with target.open("rb") as stream:
                info = os.fstat(stream.fileno())
                _require(stat.S_ISREG(info.st_mode) and info.st_size <= self._maximum, "invalid stored object")
                raw = stream.read(self._maximum + 1)
            _require(0 < len(raw) <= self._maximum, "invalid stored object size")
            return raw
        except Exception:
            raise TransportError("local object read failed") from None


def _sign(method, path, host, body, *, access_key, secret_key, timestamp, region="auto"):
    """AWS SigV4 single-chunk payload signing; deliberately no SDK/config chain."""
    digest = hashlib.sha256(body).hexdigest()
    headers = {"host": host, "x-amz-content-sha256": digest, "x-amz-date": timestamp}
    if method == "PUT":
        headers["if-none-match"] = "*"
    names = ";".join(sorted(headers))
    canonical = "\n".join([method, path, "", "".join(f"{k}:{headers[k]}\n" for k in sorted(headers)), names, digest])
    day = timestamp[:8]
    scope = f"{day}/{region}/s3/aws4_request"
    to_sign = f"AWS4-HMAC-SHA256\n{timestamp}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}"
    key = ("AWS4" + secret_key).encode()
    for part in (day, region, "s3", "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    headers["authorization"] = f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={names}, Signature={signature}"
    return headers


def _https_exchange(host, method, path, headers, body, *, timeout, maximum):
    """No redirect/proxy/retry; main thread bounds DNS, TLS, headers and body."""
    context = ssl.create_default_context()
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    connection = http.client.HTTPSConnection(host, timeout=timeout, context=context)
    done, cancelled = threading.Event(), threading.Event()
    deadline = time.monotonic() + timeout
    result = []

    def remaining():
        value = deadline - time.monotonic()
        if cancelled.is_set() or value <= 0:
            raise TimeoutError()
        return value

    def worker():
        try:
            connection.connect()
            connection.sock.settimeout(remaining())
            connection.request(method, path, body=body, headers=headers)
            connection.sock.settimeout(remaining())
            response = connection.getresponse()
            # Errors are never read, returned, logged or followed (may contain secrets).
            _require(response.status == 200, "R2 request rejected; retain generation")
            length = response.getheader("Content-Length")
            _require(length is None or (length.isascii() and length.isdigit() and int(length) <= maximum),
                     "R2 response exceeds byte limit")
            output = bytearray()
            while True:
                remaining()
                chunk = response.read1(min(65536, maximum + 1 - len(output)))
                if not chunk:
                    break
                output.extend(chunk)
                _require(len(output) <= maximum, "R2 response exceeds byte limit")
            _require(length is None or len(output) == int(length), "truncated R2 response")
            result.append(bytes(output))
        except Exception:
            pass
        finally:
            connection.close()
            done.set()

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    if not done.wait(timeout):
        cancelled.set()
        sock = connection.sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()
        raise TransportError("R2 deadline exceeded; PUT outcome may be unknown; retain generation")
    _require(len(result) == 1, "R2 request failed; retain generation")
    return result[0]


class R2Store:
    """Explicit Cloudflare R2 S3 endpoint; no list/delete/unconditional PUT.

    Credentials remain in caller process memory. This API is not a secret loader.
    Prefix must name a dedicated namespace; existing nightly objects are separate.
    PutObject's atomic precondition is provider-enforced. Independent transport
    pins plus publish/recover readback checks are still required.
    """
    def __init__(self, *, account_id, bucket, prefix, access_key, secret_key,
                 timeout_seconds=30, max_bytes=DEFAULT_MAX_BYTES):
        _limits(timeout_seconds, max_bytes)
        _require(isinstance(account_id, str) and re.fullmatch(r"[0-9a-f]{32}", account_id), "invalid R2 account")
        _require(isinstance(bucket, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]", bucket), "invalid R2 bucket")
        _require(isinstance(prefix, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", prefix)
                 and prefix not in {"nightly", "latest", "current"}, "dedicated immutable namespace required")
        _require(isinstance(access_key, str) and re.fullmatch(r"[A-Za-z0-9]{16,128}", access_key), "invalid explicit access key")
        _require(isinstance(secret_key, str) and re.fullmatch(r"[A-Za-z0-9/+=]{16,128}", secret_key), "invalid explicit secret key")
        self._host = account_id + ".r2.cloudflarestorage.com"
        self._prefix = f"/{bucket}/{prefix}/"
        self._access_key, self._secret_key = access_key, secret_key
        self._timeout, self._maximum = timeout_seconds, max_bytes

    def _request(self, method, key, body):
        path = self._prefix + _key(key)
        headers = _sign(method, path, self._host, body, access_key=self._access_key,
                        secret_key=self._secret_key,
                        timestamp=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
        try:
            return _https_exchange(self._host, method, path, headers, body,
                                   timeout=self._timeout, maximum=self._maximum if method == "GET" else 16384)
        except Exception:
            raise TransportError("R2 operation failed; PUT outcome may be unknown; retain generation") from None

    def put_if_absent(self, key, value):
        _require(type(value) is bytes and 0 < len(value) <= self._maximum, "invalid object size")
        self._request("PUT", key, value)

    def get(self, key):
        raw = self._request("GET", key, b"")
        _require(0 < len(raw) <= self._maximum, "invalid R2 object size")
        return raw
