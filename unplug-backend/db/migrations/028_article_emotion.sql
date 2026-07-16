-- Emotion Reader — each article carries an optional emotion indicator shown
-- as an emoji + label on cards and the article page.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS emotion VARCHAR(20);
ALTER TABLE articles DROP CONSTRAINT IF EXISTS articles_emotion_check;
ALTER TABLE articles ADD CONSTRAINT articles_emotion_check
  CHECK (emotion IS NULL OR emotion IN ('inspiring', 'business', 'community', 'breaking', 'celebration'));
