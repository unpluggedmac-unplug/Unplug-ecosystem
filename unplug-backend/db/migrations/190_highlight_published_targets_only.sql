-- Paid member highlights may only point at content that is already approved/live.
--
-- This is a database-level backstop for the member-facing Promote Existing
-- Content flow. The browser already only offers live items, but a caller must
-- not be able to bypass that rule by posting an unpublished article/profile id
-- directly to the API.
--
-- An article can be status='approved' while still scheduled for a future date.
-- The public article routes deliberately hide it until scheduled_for <= today,
-- so treating "approved" alone as "published" here would let a customer pay
-- for highlight days on a story readers cannot open yet.
--
-- Admin-created editorial highlights keep their existing flexibility: an admin
-- can prepare/schedule a highlight before publication by setting is_admin=true.

CREATE OR REPLACE FUNCTION enforce_member_highlight_published_target()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_status text;
  target_scheduled_for date;
BEGIN
  IF COALESCE(NEW.is_admin, false) THEN
    RETURN NEW;
  END IF;

  IF NEW.target_type = 'article' THEN
    SELECT status, scheduled_for
      INTO target_status, target_scheduled_for
      FROM articles
     WHERE id = NEW.target_id;
  ELSIF NEW.target_type = 'directory' THEN
    SELECT status
      INTO target_status
      FROM profiles
     WHERE id = NEW.target_id;
    target_scheduled_for := NULL;
  ELSE
    RAISE EXCEPTION 'Unsupported highlight target type: %', NEW.target_type
      USING ERRCODE = '23514';
  END IF;

  IF target_status IS NULL THEN
    RAISE EXCEPTION 'Highlight target does not exist.'
      USING ERRCODE = '23503';
  END IF;

  IF target_status <> 'approved'
     OR (NEW.target_type = 'article'
         AND target_scheduled_for IS NOT NULL
         AND target_scheduled_for > CURRENT_DATE) THEN
    RAISE EXCEPTION 'Only content already published and live can be highlighted.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_member_highlight_published_target ON highlights;

CREATE TRIGGER trg_member_highlight_published_target
BEFORE INSERT OR UPDATE OF target_type, target_id, is_admin
ON highlights
FOR EACH ROW
EXECUTE FUNCTION enforce_member_highlight_published_target();
