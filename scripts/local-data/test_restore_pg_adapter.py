"""Offline contract tests; all paths, identities and SQL here are synthetic."""
import os
import io
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import restore_bundle as bundle
import restore_pg_adapter as pg


def program_value():
    return {'format': 'reviewed-pg-program-v1', 'scope': {'synthetic': True},
            'collect_sql': 'SELECT 1;', 'unsupported_sql': "SELECT '[]';",
            'inventory_sql': "SELECT '[]';", 'acl_sql': 'SELECT 1;',
            'restore_sql_sha256': None,
            'probes': {key: {'review': {'role': 'synthetic_reader'}, 'statement': 'SELECT 1;',
                            'expected_output': '1', 'denied_output': None} for key in ('allow', 'deny')}}


class PgContractTests(unittest.TestCase):
    def test_remote_tls_cannot_be_disabled(self):
        with self.assertRaises(RuntimeError):
            pg.Endpoint('synthetic.example', 5432, 'synthetic_db', 'synthetic_owner', 'disable')

    def test_connection_string_injection_rejected(self):
        for field in ('host', 'database', 'user'):
            values = dict(host='127.0.0.1', port=12345, database='synthetic_db', user='synthetic_owner', sslmode='disable')
            values[field] = 'dbname=secret sslmode=disable'
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                pg.Endpoint(**values)

    def test_program_requires_independent_pin_and_detaches_mutations(self):
        value = program_value()
        raw = bundle.canonical(value)
        with self.assertRaises(RuntimeError):
            pg.ReviewedProgram(raw, '0' * 64)
        program = pg.ReviewedProgram(raw, bundle.digest(raw))
        program.value['acl_sql'] = 'ALTER ROLE synthetic_reader SUPERUSER;'
        self.assertEqual(program.value['acl_sql'], 'SELECT 1;')

    def test_unknown_catalog_objects_refused(self):
        value = program_value()
        raw = bundle.canonical(value)
        program = pg.ReviewedProgram(raw, bundle.digest(raw))
        with self.assertRaises(RuntimeError):
            program.collect(lambda sql: '["unsupported:synthetic"]', {'scope': value['scope']})

    def test_expired_and_changed_freeze_receipt_refused(self):
        source, scope = {'system': 'synthetic', 'database': '123'}, {'synthetic': True}
        value = {'format': 'external-pg-freeze-v1', 'source': source,
                 'scope_sha256': bundle.digest(bundle.canonical(scope)), 'expires_unix': time.time() + 60,
                 'controller_ref': 'synthetic-controller',
                 'assertion': 'all-sequence-role-ddl-provider-writers-stopped-until-release'}
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'freeze.json'
            raw = bundle.canonical(value)
            path.write_bytes(raw)
            freeze = pg.FreezeEvidence(path, bundle.digest(raw))
            freeze.check(source, scope, time.monotonic() + 10)
            with patch.object(pg.time, 'time', return_value=value['expires_unix'] + 1):
                with self.assertRaises(RuntimeError):
                    freeze.check(source, scope, time.monotonic() + 10)
            path.write_bytes(raw + b' ')
            with self.assertRaises(RuntimeError):
                freeze.check(source, scope, time.monotonic() + 10)

    def test_missing_freeze_cannot_be_an_advisory_lock_flag(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'freeze.json'
            raw = bundle.canonical({'advisory_locked': True})
            path.write_bytes(raw)
            with self.assertRaises(ValueError):
                pg.FreezeEvidence(path, bundle.digest(raw)).check({}, {}, time.monotonic() + 10)

    def test_normalization_changes_only_restrict_token_lines(self):
        first = '\\restrict abc123\nSELECT 42;\n\\unrestrict abc123\n'
        second = first.replace('abc123', 'def456')
        self.assertEqual(pg.normalized_restore_sql(first), pg.normalized_restore_sql(second))
        self.assertNotEqual(pg.normalized_restore_sql(first), pg.normalized_restore_sql(second.replace('42', '43')))

    def test_environment_does_not_inherit_secrets_or_pgsettings(self):
        tools = object.__new__(pg.PgTools)
        tools.root = Path(tempfile.gettempdir()) / 'synthetic-pg-root'
        endpoint = pg.Endpoint('127.0.0.1', 12345, 'synthetic_db', 'synthetic_owner', 'disable')
        with patch.dict(os.environ, {'PGPASSWORD': 'synthetic-secret', 'PGSERVICE': 'synthetic-service',
                                     'DATABASE_URL': 'synthetic-url', 'PGOPTIONS': 'unsafe'}):
            env = tools.env(endpoint)
        self.assertNotIn('PGPASSWORD', env)
        self.assertNotIn('PGSERVICE', env)
        self.assertNotIn('DATABASE_URL', env)
        self.assertNotEqual(env['PGOPTIONS'], 'unsafe')

    def test_subprocess_error_sanitized(self):
        tools = object.__new__(pg.PgTools)
        tools.root = Path(tempfile.gettempdir())
        tools.bin = tools.root
        endpoint = pg.Endpoint('127.0.0.1', 12345, 'synthetic_db', 'synthetic_owner', 'disable')
        with patch.object(pg.subprocess, 'Popen', side_effect=RuntimeError('synthetic-sensitive-error')):
            with self.assertRaisesRegex(RuntimeError, '^PostgreSQL subprocess failed$'):
                tools.run('psql', [], endpoint, time.monotonic() + 1)

    def test_stream_limits_cover_long_lines_and_stderr(self):
        class Process:
            def __init__(self, stdout, stderr):
                self.stdout, self.stderr, self.killed = io.BytesIO(stdout), io.BytesIO(stderr), False
            def poll(self):
                return -1 if self.killed else None
            def kill(self):
                self.killed = True
        for line_mode in (False, True):
            for stderr in (False, True):
                with self.subTest(line_mode=line_mode, stderr=stderr):
                    proc = Process(b'' if stderr else b'x'*4096, b'x'*4096 if stderr else b'')
                    with patch.object(bundle, 'MAX_BYTES', 1024):
                        streams = pg.BoundedOutput(proc, line_mode=line_mode)
                        streams.join()
                    self.assertTrue(proc.killed)
                    self.assertTrue(streams.failed)
                    self.assertEqual(streams.chunks, [])

    def test_freeze_expiry_must_be_short_and_finite(self):
        source, scope = {'system': 'synthetic', 'database': '123'}, {'synthetic': True}
        value = {'format': 'external-pg-freeze-v1', 'source': source,
                 'scope_sha256': bundle.digest(bundle.canonical(scope)), 'expires_unix': time.time()+7200,
                 'controller_ref': 'synthetic-controller',
                 'assertion': 'all-sequence-role-ddl-provider-writers-stopped-until-release'}
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/'freeze.json'
            raw = bundle.canonical(value)
            path.write_bytes(raw)
            with self.assertRaises(RuntimeError):
                pg.FreezeEvidence(path, bundle.digest(raw)).check(source, scope, time.monotonic()+10)

    def test_negative_probe_cannot_accept_unknown_output(self):
        value = program_value()
        review = {'id': 'deny', 'role': 'synthetic_reader', 'allowed': False}
        value['probes']['deny'].update(review=review, expected_output='allowed', denied_output='denied')
        raw = bundle.canonical(value)
        adapter = object.__new__(pg.DrillAdapter)
        adapter.program = pg.ReviewedProgram(raw, bundle.digest(raw))
        adapter.check = lambda lease: None
        class UnknownOutput:
            def query(self, sql):
                return 'synthetic_reader' if sql == 'SELECT current_user;' else 'unexpected'
        adapter.session = UnknownOutput()
        with self.assertRaises(RuntimeError):
            adapter.probe_access({}, [review])

    def test_negative_probe_requires_explicit_denial_evidence(self):
        value = program_value()
        value['probes']['deny']['review']['allowed'] = False
        raw = bundle.canonical(value)
        with self.assertRaises(RuntimeError):
            pg.ReviewedProgram(raw, bundle.digest(raw))

    def test_unknown_toc_kind_refused_before_creation(self):
        with tempfile.TemporaryDirectory() as root:
            class Tools:
                def run(self, *args):
                    return b'1; 0 0 SUBSCRIPTION synthetic_subscription\n'
            tools = Tools()
            tools.root = Path(root)
            adapter = pg.DrillAdapter(tools, None, None,
                source={'system': 'synthetic', 'database': '1'}, record_directory=root)
            with self.assertRaises(RuntimeError):
                adapter.inspect_archive(b'synthetic-archive')
            self.assertIsNone(adapter.lease)

    def test_durable_identity_tampering_blocks_cleanup(self):
        with tempfile.TemporaryDirectory() as root:
            adapter = object.__new__(pg.DrillAdapter)
            adapter.source = {'system': 'synthetic', 'database': '1'}
            adapter.lease = {'identity': {'system': 'synthetic', 'database': '2'}, 'nonce': 'synthetic'}
            adapter.intent = {'synthetic': 'original'}
            adapter.record = Path(root) / 'intent.json'
            adapter.record.write_bytes(bundle.canonical({'synthetic': 'changed'}))
            adapter.quarantined = True
            adapter.session = None
            with self.assertRaises(RuntimeError):
                adapter.dispose(adapter.lease)


if __name__ == '__main__':
    unittest.main()
