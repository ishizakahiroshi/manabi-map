"""Opt-in isolated PostgreSQL acceptance; never connects to an existing database.

Run with -B, --postgres-bin <installed bin> --scratch <NEW local directory>.
Copies actual selected baseline DDL/policies/RPC bodies, plus the current consent
migration. auth.uid()/auth.users and old school business columns are synthetic
shims. This is not the complete Supabase schema, real authentication, rate-limit,
PIN/lockout, or device acceptance. No third-party Python modules are required.
All processes use an environment with PG settings removed and explicit endpoints.
The new cluster is stopped on success/failure and retained for inspection.
"""

import argparse
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import unittest
import uuid

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import school_registry as registry

ROOT = HERE.parents[2]
S1 = "10000000-0000-4000-8000-000000000001"
S2 = "10000000-0000-4000-8000-000000000002"
S3 = "10000000-0000-4000-8000-000000000003"
D1 = "20000000-0000-4000-8000-000000000001"
D2 = "20000000-0000-4000-8000-000000000002"
U1 = "30000000-0000-4000-8000-000000000001"
U2 = "30000000-0000-4000-8000-000000000002"
U3 = "30000000-0000-4000-8000-000000000003"
UA = "30000000-0000-4000-8000-000000000004"
GROUP = "40000000-0000-4000-8000-000000000001"


def fixture_schema():
    """Extract source statements verbatim so tests exercise actual owner policies."""
    baseline = (ROOT / "web/supabase/baseline_schema.sql").read_text(encoding="utf-8")
    chunks = ["""CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, is_anonymous boolean NOT NULL DEFAULT false);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
CREATE TABLE public.schools (id uuid PRIMARY KEY);
CREATE TABLE public.school_departments (id uuid PRIMARY KEY, school_id uuid NOT NULL
  REFERENCES public.schools(id) ON DELETE CASCADE);
CREATE TABLE public.admin_users (user_id uuid PRIMARY KEY);
GRANT SELECT ON public.admin_users TO authenticated;
"""]
    for table in (*registry.TABLES, "family_members"):
        match = re.search(rf"CREATE TABLE public\.{table} \(.*?\n\);", baseline, re.S)
        if not match:
            raise RuntimeError("missing baseline table " + table)
        chunks.append(match.group())
    for table in registry.TABLES:
        chunks.extend(re.findall(rf"ALTER TABLE ONLY public\.{table}\s+ADD CONSTRAINT .*?;", baseline, re.S))
        chunks.extend(re.findall(rf'CREATE POLICY [^\n]+ ON public\.{table}\b.*?;', baseline, re.S))
        chunks.append(f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY;")
    for table in registry.TABLES[:3]:
        # Current explicit-grants migration gives exactly CRUD to authenticated.
        chunks.append(f"GRANT SELECT, INSERT, UPDATE, DELETE ON public.{table} TO authenticated;")
    chunks.extend(["GRANT SELECT, INSERT, UPDATE ON public.data_reports TO authenticated;",
                   "GRANT SELECT ON public.deviation_correction_logs TO authenticated;"])
    for name in ("get_family_shared_favorites", "get_family_shared_notes"):
        match = re.search(rf"CREATE FUNCTION public\.{name}\(.*?\n\$\$;", baseline, re.S)
        if not match:
            raise RuntimeError("missing baseline RPC " + name)
        chunks.append(match.group())
        chunks.append(f"REVOKE ALL ON FUNCTION public.{name}(uuid) FROM PUBLIC, anon, authenticated;")
        chunks.append(f"GRANT EXECUTE ON FUNCTION public.{name}(uuid) TO authenticated;")
    chunks.append((ROOT / "web/supabase/migrations/202609180105_v0.9_save_mine_consent_atomic.sql").read_text(encoding="utf-8"))
    return "\n".join(chunks)


def fixture_rows():
    return f"""
INSERT INTO auth.users VALUES ('{U1}', false), ('{U2}', false), ('{U3}', false), ('{UA}', true);
INSERT INTO public.admin_users VALUES ('{U3}');
INSERT INTO public.schools VALUES ('{S1}'), ('{S2}');
INSERT INTO public.school_departments VALUES ('{D1}', '{S1}'), ('{D2}', '{S2}');
INSERT INTO public.user_school_favorites (user_id, school_id, priority) VALUES ('{U1}', '{S1}', 1);
INSERT INTO public.user_school_notes (user_id, school_id, note) VALUES ('{U1}', '{S1}', 'synthetic note');
INSERT INTO public.user_school_deviations (user_id, school_id, department_id, value, note)
 VALUES ('{U1}', '{S1}', '{D1}', 50, 'synthetic deviation'), ('{U1}', '{S1}', NULL, 0, 'sentinel note');
INSERT INTO public.data_reports (school_id, department_id, field, proposed_value, source, reporter_user_id)
 VALUES ('{S1}', '{D1}', 'other', 'synthetic correction', 'https://example.invalid/source', '{U1}'),
        ('{S1}', NULL, 'other', 'synthetic school correction', 'https://example.invalid/source', '{U1}');
INSERT INTO public.deviation_correction_logs (school_id, department_id, new_value, reason)
 VALUES ('{S1}', '{D1}', 50, 'synthetic correction');
INSERT INTO public.family_members (group_id, user_id, status, share_favorites, share_notes)
 VALUES ('{GROUP}', '{U1}', 'active', false, false), ('{GROUP}', '{U2}', 'active', false, false),
        ('{GROUP}', '{UA}', 'active', false, false);
"""


class SyntheticPostgresTests(unittest.TestCase):
    cluster = None

    def setUp(self):
        self.dbname = "school_registry_synthetic_" + uuid.uuid4().hex
        self.sql(f'CREATE DATABASE "{self.dbname}";', database="postgres")
        # Roles are cluster-wide and already created after the first fixture.
        ddl = fixture_schema()
        if self.cluster.roles_created:
            ddl = re.sub(r"CREATE ROLE (anon|authenticated|service_role) NOLOGIN;", "", ddl)
        self.sql(ddl + fixture_rows())
        self.cluster.roles_created = True

    def sql(self, statement, *, database=None, role=None, user=None, fails=None):
        prefix = "SET manabi.synthetic_registry_test = 'on';\n"
        if user is not None:
            prefix += f"SET request.jwt.claim.sub = '{user}';\n"
        if role:
            prefix += f"SET ROLE {role};\n"
        result = self.cluster.psql(prefix + statement, database or self.dbname)
        if fails is None:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn(fails, result.stderr)
        return result.stdout.strip()

    def cutover(self):
        return self.sql((HERE / "registry_cutover.sql").read_text(encoding="utf-8"))

    def data(self):
        return self.sql("\n".join(f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id), '[]') FROM public.{table} t;"
                                  for table in registry.TABLES))

    def test_all_five_tables_survive_old_school_delete_with_identical_contents(self):
        before = self.data()
        policies = self.sql("SELECT md5(string_agg(oid::text || polname || polqual::text || coalesce(polwithcheck::text,''), ',' ORDER BY oid)) FROM pg_policy;")
        self.cutover()
        self.assertEqual(self.data(), before)
        self.assertEqual(self.sql("SELECT md5(string_agg(oid::text || polname || polqual::text || coalesce(polwithcheck::text,''), ',' ORDER BY oid)) FROM pg_policy;"), policies)
        self.sql(f"DELETE FROM public.schools WHERE id = '{S1}';")
        self.assertEqual(self.data(), before)
        self.assertEqual(self.sql(f"SELECT count(*) FROM public.school_departments WHERE id = '{D1}';"), "0")
        self.assertEqual(self.sql("SELECT count(*) FROM pg_constraint WHERE conname LIKE '%_registry_%' AND NOT convalidated;"), "0")
        self.assertEqual(self.sql("SELECT count(*) FROM pg_constraint WHERE conrelid IN "
                                 "('public.user_school_favorites'::regclass,'public.user_school_notes'::regclass,"
                                 "'public.user_school_deviations'::regclass,'public.data_reports'::regclass,"
                                 "'public.deviation_correction_logs'::regclass) AND confrelid IN "
                                 "('public.schools'::regclass,'public.school_departments'::regclass);"), "0")

    def test_membership_mismatch_blocks_and_rolls_back_entire_cutover(self):
        for table in registry.TABLES[2:]:
            with self.subTest(table=table):
                self.sql(f"UPDATE public.{table} SET department_id = '{D2}' WHERE department_id = '{D1}';")
                self.sql((HERE / "registry_cutover.sql").read_text(encoding="utf-8"), fails="foreign key constraint")
                self.assertEqual(self.sql("SELECT to_regclass('public.school_id_registry') IS NULL;"), "t")
                self.assertEqual(self.sql(f"SELECT count(*) FROM pg_constraint WHERE conname = '{table}_school_id_fkey';"), "1")
                self.sql(f"UPDATE public.{table} SET department_id = '{D1}' WHERE department_id = '{D2}';")

    def test_null_department_still_checks_school_and_membership(self):
        self.cutover()
        self.sql(f"INSERT INTO public.user_school_deviations (user_id,school_id,department_id,value) VALUES ('{U2}','{S1}',NULL,0);", role="authenticated", user=U2)
        self.sql(f"INSERT INTO public.user_school_deviations (user_id,school_id,department_id,value) VALUES ('{U2}','{S1}','{D2}',50);", role="authenticated", user=U2, fails="foreign key constraint")
        self.sql(f"INSERT INTO public.user_school_deviations (user_id,school_id,department_id,value) VALUES ('{U2}','{S3}',NULL,0);", role="authenticated", user=U2, fails="foreign key constraint")
        self.sql(f"INSERT INTO public.user_school_deviations (user_id,school_id,department_id,value) VALUES ('{U2}','{S1}',NULL,0);", role="authenticated", user=U2, fails="duplicate key")

    def test_historical_id_and_new_note_survive_recovery_preflight(self):
        self.cutover()
        self.sql(f"DELETE FROM public.schools WHERE id = '{S1}'; INSERT INTO public.school_id_registry VALUES ('{S3}');")
        self.sql(f"INSERT INTO public.user_school_notes (user_id,school_id,note) VALUES ('{U2}','{S1}','historical ID note'), ('{U2}','{S3}','post-cutover new note');", role="authenticated", user=U2)
        before = self.data()
        recovery = self.sql((HERE / "registry_recovery_check.sql").read_text(encoding="utf-8"))
        self.assertIn(S3, recovery)
        self.assertEqual(self.data(), before)
        self.assertEqual(self.sql(f"SELECT note FROM public.user_school_notes WHERE school_id='{S3}';", role="authenticated", user=U2), "post-cutover new note")
        for sql in (f"DELETE FROM public.school_id_registry WHERE id='{S3}';",
                    f"UPDATE public.department_id_registry SET school_id='{S2}' WHERE id='{D1}';"):
            self.sql(sql, fails="append-only")
        self.sql("TRUNCATE public.department_id_registry;", fails="foreign key constraint")
        self.sql("TRUNCATE public.department_id_registry CASCADE;", fails="append-only")
        self.assertEqual(self.data(), before)

    def test_owner_rls_and_registry_acl_preserved(self):
        self.cutover()
        for table in registry.TABLES[:3]:
            self.assertEqual(self.sql(f"SELECT count(*) FROM public.{table};", role="authenticated", user=U2), "0")
            self.sql(f"SELECT * FROM public.{table};", role="anon", fails="permission denied")
        self.sql(f"INSERT INTO public.user_school_notes(user_id,school_id,note) VALUES ('{U1}','{S2}','intrusion');", role="authenticated", user=U2, fails="row-level security")
        self.sql(f"UPDATE public.user_school_notes SET user_id='{U2}';", role="authenticated", user=U1, fails="row-level security")
        for role in ("anon", "authenticated", "service_role"):
            for table in ("school_id_registry", "department_id_registry"):
                self.sql(f"SELECT * FROM public.{table};", role=role, user=U1, fails="permission denied")
                self.sql(f"DELETE FROM public.{table};", role=role, user=U1, fails="permission denied")
                self.assertEqual(self.sql(f"SELECT has_any_column_privilege('{role}','public.{table}','INSERT,UPDATE,REFERENCES');"), "f")

    def test_consent_rpc_withdrawal_preserves_notes_and_anonymous_signin(self):
        self.cutover()
        self.sql(f"SELECT public.save_mine_consent('{S1}',true); SELECT public.save_mine_consent('{S1}',false);", role="authenticated", user=U1)
        self.assertEqual(self.sql(f"SELECT count(*) FROM public.user_school_deviations WHERE user_id='{U1}' AND visibility <> 'private';"), "0")
        self.assertEqual(self.sql(f"SELECT note FROM public.user_school_deviations WHERE user_id='{U1}' AND department_id IS NULL;"), "sentinel note")
        self.sql(f"SELECT public.save_mine_consent('{S1}',true); SELECT public.save_mine_consent('{S1}',false);", role="authenticated", user=UA)
        self.sql(f"SELECT public.save_mine_consent('{S1}',false);", role="anon", fails="permission denied")

    def test_family_rpcs_enforce_membership_anonymity_and_owner_optin(self):
        # Preserve evidence of the pre-existing RPC error; do not silently set
        # plpgsql.variable_conflict or rewrite the extracted baseline function.
        self.sql(f"SELECT * FROM public.get_family_shared_favorites('{GROUP}');", role="authenticated", user=U2,
                 fails='column reference "status" is ambiguous')
        self.sql((HERE / "family_favorites_qualification.sql").read_text(encoding="utf-8"))
        self.cutover()
        self.sql(f"DELETE FROM public.schools WHERE id='{S1}';")
        for function in ("get_family_shared_favorites", "get_family_shared_notes"):
            self.assertEqual(self.sql(f"SELECT count(*) FROM public.{function}('{GROUP}');", role="authenticated", user=U2), "0")
            self.sql(f"SELECT * FROM public.{function}('{GROUP}');", role="authenticated", user=U3, fails="not a member")
            self.sql(f"SELECT * FROM public.{function}('{GROUP}');", role="authenticated", user=UA, fails="anonymous users")
            self.sql(f"SELECT * FROM public.{function}('{GROUP}');", role="anon", fails="permission denied")
        self.sql(f"UPDATE public.family_members SET share_favorites=true,share_notes=true WHERE user_id='{U1}';")
        for function in ("get_family_shared_favorites", "get_family_shared_notes"):
            self.assertEqual(self.sql(f"SELECT school_id FROM public.{function}('{GROUP}');", role="authenticated", user=U2), S1)
        self.sql(f"UPDATE public.family_members SET status='invited' WHERE user_id='{U2}';")
        self.sql(f"SELECT * FROM public.get_family_shared_notes('{GROUP}');", role="authenticated", user=U2, fails="not a member")

    def test_report_and_audit_admin_policies_preserved(self):
        self.cutover()
        self.assertEqual(self.sql("SELECT count(*) FROM public.data_reports;", role="authenticated", user=U1), "0")
        self.assertEqual(self.sql("SELECT count(*) FROM public.data_reports;", role="authenticated", user=U3), "2")
        self.assertEqual(self.sql("SELECT count(*) FROM public.deviation_correction_logs;", role="authenticated", user=U1), "0")
        self.assertEqual(self.sql("SELECT count(*) FROM public.deviation_correction_logs;", role="authenticated", user=U3), "1")
        self.sql(f"UPDATE public.data_reports SET status='reviewed',reviewed_at=now(),reviewed_by='{U3}';", role="authenticated", user=U3)
        self.sql(f"UPDATE public.data_reports SET reviewed_by='{U1}';", role="authenticated", user=U3, fails="row-level security")
        self.sql(f"INSERT INTO public.data_reports(school_id,field,proposed_value,source,reporter_user_id) VALUES ('{S1}','other','synthetic','https://example.invalid','{U1}');", role="authenticated", user=U2, fails="row-level security")

    def test_guard_requires_explicit_synthetic_session(self):
        result = self.cluster.psql((HERE / "registry_cutover.sql").read_text(encoding="utf-8"), self.dbname)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("isolated synthetic", result.stderr)

    def test_generated_registration_sql_retry_and_membership_rejection(self):
        self.cutover()
        candidate = {"format": "school-id-index-candidate", "format_version": 1, "synthetic": True,
                     "state": "candidate", "previous_index_sha256": None,
                     "source": {"schema_version": 3, "dataset_version": "synthetic-test", "source_version": "synthetic-test",
                                "snapshot_content_sha256": "0" * 64, "snapshot_sha256": "0" * 64},
                     "schools": [{"id": S3}], "departments": [{"id": D1, "school_id": S3}],
                     "counts": {"schools": 1, "departments": 1},
                     "diff": {"added": {"schools": [S3], "departments": [D1]},
                              "retained_absent": {"schools": [], "departments": []}}}
        candidate["index_sha256"] = registry.school.content_hash(candidate)
        self.sql(registry.render_registration_sql(candidate), fails="department membership changed")
        self.assertEqual(self.sql(f"SELECT count(*) FROM public.school_id_registry WHERE id='{S3}';"), "0")
        candidate["departments"] = []
        candidate["counts"]["departments"] = 0
        candidate["diff"]["added"]["departments"] = []
        candidate["index_sha256"] = registry.school.content_hash({k: v for k, v in candidate.items() if k != "index_sha256"})
        sql = registry.render_registration_sql(candidate)
        self.sql(sql)
        self.sql(sql)
        self.assertEqual(self.sql("SELECT count(*) FROM public.school_id_registry;"), "3")


class Cluster:
    def __init__(self, binary, scratch):
        self.binary = binary.resolve(strict=True)
        self.scratch = scratch.absolute()
        if self.scratch.exists() or str(self.scratch).startswith(("\\\\", "//")):
            raise ValueError("new local scratch directory required")
        self.scratch.mkdir()
        self.data = self.scratch / "data"
        self.roles_created = False
        # Do not inherit connection/service/options/password overrides. Never print env.
        self.env = {key: value for key, value in os.environ.items() if not key.upper().startswith("PG")}
        self.env.update(PGPASSFILE=str(self.scratch / "absent.pgpass"),
                        PGSERVICEFILE=str(self.scratch / "absent.pg_service"))
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        self.started = False

    def run(self, executable, arguments, **kwargs):
        # Windows postmaster inherits pg_ctl pipe handles; capture_output would
        # wait for server shutdown even after pg_ctl exits. Use real log handles.
        if executable == "pg_ctl":
            with (self.scratch / "pg_ctl.log").open("a", encoding="utf-8") as log:
                result = subprocess.run([str(self.binary / (executable + (".exe" if os.name == "nt" else ""))), *arguments],
                                        env=self.env, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                                        timeout=90, **kwargs)
            return subprocess.CompletedProcess(result.args, result.returncode, "", "see pg_ctl.log")
        return subprocess.run([str(self.binary / (executable + (".exe" if os.name == "nt" else ""))), *arguments],
                              env=self.env, text=True, encoding="utf-8", errors="replace", capture_output=True,
                              creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0, timeout=90, **kwargs)

    def start(self):
        result = self.run("initdb", ["-D", str(self.data), "-U", "synthetic_owner", "--auth=trust", "--no-locale", "-E", "UTF8"])
        (self.scratch / "initdb.log").write_text(result.stdout + result.stderr, encoding="utf-8")
        if result.returncode:
            raise RuntimeError("isolated initdb failed; inspect scratch log")
        result = self.run("pg_ctl", ["-D", str(self.data), "-l", str(self.scratch / "postgres.log"),
                                    "-o", f"-h 127.0.0.1 -p {self.port}", "-w", "start"])
        # Even a failed readiness wait may leave the child running; finally checks PID file.
        self.started = (self.data / "postmaster.pid").exists()
        if result.returncode:
            raise RuntimeError("isolated PostgreSQL start failed: " + result.stderr)

    def psql(self, sql, database):
        return self.run("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1",
                                 "-p", str(self.port), "-U", "synthetic_owner", "-d", database], input=sql)

    def stop(self):
        if self.started or (self.data / "postmaster.pid").exists():
            result = self.run("pg_ctl", ["-D", str(self.data), "-m", "fast", "-w", "stop"])
            if result.returncode or (self.data / "postmaster.pid").exists():
                raise RuntimeError("isolated PostgreSQL stop failed; inspect scratch")
            print("Isolated PostgreSQL stopped; retained synthetic cluster: " + str(self.scratch))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--postgres-bin", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    args = parser.parse_args()
    cluster = Cluster(args.postgres_bin, args.scratch)
    SyntheticPostgresTests.cluster = cluster
    try:
        cluster.start()
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(SyntheticPostgresTests))
        return 0 if result.wasSuccessful() else 1
    finally:
        cluster.stop()


if __name__ == "__main__":
    raise SystemExit(main())
