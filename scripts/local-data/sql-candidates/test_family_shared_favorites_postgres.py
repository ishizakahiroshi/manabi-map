"""Owned loopback PG regression: unmodified baseline ambiguity and real repair.

Synthetic auth/users only. No real Supabase connection or auth acceptance.
"""
import argparse
from pathlib import Path
import unittest

import test_registry_postgres as harness
from test_live_registry_postgres import LiveRegistryTests

MIGRATION=harness.ROOT / "web/supabase/migrations/202609280103_family_shared_favorites_qualified.sql"
GROUP,S1,U1,U2,U3,UA=harness.GROUP,harness.S1,harness.U1,harness.U2,harness.U3,harness.UA


class FamilyFavoritesTests(unittest.TestCase):
    cluster=None
    sql=LiveRegistryTests.sql

    def setUp(self):
        harness.SyntheticPostgresTests.setUp(self)

    def apply(self):
        self.sql(MIGRATION.read_text(encoding="utf-8"))

    def test_actual_baseline_error_then_minimal_migration_repairs_member_read(self):
        statement=f"SELECT * FROM public.get_family_shared_favorites('{GROUP}');"
        self.sql(statement,role="authenticated",user=U2,fails='column reference "status" is ambiguous')
        self.apply()
        self.assertEqual(self.sql(statement,role="authenticated",user=U2),"")
        self.sql(f"UPDATE public.family_members SET share_favorites=true WHERE user_id='{U1}';")
        self.assertEqual(self.sql(f"SELECT school_id FROM public.get_family_shared_favorites('{GROUP}');",role="authenticated",user=U2),S1)
        self.assertEqual(self.sql(statement,role="authenticated",user=U1),"")

    def test_anonymous_nonmember_inactive_member_and_revoked_optin_still_denied(self):
        self.apply()
        statement=f"SELECT * FROM public.get_family_shared_favorites('{GROUP}');"
        self.sql(statement,role="anon",fails="permission denied")
        self.sql(statement,role="authenticated",user=UA,fails="anonymous users")
        self.sql(statement,role="authenticated",user=U3,fails="not a member")
        self.sql(f"UPDATE public.family_members SET share_favorites=true WHERE user_id='{U1}';")
        self.assertNotEqual(self.sql(statement,role="authenticated",user=U2),"")
        self.sql(f"UPDATE public.family_members SET share_favorites=false WHERE user_id='{U1}';")
        self.assertEqual(self.sql(statement,role="authenticated",user=U2),"")
        self.sql(f"UPDATE public.family_members SET status='invited' WHERE user_id='{U2}';")
        self.sql(statement,role="authenticated",user=U2,fails="not a member")


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--postgres-bin",type=Path,required=True)
    parser.add_argument("--scratch",type=Path,required=True)
    args=parser.parse_args()
    cluster=harness.Cluster(args.postgres_bin,args.scratch)
    FamilyFavoritesTests.cluster=cluster
    try:
        cluster.start()
        result=cluster.psql("CREATE ROLE postgres NOLOGIN NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS;","postgres")
        if result.returncode: raise RuntimeError("synthetic owner setup failed")
        result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(FamilyFavoritesTests))
        return 0 if result.wasSuccessful() else 1
    finally:
        cluster.stop()


if __name__=="__main__":
    raise SystemExit(main())
