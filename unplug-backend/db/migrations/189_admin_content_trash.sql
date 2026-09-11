-- WordPress-style reversible trash for the generic Admin Content manager.
--
-- We deliberately do not add deleted_at columns to every public content table:
-- older public queries would not know to filter them and trashed content could
-- remain visible. Instead, a small ledger records the prior review status and
-- the existing status column is switched to 'rejected' while the row is in
-- trash. Restore puts the exact prior status back.

CREATE TABLE IF NOT EXISTS admin_content_trash (
  id BIGSERIAL PRIMARY KEY,
  resource VARCHAR(50) NOT NULL,
  item_id BIGINT NOT NULL,
  previous_status VARCHAR(50) NOT NULL,
  trashed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  trashed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  restored_at TIMESTAMPTZ,
  restored_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  permanently_deleted_at TIMESTAMPTZ,
  permanently_deleted_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_content_trash_one_active
  ON admin_content_trash(resource, item_id)
  WHERE restored_at IS NULL AND permanently_deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS admin_content_trash_active_lookup
  ON admin_content_trash(resource, trashed_at DESC)
  WHERE restored_at IS NULL AND permanently_deleted_at IS NULL;
