-- Spine, Phase B1 — the gallery service joins the submission lifecycle.
--
-- Adds changes_requested, resubmitted and credit_issued to the two tables the
-- gallery service uses. Nothing sets them yet: the pathways that do are task
-- 05. A value nobody can write is inert, which is what makes this migration
-- safe to ship on its own.
--
-- WHY THREE AND NOT FOUR
--
-- The spine plan names four Phase-B statuses. `expired` is deliberately NOT
-- added here. A gallery submission is a one-off purchase of up to three photos
-- that stay published; it has no term to run out. Adding `expired` would create
-- a state nothing can ever reach, which every filter and report would then have
-- to carry for nothing — the exact thing the plan argued against when it
-- rejected the full §16 vocabulary.
--
-- `expired` belongs to the services that actually run for a period: highlights,
-- ad banners, marketplace listings, directory packages. It arrives with them.
--
-- WHY THIS IS SAFE TO RE-RUN
--
-- These migrations execute on EVERY deploy. Changing a CHECK means dropping and
-- re-adding it, and the ADD re-validates the whole table each time. So the list
-- below must contain every value any existing row could hold — the four
-- originals are kept exactly as they were, and only new ones are added.
-- Migration 016 fixed a live bug of precisely this shape on gallery_images:
-- inserts had been failing since the payment flow was written, because a value
-- the code used was missing from the constraint.
--
-- Nothing is renamed. `approved` stays `approved`.

ALTER TABLE gallery_bundles DROP CONSTRAINT IF EXISTS gallery_bundles_status_check;
ALTER TABLE gallery_bundles ADD CONSTRAINT gallery_bundles_status_check
  CHECK (status IN (
    'awaiting_payment', 'pending', 'approved', 'rejected',
    'changes_requested', 'resubmitted', 'credit_issued'
  ));

ALTER TABLE gallery_images DROP CONSTRAINT IF EXISTS gallery_images_status_check;
ALTER TABLE gallery_images ADD CONSTRAINT gallery_images_status_check
  CHECK (status IN (
    'awaiting_payment', 'pending', 'approved', 'rejected',
    'changes_requested', 'resubmitted', 'credit_issued'
  ));
