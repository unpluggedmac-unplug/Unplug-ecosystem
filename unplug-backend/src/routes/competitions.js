const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Note: there is no global ENTRY_FEE constant — each competition sets its
// own entry_fee (e.g. The Arena = R250) at creation time (see POST
// /competitions below).

// GET /competitions — public, open competitions only.
router.get('/competitions', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, slug, description, opens_at, closes_at
       FROM competitions
       WHERE status = 'open'
       ORDER BY closes_at ASC`
    );
    res.json({ competitions: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /competitions/:slug — public. Includes approved entries with their
// live vote counts, so the frontend can render a leaderboard directly.
router.get('/competitions/:slug', async (req, res, next) => {
  try {
    const compResult = await pool.query('SELECT * FROM competitions WHERE slug = $1', [req.params.slug]);
    if (compResult.rows.length === 0) {
      return res.status(404).json({ error: 'Competition not found.' });
    }
    const competition = compResult.rows[0];

    // LEFT JOIN, not JOIN: a manual entry has no profile, so its identity
    // comes from ce.manual_name / ce.manual_image_url instead. display_name and
    // image are COALESCEd so the frontend renders both kinds the same way; a
    // manual entry returns a null profile_slug (no profile page to link to).
    const entries = await pool.query(
      `SELECT ce.id, ce.profile_id, ce.created_at,
              COALESCE(p.display_name, ce.manual_name) AS display_name,
              p.slug AS profile_slug,
              ce.manual_image_url,
              COALESCE(ce.manual_image_url, p.feature_image_url) AS image_url,
              c.name AS category, COALESCE(SUM(v.bundle_size), 0) AS vote_count
       FROM competition_entries ce
       LEFT JOIN profiles p ON p.id = ce.profile_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN votes v ON v.entry_id = ce.id
       WHERE ce.competition_id = $1 AND ce.status = 'approved'
       GROUP BY ce.id, p.display_name, p.slug, p.feature_image_url, ce.manual_name, ce.manual_image_url, c.name
       -- Deterministic ranking, so every consumer (Top 10 page, homepage Top 3)
       -- gets the SAME order for the same data. Ties break on who reached the
       -- competition first, then on id — never arbitrarily, so positions don't
       -- shuffle between page loads when two entries are level.
       ORDER BY vote_count DESC, ce.created_at ASC, ce.id ASC`,
      [competition.id]
    );

    // SUM() comes back from pg as a NUMERIC string ("12"), which sorts and
    // compares as text in JS. Cast once here so every caller gets a real
    // number and can't accidentally rank "9" above "10".
    const rows = entries.rows.map((r) => ({ ...r, vote_count: Number(r.vote_count) }));

    res.json({ competition, entries: rows });
  } catch (err) {
    next(err);
  }
});

// POST /admin/competitions — admin creates a new competition (e.g. The Arena).
// Kept in this file rather than admin.js since it's tightly coupled to the
// slug/date logic below, but still gated by requireRole('admin').
router.post('/competitions', requireRole('admin'), async (req, res, next) => {
  try {
    const { name, slug, description, opensAt, closesAt, entryFee, status } = req.body;
    if (!name || !slug || !opensAt || !closesAt) {
      return res.status(400).json({ error: 'name, slug, opensAt, and closesAt are required.' });
    }
    // The slug ends up in URLs and is looked up by page code, so keep it to a
    // predictable shape rather than storing whatever was typed.
    const cleanSlug = String(slug).trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(cleanSlug)) {
      return res.status(400).json({ error: 'The web address may use lowercase letters, numbers and hyphens only.' });
    }
    if (status !== undefined && !['draft', 'open', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Status must be draft, open or closed.' });
    }
    if (entryFee != null && (isNaN(Number(entryFee)) || Number(entryFee) < 0)) {
      return res.status(400).json({ error: 'Entry fee must be zero or more.' });
    }
    if (new Date(closesAt) <= new Date(opensAt)) {
      return res.status(400).json({ error: 'The closing date must be after the opening date.' });
    }
    const result = await pool.query(
      `INSERT INTO competitions (name, slug, description, opens_at, closes_at, status, entry_fee)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [String(name).trim().slice(0, 160), cleanSlug, description || null, opensAt, closesAt,
       status || 'open', entryFee != null ? entryFee : 50.00]
    );
    res.status(201).json({ competition: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') { // unique_violation on slug
      return res.status(409).json({ error: 'A competition already uses that web address — pick another.' });
    }
    next(err);
  }
});

// Competitions whose slug is wired into page code (the Competitions page reads
// 'the-arena'; the Top 10 page reads 'top-10'; free Arena credits key off
// 'the-arena' in the entry route above). They can be edited and closed like any
// other, but not deleted — removing one would leave those pages with nothing to
// load.
const BUILT_IN_SLUGS = ['the-arena', 'top-10'];

// The Top 10 is NOT a competition from the magazine's point of view — it is the
// Top 10 list, a separate thing with its own page and its own admin screen
// (Publish → Top 10). It only lives in this table because the live-voting
// machinery it needs is the competitions/votes system (see the 2026-07-07 note
// in 013_top10_competition.sql), and its page never shows a closing date or an
// entry fee — the two things the competitions editor exists to change.
//
// So it is hidden from the admin competitions list: showing it there would
// invite edits to fields nothing renders, and would present the Top 10 and The
// Arena as the same kind of object when they are not.
//
// It is deliberately still returned by the PUBLIC GET /competitions, because
// the admin Publish section finds the Top 10 by looking its slug up in that
// list — filtering it out there would break adding entries to the Top 10.
const MANAGED_ELSEWHERE_SLUGS = ['top-10'];

// GET /competitions/admin/all — admin list. Unlike the public route this
// returns every competition whatever its status, plus the entry counts the
// admin needs to judge whether a competition is safe to delete.
//
// Deliberately namespaced under /competitions rather than /admin: the /admin
// router is mounted first in app.js, so an /admin/competitions path here would
// only work by falling through it, and would break silently the day someone
// adds a catch-all there. Three segments also keeps it clear of the
// /competitions/:slug route, which only ever matches two.
router.get('/competitions/admin/all', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.slug, c.description, c.opens_at, c.closes_at,
              c.status, c.entry_fee, c.created_at,
              COUNT(ce.id)::int AS entry_count,
              COUNT(ce.id) FILTER (WHERE ce.status <> 'awaiting_payment')::int AS paid_entry_count
         FROM competitions c
         LEFT JOIN competition_entries ce ON ce.competition_id = c.id
        WHERE c.slug <> ALL($1::text[])
        GROUP BY c.id
        ORDER BY c.closes_at DESC`,
      [MANAGED_ELSEWHERE_SLUGS]
    );
    res.json({
      competitions: result.rows.map((r) => ({
        ...r,
        entryFee: Number(r.entry_fee),
        builtIn: BUILT_IN_SLUGS.includes(r.slug),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /competitions/:id — admin edits a competition.
//
// The slug is deliberately NOT editable. It is the competition's identity: page
// code looks competitions up by slug, so renaming one would break the
// Competitions or Top 10 page with no error to explain why.
//
// Changing entry_fee only affects FUTURE entries. Each entry snapshots the fee
// it was created with (see the entry route above) and payments charge from that
// snapshot, so raising the price never changes what an existing entrant owes or
// already paid.
router.patch('/competitions/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await pool.query('SELECT * FROM competitions WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Competition not found.' });

    const b = req.body;
    if (b.slug !== undefined && b.slug !== existing.rows[0].slug) {
      return res.status(400).json({
        error: 'A competition\'s web address (slug) cannot be changed — pages look it up by that name.',
      });
    }
    if (b.status !== undefined && !['draft', 'open', 'closed'].includes(b.status)) {
      return res.status(400).json({ error: 'Status must be draft, open or closed.' });
    }
    if (b.name !== undefined && !String(b.name).trim()) {
      return res.status(400).json({ error: 'Give the competition a name.' });
    }
    if (b.entryFee !== undefined && (isNaN(Number(b.entryFee)) || Number(b.entryFee) < 0)) {
      return res.status(400).json({ error: 'Entry fee must be zero or more.' });
    }

    // Only touch the fields actually sent, so a form that omits one can't blank it.
    const sets = [];
    const vals = [];
    const put = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
    if (b.name !== undefined) put('name', String(b.name).trim().slice(0, 160));
    if (b.description !== undefined) put('description', String(b.description || '').trim() || null);
    if (b.opensAt !== undefined) put('opens_at', b.opensAt);
    if (b.closesAt !== undefined) put('closes_at', b.closesAt);
    if (b.status !== undefined) put('status', b.status);
    if (b.entryFee !== undefined) put('entry_fee', Number(b.entryFee));
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update.' });

    vals.push(id);
    const result = await pool.query(
      `UPDATE competitions SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    // Reject an inverted window rather than storing dates that would render as
    // a competition closing before it opens.
    const row = result.rows[0];
    if (new Date(row.closes_at) <= new Date(row.opens_at)) {
      await pool.query('UPDATE competitions SET opens_at = $1, closes_at = $2 WHERE id = $3',
        [existing.rows[0].opens_at, existing.rows[0].closes_at, id]);
      return res.status(400).json({ error: 'The closing date must be after the opening date.' });
    }
    res.json({ competition: row });
  } catch (err) {
    next(err);
  }
});

// DELETE /competitions/:id — admin removes a competition.
//
// Guarded on purpose. competition_entries and votes both CASCADE from this row,
// and entries/votes carry payment_id, so deleting a competition that people
// have paid to enter would silently destroy the entries and votes those
// payments were for and leave the payment records pointing at nothing.
//
// So: a competition with any entries cannot be deleted — close it instead,
// which hides it from the public site while keeping every record intact.
// Delete is for competitions created by mistake.
router.delete('/competitions/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await pool.query('SELECT slug, name FROM competitions WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Competition not found.' });

    if (BUILT_IN_SLUGS.includes(existing.rows[0].slug)) {
      return res.status(400).json({
        error: `"${existing.rows[0].name}" is built into the site and can't be deleted. Set it to Closed to take it off the public pages.`,
      });
    }

    const entries = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status <> 'awaiting_payment')::int AS paid
         FROM competition_entries WHERE competition_id = $1`,
      [id]
    );
    const { total, paid } = entries.rows[0];
    if (total > 0) {
      return res.status(409).json({
        error: `This competition has ${total} ${total === 1 ? 'entry' : 'entries'}${paid > 0 ? ` (${paid} paid)` : ''}. Deleting it would remove those entries and their votes, so set it to Closed instead — that hides it from the site and keeps the records.`,
      });
    }

    await pool.query('DELETE FROM competitions WHERE id = $1', [id]);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// POST /competitions/:id/entries — member enters their own profile.
// Entry starts as 'awaiting_payment', same pattern as Profile packages —
// call POST /payments/initiate with linkedType "competition_entry" and
// this entry's id next. The fee charged is whatever THIS competition set
// (e.g. The Arena = R250), not a single global amount.
router.post('/competitions/:id/entries', requireAuth, async (req, res, next) => {
  try {
    const profileResult = await pool.query('SELECT id, free_arena_credits FROM profiles WHERE user_id = $1', [req.user.id]);
    if (profileResult.rows.length === 0) {
      return res.status(400).json({ error: 'You need a Directory profile before entering a competition.' });
    }
    const profileId = profileResult.rows[0].id;

    const competitionResult = await pool.query('SELECT entry_fee, slug FROM competitions WHERE id = $1', [req.params.id]);
    if (competitionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Competition not found.' });
    }
    const entryFee = Number(competitionResult.rows[0].entry_fee);
    const isArena = competitionResult.rows[0].slug === 'the-arena';
    const hasCredit = isArena && profileResult.rows[0].free_arena_credits > 0;

    const existing = await pool.query(
      'SELECT id FROM competition_entries WHERE competition_id = $1 AND profile_id = $2',
      [req.params.id, profileId]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'You have already entered this competition.' });
    }

    const result = await pool.query(
      `INSERT INTO competition_entries (competition_id, profile_id, entry_fee, status)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.params.id, profileId, entryFee, hasCredit ? 'pending' : 'awaiting_payment']
    );

    if (hasCredit) {
      await pool.query('UPDATE profiles SET free_arena_credits = free_arena_credits - 1 WHERE id = $1', [profileId]);
    }

    res.status(201).json({
      entry: result.rows[0],
      message: hasCredit
        ? 'Entry created using your free Arena credit — no payment needed.'
        : `Entry created — call POST /payments/initiate with linkedType "competition_entry" and this entry's id (R${entryFee.toFixed(2)}) to proceed.`,
    });
  } catch (err) {
    if (err.code === '23505') { // unique_violation, belt-and-braces
      return res.status(409).json({ error: 'You have already entered this competition.' });
    }
    next(err);
  }
});

// POST /competitions/:id/admin-entries — admin adds an entry to a competition
// (including the Top 10 list) directly: approved on the spot, zero fee, no
// payment step. The member-facing route above can only enter the caller's own
// profile, which is why editorial needs its own door.
//
// Two shapes: pass profileId to feature an existing Directory profile, OR pass
// manualName (+ optional manualImageUrl) to feature someone who has no profile
// — just a name and a photo.
router.post('/competitions/:id/admin-entries', requireRole('admin'), async (req, res, next) => {
  try {
    const competitionId = Number(req.params.id);
    if (!Number.isInteger(competitionId)) {
      return res.status(400).json({ error: 'A valid competition is required.' });
    }
    const competition = await pool.query('SELECT id FROM competitions WHERE id = $1', [competitionId]);
    if (competition.rows.length === 0) {
      return res.status(404).json({ error: 'Competition not found.' });
    }

    const manualName = (req.body.manualName || '').trim();

    // Manual entry: a name (and optionally an image), no profile.
    if (manualName) {
      if (manualName.length > 160) return res.status(400).json({ error: 'That name is too long.' });
      const manualImageUrl = (req.body.manualImageUrl || '').trim() || null;
      const result = await pool.query(
        `INSERT INTO competition_entries (competition_id, profile_id, manual_name, manual_image_url, entry_fee, status)
         VALUES ($1, NULL, $2, $3, 0, 'approved')
         RETURNING *`,
        [competitionId, manualName, manualImageUrl]
      );
      return res.status(201).json({
        entry: result.rows[0],
        message: 'Entry added and approved — it is live on the list now.',
      });
    }

    // Profile entry (the original path).
    const profileId = Number(req.body.profileId);
    if (!Number.isInteger(profileId)) {
      return res.status(400).json({ error: 'Provide either a profile to feature, or a name for a manual entry.' });
    }
    const profile = await pool.query('SELECT id FROM profiles WHERE id = $1', [profileId]);
    if (profile.rows.length === 0) {
      return res.status(404).json({ error: 'That profile does not exist.' });
    }
    const result = await pool.query(
      `INSERT INTO competition_entries (competition_id, profile_id, entry_fee, status)
       VALUES ($1, $2, 0, 'approved')
       RETURNING *`,
      [competitionId, profileId]
    );
    res.status(201).json({
      entry: result.rows[0],
      message: 'Entry added and approved — it is live on the list now.',
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That profile is already entered in this competition.' });
    }
    next(err);
  }
});

// GET /competitions/:id/entries/admin — every entry in a competition (or the
// Top 10 list), whatever its status, with vote totals and whether it was paid
// for. The admin-facing counterpart to the public list, which only ever shows
// approved entries.
router.get('/competitions/:id/entries/admin', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ce.id, ce.status, ce.entry_fee, ce.created_at, ce.profile_id,
              ce.manual_name, ce.manual_image_url,
              COALESCE(p.display_name, ce.manual_name) AS display_name,
              COALESCE(ce.manual_image_url, p.feature_image_url) AS image_url,
              p.slug AS profile_slug,
              COALESCE(SUM(v.bundle_size), 0) AS vote_count,
              -- Whether real money is attached. Drives whether delete is safe.
              EXISTS (
                SELECT 1 FROM payments pay
                 WHERE pay.linked_type = 'competition_entry' AND pay.linked_id = ce.id
              ) AS has_payment
         FROM competition_entries ce
         LEFT JOIN profiles p ON p.id = ce.profile_id
         LEFT JOIN votes v ON v.entry_id = ce.id
        WHERE ce.competition_id = $1
        GROUP BY ce.id, p.display_name, p.slug, p.feature_image_url
        ORDER BY vote_count DESC, ce.created_at ASC, ce.id ASC`,
      [Number(req.params.id)]
    );
    // SUM() arrives as a NUMERIC string; cast so "9" can't sort above "10".
    res.json({
      entries: result.rows.map((r) => ({ ...r, vote_count: Number(r.vote_count) })),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /entries/:id — admin edits an entry: the displayed name, its picture,
// or its status (which is how an entry is taken off the public list without
// destroying its votes).
//
// For an entry attached to a real Directory profile, the name and photo come
// from that profile and are edited there — overriding them here would make the
// Top 10 disagree with the profile it links to.
router.patch('/entries/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await pool.query(
      'SELECT id, profile_id FROM competition_entries WHERE id = $1', [id]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Entry not found.' });

    const b = req.body;
    if (b.status !== undefined && !['awaiting_payment', 'pending', 'approved', 'rejected'].includes(b.status)) {
      return res.status(400).json({ error: 'Status must be awaiting_payment, pending, approved or rejected.' });
    }
    const isManual = existing.rows[0].profile_id === null;
    if (!isManual && (b.manualName !== undefined || b.manualImageUrl !== undefined)) {
      return res.status(400).json({
        error: 'This entry is linked to a Directory profile — change its name or photo on the profile itself.',
      });
    }
    if (isManual && b.manualName !== undefined && !String(b.manualName).trim()) {
      return res.status(400).json({ error: 'A manual entry needs a name.' });
    }

    const sets = [];
    const vals = [];
    const put = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
    if (isManual && b.manualName !== undefined) put('manual_name', String(b.manualName).trim().slice(0, 160));
    if (isManual && b.manualImageUrl !== undefined) put('manual_image_url', (b.manualImageUrl || '').trim() || null);
    if (b.status !== undefined) put('status', b.status);
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update.' });

    vals.push(id);
    const result = await pool.query(
      `UPDATE competition_entries SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    res.json({ entry: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /entries/:id — admin removes an entry.
//
// Refused when someone PAID to enter: votes cascade from the entry, and the
// payment row would be left pointing at nothing. Rejecting instead takes it off
// the public list and keeps both the entry and the financial record.
//
// Admin-added entries (free, entry_fee 0) delete cleanly, which is the common
// case for fixing a Top 10 mistake.
router.delete('/entries/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await pool.query(
      `SELECT ce.id,
              COALESCE(p.display_name, ce.manual_name) AS display_name,
              EXISTS (
                SELECT 1 FROM payments pay
                 WHERE pay.linked_type = 'competition_entry' AND pay.linked_id = ce.id
              ) AS has_payment,
              (SELECT COUNT(*)::int FROM votes v WHERE v.entry_id = ce.id) AS vote_rows
         FROM competition_entries ce
         LEFT JOIN profiles p ON p.id = ce.profile_id
        WHERE ce.id = $1`,
      [id]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Entry not found.' });
    const e = existing.rows[0];

    if (e.has_payment) {
      return res.status(409).json({
        error: `"${e.display_name || 'This entry'}" was paid for. Deleting it would remove the entry its payment refers to, so set it to Rejected instead — that takes it off the list and keeps the record.`,
      });
    }

    await pool.query('DELETE FROM competition_entries WHERE id = $1', [id]);
    res.json({ deleted: true, votesRemoved: e.vote_rows });
  } catch (err) {
    next(err);
  }
});

// GET /entries/mine — the authenticated member's own competition entries,
// at any status, with their current vote count.
router.get('/entries/mine', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ce.id, ce.status, ce.entry_fee, ce.created_at, c.name AS competition_name, c.slug AS competition_slug,
              COALESCE(SUM(v.bundle_size), 0) AS vote_count
       FROM competition_entries ce
       JOIN competitions c ON c.id = ce.competition_id
       LEFT JOIN votes v ON v.entry_id = ce.id
       WHERE ce.profile_id IN (SELECT id FROM profiles WHERE user_id = $1)
       GROUP BY ce.id, c.name, c.slug
       ORDER BY ce.created_at DESC`,
      [req.user.id]
    );
    res.json({ entries: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /entries/:id/vote — one free vote per user (if logged in) or per
// browser session (if guest). Guests must send a stable sessionId (e.g. a
// UUID stored in a cookie/localStorage by the frontend) so the unique
// index in the migration can enforce one vote each.
//
// For paid extra votes ("Bundle Vote"), see POST /entries/:id/vote-bundle
// below — priced from the admin-configurable `bundle_vote_price` setting
// rather than a hardcoded number, since no business decision on price was
// made during planning.
router.post('/entries/:id/vote', async (req, res, next) => {
  try {
    const { sessionId } = req.body;
    if (!req.user && !sessionId) {
      return res.status(400).json({ error: 'sessionId is required for guest votes.' });
    }

    const entryCheck = await pool.query(
      `SELECT ce.id FROM competition_entries ce WHERE ce.id = $1 AND ce.status = 'approved'`,
      [req.params.id]
    );
    if (entryCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Entry not found or not open for voting.' });
    }

    const result = await pool.query(
      `INSERT INTO votes (entry_id, voter_user_id, session_id, bundle_size)
       VALUES ($1, $2, $3, 1)
       RETURNING *`,
      [req.params.id, req.user ? req.user.id : null, req.user ? null : sessionId]
    );

    res.status(201).json({ vote: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      return res.status(409).json({ error: 'You have already voted for this entry.' });
    }
    next(err);
  }
});

// GET /vote-bundle-tiers — public. The fixed set of purchasable bundles
// (10 votes/R10, 50/R20, 70/R50, 150/R100, 200/R150, 300/R200), so the
// frontend can render them as buttons rather than a free-text amount.
router.get('/vote-bundle-tiers', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT votes, price FROM vote_bundle_tiers ORDER BY votes ASC');
    res.json({ tiers: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /entries/:id/vote-bundle — buy extra votes at one of the fixed
// tier prices (see GET /vote-bundle-tiers). Creates a pending
// vote_bundles row; call POST /payments/initiate with linkedType
// "vote_bundle" and this bundle's id next. Votes are only actually
// recorded once payment confirms (see applyPaymentEffect in payments.js).
router.post('/entries/:id/vote-bundle', async (req, res, next) => {
  try {
    const { votes, sessionId } = req.body;
    if (!req.user && !sessionId) {
      return res.status(400).json({ error: 'sessionId is required for guest bundle purchases.' });
    }

    const entryCheck = await pool.query(
      `SELECT id FROM competition_entries WHERE id = $1 AND status = 'approved'`,
      [req.params.id]
    );
    if (entryCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Entry not found or not open for voting.' });
    }

    const tierResult = await pool.query('SELECT price FROM vote_bundle_tiers WHERE votes = $1', [votes]);
    if (tierResult.rows.length === 0) {
      return res.status(400).json({ error: 'votes must match one of the published Bundle Vote tiers — see GET /vote-bundle-tiers.' });
    }
    const price = Number(tierResult.rows[0].price);

    const bundle = await pool.query(
      `INSERT INTO vote_bundles (entry_id, buyer_user_id, session_id, vote_count, price)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.params.id, req.user ? req.user.id : null, req.user ? null : sessionId, votes, price]
    );

    res.status(201).json({
      bundle: bundle.rows[0],
      message: `Bundle created — call POST /payments/initiate with linkedType "vote_bundle" and this bundle's id (R${price.toFixed(2)}) to proceed.`,
    });
  } catch (err) {
    next(err);
  }
});

// POST /top10/enter — member pays R100 to submit their own profile for
// Top 10 consideration. This is separate from the admin-curated
// top10_rankings table — an approved entry just means the admin can
// consider it when next publishing rankings (POST /top10/publish),
// not an automatic ranking.
router.post('/top10/enter', requireAuth, async (req, res, next) => {
  try {
    const profileResult = await pool.query('SELECT id FROM profiles WHERE user_id = $1', [req.user.id]);
    if (profileResult.rows.length === 0) {
      return res.status(400).json({ error: 'You need a Directory profile before entering Top 10 consideration.' });
    }
    const profileId = profileResult.rows[0].id;

    const result = await pool.query(
      `INSERT INTO top10_entries (profile_id, entry_fee)
       VALUES ($1, 100.00)
       RETURNING *`,
      [profileId]
    );

    res.status(201).json({
      entry: result.rows[0],
      message: 'Entry created — call POST /payments/initiate with linkedType "top10_entry" and this entry\'s id (R100.00) to proceed.',
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'You have already submitted a Top 10 entry.' });
    }
    next(err);
  }
});

// GET /top10 — public. Current period only, per the locked Blueprint.
router.get('/top10', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT t.rank, t.cause_text, p.display_name, p.slug,
              COALESCE(t.cover_image_url, p.feature_image_url) AS cover_image_url
       FROM top10_rankings t
       JOIN profiles p ON p.id = t.profile_id
       ORDER BY t.rank ASC`
    );
    res.json({ rankings: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /admin/top10/publish — admin publishes the current Top 10 by
// replacing the entire table with a new set of rankings. This is a
// deliberate wipe-and-replace, matching "current period only, no history".
router.post('/top10/publish', requireRole('admin'), async (req, res, next) => {
  try {
    const { rankings } = req.body; // [{ profileId, rank, causeText }, ...]
    if (!Array.isArray(rankings) || rankings.length === 0 || rankings.length > 10) {
      return res.status(400).json({ error: 'rankings must be an array of 1–10 entries.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM top10_rankings');
      for (const r of rankings) {
        await client.query(
          `INSERT INTO top10_rankings (period_label, profile_id, rank, cause_text)
           VALUES ($1, $2, $3, $4)`,
          [req.body.periodLabel || 'Current', r.profileId, r.rank, r.causeText || null]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ message: 'Top 10 published.' });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Hall of Fame — past competition winners (admin-entered). Uses a distinct
// /hall-of-fame path so it doesn't collide with /competitions/:slug.
// ---------------------------------------------------------------------------

// GET /hall-of-fame — public, newest year first.
router.get('/hall-of-fame', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, year, name, title, photo_url, description
       FROM hall_of_fame ORDER BY year DESC NULLS LAST, created_at DESC`
    );
    res.json({ winners: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /hall-of-fame — admin adds a past winner.
router.post('/hall-of-fame', requireRole('admin'), async (req, res, next) => {
  try {
    const { year, name, title, photoUrl, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required.' });
    const result = await pool.query(
      `INSERT INTO hall_of_fame (year, name, title, photo_url, description)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [year ? parseInt(year, 10) : null, name.trim(), (title || '').trim() || null,
       (photoUrl || '').trim() || null, (description || '').trim() || null]
    );
    res.status(201).json({ winner: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /hall-of-fame/:id — admin edits a winner. Previously the only way to
// correct a typo was to delete the entry and retype it, which loses the row.
router.patch('/hall-of-fame/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const map = { year: 'year', name: 'name', title: 'title', photoUrl: 'photo_url', description: 'description' };
    const sets = [];
    const values = [];
    for (const [bodyKey, column] of Object.entries(map)) {
      if (req.body[bodyKey] !== undefined) {
        const raw = req.body[bodyKey];
        values.push(bodyKey === 'year'
          ? (raw ? parseInt(raw, 10) : null)
          : (String(raw || '').trim() || null));
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update.' });
    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE hall_of_fame SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'That entry no longer exists.' });
    res.json({ winner: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /hall-of-fame/:id — admin removes a winner.
router.delete('/hall-of-fame/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM hall_of_fame WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Winner not found.' });
    res.json({ message: 'Removed.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
