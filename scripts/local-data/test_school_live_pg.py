"""Synthetic environment/pipe tests; opt-in native SQL compiler test is loopback only."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import school_live_pg as pg

RID='10000000-0000-4000-8000-000000000001'
OTHER='10000000-0000-4000-8000-000000000002'
TOKEN='20000000-0000-4000-8000-000000000001'
HASH='a'*64


def payload():
    value=dict.fromkeys(pg.PAYLOAD_KEYS)
    value.update(request_id=RID,kind='deviation',school_id=RID,department_id=OTHER,new_value=55,
                 reason='invented correction',expected_generation=HASH,expected_value=50,state='claimed',revision=2,
                 lease_token=TOKEN,lease_until=(datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat(),
                 included_request_ids=[],claimed_source_sha256=HASH)
    return value


class SchoolPgTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='school-pg-unit-')
        self.addCleanup(self.temp.cleanup)
        root=Path(self.temp.name)
        self.executable=root/'psql.exe'; self.executable.touch()
        self.ca=root/'synthetic-ca.pem'; self.ca.write_text('invented certificate placeholder',encoding='ascii')
        self.environment=dict(PGHOST='synthetic.invalid',PGPORT='5432',PGDATABASE='synthetic',PGUSER='postgres',
          PGPASSWORD='invented-password-only',PGSSLMODE='verify-full',PGSSLROOTCERT=str(self.ca))
        self.client=pg.SchoolLivePg(psql_executable=self.executable,pg_environment=self.environment)

    def call(self,name='school_change_worker_payload',params=None,response=None):
        with patch.object(pg,'_run',return_value=json.dumps(payload() if response is None else response).encode()) as run:
            result=self.client.rpc(name,{'p_request_id':RID} if params is None else params)
        return result,run.call_args

    def test_explicit_environment_tls_and_no_secret_or_body_in_argv(self):
        with patch.dict(os.environ,{'PGOPTIONS':'malicious','PGPASSWORD':'ambient-secret','PGSERVICE':'ambient-service','UNRELATED_SECRET':'private'}):
            result,args=self.call()
        command,env,raw,timeout,maximum=args.args
        self.assertEqual(result['request_id'],RID)
        self.assertEqual(command[1:],['-X','-qAt','--no-password','--set=ON_ERROR_STOP=1','--file=-'])
        self.assertNotIn(self.environment['PGPASSWORD'],' '.join(command)+raw.decode())
        self.assertNotIn(RID,' '.join(command))
        self.assertEqual(env['PGPASSWORD'],self.environment['PGPASSWORD'])
        self.assertEqual(env['PGSSLMODE'],'verify-full')
        self.assertNotIn('PGSERVICE',env); self.assertNotIn('UNRELATED_SECRET',env)
        self.assertNotIn('malicious',env['PGOPTIONS'])
        self.assertIn(b'BEGIN READ ONLY',raw)
        self.assertIn(b'SET LOCAL statement_timeout=30000',raw)
        self.assertIn(b'SET LOCAL lock_timeout=5000',raw)
        self.assertIn(b'owner endpoint mismatch',raw)
        self.assertEqual(maximum,pg.MAX_OUTPUT)

    def test_configuration_rejects_implicit_settings_uri_and_tls_downgrade(self):
        for changed in ({'PGSSLMODE':'require'},{'PGSERVICE':'x'},{'PGDATABASE':'postgres sslmode=disable'},
                        {'PGUSER':'postgres password=x'},{'PGHOST':'host1,host2'},{'PGPORT':'0'},
                        {'PGSSLROOTCERT':'relative.pem'},{'PGPASSWORD':''}):
            with self.subTest(changed=list(changed)):
                with self.assertRaises(pg.SchoolPgError):
                    pg.SchoolLivePg(psql_executable=self.executable,pg_environment={**self.environment,**changed})

    def test_fixed_rpc_parameter_names_types_limits_and_scope(self):
        invalid=[('request_school_publication',{}),('school_change_worker_payload; DROP TABLE x',{}),
          ('school_change_worker_payload',{'p_request_id':RID,'sql':'SELECT 1'}),
          ('school_change_worker_payload',{'p_request_id':"' OR true --"}),
          ('claim_school_change',{'p_request_id':RID,'p_expected_revision':True,'p_source_sha256':HASH}),
          ('claim_school_change',{'p_request_id':RID,'p_expected_revision':1,'p_source_sha256':HASH,'p_lease_seconds':301}),
          ('list_school_changes',{'p_limit':101}),
          ('list_school_changes',{'p_after_id':'not-a-uuid'}),
          ('list_school_changes',{'p_request_ids':[]}),
          ('list_school_changes',{'p_request_ids':[RID,RID]}),
          ('list_school_changes',{'p_request_ids':[None]})]
        with patch.object(pg,'_run') as run:
            for name,params in invalid:
                with self.subTest(name=name), self.assertRaises(pg.SchoolPgError): self.client.rpc(name,params)
            run.assert_not_called()
        scoped=pg.SchoolLivePg(psql_executable=self.executable,pg_environment=self.environment,allowed_request_ids=[RID])
        with self.assertRaises(pg.SchoolPgError): scoped.rpc('school_change_worker_payload',{'p_request_id':OTHER})
        with patch.object(pg,'_run',return_value=json.dumps([payload()]).encode()) as run:
            self.assertEqual(len(scoped.rpc('list_school_changes',{})),1)
            self.assertIn(b'p_request_ids=>p."p_request_ids"',run.call_args.args[2])
            self.assertIn(b'"p_request_ids" uuid[]',run.call_args.args[2])
            self.assertNotIn(b'WHERE result',run.call_args.args[2])
        with patch.object(pg,'_run') as run, self.assertRaises(pg.SchoolPgError):
            scoped.rpc('list_school_changes',{'p_request_ids':[OTHER]})
        run.assert_not_called()
        _,args=self.call('list_school_changes',{'p_after_id':RID,'p_request_ids':[OTHER]},[])
        self.assertIn(b'p_after_id=>p."p_after_id"',args.args[2])

    def test_json_argument_quotes_backslashes_psql_commands_are_hex_data(self):
        attack="'; COMMIT; DROP TABLE public.school_change_requests; --\n\\! echo invented\n\\q\x00"
        evidence={'review':attack}
        _,args=self.call('reject_school_change',{'p_request_id':RID,'p_expected_revision':1,'p_evidence':evidence},
                         {**payload(),'state':'rejected','lease_until':None})
        raw=args.args[2].decode()
        self.assertNotIn('DROP TABLE',raw); self.assertNotIn('\\!',raw)
        self.assertIn(json.dumps(evidence,separators=(',',':'))[1:-1].encode().hex(),raw)
        self.assertIn('p_evidence=>p."p_evidence"',raw)
        self.assertIn('"p_evidence" jsonb',raw)

    def test_output_rejects_wrong_request_duplicate_keys_nonfinite_or_noise(self):
        values=[b'null',b'{}',b'{"x":1,"x":2}',b'{"x":NaN}',b'NOTICE\n{}',b'{}\n{}',b'\xff',
                json.dumps({**payload(),'request_id':OTHER}).encode(),
                json.dumps({**payload(),'revision':True}).encode()]
        for raw in values:
            with patch.object(pg,'_run',return_value=raw),self.subTest(raw=raw[:15]),self.assertRaises(pg.SchoolPgError):
                self.client.rpc('school_change_worker_payload',{'p_request_id':RID})

    def test_preflight_checks_exact_pins_and_short_window(self):
        params={'p_request_id':RID,'p_lease_token':TOKEN,'p_expected_revision':3,
          'p_source_sha256':HASH,'p_snapshot_content_sha256':HASH,'p_manifest_sha256':HASH,'p_code_sha256':HASH,
          'p_application_receipts':[]}
        now=datetime.now(timezone.utc)
        result={'request_id':RID,'revision':3,'advisory_only':True,'checked_at':now.isoformat(),
          'valid_until':(now+timedelta(seconds=30)).isoformat(),'source_sha256':HASH,
          'snapshot_content_sha256':HASH,'manifest_sha256':HASH,'code_sha256':HASH,'application_receipts_sha256':HASH}
        self.call('school_publication_preflight',params,result)
        for change in ({'revision':4},{'advisory_only':False},{'source_sha256':'b'*64},
                       {'valid_until':(now+timedelta(seconds=31)).isoformat()}):
            with self.assertRaises(pg.SchoolPgError): self.call('school_publication_preflight',params,{**result,**change})

    def test_sanitized_failures_and_timeout_validation(self):
        with patch.object(pg,'_run',side_effect=RuntimeError('invented-secret-diagnostic')):
            with self.assertRaises(pg.SchoolPgError) as caught: self.client.rpc('school_change_worker_payload',{'p_request_id':RID})
        self.assertNotIn('invented-secret',str(caught.exception))
        for timeout in (0,-1,True,float('inf'),float('nan'),61):
            with self.assertRaises(pg.SchoolPgError): self.client.rpc('list_school_changes',{},timeout_seconds=timeout)

    def test_mutation_response_must_confirm_exact_revision_lease_state_and_pins(self):
        claim={'p_request_id':RID,'p_expected_revision':1,'p_source_sha256':HASH}
        self.call('claim_school_change',claim)
        for changed in ({'revision':1},{'claimed_source_sha256':'b'*64},{'state':'received'},{'lease_token':None}):
            with self.assertRaises(pg.SchoolPgError): self.call('claim_school_change',claim,{**payload(),**changed})
        renew={'p_request_id':RID,'p_expected_revision':1,'p_lease_token':TOKEN}
        with self.assertRaises(pg.SchoolPgError): self.call('renew_school_change_lease',renew,{**payload(),'lease_token':OTHER})
        ack={'p_request_id':RID,'p_lease_token':TOKEN,'p_stage':'adopted','p_source_sha256':HASH}
        with self.assertRaises(pg.SchoolPgError): self.call('ack_school_change',ack)
        self.call('ack_school_change',ack,{**payload(),'state':'adopted','adopted_source_sha256':HASH})


class NativePipeTests(unittest.TestCase):
    def run_child(self,body,*,timeout=3,maximum=65536,raw=b'synthetic-input'):
        env={key:os.environ[key] for key in ('SYSTEMROOT','WINDIR') if key in os.environ}
        return pg._run([sys.executable,'-I','-c',body],env,raw,timeout,maximum)

    def test_large_stdin_and_both_output_pipes_drain_without_threads(self):
        before={t.ident for t in threading.enumerate()}
        result=self.run_child("import sys; raw=sys.stdin.buffer.read(); sys.stderr.buffer.write(b'e'*60000); sys.stderr.flush(); sys.stdout.buffer.write(str(len(raw)).encode())",raw=b'x'*60000)
        self.assertEqual(result,b'60000')
        self.assertEqual(before,{t.ident for t in threading.enumerate()})

    def test_output_cap_and_stderr_cap_kill_and_reap(self):
        for stream,size,maximum in (('stdout',1000000,1024),('stderr',1000000,65536)):
            started=time.monotonic()
            with self.assertRaises(pg.SchoolPgError):
                self.run_child(f"import sys,time; sys.stdin.buffer.read(); sys.{stream}.buffer.write(b'x'*{size}); sys.{stream}.flush(); time.sleep(30)",maximum=maximum)
            self.assertLess(time.monotonic()-started,3)

    def test_blocked_writer_and_hanging_child_end_by_deadline(self):
        before={t.ident for t in threading.enumerate()}
        captured=[]
        popen=subprocess.Popen
        def launch(*args,**kwargs):
            child=popen(*args,**kwargs); captured.append(child); return child
        started=time.monotonic()
        with patch.object(pg.subprocess,'Popen',side_effect=launch),self.assertRaises(pg.SchoolPgError):
            self.run_child('import time; time.sleep(30)',timeout=0.2,raw=b'x'*65536)
        self.assertLess(time.monotonic()-started,1.5)
        self.assertIsNotNone(captured[0].returncode)
        self.assertEqual(before,{t.ident for t in threading.enumerate()})

    def test_nonzero_exit_never_exposes_stderr(self):
        with self.assertRaises(pg.SchoolPgError) as caught:
            self.run_child("import sys; sys.stdin.buffer.read(); sys.stderr.write('invented-private'); sys.exit(2)")
        self.assertNotIn('invented-private',str(caught.exception))


@unittest.skipUnless(os.environ.get('MANABI_TEST_PG_BIN'),'explicit owned loopback PostgreSQL SQL test not enabled')
class NativeSqlTests(unittest.TestCase):
    def test_fixed_compiler_and_payload_against_actual_queue_migration(self):
        sys.path.insert(0,str(Path(__file__).parent/'sql-candidates'))
        import test_registry_postgres as harness
        from test_live_school_queue_postgres import LiveSchoolQueueTests
        with tempfile.TemporaryDirectory(prefix='school-pg-native-') as temporary:
            cluster=harness.Cluster(Path(os.environ['MANABI_TEST_PG_BIN']),Path(temporary)/'cluster')
            test=LiveSchoolQueueTests(); test.cluster=cluster
            try:
                cluster.start()
                self.assertEqual(cluster.psql('CREATE ROLE postgres NOLOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS;','postgres').returncode,0)
                test.setUp()
                identifier=test.request()
                def execute(name,params):
                    raw=pg._sql(name,params,test.dbname,10,None)
                    return pg._json(test.sql(raw.decode()).encode())
                row=execute('school_change_worker_payload',{'p_request_id':identifier})
                pg._payload(row,identifier)
                self.assertEqual(execute('list_school_changes',{})[0],row)
                self.assertEqual(execute('list_school_changes',{'p_limit':1})[0],row)
                row=execute('claim_school_change',{'p_request_id':identifier,'p_expected_revision':row['revision'],'p_source_sha256':HASH})
                pg._payload(row,identifier)
                renewed=execute('renew_school_change_lease',{'p_request_id':identifier,'p_lease_token':row['lease_token'],'p_expected_revision':row['revision']})
                self.assertEqual(renewed['revision'],row['revision']+1)
                row=execute('ack_school_change',{'p_request_id':identifier,'p_lease_token':row['lease_token'],'p_stage':'adopted','p_source_sha256':'b'*64})
                self.assertEqual(pg._payload(row,identifier)['state'],'adopted')
            finally:
                cluster.stop()


if __name__=='__main__': unittest.main(verbosity=2)
