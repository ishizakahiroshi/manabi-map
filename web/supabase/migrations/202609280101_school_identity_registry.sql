-- Prepare the SQLite school cutover without deleting any old school table.
-- Run once through the migration runner as postgres (or a role allowed to SET
-- ROLE postgres). Existing user/report/audit rows and their RLS stay unchanged.
-- Historical IDs remain valid; registration does not assert public visibility.
-- Before eventual school-table removal, switch admin RPCs and all consumers.
-- After removal, the trusted SQLite synchronizer must call the two append_*
-- functions as postgres before publishing new IDs. No browser/service key can
-- register IDs. Registration is idempotent but can never move a department.
-- Rollback of a static release must retain newly registered IDs and user data.
-- Do not restore the old FKs until old school content covers every saved ID.
BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE public.schools, public.school_departments,
  public.user_school_favorites, public.user_school_notes,
  public.user_school_deviations, public.data_reports,
  public.deviation_correction_logs IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public.school_id_registry (id uuid PRIMARY KEY);
CREATE TABLE public.department_id_registry (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES public.school_id_registry(id) ON DELETE RESTRICT,
  UNIQUE (school_id, id)
);
ALTER TABLE public.school_id_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.department_id_registry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.school_id_registry, public.department_id_registry
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, REFERENCES ON TABLE public.school_id_registry,
  public.department_id_registry TO postgres;

CREATE FUNCTION public.reject_school_registry_rewrite() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'school identity registry is append-only';
END;
$$;
REVOKE ALL ON FUNCTION public.reject_school_registry_rewrite()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reject_school_registry_rewrite() TO postgres;
CREATE TRIGGER school_registry_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON public.school_id_registry
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_school_registry_rewrite();
CREATE TRIGGER department_registry_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON public.department_id_registry
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_school_registry_rewrite();

CREATE FUNCTION public.append_school_identity(p_school_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO public.school_id_registry(id) VALUES (p_school_id)
    ON CONFLICT (id) DO NOTHING;
END;
$$;
CREATE FUNCTION public.append_department_identity(p_department_id uuid, p_school_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO public.department_id_registry(id, school_id)
    VALUES (p_department_id, p_school_id) ON CONFLICT (id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM public.department_id_registry
                 WHERE id = p_department_id AND school_id = p_school_id) THEN
    RAISE EXCEPTION 'department identity cannot change school';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.append_school_identity(uuid),
  public.append_department_identity(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.append_school_identity(uuid),
  public.append_department_identity(uuid, uuid) TO postgres;

-- One-way compatibility while the old source tables still accept new rows.
-- AFTER INSERT avoids recording an attempted INSERT suppressed by ON CONFLICT.
CREATE FUNCTION public.register_inserted_school_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM public.append_school_identity(NEW.id);
  RETURN NEW;
END;
$$;
CREATE FUNCTION public.register_inserted_department_identity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM public.append_department_identity(NEW.id, NEW.school_id);
  RETURN NEW;
END;
$$;
CREATE FUNCTION public.reject_source_school_identity_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'school identity cannot change';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION public.reject_source_department_identity_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.school_id IS DISTINCT FROM OLD.school_id THEN
    RAISE EXCEPTION 'department identity cannot change school or id';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.register_inserted_school_identity(),
  public.register_inserted_department_identity(),
  public.reject_source_school_identity_change(),
  public.reject_source_department_identity_change()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_inserted_school_identity(),
  public.register_inserted_department_identity(),
  public.reject_source_school_identity_change(),
  public.reject_source_department_identity_change() TO postgres;
CREATE TRIGGER school_identity_register AFTER INSERT ON public.schools
  FOR EACH ROW EXECUTE FUNCTION public.register_inserted_school_identity();
CREATE TRIGGER department_identity_register AFTER INSERT ON public.school_departments
  FOR EACH ROW EXECUTE FUNCTION public.register_inserted_department_identity();
CREATE TRIGGER school_identity_immutable BEFORE UPDATE OF id ON public.schools
  FOR EACH ROW EXECUTE FUNCTION public.reject_source_school_identity_change();
CREATE TRIGGER department_identity_immutable BEFORE UPDATE OF id, school_id ON public.school_departments
  FOR EACH ROW EXECUTE FUNCTION public.reject_source_department_identity_change();

-- All source identities, including inactive/retired and unused ones, survive.
INSERT INTO public.school_id_registry(id) SELECT id FROM public.schools;
INSERT INTO public.department_id_registry(id, school_id)
  SELECT id, school_id FROM public.school_departments;

ALTER TABLE public.user_school_favorites ADD CONSTRAINT user_school_favorites_registry_school_fkey
  FOREIGN KEY (school_id) REFERENCES public.school_id_registry(id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.user_school_notes ADD CONSTRAINT user_school_notes_registry_school_fkey
  FOREIGN KEY (school_id) REFERENCES public.school_id_registry(id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.user_school_deviations ADD CONSTRAINT user_school_deviations_registry_school_fkey
  FOREIGN KEY (school_id) REFERENCES public.school_id_registry(id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.data_reports ADD CONSTRAINT data_reports_registry_school_fkey
  FOREIGN KEY (school_id) REFERENCES public.school_id_registry(id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.deviation_correction_logs ADD CONSTRAINT deviation_correction_logs_registry_school_fkey
  FOREIGN KEY (school_id) REFERENCES public.school_id_registry(id) ON DELETE RESTRICT NOT VALID;
-- MATCH SIMPLE preserves the NULL-department sentinel; school is still checked.
ALTER TABLE public.user_school_deviations ADD CONSTRAINT user_school_deviations_registry_department_fkey
  FOREIGN KEY (school_id, department_id) REFERENCES public.department_id_registry(school_id, id)
  MATCH SIMPLE ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.data_reports ADD CONSTRAINT data_reports_registry_department_fkey
  FOREIGN KEY (school_id, department_id) REFERENCES public.department_id_registry(school_id, id)
  MATCH SIMPLE ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.deviation_correction_logs ADD CONSTRAINT deviation_correction_logs_registry_department_fkey
  FOREIGN KEY (school_id, department_id) REFERENCES public.department_id_registry(school_id, id)
  MATCH SIMPLE ON DELETE RESTRICT NOT VALID;

ALTER TABLE public.user_school_favorites VALIDATE CONSTRAINT user_school_favorites_registry_school_fkey;
ALTER TABLE public.user_school_notes VALIDATE CONSTRAINT user_school_notes_registry_school_fkey;
ALTER TABLE public.user_school_deviations VALIDATE CONSTRAINT user_school_deviations_registry_school_fkey;
ALTER TABLE public.data_reports VALIDATE CONSTRAINT data_reports_registry_school_fkey;
ALTER TABLE public.deviation_correction_logs VALIDATE CONSTRAINT deviation_correction_logs_registry_school_fkey;
ALTER TABLE public.user_school_deviations VALIDATE CONSTRAINT user_school_deviations_registry_department_fkey;
ALTER TABLE public.data_reports VALIDATE CONSTRAINT data_reports_registry_department_fkey;
ALTER TABLE public.deviation_correction_logs VALIDATE CONSTRAINT deviation_correction_logs_registry_department_fkey;

-- Do not remove ANY old FK until every new constraint has passed validation.
ALTER TABLE public.user_school_favorites DROP CONSTRAINT user_school_favorites_school_id_fkey;
ALTER TABLE public.user_school_notes DROP CONSTRAINT user_school_notes_school_id_fkey;
ALTER TABLE public.user_school_deviations DROP CONSTRAINT user_school_deviations_school_id_fkey;
ALTER TABLE public.data_reports DROP CONSTRAINT data_reports_school_id_fkey;
ALTER TABLE public.deviation_correction_logs DROP CONSTRAINT deviation_correction_logs_school_id_fkey;
ALTER TABLE public.user_school_deviations DROP CONSTRAINT user_school_deviations_department_id_fkey;
ALTER TABLE public.data_reports DROP CONSTRAINT data_reports_department_id_fkey;
ALTER TABLE public.deviation_correction_logs DROP CONSTRAINT deviation_correction_logs_department_id_fkey;
COMMIT;
