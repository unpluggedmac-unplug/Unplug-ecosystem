// MY UNPLUG — the member's community identity (105_my_unplug_profiles.sql).
//
// Separate from the Directory by design: see the migration header. Nothing in
// this file reads or writes `profiles`, and no route here can create a
// Directory listing.
//
// PRIVACY MODEL. The public profile route selects an explicit column list
// from my_unplug_profiles only. It never joins `users`, so email, phone,
// password_hash and role are not reachable from it even by accident — the
// table simply holds no contact data. See PUBLIC_COLUMNS below.

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Handles that would be confusing, impersonating, or would collide with a
// future /my-unplug/<word> route. Checked case-insensitively.
const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'unplug', 'unplugnews', 'official', 'support',
  'help', 'api', 'www', 'root', 'system', 'moderator', 'mod', 'staff',
  'me', 'you', 'null', 'undefined', 'settings', 'login', 'logout', 'signup',
  'register', 'profile', 'profiles', 'search', 'discover', 'directory',
]);

const USERNAME_RE = /^[A-Za-z0-9_]{3,30}$/;
const ABOUT_MAX_WORDS = 50;

// Exactly what a stranger may see. Kept as one constant so a future column
// added to the table is NOT published by accident — it has to be added here
// deliberately.
const PUBLIC_COLUMNS = `user_id, username, display_name, about_me, avatar_url,
                        country, province, city, published_at`;

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function validateUsername(raw) {
  const username = String(raw || '').trim();
  if (!USERNAME_RE.test(username)) {
    return { error: 'Your @username must be 3-30 characters, using only letters, numbers and underscores.' };
  }
  if (RESERVED_USERNAMES.has(username.toLowerCase())) {
    return { error: `"@${username}" is reserved. Please choose another.` };
  }
  return { username };
}

// Loads the three taxonomy selections for a profile in one round trip.
async function loadTaxonomies(userId) {
  const [interests, skills, purposes] = await Promise.all([
    pool.query(`SELECT i.key, i.label FROM mu_profile_interests p JOIN mu_interests i ON i.key = p.key WHERE p.user_id = $1 ORDER BY i.sort_order`, [userId]),
    pool.query(`SELECT s.key, s.label FROM mu_profile_skills p JOIN mu_skills s ON s.key = p.key WHERE p.user_id = $1 ORDER BY s.sort_order`, [userId]),
    pool.query(`SELECT u.key, u.label FROM mu_profile_purposes p JOIN mu_purposes u ON u.key = p.key WHERE p.user_id = $1 ORDER BY u.sort_order`, [userId]),
  ]);
  return { interests: interests.rows, skills: skills.rows, purposes: purposes.rows };
}

// Weighted so the fields that actually make a profile discoverable are worth
// the most. Returned rather than stored: recomputing is cheap and a stored
// percentage would drift the moment anything changed.
function computeCompletion(profile, tax) {
  const steps = [
    { key: 'username', label: 'Choose your @username', weight: 15, done: !!profile.username },
    { key: 'display_name', label: 'Add your display name', weight: 15, done: !!profile.display_name },
    { key: 'avatar', label: 'Upload a profile picture', weight: 15, done: !!profile.avatar_url },
    { key: 'about', label: 'Write your About Me', weight: 15, done: !!(profile.about_me || '').trim() },
    { key: 'interests', label: 'Pick your interests', weight: 15, done: tax.interests.length > 0 },
    { key: 'skills', label: 'Add your skills', weight: 15, done: tax.skills.length > 0 },
    { key: 'purpose', label: 'Set what you are plugging into', weight: 10, done: tax.purposes.length > 0 },
  ];
  const percent = steps.filter((s) => s.done).reduce((n, s) => n + s.weight, 0);
  return { percent, steps: steps.map(({ key, label, weight, done }) => ({ key, label, weight, done })) };
}

// ---------------------------------------------------------------------------
// Taxonomy — public. The multi-select UIs read these, so adding a row in the
// database makes it selectable with no frontend change.
// ---------------------------------------------------------------------------
router.get('/taxonomy', async (req, res, next) => {
  try {
    const [interests, skills, purposes] = await Promise.all([
      pool.query('SELECT key, label FROM mu_interests WHERE is_active ORDER BY sort_order, label'),
      pool.query('SELECT key, label FROM mu_skills WHERE is_active ORDER BY sort_order, label'),
      pool.query('SELECT key, label FROM mu_purposes WHERE is_active ORDER BY sort_order, label'),
    ]);
    res.json({ interests: interests.rows, skills: skills.rows, purposes: purposes.rows });
  } catch (err) { next(err); }
});

// GET /my-unplug/username-available?username=x — so the form can say so
// before the member fills in everything else and hits a collision on save.
router.get('/username-available', async (req, res, next) => {
  try {
    const check = validateUsername(req.query.username);
    if (check.error) return res.json({ available: false, reason: check.error });
    const taken = await pool.query(
      'SELECT 1 FROM my_unplug_profiles WHERE LOWER(username) = LOWER($1)', [check.username]
    );
    res.json({
      available: taken.rowCount === 0,
      reason: taken.rowCount ? 'That @username is already taken.' : null,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// The member's own profile (includes unpublished state — this is their view).
// ---------------------------------------------------------------------------
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM my_unplug_profiles WHERE user_id = $1', [req.user.id]);
    if (!result.rowCount) {
      return res.json({ profile: null, taxonomies: { interests: [], skills: [], purposes: [] }, completion: null });
    }
    const profile = result.rows[0];
    const taxonomies = await loadTaxonomies(req.user.id);
    res.json({ profile, taxonomies, completion: computeCompletion(profile, taxonomies) });
  } catch (err) { next(err); }
});

// PUT /my-unplug/me — create or update. Deliberately does NOT publish: a
// member choosing a username is not the same as consenting to a public page,
// so publishing is its own explicit action below.
router.put('/me', requireAuth, async (req, res, next) => {
  try {
    const b = req.body || {};
    const check = validateUsername(b.username);
    if (check.error) return res.status(400).json({ error: check.error });
    const displayName = String(b.displayName || '').trim();
    if (!displayName) return res.status(400).json({ error: 'Add a display name — this is the name people see.' });

    const aboutMe = String(b.aboutMe || '').trim();
    if (countWords(aboutMe) > ABOUT_MAX_WORDS) {
      return res.status(400).json({ error: `About Me is limited to ${ABOUT_MAX_WORDS} words — yours is ${countWords(aboutMe)}.` });
    }

    const result = await pool.query(
      `INSERT INTO my_unplug_profiles
         (user_id, username, display_name, about_me, avatar_url, country, province, city)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id) DO UPDATE SET
         username = EXCLUDED.username, display_name = EXCLUDED.display_name,
         about_me = EXCLUDED.about_me, avatar_url = EXCLUDED.avatar_url,
         country = EXCLUDED.country, province = EXCLUDED.province, city = EXCLUDED.city,
         updated_at = now()
       RETURNING *`,
      [
        req.user.id, check.username, displayName.slice(0, 60),
        aboutMe || null, b.avatarUrl || null,
        b.country || null, b.province || null, b.city || null,
      ]
    );
    const taxonomies = await loadTaxonomies(req.user.id);
    res.json({ profile: result.rows[0], taxonomies, completion: computeCompletion(result.rows[0], taxonomies) });
  } catch (err) {
    // The lowercase unique index is the real guard against a race between two
    // people claiming the same handle — the availability check above is only
    // a convenience.
    if (err.code === '23505') return res.status(409).json({ error: 'That @username was just taken. Please choose another.' });
    next(err);
  }
});

// PUT /my-unplug/me/taxonomy — replace the member's selections wholesale.
// Body: { interests: [...keys], skills: [...], purposes: [...] } — any key
// omitted is left untouched, so the three multi-selects can save independently.
router.put('/me/taxonomy', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const exists = await client.query('SELECT 1 FROM my_unplug_profiles WHERE user_id = $1', [req.user.id]);
    if (!exists.rowCount) return res.status(400).json({ error: 'Create your My Unplug profile before adding interests or skills.' });

    const sets = [
      { field: 'interests', table: 'mu_profile_interests', source: 'mu_interests' },
      { field: 'skills', table: 'mu_profile_skills', source: 'mu_skills' },
      { field: 'purposes', table: 'mu_profile_purposes', source: 'mu_purposes' },
    ];

    await client.query('BEGIN');
    for (const { field, table, source } of sets) {
      if (!Array.isArray(req.body[field])) continue;
      const keys = [...new Set(req.body[field].map((k) => String(k).trim()).filter(Boolean))];
      // Only keys that exist AND are active — a disabled taxonomy row should
      // not become newly selectable through a hand-crafted request.
      const valid = keys.length
        ? (await client.query(`SELECT key FROM ${source} WHERE key = ANY($1::text[]) AND is_active`, [keys])).rows.map((r) => r.key)
        : [];
      await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [req.user.id]);
      for (const key of valid) {
        await client.query(`INSERT INTO ${table} (user_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [req.user.id, key]);
      }
    }
    await client.query('COMMIT');

    const profile = (await pool.query('SELECT * FROM my_unplug_profiles WHERE user_id = $1', [req.user.id])).rows[0];
    const taxonomies = await loadTaxonomies(req.user.id);
    res.json({ taxonomies, completion: computeCompletion(profile, taxonomies) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Opt-in publishing. Separate from saving, and reversible at any time.
// ---------------------------------------------------------------------------
router.post('/me/publish', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM my_unplug_profiles WHERE user_id = $1', [req.user.id]);
    if (!result.rowCount) return res.status(400).json({ error: 'Create your My Unplug profile first.' });

    // A published profile with no name or handle would be a broken public
    // page, so the minimum is enforced here rather than discovered by a
    // visitor. Everything else stays optional.
    const p = result.rows[0];
    if (!p.username || !p.display_name) {
      return res.status(400).json({ error: 'Add your @username and display name before publishing.' });
    }

    const updated = await pool.query(
      `UPDATE my_unplug_profiles
          SET is_published = true, published_at = COALESCE(published_at, now()), updated_at = now()
        WHERE user_id = $1 RETURNING *`,
      [req.user.id]
    );
    res.json({
      profile: updated.rows[0],
      message: `Your profile is live at /my-unplug/${updated.rows[0].username}.`,
    });
  } catch (err) { next(err); }
});

router.post('/me/unpublish', requireAuth, async (req, res, next) => {
  try {
    // published_at is kept, not cleared — it records when it FIRST went live,
    // so re-publishing later doesn't look like a brand new profile.
    const updated = await pool.query(
      `UPDATE my_unplug_profiles SET is_published = false, updated_at = now()
        WHERE user_id = $1 RETURNING *`,
      [req.user.id]
    );
    if (!updated.rowCount) return res.status(404).json({ error: 'You do not have a My Unplug profile.' });
    res.json({ profile: updated.rows[0], message: 'Your profile is now private. Only you can see it.' });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// The public profile. Unpublished profiles 404 rather than 403 — telling a
// stranger "this exists but is private" leaks that the handle is taken and
// who has it.
// ---------------------------------------------------------------------------
router.get('/u/:username', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ${PUBLIC_COLUMNS} FROM my_unplug_profiles
        WHERE LOWER(username) = LOWER($1) AND is_published = true`,
      [String(req.params.username || '').trim()]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'No published profile found for that @username.' });
    const profile = result.rows[0];
    const taxonomies = await loadTaxonomies(profile.user_id);
    res.json({ profile, taxonomies });
  } catch (err) { next(err); }
});

// GET /my-unplug/published — the public list, for a future Members page.
router.get('/published', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 24, 60);
    const result = await pool.query(
      `SELECT ${PUBLIC_COLUMNS} FROM my_unplug_profiles
        WHERE is_published = true ORDER BY published_at DESC NULLS LAST, user_id DESC LIMIT $1`,
      [limit]
    );
    res.json({ profiles: result.rows });
  } catch (err) { next(err); }
});

// Shared with the admin analytics (routes/adminMyUnplug.js) so the
// completion percentage an admin sees is the same number the member sees.
// Two copies of a scoring rule drift the first time one is tweaked.
router.computeCompletion = computeCompletion;
router.loadTaxonomies = loadTaxonomies;

module.exports = router;
