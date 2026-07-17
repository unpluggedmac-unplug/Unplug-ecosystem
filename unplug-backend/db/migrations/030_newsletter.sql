-- Newsletter subscribers captured from the homepage subscribe form. Admin
-- can later send to these via the existing bulk-email flow.
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id            SERIAL PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  subscribed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
