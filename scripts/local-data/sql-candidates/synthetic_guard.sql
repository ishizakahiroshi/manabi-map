-- Candidate only: never part of web/supabase/migrations or a deployment command.
DO $$ BEGIN
  IF current_setting('manabi.synthetic_registry_test', true) IS DISTINCT FROM 'on'
     OR current_database() NOT LIKE 'school_registry_synthetic_%' THEN
    RAISE EXCEPTION 'isolated synthetic registry database required';
  END IF;
END $$;
