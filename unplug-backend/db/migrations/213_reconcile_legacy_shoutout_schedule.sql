-- Reconcile a legacy staging-only shoutout_schedule shape.
--
-- Older staging data retained a required recipient_name column that is not
-- part of the current daily shoutout model. Current inserts correctly provide
-- shoutout_date plus nomination_id or fallback_name, so that stale NOT NULL
-- constraint makes every first request of the day fail. Production already
-- has the canonical schema; the guarded block is therefore a no-op there.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'shoutout_schedule'
       AND column_name = 'recipient_name'
       AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.shoutout_schedule
      ALTER COLUMN recipient_name DROP NOT NULL;
  END IF;
END
$$;
