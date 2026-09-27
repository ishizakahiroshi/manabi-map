"""Opt-in loopback tests for the real registry preparation migration.

Reuses selected actual baseline tables/RLS and consent/family RPCs from the
synthetic harness, not a complete Supabase instance. Auth is a synthetic shim;
all UUIDs are invented. The migration itself is loaded without modification.
Run -B with --postgres-bin and a NEW --scratch directory. Never uses an existing
database or inherited PG connection settings; the owned cluster is stopped.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import re
import unittest

import test_registry_postgres as harness
from test_review_intake_postgres import selected_protections, PIN

S1, S2, S3 = harness.S1, harness.S2, harness.S3
D1, D2 = harness.D1, harness.D2
U1, U2, UA = harness.U1, harness.U2, harness.UA
D3 = "20000000-0000-4000-8000-000000000003"
MIGRATION = harness.ROOT / "web/supabase/migrations/202609280101_school_identity_registry.sql"


class LiveRegistryTests(unittest.TestCase):
    cluster = None
    data = harness.SyntheticPostgresTests.data

    def sql(self, statement, *, database=None, role=None, user=None, fails=None):
        # postgres owns fixture objects but is NOT a superuser, matching the
        # required migration ownership instead of accidentally relying on one.
        prefix = "SET ROLE postgres; SET manabi.synthetic_registry_test='on';\n"
        if user is not None:
            prefix += f"SET request.jwt.claim.sub='{user}';\n"
        if role:
            prefix += f"SET ROLE {role};\n"
        result = self.cluster.psql(prefix + statement, database or self.dbname)
        if fails is None:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn(fails, result.stderr)
        return result.stdout.strip()

    def setUp(self):
        harness.SyntheticPostgresTests.setUp(self)

    def cutover(self):
        return self.sql(MIGRATION.read_text(encoding="utf-8"))

    # Preserve existing feature checks without rewriting the candidate harness.
    test_all_five_tables_survive_old_school_delete_with_identical_contents = harness.SyntheticPostgresTests.test_all_five_tables_survive_old_school_delete_with_identical_contents
    test_null_department_still_checks_school_and_membership = harness.SyntheticPostgresTests.test_null_department_still_checks_school_and_membership
    test_owner_rls_and_registry_acl_preserved = harness.SyntheticPostgresTests.test_owner_rls_and_registry_acl_preserved
    test_consent_rpc_withdrawal_preserves_notes_and_anonymous_signin = harness.SyntheticPostgresTests.test_consent_rpc_withdrawal_preserves_notes_and_anonymous_signin
    test_report_and_audit_admin_policies_preserved = harness.SyntheticPostgresTests.test_report_and_audit_admin_policies_preserved
    # Family favorites has a known existing ambiguity. The reused test proves
    # it before applying its separate synthetic qualification candidate; this
    # migration neither fixes it nor claims it has been fixed in production.
    test_family_rpcs_enforce_membership_anonymity_and_owner_optin = harness.SyntheticPostgresTests.test_family_rpcs_enforce_membership_anonymity_and_owner_optin

    def test_membership_mismatch_rolls_back_all_new_objects_and_old_fks(self):
        for table in harness.registry.TABLES[2:]:
            with self.subTest(table=table):
                self.sql(f"UPDATE public.{table} SET department_id='{D2}' WHERE department_id='{D1}';")
                before = self.data()
                self.sql(MIGRATION.read_text(encoding="utf-8"), fails="foreign key constraint")
                self.assertEqual(self.data(), before)
                self.assertEqual(self.sql("SELECT to_regclass('public.school_id_registry') IS NULL;"), "t")
                self.assertEqual(self.sql("SELECT count(*) FROM pg_constraint WHERE contype='f' AND "
                    "conrelid IN ('public.user_school_favorites'::regclass,'public.user_school_notes'::regclass,"
                    "'public.user_school_deviations'::regclass,'public.data_reports'::regclass,"
                    "'public.deviation_correction_logs'::regclass) AND "
                    "confrelid IN ('public.schools'::regclass,'public.school_departments'::regclass);"), "8")
                self.sql(f"UPDATE public.{table} SET department_id='{D1}' WHERE department_id='{D2}';")

    def test_new_source_ids_register_atomically_and_old_identity_cannot_move(self):
        self.cutover()
        self.sql(f"INSERT INTO public.schools VALUES('{S3}'); INSERT INTO public.school_departments VALUES('{D3}','{S3}');")
        self.assertEqual(self.sql(f"SELECT school_id FROM public.department_id_registry WHERE id='{D3}';"), S3)
        self.sql(f"INSERT INTO public.user_school_deviations(user_id,school_id,department_id,value) VALUES('{U2}','{S3}','{D3}',50);", role="authenticated", user=U2)
        self.sql(f"UPDATE public.schools SET id=gen_random_uuid() WHERE id='{S3}';", fails="school identity cannot change")
        self.sql(f"UPDATE public.school_departments SET school_id='{S1}' WHERE id='{D3}';", fails="department identity cannot change")
        self.sql(f"UPDATE public.school_departments SET id=gen_random_uuid() WHERE id='{D3}';", fails="department identity cannot change")
        self.sql(f"UPDATE public.school_departments SET school_id=school_id,id=id WHERE id='{D3}';")
        self.sql(f"DELETE FROM public.school_departments WHERE id='{D3}';")
        self.sql(f"INSERT INTO public.school_departments VALUES('{D3}','{S1}');", fails="department identity cannot change school")
        self.assertEqual(self.sql(f"SELECT count(*) FROM public.school_departments WHERE id='{D3}';"), "0")
        self.assertEqual(self.sql(f"SELECT school_id FROM public.department_id_registry WHERE id='{D3}';"), S3)

    def test_append_is_private_idempotent_and_works_after_old_tables_are_removed(self):
        self.cutover()
        for role in ("anon", "authenticated", "service_role"):
            self.sql(f"SELECT public.append_school_identity('{S3}');", role=role, fails="permission denied")
            self.sql(f"SELECT public.append_department_identity('{D3}','{S1}');", role=role, fails="permission denied")
            self.sql(f"INSERT INTO public.school_id_registry VALUES('{S3}');", role=role, fails="permission denied")
        # Synthetic fixture only: production table removal is NOT in migration.
        self.sql("DROP TABLE public.school_departments; DROP TABLE public.schools;")
        self.sql(f"SELECT public.append_school_identity('{S3}'); SELECT public.append_school_identity('{S3}');"
                 f"SELECT public.append_department_identity('{D3}','{S3}'); SELECT public.append_department_identity('{D3}','{S3}');")
        self.sql(f"SELECT public.append_department_identity('{D3}','{S1}');", fails="department identity cannot change school")
        self.sql(f"INSERT INTO public.user_school_notes(user_id,school_id,note) VALUES('{U2}','{S3}','synthetic new note');", role="authenticated", user=U2)
        for statement in ("UPDATE public.school_id_registry SET id=id;", "DELETE FROM public.department_id_registry;",
                          "TRUNCATE public.school_id_registry,public.department_id_registry CASCADE;"):
            self.sql(statement, fails="append-only")
        self.assertEqual(self.sql(f"SELECT note FROM public.user_school_notes WHERE school_id='{S3}';", role="authenticated", user=U2), "synthetic new note")

    def test_failed_source_transaction_does_not_leave_registered_ids(self):
        self.cutover()
        self.sql(f"BEGIN; INSERT INTO public.schools VALUES('{S3}');"
                 f"INSERT INTO public.school_departments VALUES('{D1}','{S3}'); COMMIT;", fails="duplicate key")
        self.assertEqual(self.sql(f"SELECT count(*) FROM public.school_id_registry WHERE id='{S3}';"), "0")
        self.sql(f"INSERT INTO public.schools VALUES('{S1}') ON CONFLICT DO NOTHING;")
        self.assertEqual(self.sql("SELECT count(*) FROM public.school_id_registry;"), "2")

    def test_concurrent_append_cannot_change_membership(self):
        self.cutover()
        def append(school):
            return self.cluster.psql(f"SET ROLE postgres; SELECT public.append_department_identity('{D3}','{school}');", self.dbname)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(append, (S1,S2)))
        self.assertEqual(sum(r.returncode == 0 for r in results), 1)
        self.assertTrue(any("cannot change school" in r.stderr for r in results))
        self.assertEqual(self.sql(f"SELECT count(*) FROM public.department_id_registry WHERE id='{D3}';"), "1")

    def test_required_role_ownership_rls_and_no_source_removal(self):
        self.cutover()
        self.assertEqual(self.sql("SELECT rolsuper FROM pg_roles WHERE rolname='postgres';"), "f")
        self.assertEqual(self.sql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname='public' AND c.relname IN ('school_id_registry','department_id_registry') "
            "AND c.relrowsecurity AND c.relowner='postgres'::regrole;"), "2")
        self.assertEqual(self.sql("SELECT count(*) FROM public.schools;"), "2")
        self.assertEqual(self.sql("SELECT count(*) FROM public.school_departments;"), "2")
        self.assertEqual(self.sql("SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace "
            "AND proname IN ('append_school_identity','append_department_identity') "
            "AND proowner='postgres'::regrole AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog'];"), "2")

    def test_existing_admin_correction_queue_pin_and_report_rate_limit_remain(self):
        baseline = (harness.ROOT / "web/supabase/baseline_schema.sql").read_text(encoding="utf-8")
        self.sql(selected_protections())
        self.sql("ALTER TABLE public.schools ADD COLUMN name text DEFAULT 'Synthetic school';"
                 "ALTER TABLE public.school_departments ADD COLUMN name text DEFAULT 'Synthetic department';")
        table = re.search(r"CREATE TABLE public\.school_deviation_values \(.*?\n\);", baseline, re.S)
        constraints = re.findall(r"ALTER TABLE ONLY public\.school_deviation_values\s+ADD CONSTRAINT [^;]+;", baseline)
        self.assertIsNotNone(table)
        self.sql(table.group() + "\n" + "\n".join(constraints))
        for name, signature in (("correct_school_deviation", "uuid,integer,text,text"),
                                ("get_deviation_review_queue", "uuid,integer")):
            routine = re.search(rf"CREATE FUNCTION public\.{name}\(.*?\n\$\$;", baseline, re.S)
            self.assertIsNotNone(routine)
            self.sql(routine.group() + f"\nREVOKE ALL ON FUNCTION public.{name}({signature}) FROM PUBLIC,anon,authenticated;"
                     f"GRANT EXECUTE ON FUNCTION public.{name}({signature}) TO authenticated;")
        self.cutover()
        for _ in range(5):
            self.assertEqual(self.sql(f"SELECT * FROM public.correct_school_deviation('{D1}',54,'synthetic reason','wrong');",
                                     role="authenticated", user=harness.U3), "")
        self.assertEqual(self.sql(f"SELECT locked_until > now() FROM public.admin_pin_attempts WHERE user_id='{harness.U3}';"), "t")
        self.assertEqual(self.sql(f"SELECT * FROM public.correct_school_deviation('{D1}',54,'synthetic reason','{PIN}');",
                                 role="authenticated", user=harness.U3), "")
        self.sql(f"UPDATE public.admin_pin_attempts SET locked_until=now()-interval '1 minute' WHERE user_id='{harness.U3}';")
        self.assertEqual(self.sql(f"SELECT new_value FROM public.correct_school_deviation('{D1}',54,'synthetic reason','{PIN}');",
                                 role="authenticated", user=harness.U3), "54")
        self.assertEqual(self.sql("SELECT count(*) FROM public.deviation_correction_logs;"), "2")
        self.sql(f"SELECT public.save_mine_consent('{S1}',true);", role="authenticated", user=U1)
        self.assertEqual(self.sql(f"SELECT official_value FROM public.get_deviation_review_queue('{S1}',1);",
                                 role="authenticated", user=harness.U3), "54")
        self.sql(f"SELECT * FROM public.get_deviation_review_queue('{S1}',1);", role="authenticated", user=U2, fails="admin required")
        for _ in range(5):
            self.sql(f"INSERT INTO public.data_reports(school_id,department_id,field,proposed_value,source,reporter_user_id) "
                     f"VALUES('{S1}','{D1}','other','synthetic report','https://example.invalid','{U2}');", role="authenticated", user=U2)
        self.sql(f"INSERT INTO public.data_reports(school_id,field,proposed_value,source,reporter_user_id) "
                 f"VALUES('{S1}','other','synthetic report','https://example.invalid','{U2}');",
                 role="authenticated", user=U2, fails="data report rate limit exceeded")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--postgres-bin", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    args = parser.parse_args()
    cluster = harness.Cluster(args.postgres_bin, args.scratch)
    LiveRegistryTests.cluster = cluster
    try:
        cluster.start()
        role = cluster.psql("CREATE ROLE postgres NOLOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS;", "postgres")
        if role.returncode:
            raise RuntimeError("synthetic migration owner setup failed")
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(LiveRegistryTests))
        return 0 if result.wasSuccessful() else 1
    finally:
        cluster.stop()


if __name__ == "__main__":
    raise SystemExit(main())
