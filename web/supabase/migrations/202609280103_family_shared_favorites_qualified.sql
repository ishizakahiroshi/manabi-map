-- RETURNS TABLE exposes status as a PL/pgSQL variable. Qualify the membership
-- columns to preserve the authorization predicate under variable_conflict=error.
BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE OR REPLACE FUNCTION public.get_family_shared_favorites(p_group_id uuid)
RETURNS TABLE(owner_id uuid, school_id uuid, priority integer, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF coalesce((SELECT u.is_anonymous FROM auth.users u WHERE u.id = v_uid), true) THEN
    RAISE EXCEPTION 'anonymous users cannot use family sharing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.family_members fm
    WHERE fm.group_id = p_group_id AND fm.user_id = v_uid AND fm.status = 'active'
  ) THEN RAISE EXCEPTION 'not a member of this group'; END IF;
  RETURN QUERY
    SELECT f.user_id, f.school_id, f.priority::int, f.status::text
    FROM public.user_school_favorites f
    JOIN public.family_members m
      ON m.user_id = f.user_id AND m.group_id = p_group_id
     AND m.status = 'active' AND m.share_favorites = true
    WHERE f.user_id <> v_uid;
END;
$$;
REVOKE ALL ON FUNCTION public.get_family_shared_favorites(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_family_shared_favorites(uuid) TO authenticated;
COMMIT;
