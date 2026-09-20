-- 216_pg_trgm_extension_schema.sql
--
-- Supabase's security advisor flags extensions installed in the public schema.
-- pg_trgm is the only extension currently there. Supabase already places the
-- "extensions" schema on this database role's normal search_path, so moving
-- the extension keeps word_similarity()/gin_trgm_ops available while removing
-- extension-owned functions/operators from the application-owned public schema.
--
-- Embedded PostgreSQL used by CI does not ship pg_trgm; that is an intentional
-- supported state already handled by migrations 135/150. This migration is
-- therefore a no-op when pg_trgm is unavailable.
DO $$
DECLARE
  v_schema TEXT;
BEGIN
  SELECT n.nspname
    INTO v_schema
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'pg_trgm';

  IF v_schema IS NULL OR v_schema = 'extensions' THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
    EXECUTE 'CREATE SCHEMA extensions';
  END IF;

  BEGIN
    ALTER EXTENSION pg_trgm SET SCHEMA extensions;
  EXCEPTION
    WHEN insufficient_privilege THEN
      -- Managed PostgreSQL providers can own extension member objects (for
      -- example pg_trgm.set_limit) with a provider role even when the
      -- application role can otherwise use the extension. In that supported
      -- state, moving the extension is impossible without provider-level
      -- ownership. Do not block application startup; leave the provider-owned
      -- extension where it is and keep the rest of the migration chain usable.
      RAISE NOTICE 'Skipping pg_trgm schema move: current role does not own all extension objects';
  END;
END
$;
