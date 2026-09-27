-- DESTRUCTIVE, operator-gated cutover. This file alone refuses to run.
-- Only after verified SQLite/backup pins, published static artifacts, live worker
-- acceptance, and an approved source-writer stop may the operator set
-- manabi.school_source_removal='verified' in this same psql session. SET LOCAL
-- requires an already-open transaction. Never enable this gate in a workflow.
-- The gate is an operator attestation, not independent proof of those checks.
-- No user tables, identity registries, request queues, or legacy reject RPCs are
-- removed. An unexpected dependency aborts this entire transaction.
BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE FUNCTION pg_temp.check_school_source_removal() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF pg_catalog.current_setting('manabi.school_source_removal',true) IS DISTINCT FROM 'verified' THEN
    RAISE EXCEPTION 'verified school source removal operator gate required';
  END IF;
  IF current_user<>'postgres'
     OR pg_catalog.to_regclass('public.school_id_registry') IS NULL
     OR pg_catalog.to_regclass('public.department_id_registry') IS NULL
     OR pg_catalog.to_regclass('public.school_change_requests') IS NULL
     OR pg_catalog.to_regclass('public.school_change_events') IS NULL
     OR pg_catalog.to_regprocedure('public.school_publication_preflight(uuid,uuid,integer,text,text,text,text,jsonb)') IS NULL
     OR pg_catalog.to_regprocedure('public.reject_school_change(uuid,integer,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'identity registry and live queue migrations required';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM (VALUES
    ('user_school_favorites','user_school_favorites_registry_school_fkey','school_id_registry'),
    ('user_school_notes','user_school_notes_registry_school_fkey','school_id_registry'),
    ('user_school_deviations','user_school_deviations_registry_school_fkey','school_id_registry'),
    ('data_reports','data_reports_registry_school_fkey','school_id_registry'),
    ('deviation_correction_logs','deviation_correction_logs_registry_school_fkey','school_id_registry'),
    ('user_school_deviations','user_school_deviations_registry_department_fkey','department_id_registry'),
    ('data_reports','data_reports_registry_department_fkey','department_id_registry'),
    ('deviation_correction_logs','deviation_correction_logs_registry_department_fkey','department_id_registry')
    ) expected(table_name,constraint_name,target_name)
    JOIN pg_catalog.pg_constraint c ON c.conrelid=pg_catalog.to_regclass('public.'||expected.table_name)
      AND c.conname=expected.constraint_name AND c.confrelid=pg_catalog.to_regclass('public.'||expected.target_name)
      AND c.contype='f' AND c.convalidated AND c.confdeltype='r')<>8 THEN
    RAISE EXCEPTION 'all eight validated registry foreign keys required';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schools s LEFT JOIN public.school_id_registry r ON r.id=s.id WHERE r.id IS NULL)
     OR EXISTS (SELECT 1 FROM public.school_departments d LEFT JOIN public.department_id_registry r
       ON r.id=d.id AND r.school_id=d.school_id WHERE r.id IS NULL) THEN
    RAISE EXCEPTION 'all source identities must be retained';
  END IF;
  -- Publication membership is removed automatically with a relation, so it is
  -- checked explicitly instead of relying on dependency rejection below.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_publication WHERE puballtables)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_publication_tables WHERE schemaname='public'
       AND tablename IN (
         'admission_exam_component_master','admission_map_role_master','admission_quality_reason_master',
         'admission_recruitment_unit_departments','admission_recruitment_unit_kind_master','admission_recruitment_units',
         'admission_selection_stage_master','admission_selection_track_master','course_type_master',
         'school_admission_selection_stats','school_admission_stat_exam_components','school_admission_stat_legacy_links',
         'school_admission_stat_quality_flags','school_admission_stat_sources','school_admission_stats',
         'school_departments','school_deviation_values','school_field_source_field_master','school_field_sources',
         'school_lifecycle_status_master','school_name_history','school_recruitment_status_master',
         'school_relationship_type_master','school_relationships','schools')) THEN
    RAISE EXCEPTION 'school source publication membership requires separate review';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION pg_temp.check_school_source_removal() FROM PUBLIC,anon,authenticated,service_role;
SELECT pg_temp.check_school_source_removal();

-- One explicit target statement allows dependencies WITHIN this exact source
-- set while rejecting every remaining external FK/view/other tracked dependent.
DROP TABLE
  public.admission_exam_component_master,
  public.admission_map_role_master,
  public.admission_quality_reason_master,
  public.admission_recruitment_unit_departments,
  public.admission_recruitment_unit_kind_master,
  public.admission_recruitment_units,
  public.admission_selection_stage_master,
  public.admission_selection_track_master,
  public.course_type_master,
  public.school_admission_selection_stats,
  public.school_admission_stat_exam_components,
  public.school_admission_stat_legacy_links,
  public.school_admission_stat_quality_flags,
  public.school_admission_stat_sources,
  public.school_admission_stats,
  public.school_departments,
  public.school_deviation_values,
  public.school_field_source_field_master,
  public.school_field_sources,
  public.school_lifecycle_status_master,
  public.school_name_history,
  public.school_recruitment_status_master,
  public.school_relationship_type_master,
  public.school_relationships,
  public.schools
RESTRICT;

DROP FUNCTION
  public.sync_dept_ui_group(),
  public.sync_master_ui_group(),
  public.validate_admission_recruitment_unit_department(),
  public.validate_admission_recruitment_unit_school(),
  public.sync_school_status_compatibility()
RESTRICT;
DROP FUNCTION pg_temp.check_school_source_removal() RESTRICT;
COMMIT;
