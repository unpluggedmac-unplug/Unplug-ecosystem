const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { eftInstructions } = require('../utils/eftDetails');
const { logActivity } = require('./activityLog');
const { recordParticipationAsync } = require('../utils/participation');
const { captureMonth, currentPeriod, previousPeriod } = require('../utils/top10MonthlyCapture');

const router = express.Router();

// Competitions whose vote totals start again each month. The Top 10 is a
// monthly title: at month end the board is captured to the permanent archive
// and the new month opens with everyone on zero, in the order they finished.
//
// This is a rule of the Top 10 SPECIFICALLY, kept alongside BUILT_IN_SLUGS
// below rather than in a database flag, because The Arena runs to its own
// dates and must never have its totals reset underneath it.
const MONTHLY_RESET_SLUGS = ['top-10'];
const isMonthlyReset = (slug) => MONTHLY_RESET_SLUGS.includes(slug);

// The vote total a monthly-reset competition should show: this month's votes
// only. Older votes still exist — they are attached to real payments and are
// never deleted — they simply belong to a month that has already been decided.
// For every other competition, `monthly` is false and this counts everything,
// exactly as it always has.
function voteCountExpr(monthlyParam, periodParam) {
  return `COALESCE(SUM(v.bundle_size) FILTER (
            WHERE NOT ${monthlyParam}::boolean OR v.vote_period = ${periodParam}::date
          ), 0)`;
}

// Reference codes for vote_bundles — same alphabet/shape as
// utils/editionAccess.js (O/0, I/1 excluded — read off a screen, typed
// into an EFT), but checked against vote_bundles.reference specifically,
// so it isn't reused as-is from that file.
const VOTE_REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// The Reference Code the buyer puts on their EFT IS the contestant's entry
// code — one code, under one name, everywhere a customer sees it. See
// 106_vote_reference_is_entry_code.sql for what that costs and why it is
// still what we do.
//
// A contestant who has not been issued an entry code yet (they are only
// assigned on approval) falls back to a generated code, because a purchase
// with no reference at all cannot be matched to a payment by anyone.
async function generateVoteBundleReference(entryCode) {
  if (/^[0-9]{10}$/.test(String(entryCode || ''))) return String(entryCode);
  for (let attempt = 0; attempt < 8; attempt++) {
    let candidate = '';
    for (let i = 0; i < 10; i++) candidate += VOTE_REF_ALPHABET[crypto.randomInt(VOTE_REF_ALPHABET.length)];
    const existing = await pool.query('SELECT 1 FROM vote_bundles WHERE reference = $1', [candidate]);
    if (existing.rowCount === 0) return candidate;
  }
  throw new Error('Could not generate a reference code.');
}

// The buyer's private handle on their own purchase. Never shown as "your
// reference" and never typed in by hand — it lives in the link they are given
// at checkout. It exists because the Reference Code is now a public entry
// code, and this portal has no login, so something else has to be the thing
// only the buyer knows.
async function generateVoteBundleLookupToken() {
  for (let attempt = 0; attempt < 8; attempt++) {
    let candidate = '';
    for (let i = 0; i < 24; i++) candidate += VOTE_REF_ALPHABET[crypto.randomInt(VOTE_REF_ALPHABET.length)];
    const existing = await pool.query('SELECT 1 FROM vote_bundles WHERE lookup_token = $1', [candidate]);
    if (existing.rowCount === 0) return candidate;
  }
  throw new Error('Could not generate a lookup token.');
}

// Resolves whatever the buyer came back with to exactly one bundle.
//
// Accepts the lookup token, or a LEGACY reference (the pre-106 random or
// entry-code-plus-suffix form), because those were unguessable and are still
// quoted in links already sent out. It deliberately does NOT accept a bare
// 10-digit entry code: that is printed publicly beside every contestant, so
// treating it as a credential would let anyone open — or attach files to —
// a stranger's purchase.
function isBareEntryCode(value) {
  return /^[0-9]{10}$/.test(String(value || '').trim());
}

async function resolveVoteBundle(handle) {
  const value = String(handle || '').trim().toUpperCase();
  if (!value) return { error: 'A reference is required.' };
  const byToken = await pool.query('SELECT id FROM vote_bundles WHERE lookup_token = $1', [value]);
  if (byToken.rowCount === 1) return { id: byToken.rows[0].id };
  if (isBareEntryCode(value)) {
    return { error: 'Please use the link you were given after checkout. An entry code on its own identifies the contestant, not your order.' };
  }
  const byRef = await pool.query('SELECT id FROM vote_bundles WHERE reference = $1', [value]);
  if (byRef.rowCount === 1) return { id: byRef.rows[0].id };
  if (byRef.rowCount > 1) {
    return { error: 'That reference matches more than one order. Please use the link you were given after checkout.' };
  }
  return { error: 'No purchase found for that reference.' };
}

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

    // The Top 10 shows THIS MONTH's votes; every other competition shows its
    // running total. See MONTHLY_RESET_SLUGS at the top of this file.
    const monthly = isMonthlyReset(competition.slug);
    const period = monthly ? (await currentPeriod()).period : null;

    // LEFT JOIN, not JOIN: a manual entry has no profile, so its identity
    // comes from ce.manual_name / ce.manual_image_url instead. display_name and
    // image are COALESCEd so the frontend renders both kinds the same way; a
    // manual entry returns a null profile_slug (no profile page to link to).
    const entries = await pool.query(
      `SELECT ce.id, ce.profile_id, ce.created_at, ce.entry_code, ce.carried_rank,
              COALESCE(p.display_name, ce.manual_name) AS display_name,
              p.slug AS profile_slug,
              ce.manual_image_url,
              COALESCE(ce.manual_image_url, p.feature_image_url) AS image_url,
              c.name AS category, ${voteCountExpr('$2', '$3')} AS vote_count
       FROM competition_entries ce
       LEFT JOIN profiles p ON p.id = ce.profile_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN votes v ON v.entry_id = ce.id
       WHERE ce.competition_id = $1 AND ce.status = 'approved'
       GROUP BY ce.id, ce.entry_code, p.display_name, p.slug, p.feature_image_url, ce.manual_name, ce.manual_image_url, c.name
       -- Deterministic ranking, so every consumer (Top 10 page, homepage Top 3)
       -- gets the SAME order for the same data. Ties break on who reached the
       -- competition first, then on id — never arbitrarily, so positions don't
       -- shuffle between page loads when two entries are level.
       --
       -- carried_rank sits directly after the votes: on the 1st of a new month
       -- every contestant is level on zero, and this is what keeps the board in
       -- the order the previous month closed in instead of reshuffling it. It
       -- is only ever a tie-breaker, so a single new vote still moves someone
       -- above last month's champion. It is NULL outside the Top 10, where this
       -- line then does nothing at all.
       ORDER BY vote_count DESC, ce.carried_rank ASC NULLS LAST,
                ce.created_at ASC, ce.id ASC`,
      [competition.id, monthly, period]
    );

    // SUM() comes back from pg as a NUMERIC string ("12"), which sorts and
    // compares as text in JS. Cast once here so every caller gets a real
    // number and can't accidentally rank "9" above "10".
    const rows = entries.rows.map((r) => ({ ...r, vote_count: Number(r.vote_count) }));

    // monthlyReset/votingPeriod let the page say WHICH month these totals are
    // for. Without it a board reading zero on the 1st looks broken rather than
    // like a new month starting.
    res.json({
      competition, entries: rows,
      monthlyReset: monthly,
      votingPeriod: period,
    });
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
      // has_votes drives whether the admin UI offers the voting-rule control
      // at all: it is frozen once voting starts (see the guard in PATCH
      // /competitions/:id), and a control that always fails is worse than one
      // that explains why it is locked. EXISTS rather than a count — it is
      // only ever asked as a yes/no, and this stops at the first row.
      `SELECT c.id, c.name, c.slug, c.description, c.opens_at, c.closes_at,
              c.status, c.entry_fee, c.daily_voting, c.created_at,
              COUNT(ce.id)::int AS entry_count,
              COUNT(ce.id) FILTER (WHERE ce.status <> 'awaiting_payment')::int AS paid_entry_count,
              EXISTS (
                SELECT 1 FROM votes v
                  JOIN competition_entries ce2 ON ce2.id = v.entry_id
                 WHERE ce2.competition_id = c.id
              ) AS has_votes
         FROM competitions c
         LEFT JOIN competition_entries ce ON ce.competition_id = c.id
        GROUP BY c.id
        ORDER BY c.closes_at DESC`
    );
    res.json({
      competitions: result.rows.map((r) => ({
        ...r,
        entryFee: Number(r.entry_fee),
        builtIn: BUILT_IN_SLUGS.includes(r.slug),
        // Its entries and rankings are managed on their own admin screens;
        // this flag lets the editor show that rather than imply otherwise.
        managedElsewhere: MANAGED_ELSEWHERE_SLUGS.includes(r.slug),
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

    // Voting rules are part of what entrants and voters were promised, so
    // they cannot be changed once voting has started. Turning daily voting
    // OFF mid-run is the worse direction — every vote already cast on a day
    // stays counted while new ones become one-per-person, so two voters end
    // up under different rules in the same competition — but ON is no fairer
    // to whoever already voted under the old rule. Allowed freely until the
    // first vote lands.
    if (b.dailyVoting !== undefined && !!b.dailyVoting !== existing.rows[0].daily_voting) {
      const voted = await pool.query(
        `SELECT 1 FROM votes v
           JOIN competition_entries ce ON ce.id = v.entry_id
          WHERE ce.competition_id = $1 LIMIT 1`,
        [id]
      );
      if (voted.rowCount > 0) {
        return res.status(409).json({
          error: 'Voting has already started for this competition, so the voting rule cannot be changed. Doing so would put early and late voters under different rules.',
        });
      }
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
    if (b.dailyVoting !== undefined) put('daily_voting', !!b.dailyVoting);
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

    recordParticipationAsync(req.user.id, 'competition_enter', {
      contentType: 'competition', contentId: Number(req.params.id),
    });

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
    // vote_count is what the public board shows (this month, for the Top 10).
    // all_time_vote_count is every vote ever counted for the entry. Both are
    // returned because an admin checking a bulk purchase needs to see the
    // votes they delivered even after the month they landed in has closed.
    const comp = await pool.query('SELECT slug FROM competitions WHERE id = $1', [Number(req.params.id)]);
    const monthly = comp.rows[0] ? isMonthlyReset(comp.rows[0].slug) : false;
    const period = monthly ? (await currentPeriod()).period : null;

    const result = await pool.query(
      `SELECT ce.id, ce.status, ce.entry_fee, ce.created_at, ce.profile_id, ce.carried_rank,
              ce.manual_name, ce.manual_image_url, ce.entry_code,
              COALESCE(p.display_name, ce.manual_name) AS display_name,
              COALESCE(ce.manual_image_url, p.feature_image_url) AS image_url,
              p.slug AS profile_slug,
              ${voteCountExpr('$2', '$3')} AS vote_count,
              COALESCE(SUM(v.bundle_size), 0) AS all_time_vote_count,
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
        ORDER BY vote_count DESC, ce.carried_rank ASC NULLS LAST,
                 ce.created_at ASC, ce.id ASC`,
      [Number(req.params.id), monthly, period]
    );
    // SUM() arrives as a NUMERIC string; cast so "9" can't sort above "10".
    res.json({
      monthlyReset: monthly,
      votingPeriod: period,
      entries: result.rows.map((r) => ({
        ...r,
        vote_count: Number(r.vote_count),
        all_time_vote_count: Number(r.all_time_vote_count),
      })),
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

    // The competition's own rule decides whether this vote is day-scoped.
    // Read from the entry rather than assumed, so the Arena keeps one vote
    // per person while the Top 10 allows one a day (098_daily_voting.sql).
    const entryCheck = await pool.query(
      `SELECT ce.id, c.daily_voting
         FROM competition_entries ce
         JOIN competitions c ON c.id = ce.competition_id
        WHERE ce.id = $1 AND ce.status = 'approved'`,
      [req.params.id]
    );
    if (entryCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Entry not found or not open for voting.' });
    }
    const dailyVoting = entryCheck.rows[0].daily_voting === true;

    // NULL vote_day = "once ever"; a date = "once on that date". The date is
    // South African rather than the server's UTC, so the day rolls over at
    // local midnight instead of 02:00 SAST.
    const result = await pool.query(
      `INSERT INTO votes (entry_id, voter_user_id, session_id, bundle_size, vote_day)
       VALUES ($1, $2, $3, 1,
               CASE WHEN $4::boolean
                    THEN (now() AT TIME ZONE 'Africa/Johannesburg')::date
                    ELSE NULL END)
       RETURNING *`,
      [req.params.id, req.user ? req.user.id : null, req.user ? null : sessionId, dailyVoting]
    );

    // Signed-in voters only. An anonymous vote has no member to credit, and
    // this must never be a way to earn points without an account.
    if (req.user) {
      recordParticipationAsync(req.user.id, 'competition_vote', {
        contentType: 'competition_entry', contentId: Number(req.params.id),
      });
    }

    res.status(201).json({ vote: result.rows[0], dailyVoting });
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      // Two different rules, so two different messages — "you have already
      // voted" would read as final on a competition the voter can in fact
      // return to tomorrow.
      const daily = /daily/.test(err.constraint || '');
      return res.status(409).json({
        error: daily
          ? 'You have already voted for this entry today. You can vote again tomorrow.'
          : 'You have already voted for this entry.',
        votedToday: daily,
      });
    }
    next(err);
  }
});

// Shared shape for the two entry-lookup routes below, so the checkout page
// gets identical fields whether it resolved the entry by numeric id (a click
// from the Top 10 page, which already knows it) or by the 10-digit code (typed
// in directly at the payment portal). Only ever returns an APPROVED entry —
// the code exists so a stranger can find who to vote for, not so a pending
// entry can be discovered before it's public.
// vote_count and category added for the Bulk Votes portal (Payment Portal
// Redevelopment Phase 2) — it shows Photo/Name/Category/Current Votes as
// soon as a contestant is found, matching GET /competitions/:slug's own
// vote_count computation exactly, so the two never disagree.
const ENTRY_LOOKUP_SELECT = `
  SELECT ce.id, ce.entry_code, ce.competition_id,
         COALESCE(p.display_name, ce.manual_name) AS display_name,
         COALESCE(ce.manual_image_url, p.feature_image_url) AS image_url,
         cat.name AS category,
         c.name AS competition_name, c.slug AS competition_slug,
         -- The count a BUYER is shown, so it has to be the same number the
         -- public board shows — for the Top 10 that is this month's total, not
         -- the all-time one. Someone about to buy votes seeing "5,000 votes so
         -- far" next to a board reading 0 would rightly think one of them is
         -- broken. The slug test mirrors MONTHLY_RESET_SLUGS at the top of this
         -- file; it is inlined here because this fragment is shared by several
         -- queries and carries no parameters of its own.
         COALESCE((SELECT SUM(v.bundle_size) FROM votes v
                    WHERE v.entry_id = ce.id
                      AND (c.slug <> 'top-10'
                           OR v.vote_period = date_trunc('month', (now() AT TIME ZONE 'Africa/Johannesburg'))::date)
                  ), 0)::INTEGER AS vote_count
    FROM competition_entries ce
    LEFT JOIN profiles p ON p.id = ce.profile_id
    LEFT JOIN categories cat ON cat.id = p.category_id
    JOIN competitions c ON c.id = ce.competition_id
`;

// GET /entries/search?q=&competitionSlug= — public. "Search contestant" (as
// opposed to the code lookup below) for the Bulk Votes portal — Portal 2
// Step 1, Option A. Capped at 10 results; a name search returning hundreds
// of rows isn't a "pick who you mean" list any more.
router.get('/entries/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      return res.status(400).json({ error: 'Enter at least 2 characters to search.' });
    }
    const slug = String(req.query.competitionSlug || 'top-10').trim();
    const result = await pool.query(
      `${ENTRY_LOOKUP_SELECT}
       WHERE ce.status = 'approved' AND c.slug = $1
         AND COALESCE(p.display_name, ce.manual_name) ILIKE $2
       ORDER BY vote_count DESC
       LIMIT 10`,
      [slug, `%${q}%`]
    );
    res.json({ entries: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /entries/by-code/:code — public. Resolves an entry by its 10-digit
// code, for the checkout page when someone arrives wanting to buy votes for a
// specific entry without having browsed to it on the Top 10 page first —
// e.g. a code shared by the entrant themselves ("vote for me, code
// 0004821037"). MUST be registered before GET /entries/:id below: Express
// matches in registration order, and :id would otherwise greedily match the
// literal path segment "by-code" as if it were an id.
router.get('/entries/by-code/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!/^[0-9]{10}$/.test(code)) {
      return res.status(400).json({ error: 'Enter the entry code exactly as shown — 10 digits, numbers only.' });
    }
    const result = await pool.query(`${ENTRY_LOOKUP_SELECT} WHERE ce.entry_code = $1 AND ce.status = 'approved'`, [code]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No entry was found for that code. Please check it and try again.' });
    }
    res.json({ entry: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /entries/:id — public. Resolves an entry by its database id, for the
// checkout page when it was reached by clicking a specific entry on the Top
// 10 page (the id is already known in that case, so no code entry is needed).
router.get('/entries/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid entry id is required.' });
    const result = await pool.query(`${ENTRY_LOOKUP_SELECT} WHERE ce.id = $1 AND ce.status = 'approved'`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Entry not found.' });
    res.json({ entry: result.rows[0] });
  } catch (err) {
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

// POST /entries/:id/vote-bundle — buy extra votes at one of the fixed tier
// prices (see GET /vote-bundle-tiers). This is the Bulk Votes portal's
// entire purchase step: creates the bundle AND returns a reference + EFT
// instructions in one call (there's nothing further to configure after
// picking a tier, unlike e.g. a Highlight's duration/start-date, so
// create-then-separately-pay would just be an extra round trip for
// nothing). Fully anonymous — works with just a sessionId, no account —
// and deliberately does NOT go through POST /payments/initiate: see
// 095_vote_bundle_standalone_portal.sql for why this portal has its own
// independent payment path rather than sharing the one every other paid
// service uses.
router.post('/entries/:id/vote-bundle', async (req, res, next) => {
  try {
    const { votes, sessionId, termsAccepted } = req.body;
    if (!req.user && !sessionId) {
      return res.status(400).json({ error: 'sessionId is required for guest bundle purchases.' });
    }
    // MANDATORY Terms & Conditions gate — same rule as every other payment
    // portal on the site, enforced server-side.
    if (termsAccepted !== true) {
      return res.status(400).json({ error: 'You must read and accept the current Unplug Terms & Conditions and Cancellation, Refund & Account Credit Policy before checkout.' });
    }

    // entry_code comes back too — it becomes the visible prefix of the EFT
    // reference, so a buyer's bank statement says who they voted for.
    const entryCheck = await pool.query(
      `SELECT id, entry_code FROM competition_entries WHERE id = $1 AND status = 'approved'`,
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
    const entryCode = entryCheck.rows[0].entry_code;
    const reference = await generateVoteBundleReference(entryCode);
    const lookupToken = await generateVoteBundleLookupToken();

    const bundle = await pool.query(
      `INSERT INTO vote_bundles (entry_id, buyer_user_id, session_id, vote_count, price, reference, lookup_token, terms_accepted_at, terms_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
       RETURNING *`,
      [req.params.id, req.user ? req.user.id : null, req.user ? null : sessionId, votes, price, reference, lookupToken, String(req.body.termsVersion || '')]
    );

    res.status(201).json({
      bundle: bundle.rows[0],
      reference,
      entryCode,
      // The buyer's private handle. Named plainly so nothing downstream is
      // tempted to show it as "your reference" — that is what `reference` is.
      lookupToken,
      instructions: eftInstructions(reference,
        entryCode
          ? `Make a standard bank EFT to the account above using this exact Reference Code: ${entryCode}. It is the entry code of the contestant you are voting for. Your votes are added once our team confirms the payment, usually within one business day.`
          : 'Make a standard bank EFT to the account above using this exact Reference Code. Your votes are added once our team confirms the payment — usually within one business day.'),
    });
  } catch (err) {
    next(err);
  }
});

// GET /entries/:id/vote-bundles/:reference — public. Lets the buyer check
// their own purchase's status later (e.g. "did my votes get added yet?")
// without needing an account — same spirit as editions' reference+email
// claim, but a vote bundle has no separate content to protect behind it,
// so no email match is needed, just the reference itself.
router.get('/vote-bundles/status/:reference', async (req, res, next) => {
  try {
    const found = await resolveVoteBundle(req.params.reference);
    if (found.error) return res.status(404).json({ error: found.error });
    const result = await pool.query(
      `SELECT vb.status, vb.vote_count, vb.confirmed_at, vb.reference, ce.entry_code,
              COALESCE(p.display_name, ce.manual_name) AS display_name
         FROM vote_bundles vb
         JOIN competition_entries ce ON ce.id = vb.entry_id
         LEFT JOIN profiles p ON p.id = ce.profile_id
        WHERE vb.id = $1`,
      [found.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'No purchase found for that reference.' });
    res.json({ purchase: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PATCH /vote-bundles/:reference/proof — attaches a proof-of-payment URL
// (already uploaded via POST /uploads/proof) to a vote bundle. Deliberately
// NOT behind requireAuth, matching GET /vote-bundles/status/:reference right
// above: this whole portal has no login.
//
// What stands in for a login is the lookup token, not the Reference Code.
// The Reference Code is now the contestant's entry code, which is printed
// publicly beside every contestant — so accepting it here would let anyone
// read a code off the Top 10 page and attach a file to a stranger's order.
router.patch('/vote-bundles/:reference/proof', async (req, res, next) => {
  try {
    const url = String(req.body.url || '').trim();
    if (!url) return res.status(400).json({ error: 'A file URL is required — upload via POST /uploads/proof first.' });
    const found = await resolveVoteBundle(req.params.reference);
    if (found.error) return res.status(404).json({ error: found.error });
    const result = await pool.query(
      `UPDATE vote_bundles SET pop_url = $1 WHERE id = $2 RETURNING id, pop_url`,
      [url, found.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'No purchase found for that reference.' });
    res.json({ bundle: result.rows[0], message: 'Proof of payment attached — thank you.' });
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

    // The three placement badges, stamped with the month being published.
    //
    // Defaults to the current month because the Top 10 is published at the
    // end of each month, but can be overridden — publishing on the 1st for
    // the month just gone would otherwise stamp the wrong period, and a badge
    // that says the wrong month is worse than no badge.
    const now = new Date();
    const month = Number(req.body.awardMonth) || (now.getMonth() + 1);
    const year = Number(req.body.awardYear) || now.getFullYear();
    const PLACEMENT_BADGES = { 1: 'top10_champion', 2: 'top10_runner_up', 3: 'top10_third_place' };
    const awarded = [];

    try {
      // Republishing a corrected month must not leave the previous winner
      // holding "Champion — August". Every placement badge for THIS period is
      // cleared first, then re-awarded from the rankings that were just
      // published, so the badges can never disagree with the live Top 10.
      await pool.query(
        `DELETE FROM user_badges
          WHERE badge_code = ANY($1) AND award_month = $2 AND award_year = $3`,
        [Object.values(PLACEMENT_BADGES), month, year]
      );

      for (const r of rankings) {
        const code = PLACEMENT_BADGES[Number(r.rank)];
        if (!code) continue; // only the top three carry a badge

        // Badges belong to a USER; the rankings store a profile. A listing
        // with no owner account simply cannot be awarded one.
        const owner = await pool.query('SELECT user_id FROM profiles WHERE id = $1', [r.profileId]);
        if (!owner.rows[0] || !owner.rows[0].user_id) continue;

        await pool.query('SELECT award_badge($1, $2, $3, $4, $5, $6)', [
          owner.rows[0].user_id, code, req.user.id,
          `Top 10 placement ${r.rank} for ${month}/${year}`, month, year,
        ]);
        awarded.push({ rank: r.rank, userId: owner.rows[0].user_id, badge: code });
      }
    } catch (err) {
      // The rankings are already published and must stand. A badge failure is
      // reported, not thrown — the admin can award by hand from the Badges
      // screen rather than have the publish look like it failed.
      console.error('[top10] placement badges failed:', err.message);
      return res.json({
        message: 'Top 10 published, but the placement badges could not be awarded automatically.',
        badgeError: err.message,
      });
    }

    res.json({
      message: `Top 10 published. ${awarded.length} placement badge${awarded.length === 1 ? '' : 's'} awarded for ${month}/${year}.`,
      awardedBadges: awarded,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// TOP 10 MONTHLY RANKINGS — the permanent record of how each month finished.
//
// Separate from top10_rankings above, which holds only the current editorial
// board and is wiped on every publish. These are captured automatically at
// month end and never overwritten by the next month. See
// src/utils/top10MonthlyCapture.js.
// ---------------------------------------------------------------------------

// GET /top10/monthly-rankings — the list of captured months, newest first.
// Admin-only: this is the record-keeping view the dashboard renders.
router.get('/top10/monthly-rankings', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.period_year, c.period_month, c.entry_count, c.total_votes,
              c.captured_at, c.captured_auto,
              u.email AS captured_by_email,
              to_char(make_date(c.period_year, c.period_month, 1), 'FMMonth YYYY') AS period_label,
              -- A month in which nobody voted has NO winner. The board is
              -- still ranked, because the ordering rules always produce one,
              -- but rank 1 on an all-zero board was decided by entry order and
              -- presenting that person as the winner would be inventing a
              -- result. This is not hypothetical: the first automatic capture
              -- ran for a month whose votes all belong to the current period.
              CASE WHEN c.total_votes > 0 THEN
                (SELECT display_name FROM top10_monthly_rankings r
                  WHERE r.period_year = c.period_year AND r.period_month = c.period_month
                    AND r.rank = 1)
              END AS winner_name
         FROM top10_monthly_captures c
         LEFT JOIN users u ON u.id = c.captured_by
        ORDER BY c.period_year DESC, c.period_month DESC`
    );
    res.json({ months: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /top10/monthly-rankings/:year/:month — one month's full board, #1 down
// to the last spot.
router.get('/top10/monthly-rankings/:year/:month', requireRole('admin'), async (req, res, next) => {
  try {
    const year = Number(req.params.year);
    const month = Number(req.params.month);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      return res.status(400).json({ error: 'Give a valid year and a month from 1 to 12.' });
    }

    const capture = await pool.query(
      `SELECT period_year, period_month, entry_count, total_votes, captured_at, captured_auto,
              to_char(make_date(period_year, period_month, 1), 'FMMonth YYYY') AS period_label
         FROM top10_monthly_captures WHERE period_year = $1 AND period_month = $2`,
      [year, month]
    );
    if (capture.rows.length === 0) {
      return res.status(404).json({ error: 'That month has not been captured.' });
    }

    const rankings = await pool.query(
      `SELECT rank, entry_id, profile_id, display_name, entry_code, category,
              image_url, profile_slug, vote_count
         FROM top10_monthly_rankings
        WHERE period_year = $1 AND period_month = $2
        ORDER BY rank ASC`,
      [year, month]
    );

    res.json({ month: capture.rows[0], rankings: rankings.rows });
  } catch (err) {
    next(err);
  }
});

// POST /top10/capture-month — run the capture by hand.
//
// The hourly job does this on its own; this exists so an admin can close a
// month early, re-run one that was captured before a correction was made
// (force), or capture a month the site was asleep through.
router.post('/top10/capture-month', requireRole('admin'), async (req, res, next) => {
  try {
    // Defaults to the month just gone, which is what "close last month" means
    // and what the button on the dashboard does.
    const prev = await previousPeriod();
    const year = Number(req.body.year) || prev.year;
    const month = Number(req.body.month) || prev.month;
    if (month < 1 || month > 12) {
      return res.status(400).json({ error: 'Month must be from 1 to 12.' });
    }

    const cur = await currentPeriod();
    if (year > cur.year || (year === cur.year && month > cur.month)) {
      return res.status(400).json({ error: 'That month has not happened yet.' });
    }

    const result = await captureMonth({
      year, month, adminUserId: req.user.id, auto: false,
      force: req.body.force === true,
    });

    if (!result.captured && result.reason === 'already-captured') {
      return res.status(409).json({
        error: `${month}/${year} was already captured on ${new Date(result.capturedAt).toLocaleString('en-ZA')}. Re-capture it only if the votes have since been corrected.`,
        alreadyCaptured: true, ...result,
      });
    }
    if (!result.captured && result.reason === 'no-top10-competition') {
      return res.status(400).json({ error: 'There is no Top 10 competition to capture.' });
    }

    await logActivity(req.user.id, 'top10_month_captured',
      `Captured the Top 10 for ${month}/${year}: ${result.entryCount} entries, `
      + `${result.totalVotes} votes, ${result.awardedBadges.length} placement badges`).catch(() => {});

    res.json({
      message: `${month}/${year} captured — ${result.entryCount} contestant${result.entryCount === 1 ? '' : 's'} recorded`
        + (result.awardedBadges.length ? `, ${result.awardedBadges.length} placement badge${result.awardedBadges.length === 1 ? '' : 's'} awarded.` : '.'),
      ...result,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Hall of Fame — past competition winners (admin-entered). Uses a distinct
// /hall-of-fame path so it doesn't collide with /competitions/:slug.
// ---------------------------------------------------------------------------

// GET /hall-of-fame — public, newest year first. The admin dashboard's
// Hall of Fame management UI reuses this same route rather than a
// separate admin-only one, so linked_user_id (a plain internal id, not
// contact information) is included here too — the win itself also shows
// under the winner's real profile via get_public_profile_analytics()
// (competitions_won).
router.get('/hall-of-fame', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, year, name, title, photo_url, description, linked_user_id
       FROM hall_of_fame ORDER BY year DESC NULLS LAST, created_at DESC`
    );
    res.json({ winners: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /hall-of-fame — admin adds a past winner. linkedUserId is
// optional — existing/typical entries stay text-only (a name typed in),
// same as before this was added; an admin sets it only when they know
// which real account the win belongs to.
router.post('/hall-of-fame', requireRole('admin'), async (req, res, next) => {
  try {
    const { year, name, title, photoUrl, description, linkedUserId } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required.' });
    const result = await pool.query(
      `INSERT INTO hall_of_fame (year, name, title, photo_url, description, linked_user_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [year ? parseInt(year, 10) : null, name.trim(), (title || '').trim() || null,
       (photoUrl || '').trim() || null, (description || '').trim() || null,
       linkedUserId ? parseInt(linkedUserId, 10) : null]
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
    const map = { year: 'year', name: 'name', title: 'title', photoUrl: 'photo_url', description: 'description', linkedUserId: 'linked_user_id' };
    const sets = [];
    const values = [];
    for (const [bodyKey, column] of Object.entries(map)) {
      if (req.body[bodyKey] !== undefined) {
        const raw = req.body[bodyKey];
        values.push((bodyKey === 'year' || bodyKey === 'linkedUserId')
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

// ---------------------------------------------------------------------------
// Bulk Votes admin queue (Payment Portal Redevelopment Phase 2) — its own
// dedicated approve/reject/reverse, independent of the shared /payments
// admin routes, matching the standalone EFT flow above.
// ---------------------------------------------------------------------------

// GET /admin/vote-bundles?status=&q=&from=&to= — search by contestant name,
// reference or entry code, filter by status and/or date range.
// POST /admin/entries/:id/adjust-votes — corrects an entry's vote total.
//
// Recorded as a votes row rather than by rewriting a stored total, because
// there is no stored total: every count on the site is SUM(bundle_size) over
// votes. Writing an adjustment row keeps that one source of truth, keeps the
// correction reversible, and leaves it visible in the same history as every
// real vote instead of a number silently changing overnight.
//
// The votes table requires a voter or a session, so each adjustment carries
// its own unique synthetic session id — which also means the per-voter unique
// indexes from 098 can never collide with an admin correction.
router.post('/admin/entries/:id/adjust-votes', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const delta = Number(req.body.delta);
    const reason = String(req.body.reason || '').trim();
    if (!Number.isInteger(delta) || delta === 0) {
      return res.status(400).json({ error: 'Enter a whole number of votes to add or remove — for example 25, or -25.' });
    }
    if (!reason) {
      return res.status(400).json({ error: 'A reason is required, so the correction can be explained later.' });
    }

    // The correction row this inserts is stamped with the CURRENT month (the
    // column default), so it lands on the board the admin is looking at. The
    // guard below therefore has to be against that same month's total, not the
    // all-time one — otherwise -50 could be accepted against a healthy
    // all-time figure and still drive this month's public number negative.
    const period = (await currentPeriod()).period;
    const entry = await pool.query(
      `SELECT ce.id, ce.entry_code, comp.slug AS competition_slug,
              COALESCE(p.display_name, ce.manual_name) AS name,
              COALESCE((SELECT SUM(bundle_size) FROM votes
                         WHERE entry_id = ce.id AND vote_period = $2::date), 0) AS month_total,
              COALESCE((SELECT SUM(bundle_size) FROM votes
                         WHERE entry_id = ce.id), 0) AS all_time_total
         FROM competition_entries ce
         LEFT JOIN competitions comp ON comp.id = ce.competition_id
         LEFT JOIN profiles p ON p.id = ce.profile_id
        WHERE ce.id = $1`,
      [id, period]
    );
    if (entry.rows.length === 0) return res.status(404).json({ error: 'Entry not found.' });

    const monthly = isMonthlyReset(entry.rows[0].competition_slug);
    const before = Number(monthly ? entry.rows[0].month_total : entry.rows[0].all_time_total);
    // An adjustment must never drive a contestant's public total negative —
    // that would show as a negative number on the leaderboard.
    if (before + delta < 0) {
      return res.status(400).json({ error: `That would take the total below zero. This entry currently has ${before} vote${before === 1 ? '' : 's'}.` });
    }

    await pool.query(
      `INSERT INTO votes (entry_id, session_id, bundle_size, vote_day)
       VALUES ($1, $2, $3, NULL)`,
      [id, `admin-adjust:${crypto.randomUUID()}`, delta]
    );

    const after = before + delta;
    await logActivity(req.user.id, 'entry_votes_adjusted',
      `Adjusted votes for ${entry.rows[0].name || 'entry #' + id}`
      + (entry.rows[0].entry_code ? ` (entry code ${entry.rows[0].entry_code})` : '')
      + ` by ${delta > 0 ? '+' : ''}${delta}: ${before} -> ${after}. Reason: ${reason}`).catch(() => {});

    res.json({
      adjusted: true, before, after, delta,
      message: `Vote total changed from ${before} to ${after}.`,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/vote-bundles', requireRole('admin'), async (req, res, next) => {
  try {
    const conditions = [];
    const values = [];
    if (req.query.status) { values.push(req.query.status); conditions.push(`vb.status = $${values.length}`); }
    if (req.query.from) { values.push(req.query.from); conditions.push(`vb.created_at >= $${values.length}`); }
    if (req.query.to) { values.push(req.query.to); conditions.push(`vb.created_at <= $${values.length}`); }
    if (req.query.q) {
      values.push(`%${req.query.q}%`);
      conditions.push(`(vb.reference ILIKE $${values.length} OR ce.entry_code ILIKE $${values.length} OR COALESCE(p.display_name, ce.manual_name) ILIKE $${values.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT vb.id, vb.vote_count, vb.price, vb.status, vb.reference, vb.session_id, vb.buyer_user_id,
              vb.created_at, vb.confirmed_at, vb.rejected_at,
              ce.entry_code, COALESCE(p.display_name, ce.manual_name) AS contestant_name,
              u.email AS buyer_email
         FROM vote_bundles vb
         JOIN competition_entries ce ON ce.id = vb.entry_id
         LEFT JOIN profiles p ON p.id = ce.profile_id
         LEFT JOIN users u ON u.id = vb.buyer_user_id
         ${where}
        ORDER BY vb.created_at DESC
        LIMIT 500`,
      values
    );
    res.json({ bundles: result.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/vote-bundles/:id/approve — confirms EFT payment and
// allocates the votes as their own votes row (see the insert below).
//
// This used to merge into the buyer's existing free-vote row, because the
// old one-row-per-voter unique indexes left nowhere else to put them. Daily
// voting removed that limitation and made merging actively wrong, so the
// bundle now stands on its own. Totals are unaffected either way: every
// caller sums bundle_size rather than reading a stored counter.
router.patch('/admin/vote-bundles/:id/approve', requireRole('admin'), async (req, res, next) => {
  try {
    const bundle = await pool.query(`SELECT * FROM vote_bundles WHERE id = $1`, [req.params.id]);
    if (bundle.rows.length === 0) return res.status(404).json({ error: 'Bundle not found.' });
    const b = bundle.rows[0];
    if (b.status !== 'awaiting_payment') {
      return res.status(400).json({ error: `This bundle is already ${b.status}.` });
    }

    // The bundle gets its OWN votes row, tagged with vote_bundle_id, rather
    // than being merged into the buyer's free-vote row. Under daily voting a
    // voter has one row PER DAY, so there is no single row left to merge
    // into — and a dedicated row is what lets reverse below subtract exactly
    // this bundle instead of guessing. Paid rows are excluded from the
    // uniqueness indexes (098_daily_voting.sql), so no ON CONFLICT is needed.
    await pool.query(
      `INSERT INTO votes (entry_id, voter_user_id, session_id, bundle_size, vote_bundle_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [b.entry_id, b.buyer_user_id || null, b.buyer_user_id ? null : b.session_id, b.vote_count, b.id]
    );

    const updated = await pool.query(
      `UPDATE vote_bundles SET status = 'confirmed', confirmed_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    logActivity(req.user.id, 'vote_bundle_approved', `Bundle #${b.id} (${b.reference}) — ${b.vote_count} votes`);
    res.json({ bundle: updated.rows[0], message: `${b.vote_count} votes added.` });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/vote-bundles/:id/reject — no votes ever allocated, so this
// is just a status flip, unlike reverse below.
router.patch('/admin/vote-bundles/:id/reject', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE vote_bundles SET status = 'rejected', rejected_at = now()
        WHERE id = $1 AND status = 'awaiting_payment' RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(400).json({ error: 'Only a bundle still awaiting payment can be rejected.' });
    logActivity(req.user.id, 'vote_bundle_rejected', `Bundle #${result.rows[0].id} (${result.rows[0].reference})`);
    res.json({ bundle: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /admin/vote-bundles/:id/reverse — undoes a mistaken/fraudulent
// approval. Now exact for anything approved since 098_daily_voting.sql: the
// bundle owns its votes row, so removing that row removes precisely this
// bundle's votes and nothing else. Older merged bundles still fall back to
// subtraction, which stays "best effort" for the reason the merge design
// always had — a voter's free vote and their bundles shared one row.
router.post('/admin/vote-bundles/:id/reverse', requireRole('admin'), async (req, res, next) => {
  try {
    const bundle = await pool.query(`SELECT * FROM vote_bundles WHERE id = $1`, [req.params.id]);
    if (bundle.rows.length === 0) return res.status(404).json({ error: 'Bundle not found.' });
    const b = bundle.rows[0];
    if (b.status !== 'confirmed') {
      return res.status(400).json({ error: 'Only a confirmed bundle has votes to reverse.' });
    }

    // Bundles approved since 098_daily_voting.sql own their votes row, so the
    // reversal is exact: delete that row and precisely this bundle's votes go.
    const owned = await pool.query(`DELETE FROM votes WHERE vote_bundle_id = $1 RETURNING id`, [b.id]);

    // Bundles approved BEFORE that migration were merged into the buyer's
    // single free-vote row, so they must still be unwound by subtraction.
    // Safe to scope by voter here precisely because the old schema allowed
    // only one such row per voter per entry — the very constraint that made
    // merging necessary also makes this WHERE unambiguous for that old data.
    if (owned.rowCount === 0) {
      if (b.buyer_user_id) {
        await pool.query(
          `UPDATE votes SET bundle_size = GREATEST(bundle_size - $1, 0)
            WHERE entry_id = $2 AND voter_user_id = $3 AND vote_bundle_id IS NULL AND vote_day IS NULL`,
          [b.vote_count, b.entry_id, b.buyer_user_id]
        );
      } else {
        await pool.query(
          `UPDATE votes SET bundle_size = GREATEST(bundle_size - $1, 0)
            WHERE entry_id = $2 AND session_id = $3 AND vote_bundle_id IS NULL AND vote_day IS NULL`,
          [b.vote_count, b.entry_id, b.session_id]
        );
      }
    }

    const updated = await pool.query(`UPDATE vote_bundles SET status = 'reversed' WHERE id = $1 RETURNING *`, [req.params.id]);
    logActivity(req.user.id, 'vote_bundle_reversed', `Bundle #${b.id} (${b.reference}) — ${b.vote_count} votes removed`);
    res.json({ bundle: updated.rows[0], message: `${b.vote_count} votes reversed.` });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
