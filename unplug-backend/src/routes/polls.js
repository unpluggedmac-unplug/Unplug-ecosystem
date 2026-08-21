const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');
const { publicSubmitLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// Polls are open to everyone, so a vote is identified by a "voter key":
// the member id when signed in, otherwise a random id the browser keeps.
// It's a soft guard against casual double-voting, not proof of identity —
// the unique index on (poll_id, voter_key) is what enforces one vote each.
function voterKeyFor(req) {
  if (req.user && req.user.id) return 'user:' + req.user.id;
  const supplied = (req.body && req.body.voterKey ? String(req.body.voterKey) : '').trim();
  return supplied ? 'anon:' + supplied.slice(0, 64) : '';
}

// IS THIS POLL ACCEPTING VOTES RIGHT NOW?
//
// Written once and used by every caller, because the answer is needed in
// three places — the article widget, the single-poll read, and the vote
// itself — and three copies of a rule like this drift.
//
// Both flags must agree: is_open is the admin's switch, the dates are the
// schedule. A poll closed early by hand stays closed even though its end
// date is still in the future.
//
// ends_at is INCLUSIVE: a poll ending on the 7th takes votes all day on
// the 7th. Dates are compared in SQL against CURRENT_DATE rather than in
// JavaScript, so the server's date is the only clock involved.
function votingOpen(row, today) {
  if (!row.is_open) return false;
  const day = today || new Date().toISOString().slice(0, 10);
  if (row.starts_at && String(row.starts_at) > day) return false;
  if (row.ends_at && String(row.ends_at) < day) return false;
  return true;
}

// Returns null for "not supplied", false for "supplied but not a date", and
// the string otherwise. The three cases are kept apart so a typo is a clear
// 400 rather than being quietly stored as no date at all.
function cleanDate(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const v = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  // Rejects 2026-02-31, which passes the pattern but is not a real day.
  return d.toISOString().slice(0, 10) === v ? v : false;
}

// Shared shape: a poll plus its options and current tallies.
async function pollWithResults(pollId) {
  const poll = await pool.query(
    `SELECT id, question, article_id, is_open, created_at,
            to_char(starts_at, 'YYYY-MM-DD') AS starts_at,
            to_char(ends_at,   'YYYY-MM-DD') AS ends_at,
            to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today
       FROM polls WHERE id = $1`,
    [pollId]
  );
  if (poll.rowCount === 0) return null;
  const options = await pool.query(
    `SELECT o.id, o.label, o.position, COUNT(v.id)::int AS votes
       FROM poll_options o
       LEFT JOIN poll_votes v ON v.option_id = o.id
      WHERE o.poll_id = $1
      GROUP BY o.id
      ORDER BY o.position, o.id`,
    [pollId]
  );
  const total = options.rows.reduce((sum, o) => sum + o.votes, 0);
  const row = poll.rows[0];
  // Percentages are worked out here rather than in each front end. Two
  // screens rendering the same poll must not round it differently.
  const withShare = options.rows.map((o) => ({
    ...o,
    percent: total > 0 ? Math.round((o.votes / total) * 100) : 0,
  }));
  const open = votingOpen(row, row.today);
  return {
    ...row,
    options: withShare,
    totalVotes: total,
    // votingOpen is what the reader's UI should obey. is_open alone is not
    // enough — a scheduled poll can be flagged open and still not be running.
    votingOpen: open,
    closedReason: open ? null
      : (!row.is_open ? 'closed'
        : (row.starts_at && row.starts_at > row.today ? 'not_started' : 'ended')),
  };
}

// GET /polls/article/:articleId — public. The poll shown inside a story.
router.get('/article/:articleId', async (req, res, next) => {
  try {
    const articleId = Number(req.params.articleId);
    if (!Number.isInteger(articleId)) {
      return res.status(400).json({ error: 'A valid article id is required.' });
    }
    const found = await pool.query(
      'SELECT id FROM polls WHERE article_id = $1 ORDER BY created_at DESC LIMIT 1',
      [articleId]
    );
    if (found.rowCount === 0) return res.json({ poll: null });
    res.json({ poll: await pollWithResults(found.rows[0].id) });
  } catch (err) {
    next(err);
  }
});

// GET /polls/:id — public, a single poll with results.
router.get('/:id', async (req, res, next) => {
  try {
    const pollId = Number(req.params.id);
    if (!Number.isInteger(pollId)) {
      return res.status(400).json({ error: 'A valid poll id is required.' });
    }
    const poll = await pollWithResults(pollId);
    if (!poll) return res.status(404).json({ error: 'That poll no longer exists.' });
    res.json({ poll });
  } catch (err) {
    next(err);
  }
});

// POST /polls/:id/vote — public, one vote per voter key. Voting again just
// returns the current results rather than erroring, so a reader who taps
// twice sees the outcome instead of a failure.
router.post('/:id/vote', publicSubmitLimiter, async (req, res, next) => {
  try {
    const pollId = Number(req.params.id);
    const optionId = Number(req.body.optionId);
    if (!Number.isInteger(pollId) || !Number.isInteger(optionId)) {
      return res.status(400).json({ error: 'A valid poll and option are required.' });
    }
    const voterKey = voterKeyFor(req);
    if (!voterKey) {
      return res.status(400).json({ error: 'Could not identify your vote. Please refresh and try again.' });
    }
    // The schedule is enforced HERE, not only in the reader's UI. A closed
    // poll's widget is disabled in the browser, but a disabled button is a
    // suggestion — this is the part that actually refuses the vote.
    const poll = await pool.query(
      `SELECT is_open,
              to_char(starts_at, 'YYYY-MM-DD') AS starts_at,
              to_char(ends_at,   'YYYY-MM-DD') AS ends_at,
              to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today
         FROM polls WHERE id = $1`, [pollId]);
    if (poll.rowCount === 0) return res.status(404).json({ error: 'That poll no longer exists.' });
    if (!votingOpen(poll.rows[0], poll.rows[0].today)) {
      const row = poll.rows[0];
      const notYet = row.is_open && row.starts_at && row.starts_at > row.today;
      return res.status(409).json({
        error: notYet ? 'This poll has not opened yet.' : 'This poll is closed.',
        poll: await pollWithResults(pollId),
      });
    }
    // The option must belong to this poll — otherwise a crafted request could
    // add votes to another poll's option.
    const option = await pool.query(
      'SELECT 1 FROM poll_options WHERE id = $1 AND poll_id = $2',
      [optionId, pollId]
    );
    if (option.rowCount === 0) {
      return res.status(400).json({ error: 'That option is not part of this poll.' });
    }
    await pool.query(
      `INSERT INTO poll_votes (poll_id, option_id, voter_key) VALUES ($1, $2, $3)
       ON CONFLICT (poll_id, voter_key) DO NOTHING`,
      [pollId, optionId, voterKey]
    );
    res.status(201).json({ poll: await pollWithResults(pollId) });
  } catch (err) {
    next(err);
  }
});

// GET /polls — admin list.
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT p.id, p.question, p.article_id, p.is_open, p.created_at,
              to_char(p.starts_at, 'YYYY-MM-DD') AS starts_at,
              to_char(p.ends_at,   'YYYY-MM-DD') AS ends_at,
              to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today,
              a.title AS article_title,
              (SELECT COUNT(*)::int FROM poll_votes v WHERE v.poll_id = p.id) AS total_votes
         FROM polls p
         LEFT JOIN articles a ON a.id = p.article_id
        ORDER BY p.created_at DESC`
    );

    // The per-option breakdown, fetched for every poll in ONE query rather
    // than one query per poll — the admin screen shows results inline, and a
    // list of thirty polls should not be thirty round trips.
    const tallies = await pool.query(
      `SELECT o.poll_id, o.id, o.label, o.position, COUNT(v.id)::int AS votes
         FROM poll_options o
         LEFT JOIN poll_votes v ON v.option_id = o.id
        GROUP BY o.id
        ORDER BY o.poll_id, o.position, o.id`
    );
    const byPoll = {};
    tallies.rows.forEach((o) => {
      (byPoll[o.poll_id] = byPoll[o.poll_id] || []).push(o);
    });

    const polls = result.rows.map((p) => {
      const opts = byPoll[p.id] || [];
      const total = opts.reduce((sum, o) => sum + o.votes, 0);
      return {
        ...p,
        options: opts.map((o) => ({
          ...o, percent: total > 0 ? Math.round((o.votes / total) * 100) : 0,
        })),
        // What the admin needs to see: not the flag, but whether it is
        // actually taking votes today. A poll flagged open whose end date has
        // passed is not running, and showing it as "Open" would be a lie.
        votingOpen: votingOpen(p, p.today),
        state: !p.is_open ? 'closed'
          : (p.starts_at && p.starts_at > p.today ? 'scheduled'
            : (p.ends_at && p.ends_at < p.today ? 'ended' : 'open')),
      };
    });
    res.json({ polls });
  } catch (err) {
    next(err);
  }
});

// POST /polls — admin creates a poll with its options in one call.
router.post('/', requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const question = (req.body.question || '').trim();
    const options = Array.isArray(req.body.options)
      ? req.body.options.map((o) => String(o || '').trim()).filter(Boolean)
      : [];
    const articleId = req.body.articleId ? Number(req.body.articleId) : null;
    if (!question) return res.status(400).json({ error: 'A question is required.' });
    if (options.length < 2) return res.status(400).json({ error: 'Give readers at least two options.' });

    const startsAt = cleanDate(req.body.startsAt);
    const endsAt = cleanDate(req.body.endsAt);
    if (startsAt === false || endsAt === false) {
      return res.status(400).json({ error: 'Dates must be in YYYY-MM-DD format.' });
    }
    // A window that ends before it starts would accept no votes at all and
    // look, from the admin screen, exactly like a poll nobody voted in.
    if (startsAt && endsAt && endsAt < startsAt) {
      return res.status(400).json({ error: 'The end date cannot be before the start date.' });
    }

    // Poll and options are written together — a poll with no options would
    // render as an unusable empty widget.
    await client.query('BEGIN');
    const poll = await client.query(
      `INSERT INTO polls (question, article_id, starts_at, ends_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [question, Number.isInteger(articleId) ? articleId : null, startsAt || null, endsAt || null]
    );
    const pollId = poll.rows[0].id;
    for (let i = 0; i < options.length; i += 1) {
      await client.query(
        'INSERT INTO poll_options (poll_id, label, position) VALUES ($1, $2, $3)',
        [pollId, options[i], i]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ poll: await pollWithResults(pollId) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /polls/:id — admin opens or closes voting.
router.patch('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const pollId = Number(req.params.id);
    if (!Number.isInteger(pollId)) {
      return res.status(400).json({ error: 'A valid poll id is required.' });
    }
    const sets = [];
    const values = [];
    const push = (col, val) => { values.push(val); sets.push(`${col} = $${values.length}`); };

    if (req.body.isOpen !== undefined) {
      if (typeof req.body.isOpen !== 'boolean') {
        return res.status(400).json({ error: 'isOpen must be true or false.' });
      }
      push('is_open', req.body.isOpen);
    }
    // An empty string clears a date back to "no restriction", the same way
    // the wording editor reverts copy — otherwise a scheduled poll could
    // never be turned back into an open-ended one.
    for (const [key, col] of [['startsAt', 'starts_at'], ['endsAt', 'ends_at']]) {
      if (req.body[key] === undefined) continue;
      const v = cleanDate(req.body[key]);
      if (v === false) return res.status(400).json({ error: 'Dates must be in YYYY-MM-DD format.' });
      push(col, v);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update.' });

    // CHECK THE RESULTING WINDOW BEFORE WRITING IT, not after. A patch may
    // set only one of the two dates, so the pair that matters is the one this
    // change would leave behind — which means reading what is stored now and
    // merging. Validating afterwards would save the bad combination and then
    // report an error, leaving a poll that accepts no votes and looks, from
    // the list, exactly like one nobody voted in.
    const current = await pool.query(
      `SELECT to_char(starts_at, 'YYYY-MM-DD') AS starts_at,
              to_char(ends_at,   'YYYY-MM-DD') AS ends_at
         FROM polls WHERE id = $1`, [pollId]);
    if (current.rowCount === 0) return res.status(404).json({ error: 'That poll no longer exists.' });

    const merged = {
      starts_at: req.body.startsAt !== undefined ? cleanDate(req.body.startsAt) : current.rows[0].starts_at,
      ends_at: req.body.endsAt !== undefined ? cleanDate(req.body.endsAt) : current.rows[0].ends_at,
    };
    if (merged.starts_at && merged.ends_at && merged.ends_at < merged.starts_at) {
      return res.status(400).json({ error: 'The end date cannot be before the start date.' });
    }

    values.push(pollId);
    const result = await pool.query(
      `UPDATE polls SET ${sets.join(', ')} WHERE id = $${values.length}
       RETURNING id, is_open,
                 to_char(starts_at, 'YYYY-MM-DD') AS starts_at,
                 to_char(ends_at,   'YYYY-MM-DD') AS ends_at`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'That poll no longer exists.' });
    res.json({ poll: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /polls/:id — admin. Options and votes cascade away with it.
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const pollId = Number(req.params.id);
    if (!Number.isInteger(pollId)) {
      return res.status(400).json({ error: 'A valid poll id is required.' });
    }
    await pool.query('DELETE FROM polls WHERE id = $1', [pollId]);
    logActivity(req.user.id, 'poll_deleted', `poll ${pollId}`);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
