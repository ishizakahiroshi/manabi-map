"""Security/contract tests for concrete catalog proposals, no database access."""
import json
import time
import unittest
from unittest.mock import patch

import restore_bundle as bundle
import restore_pg_catalog as catalog


class ProposalSession:
    outputs = []
    instances = []
    def __init__(self,*args):
        self.events = []
        self.closed = False
        type(self).instances.append(self)
    def query(self,sql):
        self.events.append(sql)
        if sql.startswith('BEGIN') or sql=='ROLLBACK;':
            return ''
        return type(self).outputs.pop(0)
    def close(self):
        self.closed = True


class CatalogTests(unittest.TestCase):
    def propose(self,**changes):
        kwargs = dict(schemas=['public'],tables=['public.example_rows'],sequences=[],roles=['example_owner'],
                      probes={},deadline=time.monotonic()+10)
        kwargs.update(changes)
        return catalog.propose_program(None,None,**kwargs)

    def test_sql_identifier_injection_never_reaches_connection(self):
        with patch.object(catalog,'Session') as session:
            for changes in (dict(schemas=['public; DROP DATABASE example']),
                            dict(tables=['public.example_rows;--']),dict(roles=['example_owner\nSELECT 1']),
                            dict(sequences=['public.example_seq\''])):
                with self.subTest(changes=changes),self.assertRaises(RuntimeError):
                    self.propose(**changes)
            session.assert_not_called()

    def test_table_outside_selected_schema_is_rejected(self):
        with patch.object(catalog,'Session') as session,self.assertRaises(RuntimeError):
            self.propose(tables=['another.example_rows'])
        session.assert_not_called()

    def test_system_schema_selection_rejected(self):
        with patch.object(catalog,'Session') as session,self.assertRaises(RuntimeError):
            self.propose(schemas=['pg_catalog'],tables=['pg_catalog.pg_roles'])
        session.assert_not_called()

    def test_unknown_live_object_aborts_and_closes_transaction(self):
        ProposalSession.outputs=['["view:public.example_view"]']
        with patch.object(catalog,'Session',ProposalSession),self.assertRaises(RuntimeError):
            self.propose()
        instance=ProposalSession.instances[-1]
        self.assertTrue(instance.closed)
        self.assertEqual(len(instance.events),2)

    def test_proposal_is_untrusted_and_discovery_uses_one_transaction(self):
        entries={kind:[] for kind in bundle.KINDS}
        entries['schema']=[{'identity':'table:public.example_rows','definition':'example definition'}]
        entries['data']=[{'identity':'public.example_rows','values':['{"amount":999999999999999999999.1}']}]
        ProposalSession.outputs=['[]',json.dumps(entries),'[]']
        with patch.object(catalog,'Session',ProposalSession):
            proposed=self.propose()
        self.assertEqual(set(proposed),{'program','proposed_sha256','assurance'})
        self.assertEqual(bundle.digest(proposed['program']),proposed['proposed_sha256'])
        value=bundle.decode(proposed['program'])
        self.assertIsNone(value['restore_sql_sha256'])
        self.assertEqual(value['scope']['targets']['data'],['public.example_rows'])
        instance=ProposalSession.instances[-1]
        self.assertTrue(instance.closed)
        self.assertEqual(instance.events[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;')
        self.assertEqual(instance.events[-1],'ROLLBACK;')

    def test_acl_reconstruction_revokes_owner_defaults_before_explicit_grants(self):
        objects=[{'kind':'table','object':'public.example_rows','column':None,'owner':'example_owner',
                  'grants':[{'grantee':'example_owner','privilege':'UPDATE','grantable':False}]}]
        sql=catalog._acl_sql(lambda query:json.dumps(objects),'example catalog SQL')
        self.assertIn('REVOKE ALL ON TABLE public.example_rows FROM PUBLIC, "example_owner";',sql)
        self.assertIn('GRANT UPDATE ON TABLE public.example_rows TO "example_owner";',sql)
        self.assertNotIn('GRANT SELECT',sql)
        self.assertLess(sql.index('REVOKE ALL'),sql.index('GRANT UPDATE'))

    def test_column_grants_reconstructed_as_column_grants(self):
        objects=[{'kind':'column','object':'public.example_rows','column':'note','owner':'example_owner',
                  'grants':[{'grantee':'example_reader','privilege':'SELECT','grantable':True}]}]
        sql=catalog._acl_sql(lambda query:json.dumps(objects),'example catalog SQL')
        self.assertEqual(sql,'GRANT SELECT ("note") ON TABLE public.example_rows TO "example_reader" WITH GRANT OPTION;')

    def test_unknown_privilege_cannot_become_sql(self):
        objects=[{'kind':'table','object':'public.example_rows','column':None,'owner':'example_owner',
                  'grants':[{'grantee':'example_reader','privilege':'SELECT; COMMIT','grantable':False}]}]
        with self.assertRaises(RuntimeError):
            catalog._acl_sql(lambda query:json.dumps(objects),'example catalog SQL')


if __name__=='__main__':
    unittest.main()
