-- Keep the immutable definition snapshot immutable while allowing the lifecycle
-- metadata for that SAME version to advance Draft -> Legal Review -> Approved ->
-- Published -> Retired. This fixes the important distinction between changing
-- a template definition (new version) and reviewing/approving the unchanged
-- definition (same version).
--
-- The trigger changes metadata only; it never rewrites snapshot JSON or signed
-- agreement records.

CREATE OR REPLACE FUNCTION sync_agreement_form_version_approval_status()
RETURNS trigger AS $$
BEGIN
  IF NEW.approval_status IS DISTINCT FROM OLD.approval_status THEN
    UPDATE agreement_form_versions
       SET approval_status = NEW.approval_status,
           reviewed_by = NEW.reviewed_by,
           reviewed_at = NEW.reviewed_at
     WHERE agreement_id = NEW.id
       AND version = NEW.version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agreement_form_version_approval_sync ON agreement_forms;
CREATE TRIGGER trg_agreement_form_version_approval_sync
AFTER UPDATE OF approval_status, reviewed_by, reviewed_at ON agreement_forms
FOR EACH ROW
EXECUTE FUNCTION sync_agreement_form_version_approval_status();
