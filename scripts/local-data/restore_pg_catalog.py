"""Concrete PostgreSQL catalog collector proposal builder (partial, inactive).

Explicit schema/table/sequence/role allowlists close the supported database
inventory. This supports permanent ordinary tables with built-in column types,
column defaults, PK/FK/unique/check/not-null constraints, indexes, sequences,
SQL/plpgsql functions, table/column/schema/sequence/function ACLs and RLS.
Views, partitions, inheritance, identity/generated columns, custom types,
triggers/rules, custom extensions, default ACLs and provider services fail shut.

propose_program performs read-only discovery; it returns untrusted proposal
bytes and a proposed hash. Review/pin adoption and capture are separate calls.
The selected roles must already exist identically at the new target; this
adapter never creates or mutates cluster roles, auth, or provider services.
"""
import json

import restore_bundle as bundle
from restore_pg_adapter import Session, ident, literal, need


CONTEXT = "SET search_path=pg_catalog; SET timezone='UTC'; SET datestyle='ISO,YMD'; SET extra_float_digits=3; SET bytea_output=hex; "


def names(values, *, qualified=False):
    need(type(values) is list and values and values == sorted(set(values)))
    for value in values:
        parts = value.split('.') if qualified else [value]
        need(len(parts) == (2 if qualified else 1))
        for part in parts:
            ident(part)
    return values


def literals(values):
    return ','.join(literal(value) for value in values) or 'NULL'


def qualified(value):
    return '.'.join(ident(part) for part in value.split('.'))


def _array(query):
    return "(SELECT coalesce(jsonb_agg(item ORDER BY identity COLLATE \"C\"),'[]'::jsonb) FROM (" + query + ') entries)'


def _entry(identity, definition):
    return identity + " identity,jsonb_build_object('identity'," + identity + ",'definition'," + definition + ') item'


def _acl_rows(schemas, tables, sequences):
    sc, rel = literals(schemas), literals(tables+sequences)
    # 'grants' columns use NULL rather than default column ACL: column-level
    # privileges are additional to table privileges, not a second table ACL.
    return f"""SELECT 'schema' kind,quote_ident(nspname) object,NULL::text column_name,
 nspowner owner,coalesce(nspacl,acldefault('n',nspowner)) acl FROM pg_namespace WHERE nspname IN ({sc})
UNION ALL SELECT CASE WHEN c.relkind='S' THEN 'sequence' ELSE 'table' END,
 format('%I.%I',n.nspname,c.relname),NULL,c.relowner,
 coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE format('%s.%s',n.nspname,c.relname) IN ({rel})
UNION ALL SELECT 'column',format('%I.%I',n.nspname,c.relname),a.attname,c.relowner,a.attacl
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE format('%s.%s',n.nspname,c.relname) IN ({literals(tables)}) AND a.attnum>0 AND NOT a.attisdropped
UNION ALL SELECT 'function',format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)),
 NULL,p.proowner,coalesce(p.proacl,acldefault('f',p.proowner)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ({sc}) AND p.prokind='f'"""


def _acl_entries(acl_rows):
    return f"""WITH objects AS ({acl_rows}), entries AS (
 SELECT kind||':'||object||CASE WHEN column_name IS NULL THEN '' ELSE ':'||column_name END identity,
 jsonb_build_object('object_kind',kind,'owner',pg_get_userbyid(owner),'grants',
 (SELECT coalesce(jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
 'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
 'privilege',a.privilege_type,'grantable',a.is_grantable)
 ORDER BY a.is_grantable,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END COLLATE "C",
 pg_get_userbyid(a.grantor) COLLATE "C",a.privilege_type COLLATE "C"),'[]'::jsonb)
 FROM aclexplode(acl) a)) definition FROM objects)
 SELECT identity,jsonb_build_object('identity',identity,'definition',definition) item FROM entries"""


def _unsupported(schemas, tables, sequences, roles, acl_rows):
    sc, tb, sq, ro = map(literals, (schemas, tables, sequences, roles))
    user_schema = "n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_'"
    # This enumerates actual catalog rows, not a fixture-name comparison or
    # a caller-supplied boolean. Exclusions are explicit and fail on appearance.
    checks = [
        "SELECT 'unsupported-server-version' name WHERE current_setting('server_version_num')::integer/10000<>18",
        f"SELECT 'schema:'||nspname name FROM pg_namespace WHERE nspname NOT IN ({sc},'pg_catalog','information_schema') AND nspname !~ '^pg_'",
        f"SELECT 'missing-schema:'||v name FROM unnest(ARRAY[{sc}]::text[]) v WHERE NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=v)",
        f"SELECT 'missing-table:'||v name FROM unnest(ARRAY[{tb}]::text[]) v WHERE NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname||'.'||c.relname=v AND c.relkind='r')",
        f"SELECT 'missing-sequence:'||v name FROM unnest(ARRAY[{sq}]::text[]) v WHERE v IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname||'.'||c.relname=v AND c.relkind='S')",
        f"SELECT 'relation:'||n.nspname||'.'||c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE {user_schema} AND NOT ((c.relkind='r' AND n.nspname||'.'||c.relname IN ({tb}) AND c.relpersistence='p' AND NOT c.relispartition) OR (c.relkind='S' AND n.nspname||'.'||c.relname IN ({sq}) AND c.relpersistence='p') OR (c.relkind='i' AND EXISTS(SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace tn ON tn.oid=t.relnamespace WHERE i.indexrelid=c.oid AND tn.nspname||'.'||t.relname IN ({tb}))))",
        f"SELECT 'column:'||n.nspname||'.'||c.relname||'.'||a.attname name FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_type t ON t.oid=a.atttypid JOIN pg_namespace nt ON nt.oid=t.typnamespace WHERE n.nspname||'.'||c.relname IN ({tb}) AND a.attnum>0 AND (a.attisdropped OR a.attidentity<>'' OR a.attgenerated<>'' OR nt.nspname<>'pg_catalog' OR (a.attcollation<>0 AND NOT EXISTS(SELECT 1 FROM pg_collation col JOIN pg_namespace cn ON cn.oid=col.collnamespace WHERE col.oid=a.attcollation AND cn.nspname='pg_catalog')))" ,
        f"SELECT 'routine:'||n.nspname||'.'||p.proname name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE {user_schema} AND (n.nspname NOT IN ({sc}) OR p.prokind<>'f' OR l.lanname NOT IN ('sql','plpgsql'))",
        f"SELECT 'role:'||rolname name FROM pg_roles WHERE rolname !~ '^pg_' AND rolname NOT IN ({ro})",
        f"SELECT 'missing-role:'||v name FROM unnest(ARRAY[{ro}]::text[]) v WHERE NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=v)",
        f"SELECT 'acl-role:'||o.object name FROM ({acl_rows}) o CROSS JOIN LATERAL aclexplode(o.acl) a WHERE (a.grantee<>0 AND pg_get_userbyid(a.grantee) NOT IN ({ro},'pg_database_owner')) OR pg_get_userbyid(a.grantor)<>pg_get_userbyid(o.owner)",
        f"SELECT 'owner:'||o.object name FROM ({acl_rows}) o WHERE pg_get_userbyid(o.owner) NOT IN ({ro},'pg_database_owner')",
        f"SELECT 'policy-role:'||p.polname name FROM pg_policy p CROSS JOIN LATERAL unnest(p.polroles) r WHERE r<>0 AND pg_get_userbyid(r) NOT IN ({ro})",
        f"SELECT 'type:'||n.nspname||'.'||t.typname name FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE {user_schema} AND NOT(t.typtype='c' AND EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace cn ON cn.oid=c.relnamespace WHERE c.oid=t.typrelid AND cn.nspname||'.'||c.relname IN ({tb}))) AND NOT(t.typelem<>0 AND EXISTS(SELECT 1 FROM pg_type elem JOIN pg_class c ON c.oid=elem.typrelid JOIN pg_namespace cn ON cn.oid=c.relnamespace WHERE elem.oid=t.typelem AND elem.typtype='c' AND cn.nspname||'.'||c.relname IN ({tb})))",
        f"SELECT 'foreign-key-target:'||conname name FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname||'.'||c.relname IN ({tb}) AND (x.contype NOT IN ('p','f','u','c','n') OR (x.contype='f' AND NOT EXISTS(SELECT 1 FROM pg_class target JOIN pg_namespace tn ON tn.oid=target.relnamespace WHERE target.oid=x.confrelid AND tn.nspname||'.'||target.relname IN ({tb}))))",
        "SELECT 'inheritance' name FROM pg_inherits",
        "SELECT 'trigger:'||tgname name FROM pg_trigger WHERE NOT tgisinternal",
        f"SELECT 'rule:'||r.rulename name FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace WHERE {user_schema}",
        "SELECT 'extension:'||extname name FROM pg_extension WHERE extname<>'plpgsql'",
        "SELECT 'event-trigger:'||evtname name FROM pg_event_trigger",
        "SELECT 'default-acl' name FROM pg_default_acl",
        "SELECT 'database-role-setting' name FROM pg_db_role_setting WHERE setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database())",
        "SELECT 'object-comment:'||d.objoid name FROM pg_description d WHERE d.objoid>=16384 OR (d.classoid='pg_namespace'::regclass AND d.objoid=(SELECT oid FROM pg_namespace WHERE nspname='public') AND d.description<>'standard public schema')",
        "SELECT 'role-comment:'||d.objoid name FROM pg_shdescription d WHERE d.classoid='pg_authid'::regclass AND d.objoid>=16384",
        "SELECT 'extended-statistics:'||stxname name FROM pg_statistic_ext",
        "SELECT 'custom-access-method:'||amname name FROM pg_am WHERE amname NOT IN ('heap','btree','hash','gist','gin','spgist','brin')",
        # FirstNormalObjectId is PostgreSQL's normal-postmaster boundary.
        # Limit this catalog program to PG18 and review this on major upgrades.
        "SELECT 'custom-cast:'||c.oid name FROM pg_cast c WHERE c.oid>=16384",
        f"SELECT 'storage:'||n.nspname||'.'||c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE {user_schema} AND (c.reltablespace<>0 OR (c.relkind='r' AND NOT EXISTS(SELECT 1 FROM pg_am am WHERE am.oid=c.relam AND am.amname='heap')) OR (c.relkind='i' AND NOT EXISTS(SELECT 1 FROM pg_am am WHERE am.oid=c.relam AND am.amname IN ('btree','hash','gist','gin','spgist','brin'))))",
        "SELECT 'large-object' name FROM pg_largeobject_metadata",
        "SELECT 'publication:'||pubname name FROM pg_publication",
        "SELECT 'subscription:'||subname name FROM pg_subscription",
        "SELECT 'foreign-server:'||srvname name FROM pg_foreign_server",
        "SELECT 'foreign-wrapper:'||fdwname name FROM pg_foreign_data_wrapper",
        "SELECT 'security-label' name FROM pg_seclabel",
        "SELECT 'transform' name FROM pg_transform",
        "SELECT 'language:'||lanname name FROM pg_language WHERE lanname NOT IN ('internal','c','sql','plpgsql')",
    ]
    for table, namespace in [('pg_collation','collnamespace'),('pg_conversion','connamespace'),
        ('pg_operator','oprnamespace'),('pg_opclass','opcnamespace'),('pg_opfamily','opfnamespace'),
        ('pg_ts_config','cfgnamespace'),('pg_ts_dict','dictnamespace'),('pg_ts_parser','prsnamespace'),('pg_ts_template','tmplnamespace')]:
        checks.append(f"SELECT '{table}:'||x.oid name FROM {table} x JOIN pg_namespace n ON n.oid=x.{namespace} WHERE ({user_schema}) OR x.oid>=16384")
    # User-created objects inside pg_catalog cannot hide behind a system schema.
    for table, namespace in [('pg_class','relnamespace'),('pg_proc','pronamespace'),('pg_type','typnamespace')]:
        checks.append(f"SELECT 'system-schema-object:'||x.oid name FROM {table} x JOIN pg_namespace n ON n.oid=x.{namespace} WHERE n.nspname IN ('pg_catalog','information_schema') AND x.oid>=16384")
    return CONTEXT+"WITH unexpected AS ("+'\nUNION ALL\n'.join(checks)+") SELECT coalesce(jsonb_agg(name ORDER BY name COLLATE \"C\"),'[]'::jsonb) FROM unexpected;"


def _catalog(schemas, tables, sequences, roles):
    sc, tb, ro = map(literals, (schemas,tables,roles))
    definitions = ["SELECT "+_entry("'schema:'||nspname", "jsonb_build_object('owner',pg_get_userbyid(nspowner))::text")+f" FROM pg_namespace WHERE nspname IN ({sc})"]
    definitions.append("SELECT "+_entry("'database:owner'", "pg_get_userbyid(datdba)")+" FROM pg_database WHERE datname=current_database()")
    definitions.append("SELECT "+_entry("'database:properties'", "jsonb_build_object('encoding',encoding,'collate',datcollate,'ctype',datctype,'provider',datlocprovider,'locale',datlocale,'icu_rules',daticurules,'collversion',datcollversion)::text")+" FROM pg_database WHERE datname=current_database()")
    definitions.append("SELECT "+_entry("'role:'||r.rolname", "(to_jsonb(r)-'oid'-'rolpassword'||jsonb_build_object('memberships',(SELECT coalesce(jsonb_agg(jsonb_build_object('role',pg_get_userbyid(m.roleid),'grantor',pg_get_userbyid(m.grantor),'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option) ORDER BY pg_get_userbyid(m.roleid) COLLATE \"C\"),'[]'::jsonb) FROM pg_auth_members m WHERE m.member=r.oid)))::text")+f" FROM pg_roles r WHERE r.rolname IN ({ro})")
    table_def = """jsonb_build_object('owner',pg_get_userbyid(c.relowner),'persistence',c.relpersistence,
 'replica_identity',c.relreplident,'options',c.reloptions,'toast_options',(SELECT reloptions FROM pg_class WHERE oid=c.reltoastrelid),
 'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
 'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'storage',a.attstorage,
 'compression',a.attcompression,'statistics',a.attstattarget,'options',a.attoptions,'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::regcollation::text END)
 ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',x.conname,'definition',pg_get_constraintdef(x.oid),'validated',x.convalidated) ORDER BY x.conname COLLATE "C"),'[]'::jsonb) FROM pg_constraint x WHERE x.conrelid=c.oid),
 'indexes',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',ic.relname,'definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready,'replica_identity',i.indisreplident,'clustered',i.indisclustered) ORDER BY ic.relname COLLATE "C"),'[]'::jsonb) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid))::text"""
    definitions.append("SELECT "+_entry("'table:'||n.nspname||'.'||c.relname",table_def)+f" FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname||'.'||c.relname IN ({tb})")
    for sequence in sequences:
        definitions.append("SELECT "+_entry(literal('sequence:'+sequence), f"jsonb_build_object('owner',pg_get_userbyid(c.relowner),'definition',(to_jsonb(s)-'seqrelid'-'seqtypid')||jsonb_build_object('type',format_type(s.seqtypid,NULL)),'last_value',v.last_value,'is_called',v.is_called,'owned_by',(SELECT format('%I.%I.%I',n.nspname,t.relname,a.attname) FROM pg_depend d JOIN pg_class t ON t.oid=d.refobjid JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='a'))::text")+f" FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid CROSS JOIN {qualified(sequence)} v WHERE s.seqrelid={literal(sequence)}::regclass")
    data = []
    for table in tables:
        data.append(f"SELECT {literal(table)} identity,jsonb_build_object('identity',{literal(table)},'values',(SELECT coalesce(jsonb_agg(to_jsonb(t)::text ORDER BY to_jsonb(t)::text COLLATE \"C\"),'[]'::jsonb) FROM {qualified(table)} t)) item")
    function_identity = "format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))"
    rpc = "SELECT "+_entry(function_identity,"jsonb_build_object('owner',pg_get_userbyid(p.proowner),'definition',pg_get_functiondef(p.oid))::text")+f" FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ({sc}) AND p.prokind='f'"
    rls = "SELECT "+_entry("n.nspname||'.'||c.relname", "jsonb_build_object('enabled',c.relrowsecurity,'forced',c.relforcerowsecurity,'policies',(SELECT coalesce(jsonb_agg(jsonb_build_object('identity',p.policyname,'definition',(to_jsonb(p)-'schemaname'-'tablename')::text) ORDER BY p.policyname COLLATE \"C\"),'[]'::jsonb) FROM pg_policies p WHERE p.schemaname=n.nspname AND p.tablename=c.relname))")+f" FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname||'.'||c.relname IN ({tb})"
    acl_rows = _acl_rows(schemas,tables,sequences)
    parts = {'schema':_array('\nUNION ALL\n'.join(definitions)), 'data':_array('\nUNION ALL\n'.join(data)),
             'acl':_array(_acl_entries(acl_rows)), 'rls':_array(rls),'rpc':_array(rpc),'provider':"'[]'::jsonb"}
    collect = CONTEXT+'SELECT jsonb_build_object('+','.join(literal(k)+','+v for k,v in parts.items())+');'
    inventory = CONTEXT+'SELECT jsonb_build_object('+','.join(literal(k)+','+v for k,v in parts.items() if k!='data')+');'
    return collect, inventory, acl_rows


def _acl_sql(query, acl_rows):
    """Emit reviewed grant SQL from catalog-derived names, never string splits."""
    raw = query("WITH objects AS ("+acl_rows+") SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'object',object,'column',column_name,'owner',pg_get_userbyid(owner),'grants',(SELECT coalesce(jsonb_agg(jsonb_build_object('grantee',CASE WHEN grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(grantee) END,'privilege',privilege_type,'grantable',is_grantable)),'[]'::jsonb) FROM aclexplode(acl)))),'[]'::jsonb) FROM objects;")
    objects = json.loads(raw)
    statements = []
    # Restore owners first so every subsequent grant has the reviewed grantor.
    for obj in objects:
        kind, target = obj['kind'].upper(), obj['object']
        need(kind in ('TABLE','SEQUENCE','SCHEMA','FUNCTION','COLUMN'))
        if kind != 'COLUMN':
            statements.append('ALTER '+kind+' '+target+' OWNER TO '+ident(obj['owner'])+';')
    for obj in objects:
        kind, target, column = obj['kind'].upper(), obj['object'], obj['column']
        # pg_restore --no-acl provides default ACLs. Revoke PUBLIC defaults and
        # restore exact explicit grants, including column-only privileges.
        if kind != 'COLUMN':
            recipients = sorted({obj['owner'],*(g['grantee'] for g in obj['grants'] if g['grantee']!='PUBLIC')})
            statements.append('REVOKE ALL ON '+kind+' '+target+' FROM PUBLIC, '+', '.join(ident(r) for r in recipients)+';')
        for grant in obj['grants']:
            privilege = grant['privilege']
            need(privilege in ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN','USAGE','CREATE','EXECUTE'))
            grantee = 'PUBLIC' if grant['grantee']=='PUBLIC' else ident(grant['grantee'])
            if kind == 'COLUMN':
                statements.append('GRANT '+privilege+' ('+ident(column)+') ON TABLE '+target+' TO '+grantee+(' WITH GRANT OPTION' if grant['grantable'] else '')+';')
            else:
                statements.append('GRANT '+privilege+' ON '+kind+' '+target+' TO '+grantee+(' WITH GRANT OPTION' if grant['grantable'] else '')+';')
    return '\n'.join(statements)


def propose_program(tools, endpoint, *, schemas, tables, sequences, roles, probes, deadline):
    """Return a concrete collector proposal; NEVER construct ReviewedProgram.

    The caller reviews raw SQL, coverage, freeze plan and resulting source
    evidence before adopting any pin. Probe specs are separately reviewed input
    because safe business-specific positive/negative writes cannot be inferred.
    restore_sql_sha256 remains None until the produced dump SQL is reviewed.
    """
    schemas, tables, roles = names(schemas), names(tables,qualified=True), names(roles)
    need(type(sequences) is list and sequences == sorted(set(sequences)))
    if sequences:
        names(sequences,qualified=True)
    need(all(value.split('.')[0] in schemas for value in tables+sequences))
    need(not any(value.startswith('pg_') or value=='information_schema' for value in schemas))
    collect, inventory, acl_rows = _catalog(schemas,tables,sequences,roles)
    unsupported = _unsupported(schemas,tables,sequences,roles,acl_rows)
    session = Session(tools,endpoint,deadline)
    try:
        session.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;')
        need(json.loads(session.query(unsupported)) == [])
        entries = json.loads(session.query(collect))
        acl_sql = _acl_sql(session.query,acl_rows)
        session.query('ROLLBACK;')
    finally:
        session.close()
    bundle.fields(entries,' '.join(bundle.KINDS))
    scope = {'assurance':'partial','targets':{kind:[entry['identity'] for entry in entries[kind]] for kind in bundle.KINDS},
             'exclusions':[{'identity':'provider.external-services','reason':'Database subset only; external Auth/JWT/PostgREST/storage and provider settings are not restored.'},
                           {'identity':'provider.roles-lifecycle','reason':'Explicit allowlisted roles must already exist identically; role creation/passwords and cluster settings are excluded.'},
                           {'identity':'provider.system-object-acls','reason':'Builtin catalog object ACL modifications and database settings/ACLs are excluded; database owner is verified while target CONNECT ACL remains isolated.'}]}
    value = {'format':'reviewed-pg-program-v1','scope':scope,'collect_sql':collect,'unsupported_sql':unsupported,
             'inventory_sql':inventory,'acl_sql':acl_sql,'probes':bundle.detached(probes),'restore_sql_sha256':None}
    raw = bundle.canonical(value)
    return {'program':raw,'proposed_sha256':bundle.digest(raw),'assurance':'partial'}
