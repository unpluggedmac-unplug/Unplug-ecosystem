-- Unplug Control Centre Phase 9 — advertising campaign management + analytics.
-- Extends the existing ad_slots system; sponsor_campaigns remains a separate
-- participation/sponsorship product.

ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS campaign_name       VARCHAR(180);
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS advertiser_name     VARCHAR(180);
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS advertiser_contact  VARCHAR(180);
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS advertiser_email    VARCHAR(255);
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS amount_paid         NUMERIC(12,2);
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS payment_status      VARCHAR(24) NOT NULL DEFAULT 'not_recorded';
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS internal_notes      TEXT;
ALTER TABLE ad_slots ADD COLUMN IF NOT EXISTS archived_at         TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE ad_slots ADD CONSTRAINT ad_slots_payment_status_check
    CHECK (payment_status IN ('not_recorded','pending','paid','credited','refunded','complimentary'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_ad_slots_campaign_dates ON ad_slots(starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_ad_slots_archived ON ad_slots(archived_at);

CREATE TABLE IF NOT EXISTS ad_banner_analytics (
  id          BIGSERIAL PRIMARY KEY,
  ad_slot_id  INTEGER NOT NULL REFERENCES ad_slots(id) ON DELETE CASCADE,
  event_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  impressions INTEGER NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks      INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ad_slot_id, event_date)
);
CREATE INDEX IF NOT EXISTS idx_ad_banner_analytics_date ON ad_banner_analytics(event_date);

-- Existing paid member banners can inherit their confirmed payment value and
-- status without changing the underlying payment/order records.
UPDATE ad_slots a
   SET amount_paid = COALESCE(a.amount_paid, p.amount + COALESCE(p.credit_used, 0)),
       payment_status = CASE
         WHEN a.payment_status <> 'not_recorded' THEN a.payment_status
         WHEN p.status = 'confirmed' THEN 'paid'
         WHEN p.status = 'pending' THEN 'pending'
         WHEN p.status = 'refunded' THEN 'refunded'
         ELSE a.payment_status
       END
  FROM payments p
 WHERE a.payment_id = p.id;
