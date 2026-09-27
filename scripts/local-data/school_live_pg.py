"""Explicit owner-only psql transport for school_live_controller (Python 3.12+).

No credential discovery, CLI, arbitrary SQL, retries, or background threads.
The caller obtains credentials with the approved secret helper and supplies a
minimal PG environment. Passwords never enter argv or SQL. TLS verify-full and
an explicit CA are mandatory. A failed mutation is indeterminate: reconcile its
durable request before retrying. Trusted native psql must not spawn descendants.
"""
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import uuid

MAX_INPUT=65536
MAX_OUTPUT=2*1024*1024
STATES={'received','claimed','adopted','generated','publication_confirmed','blocked','rejected'}
FAILURES={'source_conflict','consent_changed','generation_failed','publication_failed','executor_stopped'}
# (SQL type, validator kind, required). Function names and argument names never
# originate in SQL text supplied by a caller. Missing optional args use DB defaults.
RPC={
 'school_change_worker_payload': {'p_request_id':('uuid','uuid',True)},
 'list_school_changes': {'p_limit':('integer','limit',False),'p_after_id':('uuid','nullable_uuid',False),
   'p_request_ids':('uuid[]','nullable_uuid_list',False)},
 'claim_school_change': {'p_request_id':('uuid','uuid',True),'p_expected_revision':('integer','revision',True),
   'p_source_sha256':('text','sha',True),'p_lease_seconds':('integer','lease',False)},
 'renew_school_change_lease': {'p_request_id':('uuid','uuid',True),'p_lease_token':('uuid','uuid',True),
   'p_expected_revision':('integer','revision',True),'p_lease_seconds':('integer','lease',False)},
 'ack_school_change': {'p_request_id':('uuid','uuid',True),'p_lease_token':('uuid','uuid',True),
   'p_stage':('text','stage',True),'p_source_sha256':('text','sha',True),
   'p_snapshot_content_sha256':('text','nullable_sha',False),'p_manifest_sha256':('text','nullable_sha',False),
   'p_code_sha256':('text','nullable_sha',False),'p_publication':('jsonb','nullable_object',False),
   'p_application_receipts':('jsonb','nullable_receipts',False)},
 'fail_school_change': {'p_request_id':('uuid','uuid',True),'p_lease_token':('uuid','uuid',True),
   'p_failure_code':('text','failure',True)},
 'reject_school_change': {'p_request_id':('uuid','uuid',True),'p_expected_revision':('integer','revision',True),
   'p_evidence':('jsonb','object',True)},
 'school_publication_preflight': {'p_request_id':('uuid','uuid',True),'p_lease_token':('uuid','uuid',True),
   'p_expected_revision':('integer','revision',True),'p_source_sha256':('text','sha',True),
   'p_snapshot_content_sha256':('text','sha',True),'p_manifest_sha256':('text','sha',True),
   'p_code_sha256':('text','sha',True),'p_application_receipts':('jsonb','receipts',True)},
}
READS={'school_change_worker_payload','list_school_changes'}
PAYLOAD_KEYS=set(('request_id kind school_id department_id new_value reason expected_generation expected_value '
 'submission_fingerprint state revision lease_token lease_until claimed_source_sha256 adopted_source_sha256 '
 'snapshot_content_sha256 manifest_sha256 code_sha256 failure_code included_request_ids publication_request_id '
 'application_receipts application_receipts_sha256').split())


class SchoolPgError(ValueError):
    """Sanitized: SQL/response/connection/credentials are never part of diagnostics."""


def _need(ok):
    if not ok: raise SchoolPgError('school PostgreSQL transport rejected input or response')


def _uuid(value):
    _need(type(value) is str and str(uuid.UUID(value))==value)


def _sha(value):
    _need(type(value) is str and re.fullmatch('[0-9a-f]{64}',value))


def _validate(kind,value):
    if kind.startswith('nullable_'):
        if value is None: return
        kind=kind[9:]
    if kind=='uuid': _uuid(value)
    elif kind=='sha': _sha(value)
    elif kind in ('revision','limit','lease'):
        _need(type(value) is int and 1<=value<= {'revision':2147483647,'limit':100,'lease':300}[kind])
    elif kind=='stage': _need(type(value) is str and value in {'adopted','generated','publication_confirmed'})
    elif kind=='failure': _need(type(value) is str and value in FAILURES)
    elif kind=='object': _need(type(value) is dict)
    elif kind=='uuid_list':
        _need(type(value) is list and 0<len(value)<=100)
        for identifier in value: _uuid(identifier)
        _need(len(set(value))==len(value))
    elif kind=='receipts':
        _need(type(value) is list and len(value)<=100)
        seen=set()
        for entry in value:
            _need(type(entry) is dict and set(entry)=={'request_id','receipt_sha256'})
            _uuid(entry['request_id']); _sha(entry['receipt_sha256'])
            _need(entry['request_id'] not in seen); seen.add(entry['request_id'])
    else: _need(False)


def _json(raw):
    def pairs(items):
        value={}
        for key,item in items:
            _need(key not in value); value[key]=item
        return value
    return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _: _need(False))


def _sql(name,params,database,timeout,scope):
    _need(type(name) is str and name in RPC and type(params) is dict)
    spec=RPC[name]
    _need(set(params)<=set(spec) and all(key in params for key,(_,_,required) in spec.items() if required))
    for key,value in params.items(): _validate(spec[key][1],value)
    if scope is not None and name!='list_school_changes': _need(params['p_request_id'] in scope)
    if name=='list_school_changes' and scope is not None:
        params=dict(params)
        requested=params.get('p_request_ids')
        _need(requested is None or set(requested)<=scope)
        params['p_request_ids']=sorted(scope) if requested is None else requested
    raw=json.dumps(params,ensure_ascii=True,allow_nan=False,separators=(',',':')).encode('ascii')
    _need(len(raw)<=MAX_INPUT)
    columns=','.join(f'"{key}" {spec[key][0]}' for key in spec if key in params)
    args=','.join(f'{key}=>p."{key}"' for key in spec if key in params)
    expression=f'public.{name}({args})'
    source=(" FROM jsonb_to_record(convert_from(decode('"+raw.hex()+"','hex'),'UTF8')::jsonb) AS p("+columns+")") if columns else ''
    if name=='list_school_changes':
        expression=f"coalesce(jsonb_agg(result),'[]'::jsonb)"
        invocation='public.list_school_changes('+args+')'
        source=(source+' CROSS JOIN LATERAL ' if source else ' FROM ')+invocation+' AS result'
    dbhex=database.encode('utf-8').hex()
    # Hex-encoded UTF8 JSON keeps even quotes, backslashes and psql commands out
    # of the SQL grammar; typed jsonb_to_record supplies named RPC arguments.
    return ("BEGIN"+(' READ ONLY' if name in READS else '')+";\n"
      "SET LOCAL standard_conforming_strings=on; SET LOCAL search_path=pg_catalog;\n"
      f"SET LOCAL statement_timeout={max(1,int(timeout*1000))}; SET LOCAL lock_timeout={min(5000,max(1,int(timeout*1000)))};\n"
      "DO $$ BEGIN IF current_user<>'postgres' OR current_database()<>convert_from(decode('"+dbhex+"','hex'),'UTF8') "
      "THEN RAISE EXCEPTION 'owner endpoint mismatch'; END IF; END $$;\n"
      'SELECT '+expression+source+';\nCOMMIT;\n').encode('ascii')


def _run(command,environment,raw,timeout,maximum):
    """Nonblocking pipes on Windows/Unix: bounded RAM, no reader thread survives.

    Python 3.12 added Windows pipe support to os.set_blocking. Native psql is the
    trusted executable. Killing the connection cannot roll back a completed RPC.
    """
    deadline=time.monotonic()+timeout
    proc=None
    output=bytearray()
    try:
        proc=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            env=environment,shell=False,bufsize=0,close_fds=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        for stream in (proc.stdin,proc.stdout,proc.stderr): os.set_blocking(stream.fileno(),False)
        offset=errors=0
        opened={proc.stdout:True,proc.stderr:True}
        while proc.poll() is None or any(opened.values()):
            _need(time.monotonic()<deadline)
            progressed=False
            if not proc.stdin.closed:
                if offset==len(raw): proc.stdin.close()
                else:
                    try:
                        count=os.write(proc.stdin.fileno(),raw[offset:offset+4096])
                        _need(count>0); offset+=count; progressed=True
                    except BlockingIOError: pass
            for stream,active in tuple(opened.items()):
                if not active: continue
                try: chunk=os.read(stream.fileno(),65536)
                except BlockingIOError: continue
                if not chunk:
                    opened[stream]=False
                    continue
                progressed=True
                if stream is proc.stdout:
                    _need(len(output)+len(chunk)<=maximum); output.extend(chunk)
                else:
                    errors+=len(chunk); _need(errors<=65536)
            if not progressed: time.sleep(min(0.005,max(0,deadline-time.monotonic())))
        _need(proc.returncode==0 and offset==len(raw) and output and time.monotonic()<deadline)
        return bytes(output)
    except Exception:
        raise SchoolPgError('school PostgreSQL operation failed; reconcile any ambiguous mutation') from None
    finally:
        if proc is not None:
            if proc.poll() is None: proc.kill()
            proc.wait(timeout=1)
            for stream in (proc.stdin,proc.stdout,proc.stderr):
                if stream is not None: stream.close()


def _payload(value,request_id=None):
    _need(type(value) is dict and set(value)==PAYLOAD_KEYS)
    _uuid(value['request_id'])
    _need(request_id is None or value['request_id']==request_id)
    _need(value['kind'] in ('deviation','publish') and value['state'] in STATES)
    _validate('revision',value['revision']); _sha(value['expected_generation'])
    for key in ('school_id','department_id','lease_token','publication_request_id'):
        if value[key] is not None: _uuid(value[key])
    for key in ('submission_fingerprint','claimed_source_sha256','adopted_source_sha256','snapshot_content_sha256',
                'manifest_sha256','code_sha256','application_receipts_sha256'):
        _validate('nullable_sha',value[key])
    _need(type(value['included_request_ids']) is list and len(value['included_request_ids'])<=100)
    for identifier in value['included_request_ids']: _uuid(identifier)
    _need(len(set(value['included_request_ids']))==len(value['included_request_ids']))
    _validate('nullable_receipts',value['application_receipts'])
    if value['lease_until'] is not None: _need(datetime.fromisoformat(value['lease_until']).tzinfo is not None)
    if value['failure_code'] is not None: _validate('failure',value['failure_code'])
    if value['kind']=='deviation':
        _need(value['school_id'] is not None and value['department_id'] is not None
              and type(value['new_value']) is int and 20<=value['new_value']<=80
              and type(value['reason']) is str and 4<=len(value['reason'])<=500)
    else: _need(all(value[k] is None for k in ('school_id','department_id','new_value','reason','expected_value','submission_fingerprint')))
    _need(value['expected_value'] is None or (type(value['expected_value']) is int and -2147483648<=value['expected_value']<=2147483647))
    return value


class SchoolLivePg:
    """rpc(name, params, timeout_seconds=30) -> payload dict, or list for list RPC.

    allowed_request_ids=None explicitly uses the owner's whole school queue;
    a nonempty UUID collection confines both mutations and returned list entries.
    pg_environment accepts only the seven keys below, never ambient PG settings.
    """
    def __init__(self,*,psql_executable,pg_environment,allowed_request_ids=None):
        try:
            path=Path(psql_executable)
            _need(path.is_absolute() and path.is_file() and path.name.lower() in ('psql','psql.exe'))
            self._executable=str(path.resolve(strict=True))
            keys={'PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSSLMODE','PGSSLROOTCERT'}
            _need(type(pg_environment) is dict and set(pg_environment)==keys)
            _need(all(type(v) is str and '\0' not in v and 0<len(v)<=4096 for v in pg_environment.values()))
            env=dict(pg_environment)
            _need(re.fullmatch('[A-Za-z0-9_.:-]{1,253}',env['PGHOST']) and not env['PGHOST'].startswith('-'))
            _need(re.fullmatch('[0-9]{1,5}',env['PGPORT']) and 1<=int(env['PGPORT'])<=65535)
            _need(re.fullmatch('[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}',env['PGUSER']))
            _need(re.fullmatch('[A-Za-z0-9_][A-Za-z0-9_-]{0,62}',env['PGDATABASE']))
            _need(env['PGSSLMODE']=='verify-full')
            ca=Path(env['PGSSLROOTCERT']); _need(ca.is_absolute() and ca.is_file())
            env['PGSSLROOTCERT']=str(ca.resolve(strict=True))
            self._environment=env
            self._scope=None
            if allowed_request_ids is not None:
                _need(type(allowed_request_ids) in (list,tuple,set,frozenset) and 0<len(allowed_request_ids)<=100)
                for identifier in allowed_request_ids: _uuid(identifier)
                self._scope=frozenset(allowed_request_ids)
        except Exception: raise SchoolPgError('school PostgreSQL configuration rejected') from None

    def rpc(self,name,params,*,timeout_seconds=30):
        try:
            _need(type(timeout_seconds) in (int,float) and math.isfinite(timeout_seconds) and 0<timeout_seconds<=60)
            raw=_sql(name,params,self._environment['PGDATABASE'],timeout_seconds,self._scope)
            with tempfile.TemporaryDirectory(prefix='school-live-pg-') as scratch:
                env={key:os.environ[key] for key in ('SYSTEMROOT','WINDIR') if key in os.environ}
                env.update(self._environment)
                env.update(HOME=scratch,USERPROFILE=scratch,APPDATA=scratch,TEMP=scratch,TMP=scratch,
                    PGPASSFILE=str(Path(scratch)/'no-password'),PGSERVICEFILE=str(Path(scratch)/'no-service'),
                    PGCONNECT_TIMEOUT=str(max(1,min(5,math.ceil(timeout_seconds)))),PGCLIENTENCODING='UTF8',
                    PGAPPNAME='school-local-owner',PGOPTIONS='-c search_path=pg_catalog -c timezone=UTC '
                    '-c datestyle=ISO,YMD -c standard_conforming_strings=on')
                result=_json(_run([self._executable,'-X','-qAt','--no-password','--set=ON_ERROR_STOP=1','--file=-'],
                    env,raw,timeout_seconds,MAX_OUTPUT).decode('utf-8'))
            if name=='list_school_changes':
                _need(type(result) is list and len(result)<=params.get('p_limit',25))
                for row in result:
                    _payload(row); _need(self._scope is None or row['request_id'] in self._scope)
                _need(len({r['request_id'] for r in result})==len(result))
            elif name=='school_publication_preflight':
                _need(type(result) is dict and set(result)==set(('request_id revision advisory_only checked_at valid_until '
                    'source_sha256 snapshot_content_sha256 manifest_sha256 code_sha256 application_receipts_sha256').split()))
                _need(result['request_id']==params['p_request_id'] and result['revision']==params['p_expected_revision']
                      and result['advisory_only'] is True)
                for key in ('source_sha256','snapshot_content_sha256','manifest_sha256','code_sha256'):
                    _need(result[key]==params['p_'+key])
                _sha(result['application_receipts_sha256'])
                start,end=(datetime.fromisoformat(result[k]) for k in ('checked_at','valid_until'))
                now=datetime.now(timezone.utc)
                _need(start.tzinfo is not None and end.tzinfo is not None and 0<(end-start).total_seconds()<=30
                      and end>now and (start-now).total_seconds()<=5)
            else:
                _payload(result,params['p_request_id'])
                if name in ('claim_school_change','renew_school_change_lease'):
                    _need(result['revision']==params['p_expected_revision']+1
                          and result['state'] in ('claimed','adopted','generated')
                          and result['lease_token'] is not None and result['lease_until'] is not None
                          and datetime.fromisoformat(result['lease_until'])>datetime.now(timezone.utc))
                    if name=='claim_school_change': _need(result['claimed_source_sha256']==params['p_source_sha256'])
                    else: _need(result['lease_token']==params['p_lease_token'])
                elif name=='ack_school_change':
                    _need(result['state']==params['p_stage'] and result['lease_token']==params['p_lease_token']
                          and result['adopted_source_sha256']==params['p_source_sha256'])
                    if params['p_stage']!='adopted':
                        for key in ('snapshot_content_sha256','manifest_sha256','code_sha256','application_receipts'):
                            _need(result[key]==params.get('p_'+key))
                elif name=='fail_school_change':
                    _need(result['state']=='blocked' and result['failure_code']==params['p_failure_code']
                          and result['lease_token']==params['p_lease_token'] and result['lease_until'] is None)
                elif name=='reject_school_change': _need(result['state']=='rejected' and result['lease_until'] is None)
            return result
        except Exception:
            raise SchoolPgError('school PostgreSQL operation failed; reconcile any ambiguous mutation') from None
