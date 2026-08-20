// EVERY TAG IN USE, in one place — and a way to fill in the ones that are
// missing.
//
// Tags are written by three different people (an editor, a business owning a
// Directory listing, a member owning a My Unplug profile) across three tables.
// Without a single view of them, nobody can see that "Fashion", "fashion" and
// "Fashion & Style" have become three separate subjects, and the topic
// analytics quietly splits its numbers between them.

const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { normaliseTags, MAX_TAGS } = require('../utils/tags');
const { keywords, cleanTopicTerms, stripHtml } = require('../utils/articleMeta');
const { logActivity } = require('./activityLog');

const router = express.Router();

// GET /admin/tags — every tag across all three types, with where it is used.
// Grouped case-insensitively so near-duplicates sit together and are obvious.
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `WITH all_tags AS (
         SELECT unnest(tags) AS tag, 'article' AS kind FROM articles WHERE tags IS NOT NULL
         UNION ALL
         SELECT unnest(tags), 'directory' FROM profiles WHERE tags IS NOT NULL
         UNION ALL
         SELECT unnest(tags), 'member' FROM my_unplug_profiles WHERE tags IS NOT NULL
       )
       SELECT lower(tag) AS key,
              -- The spelling used most often wins as the display form, so the
              -- list reads the way the site does.
              (array_agg(tag ORDER BY tag))[1] AS tag,
              COUNT(*)::int AS uses,
              COUNT(*) FILTER (WHERE kind = 'article')::int   AS articles,
              COUNT(*) FILTER (WHERE kind = 'directory')::int AS directory,
              COUNT(*) FILTER (WHERE kind = 'member')::int    AS members,
              COUNT(DISTINCT tag)::int AS spellings
         FROM all_tags
        GROUP BY lower(tag)
        ORDER BY uses DESC, key ASC`
    );

    const rows = result.rows;
    res.json({
      tags: rows,
      totals: {
        distinct: rows.length,
        // Worth surfacing on its own: a tag written two ways is two subjects
        // in every report until somebody notices.
        withMultipleSpellings: rows.filter((r) => r.spellings > 1).length,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/tags/rename — body { from, to }. Merges one spelling into
// another everywhere it appears. Deleting `to` from the array first stops a
// row that already carried both ending up with it twice.
router.post('/rename', requireRole('admin'), async (req, res, next) => {
  try {
    const from = String(req.body.from || '').trim();
    const toList = normaliseTags(req.body.to);
    const to = toList && toList.length ? toList[0] : null;
    if (!from) return res.status(400).json({ error: 'Which tag should be changed?' });

    const counts = {};
    for (const [table, key] of [['articles', 'articles'], ['profiles', 'directory'], ['my_unplug_profiles', 'members']]) {
      const r = to
        ? await pool.query(
          `UPDATE ${table}
              SET tags = array_append(array_remove(array_remove(tags, $1), $2), $2)
            WHERE tags IS NOT NULL AND $1 = ANY(tags)`,
          [from, to]
        )
        : await pool.query(
          `UPDATE ${table} SET tags = array_remove(tags, $1)
            WHERE tags IS NOT NULL AND $1 = ANY(tags)`,
          [from]
        );
      counts[key] = r.rowCount;
    }

    await logActivity(req.user.id, 'tag_renamed',
      to ? `Merged tag "${from}" into "${to}"` : `Removed tag "${from}" everywhere`).catch(() => {});

    res.json({ from, to, updated: counts });
  } catch (err) {
    next(err);
  }
});

// Suggested tags for one piece of text. Deliberately stops at what is
// actually meaningful rather than padding to ten: a weak tag is worse than a
// missing one, because it feeds the topic reports and makes them lie. The
// never-a-topic filter from articleMeta is what keeps "Something" out.
function suggestFrom(parts, limit = 6) {
  const text = parts.filter(Boolean).join(' ');
  if (!text || text.trim().length < 40) return [];
  const terms = cleanTopicTerms(keywords(stripHtml(text), limit));
  return (terms || []).map((w) => w.charAt(0).toUpperCase() + w.slice(1));
}

// POST /admin/tags/backfill — fills in tags for everything that has NONE.
//
// Never touches a row that already has tags, so it cannot overwrite anything a
// person chose, and running it twice is harmless. Body { dryRun: true } to see
// what it would do first.
router.post('/backfill', requireRole('admin'), async (req, res, next) => {
  try {
    const dryRun = req.body.dryRun === true;
    const report = { articles: 0, directory: 0, members: 0, skippedTooLittleText: 0, samples: [] };

    const empty = 'tags IS NULL OR cardinality(tags) = 0';

    const articles = await pool.query(
      `SELECT id, title, body, subtitle FROM articles WHERE ${empty} LIMIT 500`
    );
    for (const a of articles.rows) {
      const tags = suggestFrom([a.title, a.subtitle, a.body]);
      if (!tags.length) { report.skippedTooLittleText++; continue; }
      if (!dryRun) await pool.query('UPDATE articles SET tags = $1 WHERE id = $2', [tags, a.id]);
      report.articles++;
      if (report.samples.length < 8) report.samples.push({ kind: 'article', name: a.title, tags });
    }

    const profiles = await pool.query(
      `SELECT id, display_name, bio, career, achievements FROM profiles WHERE ${empty} LIMIT 500`
    );
    for (const p of profiles.rows) {
      const tags = suggestFrom([p.bio, p.career, p.achievements]);
      if (!tags.length) { report.skippedTooLittleText++; continue; }
      if (!dryRun) await pool.query('UPDATE profiles SET tags = $1 WHERE id = $2', [tags, p.id]);
      report.directory++;
      if (report.samples.length < 8) report.samples.push({ kind: 'directory', name: p.display_name, tags });
    }

    const members = await pool.query(
      `SELECT user_id, display_name, about_me FROM my_unplug_profiles WHERE ${empty} LIMIT 500`
    );
    for (const m of members.rows) {
      const tags = suggestFrom([m.about_me]);
      if (!tags.length) { report.skippedTooLittleText++; continue; }
      if (!dryRun) await pool.query('UPDATE my_unplug_profiles SET tags = $1 WHERE user_id = $2', [tags, m.user_id]);
      report.members++;
      if (report.samples.length < 8) report.samples.push({ kind: 'member', name: m.display_name, tags });
    }

    if (!dryRun) {
      await logActivity(req.user.id, 'tags_backfilled',
        `Suggested tags for ${report.articles} articles, ${report.directory} listings, ${report.members} member profiles`).catch(() => {});
    }

    res.json({
      dryRun,
      ...report,
      maxTags: MAX_TAGS,
      note: 'Only items with NO tags were touched, so nothing anyone chose was overwritten. '
        + 'Suggestions stop at what the text actually supports rather than padding to ten — '
        + 'a weak tag feeds the topic reports and makes them misleading.',
    });
  } catch (err) {
    next(err);
  }
});

// The three tables tags live on. Kept as one table so every endpoint below
// speaks the same language, and so adding a fourth taggable thing is one line
// rather than three switch statements.
//
// `key` is the primary key column, which differs: my_unplug_profiles is keyed
// by user_id, not id.
const TAGGABLE = {
  article: { table: 'articles', key: 'id', label: 'title', where: '' },
  directory: { table: 'profiles', key: 'id', label: 'display_name', where: '' },
  member: { table: 'my_unplug_profiles', key: 'user_id', label: 'display_name', where: '' },
};

// GET /admin/tags/items?tag=Coffee — everything carrying one tag.
//
// Without this the tag list can say "used 7 times" and give no way to find
// those seven, which makes "remove this from the one listing that has it
// wrong" impossible without a database client.
router.get('/items', requireRole('admin'), async (req, res, next) => {
  try {
    const tag = String(req.query.tag || '').trim();
    if (!tag) return res.status(400).json({ error: 'Which tag?' });

    const out = [];
    for (const [kind, t] of Object.entries(TAGGABLE)) {
      // Case-insensitive, because the list groups spellings together and an
      // admin clicking "Coffee" means every casing of it.
      const r = await pool.query(
        `SELECT ${t.key} AS id, ${t.label} AS name, tags
           FROM ${t.table}
          WHERE tags IS NOT NULL
            AND EXISTS (SELECT 1 FROM unnest(tags) x WHERE lower(x) = lower($1))
          ORDER BY ${t.label} ASC LIMIT 200`,
        [tag]
      );
      r.rows.forEach((row) => out.push({ kind, id: row.id, name: row.name, tags: row.tags }));
    }
    res.json({ tag, items: out, total: out.length });
  } catch (err) {
    next(err);
  }
});

// POST /admin/tags/apply — body { tag, items: [{ kind, id }] }
//
// ADDING a tag to things that already exist. Until now a tag could only be
// added by opening each item's own editor, which is fine for one and useless
// for twenty.
//
// Reads the current tags and writes them back rather than using array_append,
// because the ten-tag ceiling and the de-duplication rules live in one place
// (utils/tags.js) and this must not grow a second, slightly different copy.
router.post('/apply', requireRole('admin'), async (req, res, next) => {
  try {
    const cleaned = normaliseTags(req.body.tag);
    const tag = cleaned && cleaned.length ? cleaned[0] : null;
    if (!tag) return res.status(400).json({ error: 'Give a tag to add.' });

    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'Choose at least one item to tag.' });

    const result = { added: 0, alreadyHadIt: 0, full: [] };

    for (const item of items) {
      const t = TAGGABLE[item.kind];
      const id = Number(item.id);
      if (!t || !Number.isInteger(id)) continue;

      const current = await pool.query(`SELECT tags, ${t.label} AS name FROM ${t.table} WHERE ${t.key} = $1`, [id]);
      if (!current.rows.length) continue;

      const existing = current.rows[0].tags || [];
      if (existing.some((x) => x.toLowerCase() === tag.toLowerCase())) { result.alreadyHadIt++; continue; }

      // At the ceiling: reported rather than silently dropping the tag or
      // silently dropping one of theirs to make room.
      if (existing.length >= MAX_TAGS) {
        result.full.push({ kind: item.kind, id, name: current.rows[0].name });
        continue;
      }

      await pool.query(`UPDATE ${t.table} SET tags = $1 WHERE ${t.key} = $2`,
        [normaliseTags([...existing, tag]), id]);
      result.added++;
    }

    await logActivity(req.user.id, 'tag_applied',
      `Added tag "${tag}" to ${result.added} item(s)`).catch(() => {});

    res.json({
      tag, ...result,
      message: `Added "${tag}" to ${result.added} item(s).`
        + (result.alreadyHadIt ? ` ${result.alreadyHadIt} already had it.` : '')
        + (result.full.length ? ` ${result.full.length} already had ${MAX_TAGS} tags and were left alone.` : ''),
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/tags/remove-from — body { tag, kind, id }
// Takes a tag off ONE item, as opposed to /rename with no target which takes
// it off everything.
router.post('/remove-from', requireRole('admin'), async (req, res, next) => {
  try {
    const tag = String(req.body.tag || '').trim();
    const t = TAGGABLE[req.body.kind];
    const id = Number(req.body.id);
    if (!tag || !t || !Number.isInteger(id)) {
      return res.status(400).json({ error: 'A tag, a kind and a valid id are required.' });
    }

    const current = await pool.query(`SELECT tags FROM ${t.table} WHERE ${t.key} = $1`, [id]);
    if (!current.rows.length) return res.status(404).json({ error: 'That item no longer exists.' });

    const kept = (current.rows[0].tags || []).filter((x) => x.toLowerCase() !== tag.toLowerCase());
    await pool.query(`UPDATE ${t.table} SET tags = $1 WHERE ${t.key} = $2`, [kept, id]);

    await logActivity(req.user.id, 'tag_removed_from_item',
      `Removed tag "${tag}" from ${req.body.kind} ${id}`).catch(() => {});

    res.json({ removed: true, tags: kept });
  } catch (err) {
    next(err);
  }
});

// GET /admin/tags/search?q=bak&kind=directory — find things to tag.
// The picker behind "add this tag to…".
router.get('/search', requireRole('admin'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ items: [] });
    const kinds = TAGGABLE[req.query.kind] ? [req.query.kind] : Object.keys(TAGGABLE);

    const out = [];
    for (const kind of kinds) {
      const t = TAGGABLE[kind];
      const r = await pool.query(
        `SELECT ${t.key} AS id, ${t.label} AS name, tags FROM ${t.table}
          WHERE ${t.label} ILIKE $1 ORDER BY ${t.label} ASC LIMIT 15`,
        [`%${q}%`]
      );
      r.rows.forEach((row) => out.push({ kind, id: row.id, name: row.name, tags: row.tags || [] }));
    }
    res.json({ items: out });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
