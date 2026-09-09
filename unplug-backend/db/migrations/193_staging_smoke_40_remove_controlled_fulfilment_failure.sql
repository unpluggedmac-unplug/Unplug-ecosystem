-- Phase 12 smoke test #40 cleanup.
-- Remove the staging-only controlled fulfilment failure introduced by migration 192
-- so the failed Event #4 fulfilment can be retried successfully.

DO $$
BEGIN
  IF current_database() <> 'unplug_ecosystem_staging_db' THEN
    RAISE NOTICE 'Skipping smoke #40 cleanup outside staging database.';
    RETURN;
  END IF;

  DROP TRIGGER IF EXISTS staging_smoke_39_fail_event_4 ON events;
  DROP FUNCTION IF EXISTS staging_smoke_39_fail_event_4_fulfilment();
END;
$$;
