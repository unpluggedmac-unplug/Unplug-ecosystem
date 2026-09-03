// What a member has asked to receive, and how they change it.
//
// The table has existed since the notifications work and memberNotify.js has
// been READING it to decide whether to email somebody — but nothing ever wrote
// to it and no screen ever showed it. A member could be emailed with no way to
// stop it, which is the gap this closes.
//
// THE DEFAULTS HERE MUST MATCH memberNotify.preferencesFor EXACTLY. If this
// screen says "email: on" while the sender assumes off (or the reverse), a
// member is told one thing and sent another. There is a test comparing the two.

const pool = require('../db');

// The four switches, each with the column it maps to and what it actually
// governs, in the words the member reads.
//
// Written out rather than derived from the table so that adding a column does
// not silently add an unexplained toggle to somebody's settings screen.
const FIELDS = [
  {
    key: 'web',
    column: 'web_enabled',
    label: 'Notifications on the site',
    help: 'The bell in your dashboard.',
  },
  {
    key: 'email',
    column: 'email_enabled',
    label: 'Notifications by email',
    help: 'We email you when something needs you. Turning this off does not stop essential emails about payment or your account.',
  },
  {
    key: 'statusChange',
    column: 'notify_status_change',
    label: 'When a submission changes',
    help: 'Approved, needs changes, or could not be approved.',
  },
  {
    key: 'achievement',
    column: 'notify_achievement',
    label: 'Badges and achievements',
    help: 'Milestones and recognition.',
  },
];

const BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

// All on. A member who has never opened this screen should still be told their
// submission needs work — the same reasoning, and the same values, as
// memberNotify.preferencesFor.
const DEFAULTS = Object.fromEntries(FIELDS.map((f) => [f.key, true]));

// A member's preferences, with the defaults filled in for anything unset.
//
// No row means the defaults rather than an error: most members will never have
// touched this, and "you have no preferences" is not a useful answer.
async function getFor(userId, client = pool) {
  const id = Number(userId);
  if (!Number.isInteger(id)) return { ...DEFAULTS };

  const r = await client.query(
    `SELECT ${FIELDS.map((f) => f.column).join(', ')}
       FROM notification_preferences WHERE user_id = $1`,
    [id]
  );
  if (!r.rows.length) return { ...DEFAULTS };

  const row = r.rows[0];
  // `!== false` rather than `=== true`: a NULL in a column that gained a default
  // later should read as on, not off.
  return Object.fromEntries(FIELDS.map((f) => [f.key, row[f.column] !== false]));
}

// Change some of them. Only the keys sent are touched.
//
// Upserts, because most members have no row until the first time they change
// something. Anything that is not one of the four known keys, or not a boolean,
// is ignored rather than rejected: a screen sending a stale field should not
// fail a member's whole save.
async function updateFor(userId, changes, client = pool) {
  const id = Number(userId);
  if (!Number.isInteger(id)) return { ...DEFAULTS };

  const wanted = Object.entries(changes || {})
    .filter(([key, value]) => BY_KEY[key] && typeof value === 'boolean');

  if (!wanted.length) return getFor(id, client);

  // Start from what they have (or the defaults), apply the changes, write the
  // whole row. Simpler to reason about than a partial update against a row that
  // may not exist yet.
  const current = await getFor(id, client);
  const merged = { ...current };
  for (const [key, value] of wanted) merged[key] = value;

  const columns = FIELDS.map((f) => f.column);
  const values = FIELDS.map((f) => merged[f.key]);

  await client.query(
    `INSERT INTO notification_preferences (user_id, ${columns.join(', ')}, updated_at)
     VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(', ')}, now())
     ON CONFLICT (user_id) DO UPDATE SET
       ${columns.map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
       updated_at = now()`,
    [id, ...values]
  );

  return merged;
}

module.exports = { FIELDS, DEFAULTS, getFor, updateFor };
