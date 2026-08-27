const express = require('express');
const pool = require('../db');

const router = express.Router();

// ---------------------------------------------------------------------------
// The tsvector expressions. These are EXPORTED, and migration 150 builds its
// GIN indexes from exactly these strings.
//
// This is not tidiness. A Postgres expression index is only used when the
// query spells the expression identically — add a column here and forget the
// migration and nothing breaks visibly: the search still returns the right
// answers, it just quietly starts scanning every article body on the site on
// every keystroke. There is a test that reads both files and fails if they
// stop matching, because nothing else would tell us.
// ---------------------------------------------------------------------------
const FTS = {
  articles: `to_tsvector('english',
       coalesce(title, '') || ' ' ||
       coalesce(subtitle, '') || ' ' ||
       coalesce(meta_description, '') || ' ' ||
       coalesce(body, ''))`,
  profiles: `to_tsvector('english',
       coalesce(display_name, '') || ' ' ||
       coalesce(bio, '') || ' ' ||
       coalesce(achievements, '') || ' ' ||
       coalesce(career, '') || ' ' ||
       coalesce(quote, ''))`,
  myUnplug: `to_tsvector('english',
       coalesce(display_name, '') || ' ' ||
       coalesce(username, '') || ' ' ||
       coalesce(about_me, ''))`,
};

// websearch_to_tsquery, never to_tsquery. This is a public endpoint taking a
// stranger's typing: to_tsquery THROWS on anything it considers bad syntax, so
// a reader typing `C++ & ` would get a 500. websearch_to_tsquery accepts
// whatever arrives, understands quoted phrases and OR and a leading minus,
// and never errors.
const TSQ = `websearch_to_tsquery('english', $1)`;

// Highlighting is marked with control characters, not with <mark> tags.
//
// ts_headline does NOT escape the text it is given, so asking it for HTML
// would mean handing the client a string built out of article bodies with
// markup already in it — an injection route straight through the search
// results. Chr(2) and chr(3) cannot occur in typed text and cannot form a
// tag; the client escapes the snippet first and swaps them for <mark>
// afterwards.
const HEADLINE_OPTS =
  `'MaxFragments=1,MaxWords=32,MinWords=14,StartSel=' || chr(2) || ',StopSel=' || chr(3)`;

const DEFAULT_CAPS = { articles: 8, profiles: 8, editions: 6, members: 8 };
const TYPES = ['articles', 'profiles', 'editions', 'members'];

function clampLimit(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), 24);
}

function clampPage(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.trunc(n), 500);
}

// A date filter that cannot be parsed is IGNORED rather than being an error.
// Somebody deep-linking a search from a shared URL should get results, not a
// validation message about a query string they never typed.
function isoDate(raw) {
  if (!raw) return null;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function intOrNull(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// GET /search?q=term
//
// Same response shape as before — { query, results: { articles, profiles,
// editions, members } } — so the existing overlay keeps working untouched.
// What is new is on top of it: relevance ordering, snippets, `totals`, an
// optional `type` for one paginated list, category/date filters, and a
// "did you mean" when nothing matched at all.
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const empty = { articles: [], profiles: [], editions: [], members: [] };
    if (q.length < 2) {
      return res.json({
        query: q, results: empty, totals: { articles: 0, profiles: 0, editions: 0, members: 0 },
        page: 1, limit: 0, suggestion: null,
      });
    }

    const type = TYPES.includes(req.query.type) ? req.query.type : 'all';
    const page = clampPage(req.query.page);
    const limit = type === 'all' ? null : clampLimit(req.query.limit, 12);
    const offset = type === 'all' ? 0 : (page - 1) * limit;
    const categoryId = intOrNull(req.query.category);
    const from = isoDate(req.query.from);
    const to = isoDate(req.query.to);
    const like = '%' + q + '%';

    const want = (t) => type === 'all' || type === t;
    const take = (t) => (type === 'all' ? DEFAULT_CAPS[t] : limit);
    const skip = (t) => (type === 'all' ? 0 : offset);

    const [articles, profiles, editions, members] = await Promise.all([
      want('articles') ? searchArticles(q, like, take('articles'), skip('articles'), categoryId, from, to) : null,
      want('profiles') ? searchProfiles(q, like, take('profiles'), skip('profiles'), categoryId) : null,
      want('editions') ? searchEditions(like, take('editions'), skip('editions')) : null,
      want('members') ? searchMembers(q, like, take('members'), skip('members')) : null,
    ]);

    const results = {
      articles: articles ? articles.rows : [],
      profiles: profiles ? profiles.rows : [],
      editions: editions ? editions.rows : [],
      members: members ? members.rows : [],
    };
    // COUNT(*) OVER() rides along on the same scan, so the total costs nothing
    // extra — but it is only present when there was at least one row.
    const totalOf = (r) => (r && r.rows.length ? Number(r.rows[0].total_count) : 0);
    const totals = {
      articles: totalOf(articles),
      profiles: totalOf(profiles),
      editions: totalOf(editions),
      members: totalOf(members),
    };
    TYPES.forEach((t) => results[t].forEach((row) => { delete row.total_count; }));

    const found = TYPES.reduce((sum, t) => sum + totals[t], 0);
    const suggestion = found === 0 ? await suggest(q) : null;

    res.json({ query: q, results, totals, page, limit: limit || 0, suggestion });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Articles. Title outranks standfirst outranks body — the piece actually
// called "Load Shedding" should come first for "load shedding", regardless of
// which article mentioned it most recently.
//
// Tags stay on an ILIKE rather than joining the tsvector: a tag exists so
// somebody searching the subject finds the piece even when the word never
// appears in it, and partial words have to match ("fash" finding "Fashion"),
// which stemming does not do. A tag-only hit gets a small fixed rank so it
// lands below a real textual match instead of at the very bottom.
// ---------------------------------------------------------------------------
function searchArticles(q, like, limit, offset, categoryId, from, to) {
  const params = [q, like];
  let filters = '';
  if (categoryId) { params.push(categoryId); filters += ` AND a.category_id = $${params.length}`; }
  if (from) { params.push(from); filters += ` AND a.published_at >= $${params.length}`; }
  if (to) { params.push(to); filters += ` AND a.published_at <= $${params.length}`; }
  params.push(limit, offset);
  const lim = `$${params.length - 1}`;
  const off = `$${params.length}`;

  return pool.query(
    `SELECT a.id, a.title, a.kicker_supplied_by, a.tags, a.banner_image_url,
            a.published_at, c.name AS category,
            ts_headline('english', left(coalesce(a.body, ''), 4000), ${TSQ}, ${HEADLINE_OPTS}) AS snippet,
            ts_rank(
              setweight(to_tsvector('english', coalesce(a.title, '')), 'A') ||
              setweight(to_tsvector('english', coalesce(a.subtitle, '') || ' ' ||
                                               coalesce(a.meta_description, '')), 'B') ||
              setweight(to_tsvector('english', coalesce(a.body, '')), 'C'),
              ${TSQ}) + CASE WHEN ${FTS.articles} @@ ${TSQ} THEN 0 ELSE 0.001 END AS rank,
            COUNT(*) OVER() AS total_count
       FROM articles a
       LEFT JOIN categories c ON c.id = a.category_id
      WHERE a.status = 'approved'
        AND (${FTS.articles} @@ ${TSQ}
             OR EXISTS (SELECT 1 FROM unnest(COALESCE(a.tags, '{}')) t WHERE t ILIKE $2))
        ${filters}
      ORDER BY rank DESC, a.published_at DESC NULLS LAST, a.id DESC
      LIMIT ${lim} OFFSET ${off}`,
    params
  );
}

function searchProfiles(q, like, limit, offset, categoryId) {
  const params = [q, like];
  let filters = '';
  if (categoryId) { params.push(categoryId); filters += ` AND p.category_id = $${params.length}`; }
  params.push(limit, offset);
  const lim = `$${params.length - 1}`;
  const off = `$${params.length}`;

  return pool.query(
    `SELECT p.id, p.slug, p.display_name, p.type, p.deaf_owned_verified, p.tags,
            p.feature_image_url, c.name AS category,
            ts_rank(
              setweight(to_tsvector('english', coalesce(p.display_name, '')), 'A') ||
              setweight(to_tsvector('english', coalesce(p.bio, '') || ' ' ||
                                               coalesce(p.achievements, '') || ' ' ||
                                               coalesce(p.career, '') || ' ' ||
                                               coalesce(p.quote, '')), 'C'),
              ${TSQ}) AS rank,
            COUNT(*) OVER() AS total_count
       FROM profiles p
       LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.status = 'approved'
        AND (${FTS.profiles} @@ ${TSQ}
             OR EXISTS (SELECT 1 FROM unnest(COALESCE(p.tags, '{}')) t WHERE t ILIKE $2))
        ${filters}
      ORDER BY rank DESC, p.display_name ASC
      LIMIT ${lim} OFFSET ${off}`,
    params
  );
}

// Editions have a title and nothing else worth searching, so this stays an
// ILIKE. Full-text search on six words would only stop "Ed" matching
// "Edition", which is the opposite of helpful.
function searchEditions(like, limit, offset) {
  return pool.query(
    `SELECT id, issue_number, title, cover_image_url, published_at,
            COUNT(*) OVER() AS total_count
       FROM editions
      WHERE title ILIKE $1
      ORDER BY issue_number DESC
      LIMIT $2 OFFSET $3`,
    [like, limit, offset]
  );
}

// PUBLISHED ONLY. An unpublished My Unplug profile is private, and a search
// result is a public page. No contact fields are selected because the table
// has none by design — see migration 105.
function searchMembers(q, like, limit, offset) {
  return pool.query(
    `SELECT m.user_id, m.username, m.display_name, m.avatar_url, m.tags,
            ts_rank(
              setweight(to_tsvector('english', coalesce(m.display_name, '') || ' ' ||
                                               coalesce(m.username, '')), 'A') ||
              setweight(to_tsvector('english', coalesce(m.about_me, '')), 'C'),
              ${TSQ}) AS rank,
            COUNT(*) OVER() AS total_count
       FROM my_unplug_profiles m
      WHERE m.is_published = true
        AND (${FTS.myUnplug} @@ ${TSQ}
             OR EXISTS (SELECT 1 FROM unnest(COALESCE(m.tags, '{}')) t WHERE t ILIKE $2))
      ORDER BY rank DESC, m.display_name ASC
      LIMIT $3 OFFSET $4`,
    [q, like, limit, offset]
  );
}

// ---------------------------------------------------------------------------
// "Did you mean". Only ever asked when the search found nothing at all, so a
// reader who typed "fashon" is offered "Fashion" instead of a blank page.
//
// word_similarity, not similarity: comparing one typed word against a whole
// headline scores badly, while word_similarity finds the best-matching word
// inside it. Titles and names only — nobody mistypes their way into wanting
// paragraph three, and indexing bodies for trigrams would be a large index
// earning very little.
//
// Returns null rather than throwing when pg_trgm is not installed. A missing
// nicety must not turn a working search into a 500.
// ---------------------------------------------------------------------------
async function suggest(q) {
  try {
    const result = await pool.query(
      `SELECT term, word_similarity($1, term) AS sim
         FROM (
           SELECT title AS term FROM articles WHERE status = 'approved'
           UNION ALL
           SELECT display_name FROM profiles WHERE status = 'approved'
           UNION ALL
           SELECT title FROM editions
         ) candidates
        WHERE term IS NOT NULL AND word_similarity($1, term) > 0.5
        ORDER BY sim DESC
        LIMIT 1`,
      [q]
    );
    return result.rows.length ? result.rows[0].term : null;
  } catch (err) {
    return null;
  }
}

module.exports = router;
module.exports.FTS = FTS;
