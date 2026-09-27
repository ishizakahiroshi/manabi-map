-- Read-only recovery preflight. Keep registry additions and post-cutover user data.
-- A publication rollback is independent: never restore an old user-data snapshot.
-- Do not re-add old FKs until old school content has been separately reconstructed,
-- reconciled and approved. This result describes missing IDs, not permission to delete.
BEGIN READ ONLY;
DO $$ BEGIN
  IF current_setting('manabi.synthetic_registry_test', true) IS DISTINCT FROM 'on'
     OR current_database() NOT LIKE 'school_registry_synthetic_%' THEN
    RAISE EXCEPTION 'isolated synthetic registry database required';
  END IF;
END $$;
SELECT 'school' AS kind, r.id, NULL::uuid AS school_id
  FROM public.school_id_registry r LEFT JOIN public.schools s USING (id) WHERE s.id IS NULL
UNION ALL
SELECT 'department', r.id, r.school_id FROM public.department_id_registry r
  LEFT JOIN public.school_departments d ON d.id = r.id AND d.school_id = r.school_id
  WHERE d.id IS NULL;
COMMIT;
