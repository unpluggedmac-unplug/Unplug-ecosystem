-- 215_function_search_path_hardening.sql
--
-- Supabase's database linter reports every application function that inherits
-- the caller's search_path. None of these functions is SECURITY DEFINER today,
-- but pinning the lookup path removes a whole class of object-shadowing bugs
-- and makes the contract explicit before a future privilege change can make
-- the warning security-sensitive.
--
-- This project re-runs every migration on each deploy. The loop is therefore
-- deliberately idempotent and discovers application functions dynamically.
-- Extension-owned functions (for example pg_trgm) are excluded: extensions
-- manage their own objects and moving/rewriting them is a separate decision.
DO $$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT n.nspname,
           p.proname,
           pg_get_function_identity_arguments(p.oid) AS identity_args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND NOT EXISTS (
         SELECT 1
           FROM pg_depend d
           JOIN pg_extension e ON e.oid = d.refobjid
          WHERE d.classid = 'pg_proc'::regclass
            AND d.objid = p.oid
            AND d.deptype = 'e'
       )
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = public, pg_temp',
      fn.nspname,
      fn.proname,
      fn.identity_args
    );
  END LOOP;
END
$$;
