const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
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

// Shared shape: a poll plus its options and current tallies.
async function pollWithResults(pollId) {
  const poll = await pool.query(
    'SELECT id, question, article_id, is_open, created_at FROM polls WHERE id = $1',
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
  return { ...poll.rows[0], options: options.rows, totalVotes: total };
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
    const poll = await pool.query('SELECT is_open FROM polls WHERE id = $1', [pollId]);
    if (poll.rowCount === 0) return res.status(404).json({ error: 'That poll no longer exists.' });
    if (!poll.rows[0].is_open) {
      return res.status(409).json({ error: 'This poll is closed.', poll: await pollWithResults(pollId) });
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
              a.title AS article_title,
              (SELECT COUNT(*)::int FROM poll_votes v WHERE v.poll_id = p.id) AS total_votes
         FROM polls p
         LEFT JOIN articles a ON a.id = p.article_id
        ORDER BY p.created_at DESC`
    );
    res.json({ polls: result.rows });
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

    // Poll and options are written together — a poll with no options would
    // render as an unusable empty widget.
    await client.query('BEGIN');
    const poll = await client.query(
      'INSERT INTO polls (question, article_id) VALUES ($1, $2) RETURNING id',
      [question, Number.isInteger(articleId) ? articleId : null]
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
    if (typeof req.body.isOpen !== 'boolean') {
      return res.status(400).json({ error: 'isOpen must be true or false.' });
    }
    const result = await pool.query(
      'UPDATE polls SET is_open = $1 WHERE id = $2 RETURNING id, is_open',
      [req.body.isOpen, pollId]
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
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
