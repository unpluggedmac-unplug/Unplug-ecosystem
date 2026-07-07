-- Unplug Ecosystem — Phase 3, Step 8: Sales Consultants & Referral Tracking
-- Depends on 001_users.sql through 006_investors_marketplace.sql having already run.

CREATE TABLE IF NOT EXISTS sales_consultants (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(160) NOT NULL,
  email         VARCHAR(255),
  commission_pct NUMERIC(5,2) NOT NULL DEFAULT 10.00,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sales_consultants_active ON sales_consultants (active);

-- Every payment now records how the payer heard about Unplug, and — when
-- the answer is "sales consultant" — which one, so commission can be
-- calculated later.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS referral_source VARCHAR(20)
  CHECK (referral_source IN ('google', 'facebook', 'instagram', 'linkedin', 'tiktok', 'sales_consultant', 'other'));
ALTER TABLE payments ADD COLUMN IF NOT EXISTS sales_consultant_id INTEGER REFERENCES sales_consultants(id);

CREATE INDEX IF NOT EXISTS idx_payments_referral ON payments (referral_source);
CREATE INDEX IF NOT EXISTS idx_payments_consultant ON payments (sales_consultant_id);

-- Simple admin notification feed — a sales-consultant-linked payment
-- creates one of these so the admin sees it without needing to poll the
-- full payments table looking for new commission-relevant activity.
CREATE TABLE IF NOT EXISTS admin_notifications (
  id            SERIAL PRIMARY KEY,
  type          VARCHAR(40) NOT NULL,
  message       VARCHAR(500) NOT NULL,
  related_payment_id INTEGER REFERENCES payments(id),
  read          BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON admin_notifications (read);
