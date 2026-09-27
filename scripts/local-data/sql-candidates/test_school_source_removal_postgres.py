"""Owned loopback source-removal test; real migration, synthetic data/auth.

Reuses populated five user tables and minimal school/department/auth fixtures.
The remaining 23 source and 10 retained table definitions, source FKs and five
trigger functions come from baseline DDL. Not full provider/auth acceptance.
"""
import argparse
import hashlib
from pathlib import Path
import re
import unittest

import test_registry_postgres as harness
from test_live_school_queue_postgres import LiveSchoolQueueTests
import store_school

MIGRATION=harness.ROOT/'web/supabase/migrations/202609280104_remove_school_source.sql'
SOURCE=set(store_school.TABLES)
FUNCTIONS=('sync_dept_ui_group','sync_master_ui_group','validate_admission_recruitment_unit_department',
           'validate_admission_recruitment_unit_school','sync_school_status_compatibility')
BASELINE=(harness.ROOT/'web/supabase/baseline_schema.sql').read_text(encoding='utf-8')
RETAINED=set(re.findall(r'CREATE TABLE public\.([a-z_]+) \(',BASELINE))-SOURCE


class RemovalTests(unittest.TestCase):
    cluster=None
    sql=LiveSchoolQueueTests.sql
    request=LiveSchoolQueueTests.request
    publish=LiveSchoolQueueTests.publish
    payload=LiveSchoolQueueTests.payload

    def setUp(self):
        LiveSchoolQueueTests.setUp(self)
        self.sql('ALTER TABLE public.school_departments ADD COLUMN course_type text, ADD COLUMN ui_group text; '
                 'ALTER TABLE public.schools ADD COLUMN lifecycle_status_code text, ADD COLUMN recruitment_status_code text;')
        existing=set(harness.registry.TABLES)|{'schools','school_departments','admin_users','admin_pin_attempts','family_members'}
        added=(SOURCE|RETAINED)-existing
        statements=re.findall(r'CREATE TYPE public\.[a-z_]+ AS ENUM \(.*?\n\);',BASELINE,re.S)
        for name in sorted(added):
            statements.append(re.search(rf'CREATE TABLE public\.{name} \(.*?\n\);',BASELINE,re.S).group())
        constraints=[]
        for name in sorted(added):
            constraints.extend(re.findall(rf'ALTER TABLE ONLY public\.{name}\s+ADD CONSTRAINT .*?;',BASELINE,re.S))
        statements.extend(c for c in constraints if 'FOREIGN KEY' not in c)
        statements.extend(c for c in constraints if 'FOREIGN KEY' in c)
        for name in FUNCTIONS:
            statements.append(re.search(rf'CREATE FUNCTION public\.{name}\(\).*?\n\$\$;',BASELINE,re.S).group())
            statements.extend(re.findall(rf'CREATE TRIGGER [^;]+EXECUTE FUNCTION public\.{name}\(\);',BASELINE))
        self.sql('\n'.join(statements))
        self.request()
        self.publish()

    def apply(self,*,gate=True,fails=None):
        statement=("SET manabi.school_source_removal='verified';\n" if gate else '')+MIGRATION.read_text(encoding='utf-8')
        return self.sql(statement,fails=fails)

    def before(self):
        names=sorted(RETAINED|{'school_id_registry','department_id_registry','school_change_requests','school_change_events'})
        rows=self.sql('\n'.join(f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM public.{name} t;" for name in names))
        metadata=self.sql("SELECT jsonb_agg(jsonb_build_array(c.oid,c.relname,c.relacl,c.relrowsecurity) ORDER BY c.relname) "
          "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ("+
          ','.join("'"+name+"'" for name in names)+");")
        policies=self.sql("SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.oid),'[]') FROM pg_policy p "
          "JOIN pg_class c ON c.oid=p.polrelid WHERE c.relname IN ("+','.join("'"+name+"'" for name in names)+");")
        return hashlib.sha256((rows+metadata+policies).encode()).hexdigest()

    def assert_source_intact(self):
        self.assertEqual(self.sql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
          "WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN ("+','.join("'"+name+"'" for name in sorted(SOURCE))+");"),'25')
        for name in FUNCTIONS:
            self.assertEqual(self.sql(f"SELECT to_regprocedure('public.{name}()') IS NOT NULL;"),'t')

    def test_exact_source_list_and_operator_gate_default_refuse(self):
        sql=MIGRATION.read_text(encoding='utf-8')
        block=re.search(r'DROP TABLE\s+(.*?)\s+RESTRICT;',sql,re.S).group(1)
        self.assertEqual(set(re.findall(r'public\.([a-z_]+)',block)),SOURCE)
        self.assertEqual(len(re.findall(r'public\.([a-z_]+)',block)),25)
        self.assertEqual(len(re.findall(r'DROP TABLE\b',sql)),1)
        self.assertNotRegex(sql,r'\bCASCADE\b')
        before=self.before()
        self.apply(gate=False,fails='operator gate required')
        self.assert_source_intact(); self.assertEqual(self.before(),before)

    def test_all_25_removed_and_18_user_registry_queue_rows_acl_rls_unchanged(self):
        self.assertEqual(len(RETAINED),18)
        before=self.before()
        self.apply()
        self.assertEqual(self.before(),before)
        for name in SOURCE:
            self.assertEqual(self.sql(f"SELECT to_regclass('public.{name}') IS NULL;"),'t')
        for name in FUNCTIONS:
            self.assertEqual(self.sql(f"SELECT to_regprocedure('public.{name}()') IS NULL;"),'t')
        self.sql(f"SELECT * FROM public.correct_school_deviation('{harness.D1}',55,'reason','synthetic-pin');",
                 role='authenticated',user=harness.U3,fails='moved to')
        self.sql('SELECT * FROM public.get_deviation_review_queue();',role='authenticated',user=harness.U3,fails='moved to')
        self.sql(f"INSERT INTO public.user_school_notes(user_id,school_id,note) VALUES('{harness.U2}','{harness.S1}','new synthetic note');",
                 role='authenticated',user=harness.U2)
        self.sql(f"INSERT INTO public.user_school_notes(user_id,school_id,note) VALUES('{harness.U1}','{harness.S2}','intrusion');",
                 role='authenticated',user=harness.U2,fails='row-level security')
        self.request(value=56)

    def test_unexpected_external_fk_rolls_back_entire_removal(self):
        self.sql('CREATE TABLE public.unexpected_consumer(school_id uuid REFERENCES public.schools(id));')
        before=self.before()
        self.apply(fails='other objects depend on them')
        self.assert_source_intact(); self.assertEqual(self.before(),before)
        self.assertEqual(self.sql("SELECT to_regclass('public.unexpected_consumer') IS NOT NULL;"),'t')

    def test_unexpected_view_rolls_back_entire_removal(self):
        self.sql('CREATE VIEW public.unexpected_view AS SELECT id FROM public.schools;')
        before=self.before()
        self.apply(fails='other objects depend on them')
        self.assert_source_intact(); self.assertEqual(self.before(),before)

    def test_unexpected_function_consumer_rolls_back_prior_table_removal(self):
        self.sql('CREATE TRIGGER unexpected_consumer BEFORE INSERT ON public.user_school_notes '
                 'FOR EACH ROW EXECUTE FUNCTION public.sync_dept_ui_group();')
        before=self.before()
        self.apply(fails='other objects depend on them')
        self.assert_source_intact(); self.assertEqual(self.before(),before)

    def test_missing_validated_registry_fk_refuses_before_removal(self):
        self.sql('ALTER TABLE public.user_school_notes DROP CONSTRAINT user_school_notes_registry_school_fkey;')
        self.apply(fails='eight validated registry foreign keys required')
        self.assert_source_intact()

    def test_incomplete_queue_migration_refuses_before_removal(self):
        self.sql('DROP FUNCTION public.school_publication_preflight(uuid,uuid,integer,text,text,text,text,jsonb) RESTRICT;')
        self.apply(fails='registry and live queue migrations required')
        self.assert_source_intact()

    def test_missing_unreferenced_department_identity_refuses_before_removal(self):
        self.sql('ALTER TABLE public.department_id_registry DISABLE TRIGGER USER; '
                 f"DELETE FROM public.department_id_registry WHERE id='{harness.D2}'; "
                 'ALTER TABLE public.department_id_registry ENABLE TRIGGER USER;')
        self.apply(fails='all source identities must be retained')
        self.assert_source_intact()

    def test_publication_membership_refuses_automatic_membership_loss(self):
        # Local fixture owner lacks SUPERUSER; table owner may create this
        # specific-table publication after synthetic database owner setup.
        self.sql('CREATE PUBLICATION synthetic_school_source FOR TABLE public.schools;')
        self.apply(fails='publication membership requires separate review')
        self.assert_source_intact()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--postgres-bin',type=Path,required=True)
    parser.add_argument('--scratch',type=Path,required=True)
    args=parser.parse_args()
    cluster=harness.Cluster(args.postgres_bin,args.scratch)
    RemovalTests.cluster=cluster
    try:
        cluster.start()
        result=cluster.psql('CREATE ROLE postgres NOLOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS;','postgres')
        if result.returncode: raise RuntimeError('synthetic owner setup failed')
        result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(RemovalTests))
        return 0 if result.wasSuccessful() else 1
    finally:
        cluster.stop()


if __name__=='__main__': raise SystemExit(main())
