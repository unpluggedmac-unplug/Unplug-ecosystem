-- Article gallery images and links.

-- Up to five images beyond the cover. An array rather than a table: they are
-- always read and written together with the article, are ordered, and never
-- referenced individually — a join table would add work for nothing.
-- The five-image cap is enforced in the API, where it can return a clear
-- message, rather than as a constraint that would surface as a 500.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS gallery_images TEXT[];

-- Social and other links the author wants on the piece. Stored as JSONB
-- rather than parallel arrays so a link keeps its label with its URL:
--   [{"label":"Instagram","url":"https://…"}, …]
ALTER TABLE articles ADD COLUMN IF NOT EXISTS links JSONB NOT NULL DEFAULT '[]'::jsonb;

-- How the body should be rendered. Existing rows are imported WordPress HTML,
-- so 'html' stays the default; anything written in the plain-text editor is
-- marked 'text' and gets its line breaks turned into paragraphs on display.
-- Without this flag, plain text would render as one unbroken block.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS body_format VARCHAR(10) NOT NULL DEFAULT 'html';
ALTER TABLE articles DROP CONSTRAINT IF EXISTS articles_body_format_check;
ALTER TABLE articles ADD CONSTRAINT articles_body_format_check
  CHECK (body_format IN ('html', 'text'));
