-- A member's link to a sales consultant, as a standing attribute of the
-- member — not something re-derived from payment history each time.
--
-- Before this, "is this member X's client" only ever meant "has a confirmed
-- payment with referral_source='sales_consultant' and sales_consultant_id=X"
-- — real, but indirect, and with no way for an admin to link someone who
-- hasn't paid yet, or to correct a wrong attribution. This column is the
-- single, direct answer everywhere: set automatically when a referred
-- payment confirms (see payments.js), and settable directly by an admin at
-- any time via PATCH /admin/users/:id.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS sales_consultant_id INTEGER REFERENCES sales_consultants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_sales_consultant ON users (sales_consultant_id) WHERE sales_consultant_id IS NOT NULL;
