"""Opt-in candidate RPC checks in a NEW loopback PostgreSQL cluster.

Reuses the registry harness; no production connection or new dependency. Actual
selected data_reports rate trigger and admin PIN table DDL are extracted from
the baseline. Candidate PIN uses installed pgcrypto, not a crypt stub. auth.uid
and auth.users remain synthetic shims, so no JWT/OAuth/PostgREST acceptance.
"""
import argparse
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import re
import unittest
import secrets

import test_registry_postgres as harness
from school_intake_transfer import issue_envelope, verify_envelope

HERE = Path(__file__).resolve().parent
U1, U2, U3, UA = harness.U1, harness.U2, harness.U3, harness.UA
S1, S2, D1, D2 = harness.S1, harness.S2, harness.D1, harness.D2
PIN = "synthetic-only-pin"


def selected_protections():
    baseline = (harness.ROOT / "web/supabase/baseline_schema.sql").read_text(encoding="utf-8")
    table = re.search(r"CREATE TABLE public\.admin_pin_attempts \(.*?\n\);", baseline, re.S).group()
    constraints = re.findall(r"ALTER TABLE ONLY public\.admin_pin_attempts\s+ADD CONSTRAINT .*?;", baseline, re.S)
    rate = re.search(r"CREATE FUNCTION public\.enforce_data_reports_rate_limit\(\).*?\n\$\$;", baseline, re.S).group()
    return "\n".join([
        "CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;",
        "ALTER TABLE public.admin_users ADD COLUMN pin_hash text;",
        "REVOKE ALL ON public.admin_users FROM authenticated; GRANT SELECT(user_id) ON public.admin_users TO authenticated;",
        f"UPDATE public.admin_users SET pin_hash=extensions.crypt('{PIN}',extensions.gen_salt('bf',4));",
        table, *constraints,
        "ALTER TABLE public.admin_pin_attempts ENABLE ROW LEVEL SECURITY;",
        "REVOKE ALL ON public.admin_pin_attempts FROM PUBLIC,anon,authenticated,service_role;",
        rate,
        "REVOKE ALL ON FUNCTION public.enforce_data_reports_rate_limit() FROM PUBLIC,anon,authenticated,service_role;",
        "CREATE TRIGGER data_reports_rate_limit BEFORE INSERT ON public.data_reports FOR EACH ROW EXECUTE FUNCTION public.enforce_data_reports_rate_limit();",
    ])


class ReviewIntakeTests(unittest.TestCase):
    cluster = None
    sql = harness.SyntheticPostgresTests.sql

    def setUp(self):
        harness.SyntheticPostgresTests.setUp(self)
        self.sql(selected_protections())
        self.sql((HERE / "review_intake.sql").read_text(encoding="utf-8"))

    def submit(self, *, user=U2, role="authenticated", value=55, fails=None):
        return self.sql(f"SELECT school_intake_candidate.submit('{S1}','{D1}',{value},'https://example.invalid/evidence',true);",
                        user=user, role=role, fails=fails)

    def review(self, request, *, revision=1, value=55, decision="reviewed", pin=PIN, user=U3, fails=None):
        return self.sql(f"SELECT state FROM school_intake_candidate.review('{request}',{revision},{value},'{decision}','synthetic review','{pin}');",
                        role="authenticated", user=user, fails=fails)

    def enroll_executor(self):
        self.sql(f"INSERT INTO school_intake_candidate.executors VALUES('{U1}');")

    def export_event(self, request, revision, *, user=U1, fails=None):
        result = self.sql(f"SELECT school_intake_candidate.export_transfer('{request}',{revision});",
                          role="authenticated",user=user,fails=fails)
        return json.loads(result) if fails is None else result

    def scenario(self):
        self.enroll_executor()
        request = self.submit(value=61)
        self.sql(f"SELECT school_intake_candidate.set_consent('{request}',1,true,true);",role="authenticated",user=U2)
        self.review(request,revision=2,value=61)
        events = {"reviewed": self.export_event(request,3)}
        self.sql(f"SELECT school_intake_candidate.withdraw('{request}',3);",role="authenticated",user=U2)
        events["withdrawn"] = self.export_event(request,4)
        self.sql(f"SELECT school_intake_candidate.revise('{request}',4,52,'https://example.invalid/corrected');",role="authenticated",user=U2)
        events["revised"] = self.export_event(request,5)
        self.sql(f"SELECT school_intake_candidate.set_consent('{request}',5,true,true);",role="authenticated",user=U2)
        events["reconsented"] = self.export_event(request,6)
        self.review(request,revision=6,value=52)
        events["rereviewed"] = self.export_event(request,7)
        self.sql(f"SELECT school_intake_candidate.withdraw('{request}',7);",role="authenticated",user=U2)
        events["after_rereview_withdrawn"] = self.export_event(request,8)
        return {"synthetic": True, "events": events}

    def test_transfer_export_requires_separate_executor_authorization_and_is_minimal(self):
        request = self.submit()
        self.review(request)
        for user in (U1,U2,U3):
            self.export_event(request,2,user=user,fails="authorized synthetic executor required")
        self.sql(f"SET request.jwt.claim.role='executor'; SELECT school_intake_candidate.export_transfer('{request}',2);",
                 role="authenticated",user=U2,fails="authorized synthetic executor required")
        for table in ("executors", "subjects", "transfer_events"):
            self.sql(f"SELECT * FROM school_intake_candidate.{table};",role="authenticated",user=U3,fails="permission denied")
            self.sql(f"DELETE FROM school_intake_candidate.{table};",role="authenticated",user=U3,fails="permission denied")
        self.sql(f"INSERT INTO school_intake_candidate.executors VALUES('{U2}');",role="authenticated",user=U2,fails="permission denied")
        self.sql(f"SELECT school_intake_candidate.record_transfer('{request}','reviewed');",role="authenticated",user=U3,fails="permission denied")
        self.enroll_executor()
        event = self.export_event(request,2)
        self.assertEqual(event,self.export_event(request,2))
        self.assertIsNone(event["school_consent"])
        self.assertNotEqual(event["subject_ref"],U2)
        text = json.dumps(event)
        for private in (U2,"owner_id","source","audit","pin","actor_id"):
            self.assertNotIn(private,text)
        self.export_event(request,1,fails="exportable revision missing")
        key = secrets.token_bytes(32)
        self.assertEqual(verify_envelope(issue_envelope(event,issuer="synthetic-pg",key_id="ephemeral",key=key),
                                        trusted_keys={("synthetic-pg","ephemeral"):key}),event)

    def test_exported_revision_history_correction_and_reconsent_require_review(self):
        events = self.scenario()["events"]
        self.assertEqual([e["revision"] for e in events.values()],[3,4,5,6,7,8])
        self.assertEqual([e["kind"] for e in events.values()],["reviewed","withdrawn","withdrawn","consent","reviewed","withdrawn"])
        self.assertEqual(events["revised"]["payload"]["value"],52)
        self.assertFalse(events["revised"]["consent"])
        self.assertEqual(len({e["subject_ref"] for e in events.values()}),1)
        self.assertEqual(len({e["event_id"] for e in events.values()}),6)
        request=events["reviewed"]["request_id"]
        self.assertEqual(self.export_event(request,3),events["reviewed"])

    def test_consent_and_correction_scope_owner_revision_and_membership_guards(self):
        request = self.submit()
        self.sql(f"SELECT school_intake_candidate.set_consent('{request}',1,true,true);",role="authenticated",user=U1,fails="own request required")
        self.sql(f"SELECT school_intake_candidate.set_consent('{request}',0,true,true);",role="authenticated",user=U2,fails="stale revision")
        self.sql(f"SELECT school_intake_candidate.set_consent('{request}',1,true,NULL);",role="authenticated",user=U2,fails="explicit consent required")
        self.sql(f"SELECT school_intake_candidate.revise('{request}',1,52,'source');",role="authenticated",user=U2,fails="withdrawal before correction required")
        self.sql(f"SELECT school_intake_candidate.withdraw('{request}',1);",role="authenticated",user=U2)
        self.sql(f"SELECT school_intake_candidate.revise('{request}',2,52,'source');",role="authenticated",user=U1,fails="own request required")
        self.sql(f"SELECT school_intake_candidate.revise('{request}',1,52,'source');",role="authenticated",user=U2,fails="stale revision")
        self.sql(f"SELECT school_intake_candidate.revise('{request}',2,81,'source');",role="authenticated",user=U2,fails="invalid deviation")
        self.sql(f"UPDATE public.school_departments SET school_id='{S2}' WHERE id='{D1}';")
        self.sql(f"SELECT school_intake_candidate.revise('{request}',2,52,'source');",role="authenticated",user=U2,fails="current department membership required")
        self.assertEqual(self.sql(f"SELECT revision || ':' || proposed_value || ':' || state FROM school_intake_candidate.requests WHERE id='{request}';"),"2:55:withdrawn")

    def test_consent_is_scoped_to_request_and_does_not_restore_review(self):
        first,second = self.submit(),self.submit()
        self.review(first)
        self.sql(f"SELECT school_intake_candidate.withdraw('{first}',2);",role="authenticated",user=U2)
        self.sql(f"SELECT school_intake_candidate.set_consent('{first}',3,true,true);",role="authenticated",user=U2)
        self.assertEqual(self.sql(f"SELECT state || ':' || revision FROM school_intake_candidate.requests WHERE id='{first}';"),"pending:4")
        self.assertEqual(self.sql(f"SELECT status FROM public.data_reports WHERE id='{first}';"),"pending")
        self.assertEqual(self.sql(f"SELECT state || ':' || revision || ':' || (school_consent IS NULL) FROM school_intake_candidate.requests WHERE id='{second}';"),"pending:1:true")
        self.review(first,revision=4)

    def test_submit_fixes_owner_state_value_and_audit_without_publication(self):
        request = self.submit()
        self.assertEqual(self.sql(f"SELECT owner_id || ':' || state || ':' || revision FROM school_intake_candidate.requests WHERE id='{request}';"), U2+":pending:1")
        self.assertEqual(self.sql(f"SELECT reporter_user_id || ':' || status FROM public.data_reports WHERE id='{request}';"), U2+":pending")
        self.assertEqual(self.sql("SELECT string_agg(action,',') FROM school_intake_candidate.audit;"), "submitted")
        self.assertEqual(self.review(request), "reviewed")
        self.assertEqual(self.sql(f"SELECT revision FROM school_intake_candidate.requests WHERE id='{request}';"), "2")
        self.assertEqual(self.sql("SELECT count(*) FROM public.deviation_correction_logs;"), "1")
        self.assertEqual(self.sql("SELECT count(*) FROM school_intake_candidate.requests WHERE state IN ('adopted','applied','published');"), "0")

    def test_anon_missing_identity_and_anonymous_account_rejected(self):
        self.submit(role="anon", fails="permission denied")
        self.submit(user=UA, fails="non-anonymous authentication required")
        self.submit(user=None, fails="non-anonymous authentication required")
        self.submit(user="30000000-0000-4000-8000-000000000099", fails="non-anonymous authentication required")

    def test_no_self_asserted_admin_or_direct_table_write(self):
        request = self.submit()
        self.sql(f"SET request.jwt.claim.role='admin'; SELECT * FROM school_intake_candidate.review('{request}',1,55,'reviewed','reason','{PIN}');",
                 role="authenticated", user=U2, fails="admin required")
        for table in ("requests", "audit"):
            self.assertEqual(self.sql(f"SELECT count(*) FROM school_intake_candidate.{table};",role="authenticated",user=U2), "0")
            self.sql(f"DELETE FROM school_intake_candidate.{table};",role="authenticated",user=U3,fails="permission denied")
            self.sql(f"SELECT * FROM school_intake_candidate.{table};",role="service_role",fails="permission denied")
        self.sql("UPDATE school_intake_candidate.requests SET state='reviewed';",role="authenticated",user=U3,fails="permission denied")
        self.sql("SELECT pin_hash FROM public.admin_users;",role="authenticated",user=U3,fails="permission denied")
        self.sql("SELECT * FROM public.admin_pin_attempts;",role="authenticated",user=U3,fails="permission denied")

    def test_membership_value_consent_source_and_null_department_rejected(self):
        for school, department, value, source, consent, error in (
            (S1,D2,"55","source","true","department membership required"),
            (S1,None,"55","source","true","department membership required"),
            (S1,D1,"NULL","source","true","invalid deviation"),
            (S1,D1,"81","source","true","invalid deviation"),
            (S1,D1,"55","source","false","explicit consent required"),
            (S1,D1,"55","","true","data_reports_source_len"),
        ):
            dep = "NULL" if department is None else f"'{department}'"
            self.sql(f"SELECT school_intake_candidate.submit('{school}',{dep},{value},'{source}',{consent});",
                     role="authenticated",user=U2,fails=error)
        self.assertEqual(self.sql("SELECT count(*) FROM school_intake_candidate.requests;"), "0")

    def test_existing_rate_trigger_enforces_five_per_ten_minutes_atomically(self):
        for _ in range(5):
            self.submit()
        self.submit(fails="data report rate limit exceeded")
        self.assertEqual(self.sql("SELECT count(*) FROM school_intake_candidate.requests;"), "5")
        self.assertEqual(self.sql("SELECT count(*) FROM school_intake_candidate.audit;"), "5")
        self.sql(f"UPDATE public.data_reports SET created_at=now()-interval '11 minutes' WHERE reporter_user_id='{U2}';")
        self.submit()

    def test_concurrent_rate_requests_do_not_bypass_existing_advisory_lock(self):
        statement = (f"SET ROLE authenticated; SET request.jwt.claim.sub='{U2}'; "
                     f"SELECT school_intake_candidate.submit('{S1}','{D1}',55,'https://example.invalid/evidence',true);")
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.cluster.psql(statement,self.dbname), range(6)))
        self.assertEqual(sum(result.returncode == 0 for result in results),5)
        errors = [result.stderr for result in results if result.returncode]
        self.assertEqual(len(errors),1)
        self.assertIn("data report rate limit exceeded",errors[0])
        self.assertEqual(self.sql("SELECT count(*) FROM school_intake_candidate.audit;"),"5")

    def test_real_pgcrypto_wrong_pin_lockout_and_expiry(self):
        request = self.submit()
        for _ in range(5):
            self.assertEqual(self.review(request,pin="wrong-synthetic-pin"), "")
        self.assertEqual(self.sql(f"SELECT failed_attempts || ':' || (locked_until>now()) FROM public.admin_pin_attempts WHERE user_id='{U3}';"), "5:true")
        self.assertEqual(self.review(request), "")
        self.assertEqual(self.sql("SELECT state FROM school_intake_candidate.requests;"), "pending")
        self.assertEqual(self.sql("SELECT count(*) FROM school_intake_candidate.audit;"), "1")
        self.sql(f"UPDATE public.admin_pin_attempts SET locked_until=now()-interval '1 second' WHERE user_id='{U3}';")
        self.assertEqual(self.review(request), "reviewed")
        self.assertEqual(self.sql("SELECT count(*) FROM public.admin_pin_attempts;"), "0")

    def test_review_rejects_stale_revision_changed_value_and_fake_state(self):
        request = self.submit()
        self.review(request,revision=0,fails="stale review content or revision")
        self.review(request,value=56,fails="stale review content or revision")
        for state in ("adopted","applied","published","pending","withdrawn"):
            self.review(request,decision=state,fails="invalid decision")
        self.assertEqual(self.review(request,decision="rejected"), "rejected")
        self.review(request,revision=2,fails="request not reviewable")
        self.assertEqual(self.sql("SELECT count(*) FROM school_intake_candidate.audit;"), "2")

    def test_owner_withdrawal_invalidates_old_review_without_history_loss(self):
        request = self.submit()
        self.sql(f"SELECT school_intake_candidate.withdraw('{request}',1);",role="authenticated",user=U1,fails="own request required")
        self.sql(f"SELECT school_intake_candidate.withdraw('{request}',0);",role="authenticated",user=U2,fails="stale revision")
        self.assertEqual(self.sql(f"SELECT school_intake_candidate.withdraw('{request}',1);",role="authenticated",user=U2), "2")
        self.review(request,fails="stale review content or revision")
        self.review(request,revision=2,fails="request not reviewable")
        self.sql(f"SELECT school_intake_candidate.withdraw('{request}',2);",role="authenticated",user=U2,fails="already withdrawn")
        self.assertEqual(self.sql("SELECT string_agg(action,',' ORDER BY id) FROM school_intake_candidate.audit;"), "submitted,withdrawn")
        self.assertEqual(self.sql(f"SELECT status FROM public.data_reports WHERE id='{request}';"), "pending")

    def test_withdrawal_after_review_does_not_reactivate_or_erase_review(self):
        request = self.submit()
        self.review(request)
        self.sql(f"SELECT school_intake_candidate.withdraw('{request}',2);",role="authenticated",user=U2)
        self.review(request,revision=3,fails="request not reviewable")
        self.assertEqual(self.sql("SELECT string_agg(action,',' ORDER BY id) FROM school_intake_candidate.audit;"), "submitted,reviewed,withdrawn")
        self.assertEqual(self.sql(f"SELECT status FROM public.data_reports WHERE id='{request}';"), "reviewed")

    def test_legacy_report_mutation_and_applied_never_become_review_or_publication(self):
        request = self.submit()
        self.sql(f"UPDATE public.data_reports SET status='applied',reviewed_at=now(),reviewed_by='{U3}' WHERE id='{request}';",role="authenticated",user=U3)
        self.review(request,fails="report diverged from receipt")
        self.assertEqual(self.sql("SELECT count(*) FROM school_intake_candidate.requests;"), "1")
        self.assertEqual(self.sql("SELECT state FROM school_intake_candidate.requests;"), "pending")
        self.assertEqual(self.sql("SELECT count(*) FROM school_intake_candidate.audit;"), "1")

    def test_report_content_drift_rejected_and_all_side_effects_rolled_back(self):
        request = self.submit()
        for assignment in ("proposed_value='56'", "source='different evidence'", f"department_id='{D2}'"):
            with self.subTest(assignment=assignment):
                self.sql(f"UPDATE public.data_reports SET {assignment} WHERE id='{request}';")
                self.review(request,fails="report diverged from receipt")
                self.assertEqual(self.sql("SELECT state || ':' || revision FROM school_intake_candidate.requests;"),"pending:1")
                self.assertEqual(self.sql("SELECT count(*) FROM school_intake_candidate.audit;"),"1")
                self.sql(f"UPDATE public.data_reports SET proposed_value='55',source='https://example.invalid/evidence',department_id='{D1}' WHERE id='{request}';")

    def test_department_moved_after_intake_cannot_be_reviewed(self):
        request = self.submit()
        self.sql(f"UPDATE public.school_departments SET school_id='{S2}' WHERE id='{D1}';")
        self.review(request,fails="current department membership required")
        self.assertEqual(self.sql("SELECT state || ':' || revision FROM school_intake_candidate.requests;"),"pending:1")
        self.assertEqual(self.sql("SELECT count(*) FROM school_intake_candidate.audit;"),"1")
        self.assertEqual(self.sql(f"SELECT status FROM public.data_reports WHERE id='{request}';"),"pending")

    def test_install_guard_requires_explicit_synthetic_session(self):
        result = self.cluster.psql((HERE / "review_intake.sql").read_text(encoding="utf-8"),self.dbname)
        self.assertNotEqual(result.returncode,0)
        self.assertIn("isolated synthetic registry database required",result.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--postgres-bin",type=Path,required=True)
    parser.add_argument("--scratch",type=Path,required=True)
    parser.add_argument("--export-scenario",type=Path)
    args = parser.parse_args()
    cluster = harness.Cluster(args.postgres_bin,args.scratch)
    ReviewIntakeTests.cluster = cluster
    try:
        cluster.start()
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ReviewIntakeTests))
        if result.wasSuccessful() and args.export_scenario:
            scenario_test = ReviewIntakeTests()
            scenario_test.setUp()
            data = scenario_test.scenario()
            target = args.export_scenario.resolve()
            # Keep optional private transfer events beside the isolated cluster.
            if not target.is_relative_to(args.scratch.resolve()):
                raise ValueError("scenario output must be inside this run's scratch")
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_text(json.dumps(data,sort_keys=True,indent=2)+"\n",encoding="utf-8")
        return 0 if result.wasSuccessful() else 1
    finally:
        cluster.stop()


if __name__ == "__main__":
    raise SystemExit(main())
