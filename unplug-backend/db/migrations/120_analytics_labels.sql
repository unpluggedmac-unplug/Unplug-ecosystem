-- TOPIC ANALYTICS needs to record a WORD, and analytics_events could only
-- record a number.
--
-- entity_id is an INTEGER, which is right for "which article" and useless for
-- "which tag" or "what did they type into search". Overloading it with a hash,
-- or inventing a lookup table of every search string anyone has ever typed,
-- would both be worse than one text column.
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS label VARCHAR(160);

-- The reports group by (event_name, label) — the most-tapped topics, the
-- most-searched words — over a date window, so the index carries the date too.
CREATE INDEX IF NOT EXISTS idx_an_events_label
  ON analytics_events (event_name, label, occurred_at DESC)
  WHERE label IS NOT NULL;

-- Reading a topic is derived from the article that was read, joining
-- page_view events to articles.tags and articles.category_id, so it needs no
-- new capture and works on traffic already being recorded. This index is what
-- keeps that join cheap as the events table grows.
CREATE INDEX IF NOT EXISTS idx_an_events_article
  ON analytics_events (entity_id, occurred_at DESC)
  WHERE event_name = 'page_view' AND entity_type = 'article';

-- Grouping reads by tag means unnesting articles.tags for every article in the
-- window. A GIN index makes that lookup cheap in the other direction too, for
-- "which articles carry this tag".
CREATE INDEX IF NOT EXISTS idx_articles_tags ON articles USING GIN (tags);
