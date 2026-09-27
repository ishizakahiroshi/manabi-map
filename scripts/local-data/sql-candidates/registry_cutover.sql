-- Synthetic C3-a candidate. Apply only in the isolated test harness.
-- No production migration or public-ID saving policy is approved by this file.
BEGIN;
DO $$ BEGIN
  IF current_setting('manabi.synthetic_registry_test', true) IS DISTINCT FROM 'on'
     OR current_database() NOT LIKE 'school_registry_synthetic_%' THEN
    RAISE EXCEPTION 'isolated synthetic registry database required';
  END IF;
END $$;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.schools, public.school_departments,
  public.user_school_favorites, public.user_school_notes, public.user_school_deviations,
  public.data_reports, public.deviation_correction_logs IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public.school_id_registry (id uuid PRIMARY KEY);
CREATE TABLE public.department_id_registry (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES public.school_id_registry(id) ON DELETE RESTRICT,
  UNIQUE (school_id, id)
);
ALTER TABLE public.school_id_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.department_id_registry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.school_id_registry, public.department_id_registry
  FROM PUBLIC, anon, authenticated, service_role;
-- SELECT/publication gates and a dedicated production synchronizer are undecided.
-- The synthetic owner alone appends IDs. No browser/API role receives privileges.
CREATE FUNCTION public.reject_registry_rewrite() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'registry IDs are append-only'; END $$;
REVOKE ALL ON FUNCTION public.reject_registry_rewrite() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER school_registry_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON public.school_id_registry FOR EACH STATEMENT EXECUTE FUNCTION public.reject_registry_rewrite();
CREATE TRIGGER department_registry_append_only BEFORE UPDATE OR DELETE OR TRUNCATE
  ON public.department_id_registry FOR EACH STATEMENT EXECUTE FUNCTION public.reject_registry_rewrite();

-- Keep every old ID, including retired schools and currently unused departments.
INSERT INTO public.school_id_registry SELECT id FROM public.schools;
INSERT INTO public.department_id_registry SELECT id, school_id FROM public.school_departments;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_school_favorites', 'user_school_notes', 'user_school_deviations',
                           'data_reports', 'deviation_correction_logs'] LOOP
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (school_id) REFERENCES public.school_id_registry(id) ON DELETE RESTRICT NOT VALID', t, t || '_registry_school_fkey');
    EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', t, t || '_registry_school_fkey');
  END LOOP;
  FOREACH t IN ARRAY ARRAY['user_school_deviations', 'data_reports', 'deviation_correction_logs'] LOOP
    -- MATCH SIMPLE allows a NULL department, but the independent school FK still applies.
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (school_id, department_id) REFERENCES public.department_id_registry(school_id, id) MATCH SIMPLE ON DELETE RESTRICT NOT VALID', t, t || '_registry_department_fkey');
    EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', t, t || '_registry_department_fkey');
  END LOOP;
  -- All new FKs must validate before any old FK is removed. Mismatch rolls back everything.
  FOREACH t IN ARRAY ARRAY['user_school_favorites', 'user_school_notes', 'user_school_deviations',
                           'data_reports', 'deviation_correction_logs'] LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, t || '_school_id_fkey');
  END LOOP;
  FOREACH t IN ARRAY ARRAY['user_school_deviations', 'data_reports', 'deviation_correction_logs'] LOOP
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, t || '_department_id_fkey');
  END LOOP;
END $$;
-- Existing owner/family/report/admin policies, auth.users FKs, NULL uniqueness,
-- consent RPC and all user data are preserved. Old school rows are NOT removed here.
COMMIT;
