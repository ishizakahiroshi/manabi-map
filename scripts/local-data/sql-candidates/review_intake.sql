-- Isolated synthetic candidate only. Not a migration, UI endpoint, or an
-- approved anonymous-account/public-ID policy. No adoption/publication RPC.
-- Prototype scope: deviation 20..80 for an existing non-NULL department.
BEGIN;
DO $$ BEGIN
  IF current_setting('manabi.synthetic_registry_test', true) IS DISTINCT FROM 'on'
     OR current_database() NOT LIKE 'school_registry_synthetic_%' THEN
    RAISE EXCEPTION 'isolated synthetic registry database required';
  END IF;
END $$;
CREATE SCHEMA school_intake_candidate;
REVOKE ALL ON SCHEMA school_intake_candidate FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA school_intake_candidate TO authenticated;

CREATE TABLE school_intake_candidate.requests (
  id uuid PRIMARY KEY REFERENCES public.data_reports(id),
  owner_id uuid NOT NULL REFERENCES auth.users(id),
  school_id uuid NOT NULL,
  department_id uuid NOT NULL,
  proposed_value integer NOT NULL CHECK (proposed_value BETWEEN 20 AND 80),
  source text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  consent boolean NOT NULL DEFAULT true,
  school_consent boolean,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','reviewed','rejected','withdrawn')),
  CHECK ((state = 'withdrawn') = NOT consent)
);
CREATE TABLE school_intake_candidate.audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES school_intake_candidate.requests(id),
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  revision integer NOT NULL,
  action text NOT NULL CHECK (action IN ('submitted','reviewed','rejected','withdrawn','consent','revised')),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Private synthetic mapping and allowlist. No authenticated caller can enroll
-- itself or obtain another subject's underlying auth.users identifier.
CREATE TABLE school_intake_candidate.executors (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id)
);
CREATE TABLE school_intake_candidate.subjects (
  owner_id uuid PRIMARY KEY REFERENCES auth.users(id),
  subject_ref uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()
);
CREATE TABLE school_intake_candidate.transfer_events (
  request_id uuid NOT NULL REFERENCES school_intake_candidate.requests(id),
  revision integer NOT NULL,
  event jsonb NOT NULL,
  PRIMARY KEY(request_id,revision)
);
ALTER TABLE school_intake_candidate.requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_intake_candidate.audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY requests_admin_read ON school_intake_candidate.requests FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id = auth.uid()));
CREATE POLICY audit_admin_read ON school_intake_candidate.audit FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id = auth.uid()));
REVOKE ALL ON ALL TABLES IN SCHEMA school_intake_candidate FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA school_intake_candidate FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON school_intake_candidate.requests, school_intake_candidate.audit TO authenticated;

CREATE FUNCTION school_intake_candidate.require_member() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (
    SELECT 1 FROM auth.users u WHERE u.id = v_uid AND NOT u.is_anonymous
  ) THEN RAISE EXCEPTION 'non-anonymous authentication required'; END IF;
  RETURN v_uid;
END $$;

CREATE FUNCTION school_intake_candidate.record_transfer(p_request uuid,p_kind text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_row school_intake_candidate.requests; v_subject uuid;
BEGIN
  SELECT * INTO STRICT v_row FROM school_intake_candidate.requests WHERE id=p_request;
  INSERT INTO school_intake_candidate.subjects(owner_id) VALUES(v_row.owner_id) ON CONFLICT DO NOTHING;
  SELECT subject_ref INTO STRICT v_subject FROM school_intake_candidate.subjects WHERE owner_id=v_row.owner_id;
  INSERT INTO school_intake_candidate.transfer_events(request_id,revision,event)
  VALUES(v_row.id,v_row.revision,jsonb_build_object(
    'event_id',gen_random_uuid(),'request_id',v_row.id,'revision',v_row.revision,
    'subject_ref',v_subject,'school_id',v_row.school_id,'department_id',v_row.department_id,
    'kind',p_kind,'consent',v_row.consent,'school_consent',v_row.school_consent,
    'payload',jsonb_build_object('school_id',v_row.school_id,'department_id',v_row.department_id,
                               'field','deviation_value','value',v_row.proposed_value)));
END $$;

CREATE FUNCTION school_intake_candidate.export_transfer(p_request uuid,p_revision integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_uid uuid := school_intake_candidate.require_member(); v_event jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM school_intake_candidate.executors WHERE user_id=v_uid) THEN
    RAISE EXCEPTION 'authorized synthetic executor required';
  END IF;
  SELECT event INTO v_event FROM school_intake_candidate.transfer_events
    WHERE request_id=p_request AND revision=p_revision;
  IF v_event IS NULL THEN RAISE EXCEPTION 'exportable revision missing'; END IF;
  RETURN v_event;
END $$;

CREATE FUNCTION school_intake_candidate.submit(
  p_school uuid, p_department uuid, p_value integer, p_source text, p_consent boolean
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_uid uuid := school_intake_candidate.require_member(); v_id uuid;
BEGIN
  IF p_consent IS DISTINCT FROM true THEN RAISE EXCEPTION 'explicit consent required'; END IF;
  IF p_value IS NULL OR p_value NOT BETWEEN 20 AND 80 THEN RAISE EXCEPTION 'invalid deviation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.school_departments d
                 WHERE d.id = p_department AND d.school_id = p_school) THEN
    RAISE EXCEPTION 'department membership required';
  END IF;
  -- Existing actual data_reports rate trigger runs in this same transaction.
  INSERT INTO public.data_reports(school_id,department_id,field,proposed_value,source,reporter_user_id)
    VALUES(p_school,p_department,'deviation',p_value::text,p_source,v_uid) RETURNING id INTO v_id;
  INSERT INTO school_intake_candidate.requests(id,owner_id,school_id,department_id,proposed_value,source)
    VALUES(v_id,v_uid,p_school,p_department,p_value,p_source);
  INSERT INTO school_intake_candidate.audit(request_id,actor_id,revision,action,reason)
    VALUES(v_id,v_uid,1,'submitted','explicit candidate consent');
  RETURN v_id;
END $$;

CREATE FUNCTION school_intake_candidate.withdraw(p_request uuid, p_revision integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_uid uuid := school_intake_candidate.require_member(); v_row school_intake_candidate.requests;
BEGIN
  SELECT * INTO v_row FROM school_intake_candidate.requests r WHERE r.id = p_request FOR UPDATE;
  IF v_row.id IS NULL OR v_row.owner_id <> v_uid THEN RAISE EXCEPTION 'own request required'; END IF;
  IF p_revision IS DISTINCT FROM v_row.revision THEN RAISE EXCEPTION 'stale revision'; END IF;
  IF NOT v_row.consent THEN RAISE EXCEPTION 'already withdrawn'; END IF;
  UPDATE school_intake_candidate.requests SET consent=false,school_consent=false,state='withdrawn',revision=revision+1 WHERE id=p_request;
  INSERT INTO school_intake_candidate.audit(request_id,actor_id,revision,action,reason)
    VALUES(p_request,v_uid,v_row.revision+1,'withdrawn','owner consent withdrawal');
  -- Existing report/audit history survives withdrawal; it is never publication evidence.
  PERFORM school_intake_candidate.record_transfer(p_request,'withdrawn');
  RETURN v_row.revision+1;
END $$;

CREATE FUNCTION school_intake_candidate.set_consent(
  p_request uuid,p_revision integer,p_consent boolean,p_school_consent boolean
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_uid uuid := school_intake_candidate.require_member(); v_row school_intake_candidate.requests;
BEGIN
  SELECT * INTO v_row FROM school_intake_candidate.requests WHERE id=p_request FOR UPDATE;
  IF v_row.id IS NULL OR v_row.owner_id <> v_uid THEN RAISE EXCEPTION 'own request required'; END IF;
  IF p_revision IS DISTINCT FROM v_row.revision THEN RAISE EXCEPTION 'stale revision'; END IF;
  IF p_consent IS NULL OR p_school_consent IS NULL THEN RAISE EXCEPTION 'explicit consent required'; END IF;
  UPDATE school_intake_candidate.requests SET consent=p_consent,school_consent=p_school_consent,
    state=CASE WHEN NOT p_consent THEN 'withdrawn' WHEN state='withdrawn' THEN 'pending' ELSE state END,
    revision=revision+1 WHERE id=p_request;
  IF p_consent AND v_row.state='withdrawn' THEN
    UPDATE public.data_reports SET status='pending',reviewed_at=NULL,reviewed_by=NULL WHERE id=p_request;
  END IF;
  INSERT INTO school_intake_candidate.audit(request_id,actor_id,revision,action,reason)
    VALUES(p_request,v_uid,v_row.revision+1,'consent','explicit scoped candidate consent');
  PERFORM school_intake_candidate.record_transfer(p_request,CASE WHEN p_consent THEN 'consent' ELSE 'withdrawn' END);
  RETURN v_row.revision+1;
END $$;

CREATE FUNCTION school_intake_candidate.revise(p_request uuid,p_revision integer,p_value integer,p_source text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_uid uuid := school_intake_candidate.require_member(); v_row school_intake_candidate.requests;
BEGIN
  SELECT * INTO v_row FROM school_intake_candidate.requests WHERE id=p_request FOR UPDATE;
  IF v_row.id IS NULL OR v_row.owner_id <> v_uid THEN RAISE EXCEPTION 'own request required'; END IF;
  IF p_revision IS DISTINCT FROM v_row.revision THEN RAISE EXCEPTION 'stale revision'; END IF;
  IF v_row.state <> 'withdrawn' THEN RAISE EXCEPTION 'withdrawal before correction required'; END IF;
  IF p_value IS NULL OR p_value NOT BETWEEN 20 AND 80 THEN RAISE EXCEPTION 'invalid deviation'; END IF;
  PERFORM 1 FROM public.school_departments WHERE id=v_row.department_id AND school_id=v_row.school_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'current department membership required'; END IF;
  UPDATE public.data_reports SET proposed_value=p_value::text,source=p_source WHERE id=p_request;
  UPDATE school_intake_candidate.requests SET proposed_value=p_value,source=p_source,revision=revision+1 WHERE id=p_request;
  INSERT INTO school_intake_candidate.audit(request_id,actor_id,revision,action,reason)
    VALUES(p_request,v_uid,v_row.revision+1,'revised','owner correction remains withdrawn');
  PERFORM school_intake_candidate.record_transfer(p_request,'withdrawn');
  RETURN v_row.revision+1;
END $$;

CREATE FUNCTION school_intake_candidate.review(
  p_request uuid, p_revision integer, p_expected_value integer, p_decision text, p_reason text, p_pin text
) RETURNS SETOF school_intake_candidate.requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_uid uuid := school_intake_candidate.require_member();
  v_row school_intake_candidate.requests; v_report public.data_reports;
  v_hash text; v_locked timestamptz;
BEGIN
  SELECT a.pin_hash INTO v_hash FROM public.admin_users a WHERE a.user_id=v_uid;
  IF v_hash IS NULL THEN RAISE EXCEPTION 'admin required'; END IF;
  -- Same PIN algorithm and 5 failures / 15 minutes contract as the existing
  -- correction RPC. Added advisory lock covers the first attempt row too.
  PERFORM pg_advisory_xact_lock(hashtextextended('candidate-admin-pin:' || v_uid::text,0));
  SELECT a.locked_until INTO v_locked FROM public.admin_pin_attempts a WHERE a.user_id=v_uid FOR UPDATE;
  IF v_locked > now() THEN RETURN; END IF;
  IF extensions.crypt(coalesce(p_pin,''),v_hash) <> v_hash THEN
    INSERT INTO public.admin_pin_attempts(user_id,failed_attempts,locked_until,updated_at)
      VALUES(v_uid,1,NULL,now())
      ON CONFLICT(user_id) DO UPDATE SET
        failed_attempts=public.admin_pin_attempts.failed_attempts+1,
        locked_until=CASE WHEN public.admin_pin_attempts.failed_attempts+1 >= 5
          THEN now()+interval '15 minutes' ELSE NULL END, updated_at=now();
    RETURN; -- zero rows is failure; exception would roll back the attempt.
  END IF;
  SELECT * INTO v_row FROM school_intake_candidate.requests r WHERE r.id=p_request FOR UPDATE;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'request missing'; END IF;
  IF p_revision IS DISTINCT FROM v_row.revision OR p_expected_value IS DISTINCT FROM v_row.proposed_value THEN
    RAISE EXCEPTION 'stale review content or revision';
  END IF;
  IF NOT v_row.consent OR v_row.state <> 'pending' THEN RAISE EXCEPTION 'request not reviewable'; END IF;
  -- Recheck and lock the currently referenced rows. Receipt membership alone
  -- must not authorize a review after a department was moved or retired.
  PERFORM 1 FROM public.schools s JOIN public.school_departments d ON d.school_id=s.id
    WHERE s.id=v_row.school_id AND d.id=v_row.department_id FOR SHARE OF s,d;
  IF NOT FOUND THEN RAISE EXCEPTION 'current department membership required'; END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('reviewed','rejected') THEN RAISE EXCEPTION 'invalid decision'; END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 4 AND 500 THEN RAISE EXCEPTION 'invalid reason'; END IF;
  SELECT * INTO v_report FROM public.data_reports r WHERE r.id=p_request FOR UPDATE;
  IF v_report.status <> 'pending' OR v_report.reporter_user_id IS DISTINCT FROM v_row.owner_id
    OR v_report.school_id IS DISTINCT FROM v_row.school_id
    OR v_report.department_id IS DISTINCT FROM v_row.department_id
    OR v_report.field IS DISTINCT FROM 'deviation'
    OR v_report.proposed_value IS DISTINCT FROM v_row.proposed_value::text
    OR v_report.source IS DISTINCT FROM v_row.source THEN
    RAISE EXCEPTION 'report diverged from receipt';
  END IF;
  DELETE FROM public.admin_pin_attempts WHERE user_id=v_uid;
  UPDATE public.data_reports SET status=p_decision,reviewed_at=now(),reviewed_by=v_uid WHERE id=p_request;
  UPDATE school_intake_candidate.requests SET state=p_decision,revision=revision+1 WHERE id=p_request;
  INSERT INTO school_intake_candidate.audit(request_id,actor_id,revision,action,reason)
    VALUES(p_request,v_uid,v_row.revision+1,p_decision,btrim(p_reason));
  IF p_decision='reviewed' THEN PERFORM school_intake_candidate.record_transfer(p_request,'reviewed'); END IF;
  RETURN QUERY SELECT * FROM school_intake_candidate.requests r WHERE r.id=p_request;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA school_intake_candidate FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION school_intake_candidate.submit(uuid,uuid,integer,text,boolean),
  school_intake_candidate.withdraw(uuid,integer),
  school_intake_candidate.set_consent(uuid,integer,boolean,boolean),
  school_intake_candidate.revise(uuid,integer,integer,text),
  school_intake_candidate.export_transfer(uuid,integer),
  school_intake_candidate.review(uuid,integer,integer,text,text,text) TO authenticated;
COMMIT;
