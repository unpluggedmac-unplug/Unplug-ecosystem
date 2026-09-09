-- Phase 12 smoke test #39 only.
-- Deliberately forces fulfilment of the dedicated staging Event #4 to fail
-- after its payment is confirmed, so Checkout Health / retry recovery can be
-- verified end-to-end. This is guarded to the staging database and must be
-- removed by the follow-up #40 cleanup migration before production promotion.

DO $$
BEGIN
  IF current_database() <> 'unplug_ecosystem_staging_db' THEN
    RAISE NOTICE 'Skipping smoke #39 failure trigger outside staging database.';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION staging_smoke_39_fail_event_4_fulfilment()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  AS $fn$
  BEGIN
    IF current_database() = 'unplug_ecosystem_staging_db'
       AND NEW.id = 4
       AND OLD.status = 'awaiting_payment'
       AND NEW.status = 'pending' THEN
      RAISE EXCEPTION 'STAGING_SMOKE_39_CONTROLLED_FULFILMENT_FAILURE';
    END IF;
    RETURN NEW;
  END;
  $fn$;

  DROP TRIGGER IF EXISTS staging_smoke_39_fail_event_4 ON events;
  CREATE TRIGGER staging_smoke_39_fail_event_4
  BEFORE UPDATE OF status ON events
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION staging_smoke_39_fail_event_4_fulfilment();
END;
$$;