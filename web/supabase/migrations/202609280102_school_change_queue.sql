-- Durable admin requests for the local SQLite owner. No school data is changed
-- here and no deployment hook is called. Install after the identity registry.
-- Owner worker contract: expected_generation is the full PUBLIC generator
-- payload SHA256 (observed receipt.generatorSnapshotSha256), not the 13-table
-- private snapshot content hash. Resolve it through a verified observed receipt
-- to sourceContentSha256; validate expected_value against the current target;
-- claim with the full current SQLite hash, then commit change + immutable local
-- receipt together. An ACK is a trusted owner's attestation, NOT a distributed
-- transaction or independent proof that SQLite/HTTP was inspected.
-- A restart reconciles the local receipt, reclaims an expired lease with its
-- original claimed_source_sha256, and resends the same ACK. Never apply twice.
-- Publication ACK requires actual observed artifacts, not a deploy response.
-- Aggregate-derived requests bind current consent via submission_fingerprint.
-- A changed fingerprint blocks adoption/publication; an already adopted local
-- change then needs explicit reconciliation before a new candidate is issued.
-- Direct admin corrections (NULL fingerprint) never import personal submissions.
-- Only one owner changes the SQLite source. A pending explicit publication
-- freezes its request cohort: later corrections stay received until that cohort
-- is observed publicly. Never generate from a source containing other changes.
BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.school_change_requests (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('deviation', 'publish')),
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  school_id uuid REFERENCES public.school_id_registry(id) ON DELETE RESTRICT,
  department_id uuid,
  new_value integer CHECK (new_value BETWEEN 20 AND 80),
  reason text,
  expected_generation text NOT NULL CHECK (expected_generation ~ '^[0-9a-f]{64}$'),
  expected_value integer,
  submission_fingerprint text CHECK (submission_fingerprint ~ '^[0-9a-f]{64}$'),
  included_request_ids uuid[] NOT NULL DEFAULT '{}'::uuid[] CHECK (cardinality(included_request_ids)<=100),
  publication_request_id uuid REFERENCES public.school_change_requests(id),
  state text NOT NULL DEFAULT 'received' CHECK (state IN
    ('received','claimed','adopted','generated','publication_confirmed','blocked','rejected')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  lease_token uuid,
  lease_until timestamptz,
  claimed_source_sha256 text CHECK (claimed_source_sha256 ~ '^[0-9a-f]{64}$'),
  adopted_source_sha256 text CHECK (adopted_source_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_content_sha256 text CHECK (snapshot_content_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_sha256 text CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  code_sha256 text CHECK (code_sha256 ~ '^[0-9a-f]{64}$'),
  publication jsonb,
  application_receipts jsonb,
  application_receipts_sha256 text CHECK (application_receipts_sha256 ~ '^[0-9a-f]{64}$'),
  failure_code text,
  correction_log_id uuid REFERENCES public.deviation_correction_logs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, department_id)
    REFERENCES public.department_id_registry(school_id, id) ON DELETE RESTRICT,
  CHECK ((kind='deviation' AND school_id IS NOT NULL AND department_id IS NOT NULL
          AND new_value IS NOT NULL AND char_length(btrim(reason)) BETWEEN 4 AND 500 AND reason IS NOT NULL)
      OR (kind='publish' AND school_id IS NULL AND department_id IS NULL AND new_value IS NULL
          AND reason IS NULL AND expected_value IS NULL AND submission_fingerprint IS NULL))
);
CREATE INDEX school_change_requests_pending ON public.school_change_requests(state, created_at, id);
CREATE TABLE public.school_change_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES public.school_change_requests(id) ON DELETE RESTRICT,
  revision integer NOT NULL,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.school_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.school_change_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.school_change_requests, public.school_change_events
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.school_change_events_id_seq FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.school_change_requests, public.school_change_events TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.school_change_requests TO postgres;
GRANT SELECT, INSERT ON TABLE public.school_change_events TO postgres;
GRANT USAGE, SELECT ON SEQUENCE public.school_change_events_id_seq TO postgres;
CREATE POLICY school_changes_admin_read ON public.school_change_requests FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id=auth.uid()));
CREATE POLICY school_change_events_admin_read ON public.school_change_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id=auth.uid()));

CREATE FUNCTION public.guard_school_change_body() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'school request history cannot be removed'; END IF;
  IF ROW(NEW.id,NEW.kind,NEW.school_id,NEW.department_id,NEW.new_value,NEW.reason,
         NEW.expected_generation,NEW.expected_value,NEW.submission_fingerprint,NEW.created_at,NEW.included_request_ids)
     IS DISTINCT FROM ROW(OLD.id,OLD.kind,OLD.school_id,OLD.department_id,OLD.new_value,OLD.reason,
         OLD.expected_generation,OLD.expected_value,OLD.submission_fingerprint,OLD.created_at,OLD.included_request_ids)
     OR (NEW.requested_by IS DISTINCT FROM OLD.requested_by AND NEW.requested_by IS NOT NULL) THEN
    RAISE EXCEPTION 'school request body is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION public.guard_school_change_events() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'school change events are append-only'; END;
$$;
CREATE TRIGGER school_change_body_immutable BEFORE UPDATE OR DELETE ON public.school_change_requests
  FOR EACH ROW EXECUTE FUNCTION public.guard_school_change_body();
CREATE TRIGGER school_change_no_truncate BEFORE TRUNCATE ON public.school_change_requests
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_school_change_body();
CREATE TRIGGER school_change_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON public.school_change_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_school_change_events();

CREATE FUNCTION public.school_submission_fingerprint(p_department_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
  SELECT encode(extensions.digest(coalesce(jsonb_agg(jsonb_build_array(u.user_id,u.value,u.updated_at)
                  ORDER BY u.user_id),'[]'::jsonb)::text,'sha256'),'hex')
  FROM public.user_school_deviations u
  WHERE u.department_id=p_department_id AND u.visibility='submit_to_manabi';
$$;
CREATE FUNCTION public.require_school_change_admin() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id=v_uid) THEN
    RAISE EXCEPTION 'admin authentication required';
  END IF;
  RETURN v_uid;
END;
$$;

CREATE FUNCTION public.request_school_deviation(p_request_id uuid,p_department_id uuid,p_new_value integer,
  p_reason text,p_pin text,p_expected_generation text,p_expected_value integer,
  p_submission_fingerprint text DEFAULT NULL)
RETURNS TABLE(request_id uuid,state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_uid uuid := public.require_school_change_admin(); v_hash text; v_locked timestamptz;
  v_school uuid; v_row public.school_change_requests; v_reason text := btrim(coalesce(p_reason,''));
BEGIN
  -- Serialize the first failed attempt as well as an existing attempt row.
  PERFORM pg_advisory_xact_lock(hashtextextended('school-admin-pin:' || v_uid::text,0));
  SELECT a.locked_until INTO v_locked FROM public.admin_pin_attempts a WHERE a.user_id=v_uid FOR UPDATE;
  IF v_locked > now() THEN RETURN; END IF;
  SELECT a.pin_hash INTO v_hash FROM public.admin_users a WHERE a.user_id=v_uid;
  IF v_hash IS NULL OR extensions.crypt(coalesce(p_pin,''),v_hash) <> v_hash THEN
    INSERT INTO public.admin_pin_attempts(user_id,failed_attempts,locked_until,updated_at)
      VALUES(v_uid,1,NULL,now()) ON CONFLICT(user_id) DO UPDATE SET
      failed_attempts=public.admin_pin_attempts.failed_attempts+1,
      locked_until=CASE WHEN public.admin_pin_attempts.failed_attempts+1 >= 5 THEN now()+interval '15 minutes' ELSE NULL END,
      updated_at=now();
    RETURN;
  END IF;
  IF p_request_id IS NULL OR p_new_value IS NULL OR p_new_value NOT BETWEEN 20 AND 80
     OR char_length(v_reason) NOT BETWEEN 4 AND 500
     OR p_expected_generation IS NULL OR p_expected_generation !~ '^[0-9a-f]{64}$'
     OR (p_submission_fingerprint IS NOT NULL AND p_submission_fingerprint !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'invalid school change request';
  END IF;
  SELECT d.school_id INTO v_school FROM public.department_id_registry d WHERE d.id=p_department_id;
  IF v_school IS NULL THEN RAISE EXCEPTION 'registered department required'; END IF;
  IF p_submission_fingerprint IS NOT NULL AND
     p_submission_fingerprint IS DISTINCT FROM public.school_submission_fingerprint(p_department_id) THEN
    RAISE EXCEPTION 'current submission consent differs';
  END IF;
  INSERT INTO public.school_change_requests(id,kind,requested_by,school_id,department_id,new_value,reason,
    expected_generation,expected_value,submission_fingerprint)
    VALUES(p_request_id,'deviation',v_uid,v_school,p_department_id,p_new_value,v_reason,
      p_expected_generation,p_expected_value,p_submission_fingerprint) ON CONFLICT(id) DO NOTHING;
  IF FOUND THEN
    INSERT INTO public.school_change_events(request_id,revision,action) VALUES(p_request_id,1,'received');
  END IF;
  SELECT * INTO STRICT v_row FROM public.school_change_requests r WHERE r.id=p_request_id FOR UPDATE;
  IF ROW(v_row.kind,v_row.requested_by,v_row.school_id,v_row.department_id,v_row.new_value,v_row.reason,
         v_row.expected_generation,v_row.expected_value,v_row.submission_fingerprint)
     IS DISTINCT FROM ROW('deviation'::text,v_uid,v_school,p_department_id,p_new_value,v_reason,
         p_expected_generation,p_expected_value,p_submission_fingerprint) THEN
    RAISE EXCEPTION 'request id reused with different content';
  END IF;
  DELETE FROM public.admin_pin_attempts WHERE user_id=v_uid;
  RETURN QUERY SELECT v_row.id,v_row.state;
END;
$$;

CREATE FUNCTION public.request_school_publication(p_request_id uuid,p_expected_generation text)
RETURNS TABLE(request_id uuid,state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_uid uuid := public.require_school_change_admin(); v_row public.school_change_requests; v_ids uuid[];
BEGIN
  IF p_request_id IS NULL OR p_expected_generation IS NULL OR p_expected_generation !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid publication request';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('school-publication-request',0));
  SELECT * INTO v_row FROM public.school_change_requests r WHERE r.id=p_request_id FOR UPDATE;
  IF FOUND THEN
    IF ROW(v_row.kind,v_row.requested_by,v_row.expected_generation)
       IS DISTINCT FROM ROW('publish'::text,v_uid,p_expected_generation) THEN
      RAISE EXCEPTION 'request id reused with different content';
    END IF;
    RETURN QUERY SELECT v_row.id,v_row.state;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.school_change_requests r
             WHERE r.kind='publish' AND r.state NOT IN ('publication_confirmed','rejected')) THEN
    RAISE EXCEPTION 'a publication request is already pending';
  END IF;
  SELECT coalesce(array_agg(p.id ORDER BY p.id),'{}'::uuid[]) INTO v_ids
    FROM (SELECT r.id FROM public.school_change_requests r WHERE r.kind='deviation'
      AND r.state IN ('received','claimed','adopted') AND r.publication_request_id IS NULL FOR UPDATE) p;
  IF cardinality(v_ids)>100 THEN RAISE EXCEPTION 'publication request set exceeds limit'; END IF;
  INSERT INTO public.school_change_requests(id,kind,requested_by,expected_generation,included_request_ids)
    VALUES(p_request_id,'publish',v_uid,p_expected_generation,v_ids);
  UPDATE public.school_change_requests SET publication_request_id=p_request_id WHERE id=ANY(v_ids);
  INSERT INTO public.school_change_events(request_id,revision,action) VALUES(p_request_id,1,'received');
  SELECT * INTO STRICT v_row FROM public.school_change_requests r WHERE r.id=p_request_id;
  RETURN QUERY SELECT v_row.id,v_row.state;
END;
$$;

CREATE FUNCTION public.get_school_deviation_submissions(p_school_id uuid DEFAULT NULL,p_threshold integer DEFAULT 5)
RETURNS TABLE(school_id uuid,department_id uuid,submission_count integer,avg_value numeric,median_value numeric,
  min_value integer,max_value integer,latest_submission_at timestamptz,submission_fingerprint text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
  PERFORM public.require_school_change_admin();
  RETURN QUERY SELECT d.school_id,d.id,count(DISTINCT u.user_id)::integer,round(avg(u.value)::numeric,1),
    percentile_cont(0.5) WITHIN GROUP(ORDER BY u.value)::numeric,min(u.value),max(u.value),max(u.updated_at),
    public.school_submission_fingerprint(d.id)
    FROM public.user_school_deviations u JOIN public.department_id_registry d
      ON d.id=u.department_id AND d.school_id=u.school_id
    WHERE u.visibility='submit_to_manabi' AND (p_school_id IS NULL OR d.school_id=p_school_id)
    GROUP BY d.school_id,d.id HAVING count(DISTINCT u.user_id)>=greatest(coalesce(p_threshold,5),1)
    ORDER BY count(DISTINCT u.user_id) DESC,max(u.updated_at) DESC;
END;
$$;

-- Owner-only transport projection. Personal user rows, auth IDs and PINs never
-- enter the local source. reason is the admin's private correction justification.
CREATE FUNCTION public.school_change_worker_payload(p_request_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('request_id',r.id,'kind',r.kind,'school_id',r.school_id,
    'department_id',r.department_id,'new_value',r.new_value,'reason',r.reason,
    'expected_generation',r.expected_generation,'expected_value',r.expected_value,
    'submission_fingerprint',r.submission_fingerprint,'state',r.state,'revision',r.revision,
    'lease_token',r.lease_token,'lease_until',r.lease_until,'claimed_source_sha256',r.claimed_source_sha256,
    'adopted_source_sha256',r.adopted_source_sha256,'snapshot_content_sha256',r.snapshot_content_sha256,
    'manifest_sha256',r.manifest_sha256,'code_sha256',r.code_sha256,'failure_code',r.failure_code)
    || jsonb_build_object('included_request_ids',r.included_request_ids,'publication_request_id',r.publication_request_id,
                         'application_receipts',r.application_receipts,'application_receipts_sha256',r.application_receipts_sha256)
  FROM public.school_change_requests r WHERE r.id=p_request_id;
$$;
-- Cursor rows remain present even after terminal state: request history is
-- append-only. Apply an explicit owner scope BEFORE the page limit.
CREATE FUNCTION public.list_school_changes(p_limit integer DEFAULT 25,p_after_id uuid DEFAULT NULL,
  p_request_ids uuid[] DEFAULT NULL) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR
     (p_after_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.school_change_requests WHERE id=p_after_id)) OR
     (p_request_ids IS NOT NULL AND (cardinality(p_request_ids) NOT BETWEEN 1 AND 100 OR array_position(p_request_ids,NULL) IS NOT NULL)) THEN
    RAISE EXCEPTION 'invalid school request page';
  END IF;
  RETURN QUERY SELECT public.school_change_worker_payload(r.id) FROM public.school_change_requests r
  WHERE r.state NOT IN ('publication_confirmed','rejected')
    AND (p_request_ids IS NULL OR r.id=ANY(p_request_ids))
    AND (p_after_id IS NULL OR (r.created_at,r.id)>
      (SELECT a.created_at,a.id FROM public.school_change_requests a WHERE a.id=p_after_id))
  ORDER BY r.created_at,r.id LIMIT p_limit;
END;
$$;
CREATE FUNCTION public.claim_school_change(p_request_id uuid,p_expected_revision integer,
  p_source_sha256 text,p_lease_seconds integer DEFAULT 300) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_row public.school_change_requests; v_state text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('school-publication-request',0));
  IF p_source_sha256 IS NULL OR p_source_sha256 !~ '^[0-9a-f]{64}$'
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'invalid worker claim';
  END IF;
  SELECT * INTO STRICT v_row FROM public.school_change_requests r WHERE r.id=p_request_id FOR UPDATE;
  IF v_row.kind='deviation' AND EXISTS (SELECT 1 FROM public.school_change_requests p
      WHERE p.kind='publish' AND p.state NOT IN ('publication_confirmed','rejected')
        AND NOT (v_row.id=ANY(p.included_request_ids))) THEN
    RAISE EXCEPTION 'later correction waits for pending publication';
  END IF;
  IF p_expected_revision IS DISTINCT FROM v_row.revision OR v_row.state IN ('publication_confirmed','rejected')
     OR (v_row.kind='deviation' AND v_row.state IN ('adopted','generated'))
     OR v_row.lease_until > now() OR (v_row.state='blocked' AND
       v_row.failure_code NOT IN ('generation_failed','publication_failed','executor_stopped')) THEN
    RAISE EXCEPTION 'stale or unavailable school request';
  END IF;
  IF v_row.submission_fingerprint IS NOT NULL AND v_row.submission_fingerprint
     IS DISTINCT FROM public.school_submission_fingerprint(v_row.department_id) THEN
    RAISE EXCEPTION 'current submission consent differs';
  END IF;
  IF v_row.kind='publish' AND EXISTS (SELECT 1 FROM public.school_change_requests c
    WHERE c.id=ANY(v_row.included_request_ids) AND
      (c.state NOT IN ('adopted','generated') OR c.publication_request_id IS DISTINCT FROM v_row.id OR
       (c.submission_fingerprint IS NOT NULL AND c.submission_fingerprint
          IS DISTINCT FROM public.school_submission_fingerprint(c.department_id)))) THEN
    RAISE EXCEPTION 'publication set is not adopted with current consent';
  END IF;
  IF v_row.claimed_source_sha256 IS NOT NULL AND v_row.claimed_source_sha256 <> p_source_sha256 THEN
    RAISE EXCEPTION 'claim source differs from original receipt base';
  END IF;
  v_state := CASE WHEN v_row.snapshot_content_sha256 IS NOT NULL THEN 'generated'
                  WHEN v_row.adopted_source_sha256 IS NOT NULL AND v_row.kind='deviation' THEN 'adopted' ELSE 'claimed' END;
  UPDATE public.school_change_requests SET state=v_state,revision=revision+1,lease_token=gen_random_uuid(),
    lease_until=now()+make_interval(secs=>p_lease_seconds),claimed_source_sha256=p_source_sha256,
    failure_code=NULL,updated_at=now() WHERE id=p_request_id;
  INSERT INTO public.school_change_events(request_id,revision,action)
    SELECT id,revision,'claimed' FROM public.school_change_requests WHERE id=p_request_id;
  RETURN public.school_change_worker_payload(p_request_id);
END;
$$;

CREATE FUNCTION public.ack_school_change(p_request_id uuid,p_lease_token uuid,p_stage text,p_source_sha256 text,
  p_snapshot_content_sha256 text DEFAULT NULL,p_manifest_sha256 text DEFAULT NULL,
  p_code_sha256 text DEFAULT NULL,p_publication jsonb DEFAULT NULL,p_application_receipts jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_row public.school_change_requests; v_log uuid; v_observed timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('school-publication-request',0));
  SELECT * INTO STRICT v_row FROM public.school_change_requests r WHERE r.id=p_request_id FOR UPDATE;
  IF p_stage IS NULL OR p_stage NOT IN ('adopted','generated','publication_confirmed') OR
     (p_stage='adopted' AND v_row.kind<>'deviation') OR (p_stage<>'adopted' AND v_row.kind<>'publish') OR
     p_lease_token IS DISTINCT FROM v_row.lease_token OR p_lease_token IS NULL OR
     p_source_sha256 IS NULL OR p_source_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid school ACK'; END IF;
  -- Same successful ACK may be retried after a lost response, never with new pins.
  IF v_row.state=p_stage THEN
    IF p_source_sha256 IS DISTINCT FROM v_row.adopted_source_sha256 OR
       (p_stage='adopted' AND (p_snapshot_content_sha256 IS NOT NULL OR p_manifest_sha256 IS NOT NULL
          OR p_code_sha256 IS NOT NULL OR p_publication IS NOT NULL OR p_application_receipts IS NOT NULL)) OR
       (p_stage<>'adopted' AND ROW(p_snapshot_content_sha256,p_manifest_sha256,p_code_sha256)
          IS DISTINCT FROM ROW(v_row.snapshot_content_sha256,v_row.manifest_sha256,v_row.code_sha256)) OR
       (p_stage='publication_confirmed' AND p_publication IS DISTINCT FROM v_row.publication) OR
       (p_stage<>'adopted' AND p_application_receipts IS DISTINCT FROM v_row.application_receipts) THEN
      RAISE EXCEPTION 'repeated ACK differs';
    END IF;
    RETURN public.school_change_worker_payload(p_request_id);
  END IF;
  IF v_row.lease_until IS NULL OR v_row.lease_until<=now() THEN RAISE EXCEPTION 'school worker lease expired'; END IF;
  IF v_row.submission_fingerprint IS NOT NULL AND v_row.submission_fingerprint
     IS DISTINCT FROM public.school_submission_fingerprint(v_row.department_id) THEN
    RAISE EXCEPTION 'current submission consent differs';
  END IF;
  IF v_row.kind='publish' AND EXISTS (SELECT 1 FROM public.school_change_requests c
    WHERE c.id=ANY(v_row.included_request_ids) AND
      (c.publication_request_id IS DISTINCT FROM v_row.id OR
       (c.submission_fingerprint IS NOT NULL AND c.submission_fingerprint
          IS DISTINCT FROM public.school_submission_fingerprint(c.department_id)))) THEN
    RAISE EXCEPTION 'publication consent differs; reconcile source';
  END IF;
  IF p_stage='adopted' THEN
    IF v_row.kind<>'deviation' OR v_row.state<>'claimed' OR p_source_sha256=v_row.claimed_source_sha256
       OR p_snapshot_content_sha256 IS NOT NULL OR p_manifest_sha256 IS NOT NULL
       OR p_code_sha256 IS NOT NULL OR p_publication IS NOT NULL OR p_application_receipts IS NOT NULL THEN RAISE EXCEPTION 'invalid adoption ACK'; END IF;
    INSERT INTO public.deviation_correction_logs(school_id,department_id,changed_by,old_value,new_value,reason)
      VALUES(v_row.school_id,v_row.department_id,v_row.requested_by,v_row.expected_value,v_row.new_value,v_row.reason)
      RETURNING id INTO v_log;
    UPDATE public.school_change_requests SET adopted_source_sha256=p_source_sha256,correction_log_id=v_log WHERE id=p_request_id;
  ELSIF p_stage='generated' THEN
    IF NOT (v_row.kind='publish' AND v_row.state='claimed' AND p_source_sha256=v_row.claimed_source_sha256)
       OR p_snapshot_content_sha256 IS NULL OR p_snapshot_content_sha256 !~ '^[0-9a-f]{64}$'
       OR p_manifest_sha256 IS NULL OR p_manifest_sha256 !~ '^[0-9a-f]{64}$'
       OR p_code_sha256 IS NULL OR p_code_sha256 !~ '^[0-9a-f]{64}$' OR p_publication IS NOT NULL THEN
      RAISE EXCEPTION 'invalid generated ACK';
    END IF;
    IF p_application_receipts IS NULL OR jsonb_typeof(p_application_receipts)<>'array'
       OR jsonb_array_length(p_application_receipts)<>cardinality(v_row.included_request_ids) THEN
      RAISE EXCEPTION 'complete application receipt set required';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_application_receipts) e WHERE jsonb_typeof(e)<>'object'
       OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(e) k) IS DISTINCT FROM ARRAY['receipt_sha256','request_id']
       OR coalesce(e->>'receipt_sha256','') !~ '^[0-9a-f]{64}$'
       OR NOT (coalesce(e->>'request_id','')=ANY(v_row.included_request_ids::text[])))
       OR (SELECT count(DISTINCT e->>'request_id') FROM jsonb_array_elements(p_application_receipts) e)
          <>cardinality(v_row.included_request_ids)
       OR EXISTS (SELECT 1 FROM public.school_change_requests c WHERE c.id=ANY(v_row.included_request_ids) AND c.state<>'adopted') THEN
      RAISE EXCEPTION 'application receipt set differs';
    END IF;
    UPDATE public.school_change_requests SET adopted_source_sha256=p_source_sha256,
      snapshot_content_sha256=p_snapshot_content_sha256,manifest_sha256=p_manifest_sha256,code_sha256=p_code_sha256,
      application_receipts=p_application_receipts,
      application_receipts_sha256=encode(extensions.digest(p_application_receipts::text,'sha256'),'hex')
      WHERE id=p_request_id;
  ELSE
    IF v_row.state<>'generated' OR ROW(p_source_sha256,p_snapshot_content_sha256,p_manifest_sha256,p_code_sha256)
       IS DISTINCT FROM ROW(v_row.adopted_source_sha256,v_row.snapshot_content_sha256,v_row.manifest_sha256,v_row.code_sha256)
       OR p_publication IS NULL OR jsonb_typeof(p_publication)<>'object' THEN RAISE EXCEPTION 'invalid publication ACK'; END IF;
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_publication) k)
       IS DISTINCT FROM ARRAY['application_receipts_sha256','artifact_count','artifacts_sha256','deployment_id','destination','manifest_sha256','observed_at']
       OR p_application_receipts IS DISTINCT FROM v_row.application_receipts
       OR p_publication->>'application_receipts_sha256' IS DISTINCT FROM v_row.application_receipts_sha256
       OR coalesce(p_publication->>'destination','') NOT IN ('https://manabi-map.app','https://school.manabi-map.app')
       OR p_publication->>'manifest_sha256' IS DISTINCT FROM p_manifest_sha256
       OR coalesce(p_publication->>'artifacts_sha256','') !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(p_publication->'artifact_count') <> 'number'
       OR coalesce(p_publication->>'artifact_count','') !~ '^[1-9][0-9]{0,5}$'
       OR jsonb_typeof(p_publication->'deployment_id') <> 'string'
       OR char_length(btrim(coalesce(p_publication->>'deployment_id',''))) NOT BETWEEN 1 AND 200
       OR jsonb_typeof(p_publication->'observed_at') <> 'string'
       OR coalesce(p_publication->>'observed_at','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
       THEN RAISE EXCEPTION 'invalid observed publication evidence'; END IF;
    v_observed := (p_publication->>'observed_at')::timestamptz;
    IF v_observed < v_row.updated_at-interval '5 minutes' OR v_observed > now()+interval '5 minutes'
       OR NOT isfinite(v_observed) THEN RAISE EXCEPTION 'stale publication observation'; END IF;
    UPDATE public.school_change_requests SET publication=p_publication WHERE id=p_request_id;
  END IF;
  UPDATE public.school_change_requests SET state=p_stage,revision=revision+1,updated_at=now() WHERE id=p_request_id;
  INSERT INTO public.school_change_events(request_id,revision,action)
    SELECT id,revision,p_stage FROM public.school_change_requests WHERE id=p_request_id;
  IF v_row.kind='publish' THEN
    UPDATE public.school_change_requests SET state=p_stage,revision=revision+1,updated_at=now()
      WHERE id=ANY(v_row.included_request_ids);
    INSERT INTO public.school_change_events(request_id,revision,action,detail)
      SELECT id,revision,p_stage,jsonb_build_object('publication_request_id',p_request_id)
      FROM public.school_change_requests WHERE id=ANY(v_row.included_request_ids);
  END IF;
  RETURN public.school_change_worker_payload(p_request_id);
END;
$$;

-- A long owner operation renews before expiry; renewal does not approve publish.
CREATE FUNCTION public.renew_school_change_lease(p_request_id uuid,p_lease_token uuid,p_expected_revision integer,
  p_lease_seconds integer DEFAULT 300) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_row public.school_change_requests;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('school-publication-request',0));
  SELECT * INTO STRICT v_row FROM public.school_change_requests r WHERE r.id=p_request_id FOR UPDATE;
  IF p_lease_token IS NULL OR p_lease_token IS DISTINCT FROM v_row.lease_token
     OR p_expected_revision IS DISTINCT FROM v_row.revision OR v_row.state NOT IN ('claimed','adopted','generated')
     OR v_row.lease_until IS NULL OR v_row.lease_until<=clock_timestamp()
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'stale or invalid lease renewal';
  END IF;
  UPDATE public.school_change_requests SET lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
    revision=revision+1,updated_at=clock_timestamp() WHERE id=p_request_id;
  INSERT INTO public.school_change_events(request_id,revision,action)
    SELECT id,revision,'lease_renewed' FROM public.school_change_requests WHERE id=p_request_id;
  RETURN public.school_change_worker_payload(p_request_id);
END;
$$;

-- Call immediately before the external publish operation. This is a fresh
-- advisory check, not a stored permit: consent can change after this transaction
-- ends. Recheck on retries, and still inspect actual public artifacts for ACK.
CREATE FUNCTION public.school_publication_preflight(p_request_id uuid,p_lease_token uuid,p_expected_revision integer,
  p_source_sha256 text,p_snapshot_content_sha256 text,p_manifest_sha256 text,p_code_sha256 text,
  p_application_receipts jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_row public.school_change_requests; v_checked timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('school-publication-request',0));
  SELECT * INTO STRICT v_row FROM public.school_change_requests r WHERE r.id=p_request_id FOR UPDATE;
  v_checked := clock_timestamp();
  IF v_row.kind<>'publish' OR v_row.state<>'generated'
     OR p_expected_revision IS DISTINCT FROM v_row.revision
     OR p_lease_token IS NULL OR p_lease_token IS DISTINCT FROM v_row.lease_token
     OR v_row.lease_until IS NULL OR v_row.lease_until<=v_checked
     OR ROW(p_source_sha256,p_snapshot_content_sha256,p_manifest_sha256,p_code_sha256)
        IS DISTINCT FROM ROW(v_row.adopted_source_sha256,v_row.snapshot_content_sha256,v_row.manifest_sha256,v_row.code_sha256)
     OR p_application_receipts IS DISTINCT FROM v_row.application_receipts THEN
    RAISE EXCEPTION 'stale publication preflight or pins';
  END IF;
  IF EXISTS (SELECT 1 FROM public.school_change_requests c WHERE c.id=ANY(v_row.included_request_ids)
    AND (c.state<>'generated' OR c.publication_request_id IS DISTINCT FROM v_row.id
      OR (c.submission_fingerprint IS NOT NULL AND c.submission_fingerprint
          IS DISTINCT FROM public.school_submission_fingerprint(c.department_id)))) THEN
    RAISE EXCEPTION 'publication cohort or current consent differs';
  END IF;
  RETURN jsonb_build_object('request_id',v_row.id,'revision',v_row.revision,'advisory_only',true,
    'checked_at',v_checked,'valid_until',least(v_checked+interval '30 seconds',v_row.lease_until),
    'source_sha256',v_row.adopted_source_sha256,'snapshot_content_sha256',v_row.snapshot_content_sha256,
    'manifest_sha256',v_row.manifest_sha256,'code_sha256',v_row.code_sha256,
    'application_receipts_sha256',v_row.application_receipts_sha256);
END;
$$;

-- Manual owner reconciliation only. local_receipts_sha256 pins the inspected
-- local cancellation receipt (deviation), or the complete cohort receipt report
-- (publish); request_ids is that exact cohort. SQL cannot inspect those files.
-- Rejecting an ungenerated publication releases its members, preserving adopted
-- changes for a NEW explicit publication. It never undoes a SQLite adoption.
CREATE FUNCTION public.reject_school_change(p_request_id uuid,p_expected_revision integer,p_evidence jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_row public.school_change_requests; v_observed timestamptz; v_ids uuid[]; v_decision text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('school-publication-request',0));
  SELECT * INTO STRICT v_row FROM public.school_change_requests r WHERE r.id=p_request_id FOR UPDATE;
  IF v_row.state='rejected' THEN
    IF EXISTS (SELECT 1 FROM public.school_change_events e WHERE e.request_id=p_request_id
      AND e.action='rejected' AND e.detail=p_evidence) THEN RETURN public.school_change_worker_payload(p_request_id); END IF;
    RAISE EXCEPTION 'rejection evidence differs';
  END IF;
  IF p_expected_revision IS DISTINCT FROM v_row.revision OR v_row.state='publication_confirmed'
     OR v_row.lease_until>clock_timestamp() OR v_row.snapshot_content_sha256 IS NOT NULL
     OR v_row.manifest_sha256 IS NOT NULL OR v_row.code_sha256 IS NOT NULL
     OR v_row.publication IS NOT NULL OR v_row.application_receipts IS NOT NULL THEN
    RAISE EXCEPTION 'request may already be generated or have a live worker; reconciliation required';
  END IF;
  IF v_row.kind='deviation' THEN
    IF v_row.adopted_source_sha256 IS NOT NULL OR v_row.correction_log_id IS NOT NULL
       OR v_row.state IN ('adopted','generated') THEN RAISE EXCEPTION 'adopted correction requires a new correction'; END IF;
    v_ids := ARRAY[v_row.id]; v_decision := 'cancelled_before_adoption';
  ELSE
    v_ids := v_row.included_request_ids; v_decision := 'release_unpublished_cohort';
    IF EXISTS (SELECT 1 FROM public.school_change_requests c WHERE c.id=ANY(v_ids)
      AND (c.publication_request_id IS DISTINCT FROM v_row.id OR c.lease_until>clock_timestamp()
        OR c.state IN ('generated','publication_confirmed') OR c.snapshot_content_sha256 IS NOT NULL)) THEN
      RAISE EXCEPTION 'cohort has a live worker or publication possibility';
    END IF;
  END IF;
  IF p_evidence IS NULL OR jsonb_typeof(p_evidence)<>'object'
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_evidence) k)
       IS DISTINCT FROM ARRAY['decision','local_receipts_sha256','local_source_sha256','observed_at','request_ids']
     OR p_evidence->>'decision' IS DISTINCT FROM v_decision
     OR p_evidence->'request_ids' IS DISTINCT FROM to_jsonb(v_ids)
     OR coalesce(p_evidence->>'local_source_sha256','') !~ '^[0-9a-f]{64}$'
     OR coalesce(p_evidence->>'local_receipts_sha256','') !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(p_evidence->'observed_at')<>'string'
     OR coalesce(p_evidence->>'observed_at','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' THEN
    RAISE EXCEPTION 'complete local reconciliation evidence required';
  END IF;
  v_observed := (p_evidence->>'observed_at')::timestamptz;
  IF NOT isfinite(v_observed) OR abs(extract(epoch FROM (clock_timestamp()-v_observed)))>300 THEN
    RAISE EXCEPTION 'stale local reconciliation evidence';
  END IF;
  UPDATE public.school_change_requests SET state='rejected',revision=revision+1,lease_until=NULL,
    failure_code=NULL,updated_at=clock_timestamp() WHERE id=p_request_id;
  INSERT INTO public.school_change_events(request_id,revision,action,detail)
    SELECT id,revision,'rejected',p_evidence FROM public.school_change_requests WHERE id=p_request_id;
  IF v_row.kind='publish' THEN
    UPDATE public.school_change_requests SET publication_request_id=NULL,revision=revision+1,updated_at=clock_timestamp()
      WHERE id=ANY(v_ids);
    INSERT INTO public.school_change_events(request_id,revision,action,detail)
      SELECT id,revision,'publication_released',jsonb_build_object('publication_request_id',p_request_id)
      FROM public.school_change_requests WHERE id=ANY(v_ids);
  END IF;
  RETURN public.school_change_worker_payload(p_request_id);
END;
$$;

CREATE FUNCTION public.fail_school_change(p_request_id uuid,p_lease_token uuid,p_failure_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_row public.school_change_requests;
BEGIN
  IF p_failure_code IS NULL OR p_failure_code NOT IN
    ('source_conflict','consent_changed','generation_failed','publication_failed','executor_stopped') THEN
    RAISE EXCEPTION 'invalid school failure code';
  END IF;
  SELECT * INTO STRICT v_row FROM public.school_change_requests r WHERE r.id=p_request_id FOR UPDATE;
  IF p_lease_token IS NULL OR p_lease_token IS DISTINCT FROM v_row.lease_token
     OR v_row.state IN ('received','publication_confirmed','rejected') THEN RAISE EXCEPTION 'stale school failure'; END IF;
  UPDATE public.school_change_requests SET state='blocked',failure_code=p_failure_code,lease_until=NULL,
    revision=revision+1,updated_at=now() WHERE id=p_request_id;
  INSERT INTO public.school_change_events(request_id,revision,action,detail)
    SELECT id,revision,'blocked',jsonb_build_object('failure_code',p_failure_code) FROM public.school_change_requests WHERE id=p_request_id;
  RETURN public.school_change_worker_payload(p_request_id);
END;
$$;

-- Fail closed for cached old clients: never call an accepted request "applied".
CREATE OR REPLACE FUNCTION public.correct_school_deviation(p_department_id uuid,p_new_value integer,p_reason text,p_pin text)
RETURNS TABLE(school_id uuid,department_id uuid,old_value integer,new_value integer,log_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'school correction moved to request_school_deviation; refresh client'; END;
$$;
CREATE OR REPLACE FUNCTION public.get_deviation_review_queue(p_school_id uuid DEFAULT NULL,p_threshold integer DEFAULT 5)
RETURNS TABLE(school_id uuid,school_name text,department_id uuid,department_name text,official_value integer,
  submission_count integer,avg_value numeric,median_value numeric,min_value integer,max_value integer,latest_submission_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'school submissions moved to get_school_deviation_submissions; refresh client'; END;
$$;

REVOKE ALL ON FUNCTION public.guard_school_change_body(),public.guard_school_change_events(),
  public.school_submission_fingerprint(uuid),public.require_school_change_admin(),
  public.school_change_worker_payload(uuid),public.list_school_changes(integer,uuid,uuid[]),
  public.claim_school_change(uuid,integer,text,integer),public.ack_school_change(uuid,uuid,text,text,text,text,text,jsonb,jsonb),
  public.school_publication_preflight(uuid,uuid,integer,text,text,text,text,jsonb),
  public.renew_school_change_lease(uuid,uuid,integer,integer),
  public.reject_school_change(uuid,integer,jsonb),
  public.fail_school_change(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.guard_school_change_body(),public.guard_school_change_events(),
  public.school_submission_fingerprint(uuid),public.require_school_change_admin(),
  public.school_change_worker_payload(uuid),public.list_school_changes(integer,uuid,uuid[]),
  public.claim_school_change(uuid,integer,text,integer),public.ack_school_change(uuid,uuid,text,text,text,text,text,jsonb,jsonb),
  public.school_publication_preflight(uuid,uuid,integer,text,text,text,text,jsonb),
  public.renew_school_change_lease(uuid,uuid,integer,integer),
  public.reject_school_change(uuid,integer,jsonb),
  public.fail_school_change(uuid,uuid,text) TO postgres;
REVOKE ALL ON FUNCTION public.request_school_deviation(uuid,uuid,integer,text,text,text,integer,text),
  public.request_school_publication(uuid,text),public.get_school_deviation_submissions(uuid,integer),
  public.correct_school_deviation(uuid,integer,text,text),public.get_deviation_review_queue(uuid,integer)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.request_school_deviation(uuid,uuid,integer,text,text,text,integer,text),
  public.request_school_publication(uuid,text),public.get_school_deviation_submissions(uuid,integer),
  public.correct_school_deviation(uuid,integer,text,text),public.get_deviation_review_queue(uuid,integer) TO authenticated;
COMMIT;
