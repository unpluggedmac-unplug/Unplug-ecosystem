-- Site Buttons: a small, always-on-screen stack of admin-configured CTA
-- buttons (icon + label + link), shown as a floating stack in the corner of
-- every public page — distinct from Popups (which interrupt, on a scroll
-- trigger, and go away once dismissed). A button here is meant to always be
-- reachable, the way a WhatsApp chat bubble or a "back to top" control is.
--
-- ACTIVE DEFAULTS TO FALSE, same reasoning as popups: a button half-set-up
-- on a Tuesday must not be live on the site overnight. Turning one on is a
-- deliberate act.
--
-- Reversal: drop the table. Nothing else references it, and the frontend
-- script degrades to rendering nothing when the endpoint returns an empty
-- list.

CREATE TABLE IF NOT EXISTS site_buttons (
  id             SERIAL PRIMARY KEY,
  label          VARCHAR(60) NOT NULL,
  url            TEXT NOT NULL,
  -- A single emoji/short glyph shown on the button. Optional — a label-only
  -- button is fine.
  icon           VARCHAR(20),
  -- Lower shows first (top of the stack). Plain admin-set integer, not an
  -- automatic sequence — ties are broken by id so the order is always
  -- deterministic even before an admin has set anything.
  display_order  INTEGER NOT NULL DEFAULT 0,
  active         BOOLEAN NOT NULL DEFAULT false,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The public endpoint's only query: what is switched on, in stack order.
CREATE INDEX IF NOT EXISTS idx_site_buttons_active ON site_buttons (active, display_order, id);
