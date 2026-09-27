"""Owned loopback PG only; actual queue migration + synthetic auth fixtures.

No live source/auth/network. Native pgcrypto is used for PINs. SQLite commits and
HTTP publication are deliberately simulated owner attestations, not acceptance
of the local worker, provider deployment or Supabase JWT/PostgREST.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

import test_registry_postgres as harness
from test_live_registry_postgres import LiveRegistryTests, MIGRATION as REGISTRY
from test_review_intake_postgres import selected_protections, PIN

S1, D1, U1, U2, U3 = harness.S1, harness.D1, harness.U1, harness.U2, harness.U3
MIGRATION = harness.ROOT / "web/supabase/migrations/202609280102_school_change_queue.sql"
BASE, TARGET, SNAPSHOT, MANIFEST, CODE = (c * 64 for c in "abcde")


def literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, (dict, list)):
        return "'" + json.dumps(value, separators=(",", ":")).replace("'", "''") + "'::jsonb"
    return "'" + str(value).replace("'", "''") + "'"


class LiveSchoolQueueTests(unittest.TestCase):
    cluster = None
    sql = LiveRegistryTests.sql

    def setUp(self):
        harness.SyntheticPostgresTests.setUp(self)
        self.sql(selected_protections())
        self.sql(REGISTRY.read_text(encoding="utf-8"))
        self.sql(MIGRATION.read_text(encoding="utf-8"))

    def request(self, request_id=None, *, value=54, pin=PIN, user=U3, role="authenticated", fingerprint=None, fails=None):
        request_id = request_id or str(uuid.uuid4())
        self.sql("SELECT * FROM public.request_school_deviation(" + ",".join(map(literal,
            (request_id,D1,value,"synthetic reason",pin,BASE,50,fingerprint))) + ");", role=role,user=user,fails=fails)
        return request_id

    def publish(self, request_id=None, *, fails=None):
        request_id = request_id or str(uuid.uuid4())
        self.sql(f"SELECT * FROM public.request_school_publication('{request_id}','{BASE}');",role="authenticated",user=U3,fails=fails)
        return request_id

    def payload(self, request_id):
        return json.loads(self.sql(f"SELECT public.school_change_worker_payload('{request_id}');"))

    def claim(self, request_id, *, source=BASE, fails=None):
        revision = self.payload(request_id)["revision"]
        result = self.sql(f"SELECT public.claim_school_change('{request_id}',{revision},'{source}',300);",fails=fails)
        return None if fails else json.loads(result)

    def ack(self, row, stage, *, source=TARGET, receipts=None, evidence=None, fails=None):
        pins = (None,None,None) if stage=="adopted" else (SNAPSHOT,MANIFEST,CODE)
        args = (row["request_id"],row["lease_token"],stage,source,*pins,evidence,receipts)
        result = self.sql("SELECT public.ack_school_change(" + ",".join(map(literal,args)) + ");",fails=fails)
        return None if fails else json.loads(result)

    def adopted(self):
        row = self.claim(self.request())
        return self.ack(row,"adopted")

    def generated(self):
        adopted = self.adopted()
        publication = self.claim(self.publish(),source=TARGET)
        receipts = [{"request_id":adopted["request_id"],"receipt_sha256":"f"*64}]
        row = self.ack(publication,"generated",receipts=receipts)
        return row,receipts

    def evidence(self, row):
        return {"destination":"https://school.manabi-map.app","manifest_sha256":MANIFEST,
                "observed_at":datetime.now(timezone.utc).isoformat(),"artifact_count":3,
                "artifacts_sha256":"f"*64,"deployment_id":"invented-deployment",
                "application_receipts_sha256":row["application_receipts_sha256"]}

    def preflight(self, row, receipt_set, *, fails=None, role="postgres", **override):
        fields = dict(request_id=row["request_id"],lease_token=row["lease_token"],revision=row["revision"],
                      source=TARGET,snapshot=SNAPSHOT,manifest=MANIFEST,code=CODE,receipts=receipt_set)
        fields.update(override)
        raw=self.sql("SELECT public.school_publication_preflight(" + ",".join(map(literal,fields.values())) + ");",
                     role=role,user=U3,fails=fails)
        return None if fails else json.loads(raw)

    def test_preflight_checks_fresh_revision_lease_and_every_pin(self):
        row,receipts=self.generated()
        result=self.preflight(row,receipts)
        self.assertIs(result["advisory_only"],True)
        checked=datetime.fromisoformat(result["checked_at"])
        until=datetime.fromisoformat(result["valid_until"])
        self.assertGreater((until-checked).total_seconds(),0)
        self.assertLessEqual((until-checked).total_seconds(),30)
        for key,value in (("revision",row["revision"]-1),("lease_token",str(uuid.uuid4())),("source",BASE),
                          ("snapshot",BASE),("manifest",BASE),("code",BASE),("receipts",[])):
            self.preflight(row,receipts,**{key:value},fails="stale publication")
        for role in ("anon","authenticated","service_role"):
            self.preflight(row,receipts,role=role,fails="permission denied")
        self.sql(f"UPDATE public.school_change_requests SET lease_until=clock_timestamp()-interval '1 second' WHERE id='{row['request_id']}';")
        self.preflight(row,receipts,fails="stale publication")

    def test_preflight_rejects_withdrawal_and_changed_cohort(self):
        self.sql(f"SELECT public.save_mine_consent('{S1}',true);",role="authenticated",user=U1)
        fp=self.sql(f"SELECT public.school_submission_fingerprint('{D1}');")
        adopted=self.ack(self.claim(self.request(fingerprint=fp)),"adopted")
        row=self.claim(self.publish(),source=TARGET)
        receipts=[{"request_id":adopted["request_id"],"receipt_sha256":"f"*64}]
        row=self.ack(row,"generated",receipts=receipts)
        self.preflight(row,receipts)
        self.sql(f"SELECT public.save_mine_consent('{S1}',false);",role="authenticated",user=U1)
        self.preflight(row,receipts,fails="current consent differs")
        self.sql(f"UPDATE public.school_change_requests SET state='blocked' WHERE id='{adopted['request_id']}';")
        self.preflight(row,receipts,fails="cohort")

    def reject(self, row, *, evidence=None, fails=None, role="postgres"):
        if evidence is None:
            evidence={"decision":"cancelled_before_adoption" if row["kind"]=="deviation" else "release_unpublished_cohort",
                      "local_source_sha256":TARGET,"local_receipts_sha256":"f"*64,
                      "observed_at":datetime.now(timezone.utc).isoformat(),
                      "request_ids":[row["request_id"]] if row["kind"]=="deviation" else row["included_request_ids"]}
        raw=self.sql("SELECT public.reject_school_change(" + ",".join(map(literal,
            (row["request_id"],row["revision"],evidence))) + ");",role=role,user=U3,fails=fails)
        return None if fails else json.loads(raw)

    def test_manual_recovery_cancels_unadopted_conflict_and_releases_unpublished_cohort(self):
        adopted=self.adopted()
        conflict=self.request(value=56)
        publication=self.payload(self.publish())
        claimed=self.claim(conflict,source=TARGET)
        self.reject(claimed,fails="live worker")
        failed=json.loads(self.sql(f"SELECT public.fail_school_change('{conflict}','{claimed['lease_token']}','source_conflict');"))
        self.reject(failed,evidence={},fails="evidence required")
        self.assertEqual(self.reject(failed)["state"],"rejected")
        self.sql(f"UPDATE public.school_change_requests SET lease_until=clock_timestamp()-interval '1 second' WHERE id='{adopted['request_id']}';")
        self.assertEqual(self.reject(publication)["state"],"rejected")
        self.assertEqual(self.payload(adopted["request_id"])["state"],"adopted")
        fresh=self.payload(self.publish())
        self.assertEqual(fresh["included_request_ids"],[adopted["request_id"]])

    def test_recovery_cannot_erase_adoption_or_possible_publication(self):
        row,receipts=self.generated()
        for rid in (row["request_id"],receipts[0]["request_id"]):
            self.sql(f"UPDATE public.school_change_requests SET lease_until=clock_timestamp()-interval '1 second' WHERE id='{rid}';")
            self.reject(self.payload(rid),fails="generated" if rid==row["request_id"] else "adopted")
        fresh=self.payload(self.request())
        for role in ("anon","authenticated","service_role"):
            self.reject(fresh,role=role,fails="permission denied")

    def test_heartbeat_requires_current_lease_and_revision_and_records_event(self):
        row=self.claim(self.request())
        def renew(value,seconds=300,role="postgres",fails=None):
            raw=self.sql("SELECT public.renew_school_change_lease(" + ",".join(map(literal,
                (value["request_id"],value["lease_token"],value["revision"],seconds))) + ");",role=role,user=U3,fails=fails)
            return None if fails else json.loads(raw)
        updated=renew(row)
        self.assertEqual(updated["revision"],row["revision"]+1)
        self.assertEqual(updated["lease_token"],row["lease_token"])
        renew(row,fails="stale")
        renew(updated,301,fails="stale")
        for role in ("anon","authenticated","service_role"): renew(updated,role=role,fails="permission denied")
        self.assertEqual(self.sql("SELECT count(*) FROM public.school_change_events WHERE action='lease_renewed';"),"1")
        self.sql(f"UPDATE public.school_change_requests SET lease_until=clock_timestamp()-interval '1 second' WHERE id='{row['request_id']}';")
        renew(updated,fails="stale")

    def test_auth_and_pin_lockout_no_correction_or_implicit_publication(self):
        self.request(user=U2,fails="admin authentication")
        self.request(user=None,fails="admin authentication")
        self.request(role="anon",fails="permission denied")
        for _ in range(5): self.request(pin="wrong")
        self.request()
        self.assertEqual(self.sql("SELECT count(*) FROM public.school_change_requests;"),"0")
        self.assertEqual(self.sql("SELECT count(*) FROM public.deviation_correction_logs;"),"1")
        self.sql("UPDATE public.admin_pin_attempts SET locked_until=now()-interval '1 minute';")
        rid = self.request()
        self.assertEqual(self.payload(rid)["state"],"received")
        self.assertEqual(self.sql("SELECT count(*) FROM public.school_change_requests WHERE kind='publish';"),"0")

    def test_idempotency_immutable_body_and_private_worker_api(self):
        rid=self.request()
        self.request(rid)
        self.request(rid,value=55,fails="different content")
        self.assertEqual(self.sql("SELECT count(*) FROM public.school_change_events;"),"1")
        self.sql(f"UPDATE public.school_change_requests SET new_value=55 WHERE id='{rid}';",fails="immutable")
        self.sql("DELETE FROM public.school_change_events;",fails="append-only")
        for role in ("anon","authenticated","service_role"):
            self.sql("SELECT public.list_school_changes();",role=role,user=U3,fails="permission denied")
            self.sql(f"UPDATE public.school_change_requests SET state='publication_confirmed' WHERE id='{rid}';",
                     role=role,user=U3,fails="permission denied")
        self.assertEqual(self.sql("SELECT count(*) FROM public.school_change_requests;",role="authenticated",user=U2),"0")
        self.assertEqual(self.sql("SELECT count(*) FROM public.school_change_requests;",role="authenticated",user=U3),"1")
        self.assertNotIn("requested_by",self.payload(rid))

    def test_concurrent_claim_one_winner_expiry_new_token_fences_old_worker(self):
        rid=self.request()
        statement=f"SET ROLE postgres; SELECT public.claim_school_change('{rid}',1,'{BASE}',300);"
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.cluster.psql(statement,self.dbname),range(2)))
        self.assertEqual(sum(r.returncode==0 for r in results),1)
        old=self.payload(rid)
        self.sql(f"UPDATE public.school_change_requests SET lease_until=now()-interval '1 second' WHERE id='{rid}';")
        fresh=self.claim(rid)
        self.assertNotEqual(old["lease_token"],fresh["lease_token"])
        self.ack(old,"adopted",fails="invalid school ACK")
        self.ack(fresh,"adopted")
        self.ack(fresh,"adopted")
        self.assertEqual(self.sql("SELECT count(*) FROM public.deviation_correction_logs;"),"2")

    def test_consent_fingerprint_changes_with_withdrawal_and_blocks_adoption(self):
        self.sql(f"SELECT public.save_mine_consent('{S1}',true);",role="authenticated",user=U1)
        fp=self.sql(f"SELECT submission_fingerprint FROM public.get_school_deviation_submissions('{S1}',1);",role="authenticated",user=U3)
        rid=self.request(fingerprint=fp)
        row=self.claim(rid)
        self.sql(f"SELECT public.save_mine_consent('{S1}',false);",role="authenticated",user=U1)
        self.assertEqual(self.sql(f"SELECT count(*) FROM public.get_school_deviation_submissions('{S1}',1);",role="authenticated",user=U3),"0")
        self.ack(row,"adopted",fails="current submission consent")
        self.request(fingerprint=fp,fails="current submission consent")
        self.assertEqual(self.payload(rid)["state"],"claimed")

    def test_adoption_does_not_generate_and_explicit_publication_freezes_request_set(self):
        adopted=self.adopted()
        self.ack(adopted,"generated",receipts=[],fails="invalid school ACK")
        pid=self.publish()
        self.publish(pid)
        self.publish(fails="already pending")
        later=self.request(value=56)
        row=self.payload(pid)
        self.assertEqual(row["included_request_ids"],[adopted["request_id"]])
        self.assertIsNone(self.payload(later)["publication_request_id"])
        self.claim(later,source=TARGET,fails="later correction waits")
        publication=self.claim(pid,source=TARGET)
        self.ack(publication,"generated",receipts=[],fails="complete application receipt set")

    def test_later_correction_claim_waits_until_explicit_publication_is_observed(self):
        row,receipts=self.generated()
        later=self.request(value=56)
        self.claim(later,source=TARGET,fails="later correction waits")
        self.ack(row,"publication_confirmed",receipts=receipts,evidence=self.evidence(row))
        self.assertEqual(self.claim(later,source=TARGET)["state"],"claimed")

    def test_received_cohort_must_be_adopted_before_publication_claim(self):
        rid=self.request()
        pid=self.publish()
        self.claim(pid,source=TARGET,fails="not adopted")
        self.ack(self.claim(rid),"adopted")
        self.assertEqual(self.claim(pid,source=TARGET)["state"],"claimed")

    def test_complete_pinned_publication_updates_children_only_after_observation(self):
        row,receipts=self.generated()
        self.assertEqual(self.payload(receipts[0]["request_id"])["state"],"generated")
        evidence=self.evidence(row)
        self.ack(row,"publication_confirmed",receipts=receipts,evidence=evidence)
        self.ack(row,"publication_confirmed",receipts=receipts,evidence=evidence)
        self.assertEqual(self.payload(receipts[0]["request_id"])["state"],"publication_confirmed")
        self.assertEqual(self.sql("SELECT count(*) FROM public.deviation_correction_logs;"),"2")

    def test_publication_requires_exact_pins_receipt_set_destination_and_finite_time(self):
        row,receipts=self.generated()
        for field,value in (("manifest_sha256","0"*64),("application_receipts_sha256","0"*64),
                            ("destination",None),("destination","https://example.invalid"),
                            ("observed_at","infinity"),("artifact_count",0),("deployment_id"," ")):
            with self.subTest(field=field,value=value):
                evidence=dict(self.evidence(row),**{field:value})
                self.ack(row,"publication_confirmed",receipts=receipts,evidence=evidence,fails="publication")
        self.ack(row,"publication_confirmed",source=BASE,receipts=receipts,evidence=self.evidence(row),fails="publication")
        self.assertEqual(self.payload(row["request_id"])["state"],"generated")

    def test_current_consent_rechecked_for_entire_publication_set(self):
        self.sql(f"SELECT public.save_mine_consent('{S1}',true);",role="authenticated",user=U1)
        fp=self.sql(f"SELECT public.school_submission_fingerprint('{D1}');")
        adopted=self.ack(self.claim(self.request(fingerprint=fp)),"adopted")
        row=self.claim(self.publish(),source=TARGET)
        receipts=[{"request_id":adopted["request_id"],"receipt_sha256":"f"*64}]
        row=self.ack(row,"generated",receipts=receipts)
        self.sql(f"SELECT public.save_mine_consent('{S1}',false);",role="authenticated",user=U1)
        self.ack(row,"publication_confirmed",receipts=receipts,evidence=self.evidence(row),fails="consent differs")

    def test_requests_survive_old_school_removal_and_legacy_rpcs_fail_closed(self):
        self.sql("DROP TABLE public.school_departments; DROP TABLE public.schools;")
        self.request()
        self.sql(f"SELECT * FROM public.correct_school_deviation('{D1}',54,'reason','{PIN}');",role="authenticated",user=U3,fails="moved to")
        self.sql("SELECT * FROM public.get_deviation_review_queue();",role="authenticated",user=U3,fails="moved to")
        self.sql(f"SELECT public.save_mine_consent('{S1}',true);",role="authenticated",user=U1)
        self.assertEqual(self.sql(f"SELECT school_id FROM public.get_school_deviation_submissions('{S1}',1);",role="authenticated",user=U3),S1)

    def test_generation_failure_preserves_request_and_reclaims_same_pins(self):
        adopted=self.adopted()
        row=self.claim(self.publish(),source=TARGET)
        self.sql(f"SELECT public.fail_school_change('{row['request_id']}','{row['lease_token']}','generation_failed');")
        self.assertEqual(self.payload(row["request_id"])["state"],"blocked")
        self.claim(row["request_id"],source=BASE,fails="source differs")
        fresh=self.claim(row["request_id"],source=TARGET)
        receipts=[{"request_id":adopted["request_id"],"receipt_sha256":"f"*64}]
        self.ack(fresh,"generated",receipts=receipts)

    def test_cursor_scope_and_runner_reach_publication_beyond_completed_and_blocked(self):
        # Owner-created synthetic queue history; these rows do not claim that a
        # real SQLite adoption or external publication was performed.
        ids=[str(uuid.uuid4()) for _ in range(105)]
        values=[]
        for index,identifier in enumerate(ids):
            state='adopted' if index<80 else 'blocked'
            values.append(f"('{identifier}','deviation','{U3}','{S1}','{D1}',54,'synthetic history',"
                          f"'{BASE}',50,'{state}','{TARGET}',now()-interval '1 day'+interval '{index} seconds')")
        self.sql("INSERT INTO public.school_change_requests(id,kind,requested_by,school_id,department_id,"
                 "new_value,reason,expected_generation,expected_value,state,adopted_source_sha256,created_at) VALUES "+','.join(values)+";")
        publication=self.publish()
        sys.path.insert(0,str(harness.ROOT/'scripts/local-data'))
        import school_live_pg as transport
        import school_live_runner as runner
        calls=[]
        test=self
        class NativeRpc:
            def __init__(self,**kwargs): self.scope=kwargs.get('allowed_request_ids')
            def rpc(self,name,params,*,timeout_seconds=30):
                calls.append((name,dict(params)))
                raw=transport._sql(name,params,test.dbname,timeout_seconds,self.scope)
                return transport._json(test.sql(raw.decode()).encode())
        pg=NativeRpc()
        first=pg.rpc('list_school_changes',{'p_limit':100})
        self.assertEqual([row['request_id'] for row in first],ids[:100])
        # A cursor remains usable after its row becomes terminal.
        self.sql(f"UPDATE public.school_change_requests SET state='rejected' WHERE id='{ids[99]}';")
        second=pg.rpc('list_school_changes',{'p_limit':100,'p_after_id':ids[99]})
        self.assertEqual([row['request_id'] for row in second],ids[100:]+[publication])
        scoped=NativeRpc(allowed_request_ids={publication})
        self.assertEqual(scoped.rpc('list_school_changes',{'p_limit':1})[0]['request_id'],publication)
        self.sql(f"SELECT * FROM public.list_school_changes(1,'{uuid.uuid4()}');",fails='invalid school request page')
        for role in ('anon','authenticated','service_role'):
            self.sql('SELECT * FROM public.list_school_changes();',role=role,user=U3,fails='permission denied')
        with tempfile.TemporaryDirectory(prefix='school-queue-runner-') as temporary:
            config={'state_root':temporary,'source':str(Path(temporary)/'source.sqlite'),
                    'timeout_seconds':30,'psql_executable':str(self.cluster.binary/'psql.exe'),
                    'pg_sslrootcert':str(Path(temporary)/'synthetic.pem'),'allowed_request_ids':None,
                    'max_bytes':1024}
            environment={key:'synthetic' for key in runner.PG_KEYS}
            environment.update(PGSSLMODE='verify-full',PGSSLROOTCERT=config['pg_sslrootcert'])
            state={'anchor':{},'history':[],'completed':{identifier:'adopted' for identifier in ids[:80]}}
            calls.clear()
            with patch.object(runner,'read_state',return_value=state), \
                 patch.object(runner.controller,'run_request',return_value={'state':'dry-run'}) as run:
                outcome=runner.execute(config,'batch',{'pg_environment':environment,'publisher_environment':{}},
                                       limit=25,apply=False,pg_factory=NativeRpc)
            self.assertEqual([item['id'] for item in outcome['items']],[publication])
            self.assertEqual(run.call_args.kwargs['request_id'],publication)
            self.assertGreaterEqual(len(calls),2)
            self.assertIsNotNone(calls[1][1]['p_after_id'])


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--postgres-bin",type=Path,required=True)
    parser.add_argument("--scratch",type=Path,required=True)
    args=parser.parse_args()
    cluster=harness.Cluster(args.postgres_bin,args.scratch)
    LiveSchoolQueueTests.cluster=cluster
    try:
        cluster.start()
        result=cluster.psql("CREATE ROLE postgres NOLOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS;","postgres")
        if result.returncode: raise RuntimeError("synthetic migration owner setup failed")
        result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(LiveSchoolQueueTests))
        return 0 if result.wasSuccessful() else 1
    finally:
        cluster.stop()


if __name__=="__main__":
    raise SystemExit(main())
