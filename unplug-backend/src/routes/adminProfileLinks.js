// ADMIN — linking a Directory listing to a member's Passport account, and
// linking a sales consultant record to the account they sign in with.
//
// Both are the same shape of problem: a record that exists in its own right,
// captured before the person had an account, which now needs to be associated
// with one. In both cases the two things stay separate records — this creates
// a relationship, never a merge.
//
// Read 107_profile_link_history.sql for why the Directory link is a transfer
// of profiles.user_id with a history table rather than a new join table.
const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');

const router = express.Router();

// GET /admin/links/directory?q= — listings, with who owns each one now.
//
// Returns ALL listings, including ones with no owner at all. That used to be
// impossible (profiles.user_id was NOT NULL) but an admin can now create a
// listing directly with nobody behind it yet (177_admin_created_profiles.sql)
// — those show up here with owner_email null, and "Link to member…" is how
// an admin gives one an owner for the first time, not just how they move it
// from a placeholder account to the real one.
router.get('/directory', requireRole('admin'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const values = [];
    let where = '';
    if (q) {
      values.push(`%${q}%`);
      where = `WHERE p.display_name ILIKE $1 OR p.slug ILIKE $1 OR u.email ILIKE $1`;
    }
    const result = await pool.query(
      `SELECT p.id, p.display_name, p.slug, p.package_tier, p.status, p.user_id,
              u.email AS owner_email, u.full_name AS owner_name,
              (SELECT COUNT(*) FROM profile_link_history h WHERE h.profile_id = p.id) AS link_changes
         FROM profiles p
         LEFT JOIN users u ON u.id = p.user_id
         ${where}
        ORDER BY p.display_name
        LIMIT 300`,
      values
    );
    res.json({ listings: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /admin/links/members?q= — accounts to link TO, each flagged with
// whether it already holds a listing.
//
// That flag matters: profiles.user_id is UNIQUE, so an account that already
// has a listing cannot receive a second one. Showing it here means the admin
// finds out while choosing, not after pressing the button.
router.get('/members', requireRole('admin'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const values = [];
    let where = '';
    if (q) {
      values.push(`%${q}%`);
      where = `WHERE u.email ILIKE $1 OR u.full_name ILIKE $1`;
    }
    const result = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.role,
              p.id AS existing_profile_id, p.display_name AS existing_profile_name
         FROM users u
         LEFT JOIN profiles p ON p.user_id = u.id
         ${where}
        ORDER BY u.email
        LIMIT 300`,
      values
    );
    res.json({ members: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /admin/links/directory/:profileId/history — who this listing has
// belonged to, most recent first. This is what makes a wrong link fixable.
router.get('/directory/:profileId/history', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT h.id, h.created_at, h.reason,
              h.from_user_id, fu.email AS from_email,
              h.to_user_id, tu.email AS to_email,
              au.email AS admin_email
         FROM profile_link_history h
         LEFT JOIN users fu ON fu.id = h.from_user_id
         LEFT JOIN users tu ON tu.id = h.to_user_id
         LEFT JOIN users au ON au.id = h.admin_user_id
        WHERE h.profile_id = $1
        ORDER BY h.created_at DESC, h.id DESC
        LIMIT 100`,
      [Number(req.params.profileId)]
    );
    res.json({ history: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /admin/links/directory/:profileId { userId, reason }
//
// Moves one Directory listing to one member account. Everything happens in a
// single transaction: the listing moves and the history row is written
// together, or neither happens. A transfer with no record of where it came
// from is not reversible, and this is somebody's paid listing.
router.post('/directory/:profileId', requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const profileId = Number(req.params.profileId);
    const userId = Number(req.body.userId);
    const reason = String(req.body.reason || '').trim();
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Choose the member account to link this listing to.' });
    }

    await client.query('BEGIN');

    // FOR UPDATE so two admins linking at once can't both pass the
    // already-has-a-listing check below and leave one of them with a
    // duplicate-key error instead of a readable message.
    const profile = await client.query(
      'SELECT id, user_id, display_name FROM profiles WHERE id = $1 FOR UPDATE', [profileId]
    );
    if (profile.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That Directory listing no longer exists.' });
    }
    const currentOwner = profile.rows[0].user_id;

    const user = await client.query('SELECT id, email FROM users WHERE id = $1', [userId]);
    if (user.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That member account no longer exists.' });
    }

    if (currentOwner === userId) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `"${profile.rows[0].display_name}" is already linked to ${user.rows[0].email}.` });
    }

    // One listing per account, enforced by idx_profiles_user_id. Caught here
    // so the admin gets the name of the listing that is in the way instead of
    // a database error.
    const clash = await client.query(
      'SELECT id, display_name FROM profiles WHERE user_id = $1 AND id <> $2', [userId, profileId]
    );
    if (clash.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `${user.rows[0].email} is already linked to the listing "${clash.rows[0].display_name}". `
             + 'An account can hold one Directory listing at a time — unlink that one first, or pick a different account.',
      });
    }

    await client.query('UPDATE profiles SET user_id = $1, updated_at = now() WHERE id = $2', [userId, profileId]);
    await client.query(
      `INSERT INTO profile_link_history (profile_id, from_user_id, to_user_id, admin_user_id, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [profileId, currentOwner, userId, req.user.id, reason || null]
    );

    await client.query('COMMIT');

    await logActivity(req.user.id, 'directory_listing_linked',
      `Linked Directory listing "${profile.rows[0].display_name}" (#${profileId}) to ${user.rows[0].email}`
      + ` (previously user #${currentOwner})${reason ? '. Reason: ' + reason : ''}`).catch(() => {});

    res.json({
      linked: true,
      message: `"${profile.rows[0].display_name}" is now linked to ${user.rows[0].email}. `
             + 'Their Passport profile and this Directory listing remain separate records.',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// POST /admin/links/directory/:profileId/revert { reason }
//
// Puts a listing back where the last link took it from. This is the "undo"
// for picking the wrong account. A revert that lands on NULL is a real,
// legal outcome now: a listing an admin created standalone
// (177_admin_created_profiles.sql) and then linked to a member for the first
// time has "no owner" as its true previous state, not a deleted account.
router.post('/directory/:profileId/revert', requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const profileId = Number(req.params.profileId);
    await client.query('BEGIN');

    const last = await client.query(
      `SELECT from_user_id FROM profile_link_history
        WHERE profile_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [profileId]
    );
    if (last.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'This listing has never been re-linked, so there is nothing to undo.' });
    }
    const previousOwner = last.rows[0].from_user_id;

    const profile = await client.query(
      'SELECT id, user_id, display_name FROM profiles WHERE id = $1 FOR UPDATE', [profileId]
    );
    if (profile.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That Directory listing no longer exists.' });
    }

    if (previousOwner !== null) {
      const clash = await client.query(
        'SELECT display_name FROM profiles WHERE user_id = $1 AND id <> $2', [previousOwner, profileId]
      );
      if (clash.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `The previous owner now holds the listing "${clash.rows[0].display_name}", so this one cannot go back to them.` });
      }
    }

    await client.query('UPDATE profiles SET user_id = $1, updated_at = now() WHERE id = $2', [previousOwner, profileId]);
    await client.query(
      `INSERT INTO profile_link_history (profile_id, from_user_id, to_user_id, admin_user_id, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [profileId, profile.rows[0].user_id, previousOwner, req.user.id, String(req.body.reason || 'Reverted').trim()]
    );
    await client.query('COMMIT');

    await logActivity(req.user.id, 'directory_listing_link_reverted',
      `Reverted Directory listing "${profile.rows[0].display_name}" (#${profileId}) to user #${previousOwner}`).catch(() => {});

    res.json({ reverted: true, message: 'Listing returned to its previous account.' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// SALES CONSULTANTS
//
// sales_consultants.user_id already exists (046_consultant_role.sql), which
// also ran a one-time backfill matching consultants to accounts BY EMAIL.
// That is a verified identifier, so it stands — but it means some links were
// made without an admin ever choosing them, and there was no way to see or
// correct one. That is what these two routes are for.
//
// The consultant record and the user account stay separate: linking sets a
// foreign key, it does not fold the consultant's commission data into the
// account or vice versa.
// ---------------------------------------------------------------------------

// GET /admin/links/consultants?q=
router.get('/consultants', requireRole('admin'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const values = [];
    let where = '';
    if (q) {
      values.push(`%${q}%`);
      where = `WHERE c.name ILIKE $1 OR c.email ILIKE $1 OR u.email ILIKE $1`;
    }
    const result = await pool.query(
      `SELECT c.id, c.name, c.email, c.active, c.commission_pct, c.user_id,
              u.email AS linked_email, u.full_name AS linked_name, u.role AS linked_role
         FROM sales_consultants c
         LEFT JOIN users u ON u.id = c.user_id
         ${where}
        ORDER BY c.name
        LIMIT 300`,
      values
    );
    res.json({ consultants: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /admin/links/consultants/:id { userId | null }
//
// userId null unlinks. Unlinking IS allowed here, unlike the Directory case,
// because sales_consultants.user_id is nullable — a consultant record with no
// account is a perfectly normal state (someone on the list who has not signed
// up yet), not an orphan.
router.post('/consultants/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const raw = req.body.userId;
    const userId = raw === null || raw === undefined || raw === '' ? null : Number(raw);

    const consultant = await pool.query('SELECT id, name, user_id FROM sales_consultants WHERE id = $1', [id]);
    if (consultant.rows.length === 0) return res.status(404).json({ error: 'That consultant record no longer exists.' });

    if (userId !== null) {
      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: 'Choose the member account to link this consultant to.' });
      }
      const user = await pool.query('SELECT id, email FROM users WHERE id = $1', [userId]);
      if (user.rows.length === 0) return res.status(404).json({ error: 'That member account no longer exists.' });

      // No unique index backs this column, so a duplicate link would simply
      // succeed and quietly attribute one person's referrals to two records.
      const clash = await pool.query(
        'SELECT id, name FROM sales_consultants WHERE user_id = $1 AND id <> $2', [userId, id]
      );
      if (clash.rows.length > 0) {
        return res.status(409).json({
          error: `${user.rows[0].email} is already linked to the consultant record "${clash.rows[0].name}". Unlink that one first.`,
        });
      }
    }

    await pool.query('UPDATE sales_consultants SET user_id = $1 WHERE id = $2', [userId, id]);
    await logActivity(req.user.id, userId === null ? 'consultant_unlinked' : 'consultant_linked',
      `${userId === null ? 'Unlinked' : 'Linked'} consultant "${consultant.rows[0].name}" (#${id})`
      + (userId === null ? ` from user #${consultant.rows[0].user_id}` : ` to user #${userId}`)).catch(() => {});

    res.json({
      linked: userId !== null,
      message: userId === null
        ? 'Consultant unlinked. Their record and past commissions are unchanged.'
        : 'Consultant linked to that account.',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
