-- Growth V2 member-profile prefills are stored as normal immutable answer
-- revisions, but tagged separately from answers the member typed themselves.
ALTER TABLE growth_application_answer_revisions
  DROP CONSTRAINT IF EXISTS growth_application_answer_revisions_save_source_check;
ALTER TABLE growth_application_answer_revisions
  ADD CONSTRAINT growth_application_answer_revisions_save_source_check
  CHECK (save_source IN ('prefill','member','admin_reopen','information_request'));
