-- Lets POST /admin/bulk-email respond immediately instead of blocking the
-- request on every recipient's send (the audit's "risks timing out on a
-- large campaign" finding) — the campaign row is created up front as
-- 'queued', emails send in the background, and sent_count/status track
-- progress for GET /admin/bulk-email/history to show.

ALTER TABLE bulk_email_campaigns
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'completed'
    CHECK (status IN ('queued', 'sending', 'completed', 'failed')),
  ADD COLUMN IF NOT EXISTS sent_count INTEGER NOT NULL DEFAULT 0;
