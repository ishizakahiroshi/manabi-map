"""Inactive PostgreSQL adapters. No CLI, credential discovery or implicit endpoint.

The caller supplies a separately reviewed, SHA256-pinned SQL program. Catalog
coverage is ONLY that program's declared scope; it must reject unknown objects.
An externally maintained freeze receipt is an attestation, not a database lock.
Sequence/role/provider exclusion and freeze truth remain operator obligations.
Never print program outputs, archives, SQL, subprocess exceptions or endpoints.
"""
from contextlib import contextmanager
from dataclasses import dataclass, replace
import json
import math
import os
from pathlib import Path
import queue
import re
import subprocess
import tempfile
import threading
import time
import uuid

import restore_bundle as bundle


def need(ok):
    if not ok:
        raise RuntimeError('PostgreSQL adapter contract rejected')


def ident(value):
    need(type(value) is str and re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', value))
    return '"' + value + '"'


def literal(value):
    need(type(value) is str and '\x00' not in value)
    return "'" + value.replace("'", "''") + "'"


def remaining(deadline):
    value = deadline - time.monotonic()
    need(0 < value <= 3600)
    return value


def start_writer(proc, raw, *, close=False):
    failed = threading.Event()
    def write():
        try:
            if raw:
                proc.stdin.write(raw)
                proc.stdin.flush()
            if close:
                proc.stdin.close()
        except Exception:
            failed.set()
    writer = threading.Thread(target=write, daemon=True)
    writer.start()
    return writer, failed


@dataclass(frozen=True, repr=False)
class Endpoint:
    host: str
    port: int
    database: str
    user: str
    sslmode: str = 'verify-full'
    passfile: str | None = None
    sslrootcert: str | None = None

    def __post_init__(self):
        need(type(self.host) is str and re.fullmatch(r'[A-Za-z0-9_.:-]+', self.host))
        need(type(self.port) is int and 0 < self.port < 65536)
        ident(self.database)
        ident(self.user)
        need(self.sslmode in ('verify-full', 'disable'))
        need(self.sslmode != 'disable' or self.host in ('127.0.0.1', '::1'))
        for path in (self.passfile, self.sslrootcert):
            if path is not None:
                need(Path(path).is_absolute() and Path(path).is_file())

    def args(self):
        return ['--host=' + self.host, '--port=' + str(self.port),
                '--username=' + self.user, '--dbname=' + self.database, '--no-password']


class PgTools:
    """One private scratch root; no inherited PG*, PATH, home or service config."""
    def __init__(self, binary_directory):
        self.bin = Path(binary_directory).resolve(strict=True)
        self.scratch = tempfile.TemporaryDirectory(prefix='restore-pg-')
        self.root = Path(self.scratch.name)
        for name in ('psql', 'pg_dump', 'pg_restore'):
            need(Path(self.exe(name)).is_file())

    def exe(self, name):
        need(name in ('psql', 'pg_dump', 'pg_restore'))
        return str(self.bin / (name + ('.exe' if os.name == 'nt' else '')))

    def env(self, endpoint):
        result = {k: os.environ[k] for k in ('SYSTEMROOT', 'WINDIR', 'COMSPEC') if k in os.environ}
        result.update(TEMP=str(self.root), TMP=str(self.root), HOME=str(self.root),
                      APPDATA=str(self.root), PGCONNECT_TIMEOUT='5', PGCLIENTENCODING='UTF8',
                      PGSSLMODE=endpoint.sslmode, PGSERVICEFILE=str(self.root / 'no-service'),
                      PGPASSFILE=endpoint.passfile or str(self.root / 'no-password'),
                      PGOPTIONS='-c statement_timeout=30000 -c lock_timeout=5000 '
                      '-c search_path=pg_catalog -c timezone=UTC -c datestyle=ISO,YMD '
                      '-c extra_float_digits=3 -c bytea_output=hex')
        if endpoint.sslrootcert:
            result['PGSSLROOTCERT'] = endpoint.sslrootcert
        return result

    def run(self, name, args, endpoint, deadline, raw=None):
        proc = streams = timer = writer = None
        try:
            remaining(deadline)
            proc = subprocess.Popen([self.exe(name), *args], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.env(endpoint),
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            streams = BoundedOutput(proc)
            timer = threading.Timer(max(0.001, deadline-time.monotonic()), proc.kill)
            timer.daemon = True
            timer.start()
            if raw is not None:
                need(type(raw) is bytes and len(raw) <= bundle.MAX_BYTES)
            writer, write_failed = start_writer(proc, raw, close=True)
            proc.wait(timeout=remaining(deadline))
            writer.join(timeout=remaining(deadline))
            streams.join(deadline)
            need(proc.returncode == 0 and not streams.failed and not write_failed.is_set() and not writer.is_alive())
            return b''.join(streams.chunks)
        except Exception:
            raise RuntimeError('PostgreSQL subprocess failed') from None
        finally:
            if timer:
                timer.cancel()
            if proc:
                if proc.poll() is None:
                    proc.kill()
                proc.wait(timeout=5)
                if streams:
                    streams.join(time.monotonic()+1, required=False)
                pairs = [(proc.stdin, writer)]
                if streams:
                    pairs.extend(zip((proc.stdout, proc.stderr), streams.threads))
                for pipe, thread in pairs:
                    try:
                        if thread is None or not thread.is_alive():
                            pipe.close()
                    except OSError:
                        pass

    def sql(self, endpoint, sql, deadline):
        return self.run('psql', ['-X', '-qAt', '--set=ON_ERROR_STOP=1', *endpoint.args()],
                        endpoint, deadline, sql.encode('utf-8')).decode('utf-8').strip()

    def identity(self, endpoint, deadline):
        result = json.loads(self.sql(endpoint, "SELECT json_build_object('system',"
            "(SELECT system_identifier::text FROM pg_control_system()),'database',"
            "(SELECT oid::text FROM pg_database WHERE datname=current_database()));", deadline))
        bundle.identity(result)
        return result

    def close(self):
        self.scratch.cleanup()


class BoundedOutput:
    """Count both pipes under one lock; never read an unbounded line."""
    def __init__(self, proc, *, line_mode=False):
        self.proc, self.line_mode = proc, line_mode
        self.lines = queue.Queue()
        self.size, self.failed, self.chunks = 0, False, []
        self.lock = threading.Lock()
        def consume(pipe, output):
            pending = b''
            try:
                for chunk in iter(lambda: pipe.read1(65536), b''):
                    with self.lock:
                        self.size += len(chunk)
                        over = self.size > bundle.MAX_BYTES
                        self.failed = self.failed or over
                    if over:
                        if self.proc.poll() is None:
                            self.proc.kill()
                        return
                    if output:
                        if not self.line_mode:
                            self.chunks.append(chunk)
                        else:
                            pending += chunk
                            while b'\n' in pending:
                                line, pending = pending.split(b'\n', 1)
                                self.lines.put(line.rstrip(b'\r'))
                if output and self.line_mode and pending:
                    self.lines.put(pending)
            except Exception:
                self.failed = True
                if self.proc.poll() is None:
                    self.proc.kill()
            finally:
                if output:
                    self.lines.put(None)
        self.threads = [threading.Thread(target=consume, args=(proc.stdout, True), daemon=True),
                        threading.Thread(target=consume, args=(proc.stderr, False), daemon=True)]
        for thread in self.threads:
            thread.start()

    def join(self, deadline=None, *, required=True):
        deadline = deadline or time.monotonic()+5
        for thread in self.threads:
            thread.join(timeout=max(0, deadline-time.monotonic()))
        if required:
            need(not any(thread.is_alive() for thread in self.threads))


class Session:
    """A deadline timer also kills blocked writes and drains both output pipes."""
    def __init__(self, tools, endpoint, deadline):
        remaining(deadline)
        self.deadline, self.closed = deadline, False
        self.writer = None
        self.proc = subprocess.Popen([tools.exe('psql'), '-X', '-qAt', '--set=ON_ERROR_STOP=1',
            *endpoint.args()], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=tools.env(endpoint), creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.streams = BoundedOutput(self.proc, line_mode=True)
        self.lines = self.streams.lines
        self.timer = threading.Timer(max(0.001, deadline-time.monotonic()), self.kill)
        self.timer.daemon = True
        self.timer.start()

    def kill(self):
        if self.proc.poll() is None:
            self.proc.kill()

    def query(self, sql):
        try:
            remaining(self.deadline)
            marker = 'pg_adapter_' + uuid.uuid4().hex
            raw = (sql + '\nSELECT ' + literal(marker) + ';\n').encode('utf-8')
            need(len(raw) <= bundle.MAX_BYTES)
            self.writer, failed = start_writer(self.proc, raw)
            self.writer.join(timeout=remaining(self.deadline))
            need(not self.writer.is_alive() and not failed.is_set())
            result = []
            while True:
                line = self.lines.get(timeout=remaining(self.deadline))
                need(line is not None and not self.streams.failed)
                if line == marker.encode():
                    return b'\n'.join(result).decode('utf-8')
                result.append(line)
        except Exception:
            self.kill()
            raise RuntimeError('PostgreSQL session failed') from None

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.timer.cancel()
        self.kill()
        self.proc.wait(timeout=5)
        self.streams.join(time.monotonic()+1, required=False)
        pairs = [(self.proc.stdin, self.writer), *zip((self.proc.stdout, self.proc.stderr), self.streams.threads)]
        for pipe, thread in pairs:
            try:
                if thread is None or not thread.is_alive():
                    pipe.close()
            except OSError:
                pass


class ReviewedProgram:
    """Trusted SQL, not a SQL sandbox. Pin is supplied separately by a reviewer.

    collect_sql returns one JSON object: six arrays; data entries contain values
    (ordered rows) instead of rows/sha256. unsupported_sql returns [] only when
    catalog coverage closes. inventory_sql covers non-MVCC state. ACL SQL and
    probe SQL are explicitly reviewed alongside the collector and scope.
    """
    def __init__(self, raw, expected_sha256):
        need(bundle.sha(expected_sha256) and bundle.digest(raw) == expected_sha256)
        value = bundle.decode(raw)
        bundle.fields(value, 'format scope collect_sql unsupported_sql inventory_sql acl_sql probes restore_sql_sha256')
        need(value['format'] == 'reviewed-pg-program-v1')
        need(value['restore_sql_sha256'] is None or bundle.sha(value['restore_sql_sha256']))
        for key in ('collect_sql', 'unsupported_sql', 'inventory_sql', 'acl_sql'):
            need(bundle.text(value[key]))
        need(type(value['probes']) is dict and len(value['probes']) >= 2)
        for probe in value['probes'].values():
            bundle.fields(probe, 'review statement expected_output denied_output')
            need(bundle.text(probe['statement']) and type(probe['expected_output']) is str)
            need(probe['denied_output'] is None or (bundle.text(probe['denied_output'])
                 and probe['denied_output'] != probe['expected_output']))
            if probe['review'].get('allowed') is False:
                need(bundle.text(probe['denied_output']))
            ident(probe['review']['role'])
        self._raw = raw

    @property
    def value(self):
        return bundle.decode(self._raw)

    def collect(self, query, descriptor):
        program = self.value
        need(descriptor['scope'] == program['scope'])
        need(json.loads(query(program['unsupported_sql'])) == [])
        entries = json.loads(query(program['collect_sql']))
        bundle.fields(entries, ' '.join(bundle.KINDS))
        for entry in entries['data']:
            bundle.fields(entry, 'identity values')
            values = entry.pop('values')
            need(type(values) is list)
            entry.update(rows=len(values), sha256=bundle.digest(bundle.canonical(values)))
        result = {kind: {'generation': descriptor['generation'], 'snapshot': descriptor['snapshot'],
                         'entries': entries[kind]} for kind in bundle.KINDS}
        bundle.validate_payloads(descriptor, result)
        return result


class FreezeEvidence:
    """Pinned operator attestation. Does not itself stop writers or superusers.

    The external controller must retain the freeze until capture exits. Receipt
    expiry/removal/replacement aborts. Inventory equality alone is NOT a freeze.
    """
    def __init__(self, path, sha256):
        self.path, self.sha256 = Path(path), sha256
        need(bundle.sha(sha256))

    def check(self, source, scope, deadline):
        remaining(deadline)
        raw = self.path.read_bytes()
        need(bundle.digest(raw) == self.sha256)
        value = bundle.decode(raw)
        bundle.fields(value, 'format source scope_sha256 expires_unix controller_ref assertion')
        need(value['format'] == 'external-pg-freeze-v1' and value['source'] == source
             and value['scope_sha256'] == bundle.digest(bundle.canonical(scope))
             and type(value['expires_unix']) in (int, float) and math.isfinite(value['expires_unix'])
             and time.time() < value['expires_unix'] <= time.time() + 3600
             and bundle.identifier(value['controller_ref'])
             and value['assertion'] == 'all-sequence-role-ddl-provider-writers-stopped-until-release')


class CaptureAdapter:
    def __init__(self, tools, endpoint, program, freeze):
        self.tools, self.endpoint, self.program, self.freeze = tools, endpoint, program, freeze
        self.protected = False

    def source_identity(self, *, deadline):
        return self.tools.identity(self.endpoint, deadline)

    @contextmanager
    def protect(self, scope, *, deadline):
        need(scope == self.program.value['scope'])
        source = self.source_identity(deadline=deadline)
        adapter = self
        class Protection:
            def check(self, *, deadline):
                need(adapter.protected and adapter.source_identity(deadline=deadline) == source)
                adapter.freeze.check(source, scope, deadline)
            def inventory(self, *, deadline):
                self.check(deadline=deadline)
                return json.loads(adapter.tools.sql(adapter.endpoint, adapter.program.value['inventory_sql'], deadline))
        self.protected = True
        guard = Protection()
        try:
            guard.check(deadline=deadline)
            yield guard
            guard.check(deadline=deadline)
        finally:
            self.protected = False

    @contextmanager
    def snapshot(self, *, deadline):
        need(self.protected)
        session = Session(self.tools, self.endpoint, deadline)
        try:
            snapshot = session.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();')
            need(re.fullmatch(r'[0-9A-F]+-[0-9A-F]+-[0-9]+', snapshot))
            class Holder:
                def check(self, *, deadline):
                    remaining(deadline)
                    need(session.query('SELECT 1;') == '1')
            holder = Holder()
            holder.snapshot = snapshot
            yield holder
            session.query('ROLLBACK;')
        finally:
            session.close()

    def collect(self, snapshot, descriptor, *, deadline):
        need(re.fullmatch(r'[0-9A-F]+-[0-9A-F]+-[0-9]+', snapshot))
        session = Session(self.tools, self.endpoint, deadline)
        try:
            # Import must occur before ANY query in this transaction.
            session.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT ' + literal(snapshot) + ';')
            versions = descriptor['versions']
            need(session.query('SHOW server_version;').split()[0] == versions['server'])
            for name in ('pg_dump', 'pg_restore'):
                output = self.tools.run(name, ['--version'], self.endpoint, deadline).decode()
                need(re.search(r'\b(\d+\.\d+)\b', output).group(1) == versions[name])
            return self.program.collect(session.query, descriptor)
        finally:
            session.close()

    def dump(self, snapshot, flags, *, deadline):
        need(self.protected and flags == bundle.FLAGS)
        need(re.fullmatch(r'[0-9A-F]+-[0-9A-F]+-[0-9]+', snapshot))
        return self.tools.run('pg_dump', [*self.endpoint.args(), *flags, '--snapshot=' + snapshot],
                              self.endpoint, deadline)


TOC_MAP = {'TABLE DATA': 'table-data', 'SEQUENCE SET': 'sequence-value', 'SEQUENCE OWNED BY': 'sequence',
           'ROW SECURITY': 'policy', 'FK CONSTRAINT': 'constraint', 'DEFAULT': 'constraint', 'SCHEMA': 'schema', 'TABLE': 'table',
           'SEQUENCE': 'sequence', 'FUNCTION': 'function', 'POLICY': 'policy', 'INDEX': 'index',
           'CONSTRAINT': 'constraint', 'TRIGGER': 'trigger', 'EXTENSION': 'extension'}


class DrillAdapter:
    def __init__(self, tools, admin_endpoint, program, *, source, record_directory, timeout=300):
        need(type(timeout) in (int, float) and 0 < timeout <= 3600)
        self.tools, self.admin, self.program, self.source = tools, admin_endpoint, program, bundle.detached(source)
        self.records = Path(record_directory).resolve(strict=True)
        need(self.records.is_dir())
        self.deadline = time.monotonic() + timeout
        self.lease = self.session = self.archive = None
        self.quarantined = False

    def inspect_archive(self, raw):
        need(type(raw) is bytes and 0 < len(raw) <= bundle.MAX_BYTES // 2)
        path = self.tools.root / ('archive-' + uuid.uuid4().hex)
        path.write_bytes(raw)
        listing = self.tools.run('pg_restore', ['--list', str(path)], self.admin, self.deadline).decode()
        toc = []
        for line in listing.splitlines():
            if not line or line.startswith(';'):
                continue
            entry = re.sub(r'^\d+; \d+ \d+ ', '', line)
            kind = next((v for k, v in TOC_MAP.items() if entry.startswith(k + ' ')), None)
            need(kind is not None)
            toc.append({'kind': kind, 'identity': line})
        need(bool(toc))
        self.archive, self.dump_sha, self.toc = path, bundle.digest(raw), sorted(toc, key=bundle.canonical)
        return bundle.detached(self.toc)

    def create_target(self):
        need(self.lease is None)
        self.name = 'restore_' + uuid.uuid4().hex
        self.nonce = uuid.uuid4().hex
        self.endpoint = replace(self.admin, database=self.name)
        system = self.tools.identity(self.admin, self.deadline)['system']
        self.record = self.records / (self.name + '.json')
        self.intent = {'format': 'owned-pg-target-v1', 'system': system, 'name': self.name,
                       'nonce': self.nonce, 'owner': self.admin.user}
        # Never overwrite/reuse a durable name, including after process restart.
        with self.record.open('xb') as stream:
            stream.write(bundle.canonical(self.intent))
            stream.flush()
            os.fsync(stream.fileno())
        self.tools.sql(self.admin, 'CREATE DATABASE ' + ident(self.name) + ' TEMPLATE template0;', self.deadline)
        # If this phase fails, retain intent and report creation-unconfirmed.
        self.tools.sql(self.admin, 'REVOKE ALL ON DATABASE ' + ident(self.name) + ' FROM PUBLIC; '
            'COMMENT ON DATABASE ' + ident(self.name) + ' IS ' + literal('restore-owned:' + self.nonce) + ';', self.deadline)
        self.lease = {'identity': self.tools.identity(self.endpoint, self.deadline), 'nonce': self.nonce}
        need(self.lease['identity']['system'] == system and self.lease['identity'] != self.source)
        self.lease_record = self.records / (self.name + '.lease.json')
        with self.lease_record.open('xb') as stream:
            stream.write(bundle.canonical(self.lease))
            stream.flush()
            os.fsync(stream.fileno())
        return bundle.detached(self.lease)

    def check(self, lease):
        need(lease == self.lease and lease['identity'] != self.source)
        need(self.record.read_bytes() == bundle.canonical(self.intent)
             and self.lease_record.read_bytes() == bundle.canonical(self.lease))
        need(self.tools.identity(self.endpoint, self.deadline) == lease['identity'])
        observed = json.loads(self.tools.sql(self.admin,
            "SELECT json_build_array(pg_get_userbyid(datdba),shobj_description(oid,'pg_database'),"
            "(SELECT count(*) FROM aclexplode(coalesce(datacl,acldefault('d',datdba))) "
            "WHERE grantee<>datdba AND privilege_type='CONNECT')) FROM pg_database WHERE datname="
            + literal(self.name) + ';', self.deadline))
        need(observed == [self.admin.user, 'restore-owned:' + self.nonce, 0])
        own_pid = self.session.query('SELECT pg_backend_pid();') if self.session else '0'
        need(own_pid.isdigit())
        unexpected = self.tools.sql(self.admin, 'SELECT count(*) FROM pg_stat_activity WHERE datname='
            + literal(self.name) + ' AND pid<>' + own_pid + ';', self.deadline)
        need(unexpected == '0')

    def query(self, sql):
        return self.session.query(sql) if self.session else self.tools.sql(self.endpoint, sql, self.deadline)

    def inspect_target(self, lease):
        self.check(lease)
        empty = self.query("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                           "WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast';") == '0'
        # CONNECT is revoked from all other grantees; external superuser or
        # same-owner interference remains outside this partial isolation claim.
        return {'lease': bundle.detached(lease), 'empty': empty, 'isolated': True,
                'atomic': True, 'provider_ready': not self.program.value['scope']['targets']['provider']}

    @contextmanager
    def transaction(self, lease):
        self.check(lease)
        need(self.session is None)
        self.session = Session(self.tools, self.endpoint, self.deadline)
        try:
            self.session.query('BEGIN;')
            yield
            self.session.query('COMMIT;')
        finally:
            self.session.close()
            self.session = None

    def restore(self, lease, raw, toc, *, flags):
        self.check(lease)
        need(self.session is not None and flags == ['--no-owner', '--no-acl', '--exit-on-error'])
        need(bundle.digest(raw) == self.dump_sha and self.archive.read_bytes() == raw and toc == self.toc)
        sql = self.tools.run('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', '--file=-',
            str(self.archive)], self.admin, self.deadline).decode('utf-8')
        # TOC pins object names but cannot establish executable SQL semantics.
        # pg_restore emits a random psql restrict token; normalize ONLY that
        # generated token for a reproducible review hash, retain original SQL.
        need(bundle.digest(normalized_restore_sql(sql)) == self.program.value['restore_sql_sha256'])
        self.session.query(sql)
        self.session.query('SET row_security=on;')

    def apply_acl(self, lease, payload, *, owner_mapping):
        self.check(lease)
        need(self.session is not None and owner_mapping == {})
        self.session.query(self.program.value['acl_sql'])

    def collect_restored(self, lease, descriptor):
        self.check(lease)
        return self.program.collect(self.query, descriptor)

    def probe_access(self, lease, probes):
        self.check(lease)
        results = []
        for probe in probes:
            spec = self.program.value['probes'].get(probe['id'])
            need(spec is not None and spec['review'] == probe)
            # Both allowed and denied operations execute as the actual role.
            # Reviewed SQL returns true/false by catching only SQLSTATE 42501;
            # negative statements must contain an inner rollback sentinel.
            session = self.session or Session(self.tools, self.endpoint, self.deadline)
            own = self.session is None
            try:
                if own:
                    session.query('BEGIN;')
                session.query('SAVEPOINT restore_access_probe; SET LOCAL ROLE ' + ident(probe['role']) + ';')
                need(session.query('SELECT current_user;') == probe['role'])
                output = session.query(spec['statement'])
                if probe['allowed'] is False:
                    need(output in (spec['expected_output'], spec['denied_output']))
                results.append({'id': probe['id'], 'allowed': output == spec['expected_output']})
                session.query('ROLLBACK TO SAVEPOINT restore_access_probe; RELEASE SAVEPOINT restore_access_probe;')
                if own:
                    session.query('ROLLBACK;')
            finally:
                if own:
                    session.close()
        return results

    def quarantine(self, lease):
        self.check(lease)
        self.quarantined = True

    def dispose(self, lease):
        self.check(lease)
        need(self.quarantined and self.session is None)
        # No FORCE: an unexpected session blocks disposal, never kills a peer.
        self.tools.sql(self.admin, 'DROP DATABASE ' + ident(self.name) + ';', self.deadline)

    def is_absent(self, lease):
        need(lease == self.lease and self.record.read_bytes() == bundle.canonical(self.intent))
        need(self.tools.identity(self.admin, self.deadline)['system'] == lease['identity']['system'])
        return self.tools.sql(self.admin, 'SELECT count(*) FROM pg_database WHERE datname='
                              + literal(self.name) + ';', self.deadline) == '0'


def normalized_restore_sql(sql):
    return re.sub(r'(?m)^(\\(?:un)?restrict) [A-Za-z0-9]+\r?$', r'\1 REVIEWED_TOKEN', sql).encode('utf-8')
