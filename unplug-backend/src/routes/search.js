const express = require('express');
const pool = require('../db');

const router = express.Router();

// GET /search?q=term — public site-wide search across published articles,
// approved directory profiles, and editions. Case-insensitive substring
// match (ILIKE). Returns a small capped set per type for a quick overlay.
router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) {
      return res.json({ query: q, results: { articles: [], profiles: [], editions: [], members: [] } });
    }
    const like = '%' + q + '%';

    const [articles, profiles, editions, members] = await Promise.all([
      pool.query(
        // TAGS ARE SEARCHED TOO. A tag exists so that somebody looking for the
        // subject finds the piece even when the word never appears in the
        // title. EXISTS over unnest rather than array_to_string, so a partial
        // word still matches ("fash" finds "Fashion") and the GIN index on
        // tags stays usable for the exact case.
        `SELECT id, title, kicker_supplied_by, tags
         FROM articles a
         WHERE status = 'approved'
           AND (title ILIKE $1 OR body ILIKE $1
                OR EXISTS (SELECT 1 FROM unnest(COALESCE(a.tags, '{}')) t WHERE t ILIKE $1))
         ORDER BY published_at DESC NULLS LAST, created_at DESC
         LIMIT 8`,
        [like]
      ),
      pool.query(
        `SELECT id, slug, display_name, type, deaf_owned_verified, tags
         FROM profiles p
         WHERE status = 'approved'
           AND (display_name ILIKE $1 OR bio ILIKE $1
                OR EXISTS (SELECT 1 FROM unnest(COALESCE(p.tags, '{}')) t WHERE t ILIKE $1))
         ORDER BY display_name ASC
         LIMIT 8`,
        [like]
      ),
      pool.query(
        `SELECT id, issue_number, title
         FROM editions
         WHERE title ILIKE $1
         ORDER BY issue_number DESC
         LIMIT 6`,
        [like]
      ),
      // My Unplug profiles were not searchable at all before. Now that a
      // member can tag their profile, leaving them out would mean tagging
      // something nobody can find. PUBLISHED ONLY — an unpublished profile is
      // private, and a search result is a public page.
      //
      // No contact fields are selected because the table has none by design;
      // see migration 105.
      pool.query(
        `SELECT user_id, username, display_name, avatar_url, tags
         FROM my_unplug_profiles m
         WHERE is_published = true
           AND (display_name ILIKE $1 OR username ILIKE $1 OR about_me ILIKE $1
                OR EXISTS (SELECT 1 FROM unnest(COALESCE(m.tags, '{}')) t WHERE t ILIKE $1))
         ORDER BY display_name ASC
         LIMIT 8`,
        [like]
      ),
    ]);

    res.json({
      query: q,
      results: {
        articles: articles.rows,
        profiles: profiles.rows,
        editions: editions.rows,
        members: members.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
