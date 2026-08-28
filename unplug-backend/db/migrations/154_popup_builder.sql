-- Popups an admin composes themselves.
--
-- A popup used to be one of three fixed shapes — an image, a title, one
-- paragraph and one button — and the only choices were which of the three and
-- how far down the page it fired. This adds the pieces to build one: a list of
-- content blocks, the type it is set in, where it sits, how it arrives, what
-- makes it appear and when it goes away.
--
-- NOTHING HERE REPLACES A COLUMN. title, body, image_url, button_label and
-- button_url all stay exactly as they were, and a popup created before today
-- keeps working untouched: `blocks` defaults to an empty list, and the
-- renderer falls back to the old fixed layout when it finds one. That fallback
-- is not a temporary measure to be cleaned up later — it is what stops a
-- deploy from blanking every live popup on the site.
--
-- These migrations RE-RUN ON EVERY DEPLOY, so every statement below is
-- written to be safe to run again. That is also why the new columns carry no
-- CHECK constraints: `ADD CONSTRAINT` has no IF NOT EXISTS, so a second run
-- would fail and take the whole deploy down with it. The permitted values are
-- enforced in src/utils/popupBuilder.js instead, which is where `kind` and
-- `frequency` are already re-checked anyway — the database was never the only
-- guard for those either.

-- What the popup is made of. A list of blocks, in the order they appear:
--   [{ "type": "heading", "text": "..." }, { "type": "image", "url": "..." }]
-- An empty list means "this popup predates the builder" and the renderer
-- draws the old fixed layout from the columns above.
ALTER TABLE popups ADD COLUMN IF NOT EXISTS blocks JSONB NOT NULL DEFAULT '[]';

-- How it looks: font, colours and width. Empty means the site's own styling,
-- which is what every existing popup gets and what most should keep.
ALTER TABLE popups ADD COLUMN IF NOT EXISTS style JSONB NOT NULL DEFAULT '{}';

-- Where on the screen it sits. 'center' is the old behaviour and stays the
-- default, but it is also the most interruptive: a corner card lets somebody
-- carry on reading, which is usually the better trade for anything that is
-- not urgent.
ALTER TABLE popups ADD COLUMN IF NOT EXISTS position VARCHAR(20) NOT NULL DEFAULT 'center';

-- How it arrives. Every animation is inside a prefers-reduced-motion guard in
-- the renderer, so a reader who has asked for less movement gets the popup
-- with none of it, whatever is chosen here.
ALTER TABLE popups ADD COLUMN IF NOT EXISTS animation VARCHAR(20) NOT NULL DEFAULT 'fade-up';

-- What makes it appear: 'scroll' (the existing scroll_percent), 'delay'
-- (trigger_seconds after the page settles) or 'exit' (the pointer leaves for
-- the top of the window). scroll_percent is untouched and still drives the
-- scroll trigger.
ALTER TABLE popups ADD COLUMN IF NOT EXISTS trigger_type VARCHAR(20) NOT NULL DEFAULT 'scroll';
ALTER TABLE popups ADD COLUMN IF NOT EXISTS trigger_seconds INTEGER;

-- Closes itself after this many seconds. NULL means it stays until the reader
-- closes it, which remains the default: a dialog that vanishes on its own
-- while somebody is reading it is its own kind of rude, and one that vanishes
-- mid-sentence loses whatever they were about to type into it.
ALTER TABLE popups ADD COLUMN IF NOT EXISTS auto_close_seconds INTEGER;

-- Playback for a video or audio block: autoplay (muted only — see the note in
-- popupBuilder.js), loop, and whether the controls show.
ALTER TABLE popups ADD COLUMN IF NOT EXISTS media JSONB NOT NULL DEFAULT '{}';

-- The public endpoint already reads only live popups; nothing here changes
-- which rows it looks at, so idx_popups_live still covers it.
