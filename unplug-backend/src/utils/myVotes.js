// My Votes / Competition Activity (spec §4; the rules are in Module 9).
//
// WHAT CAN HONESTLY BE SHOWN HERE.
//
// §9.1 is explicit that online voting "requires NO account". A vote therefore
// carries EITHER a voter_user_id or a session_id, and the anonymous ones are
// anonymous on purpose — they belong to a browser, not to a person. So this
// shows a member the votes they cast WHILE SIGNED IN, and nothing else. It does
// not try to guess that a session was probably them: telling someone "you voted
// for X" when they did not is worse than showing them less.
//
// The same is true of bulk vote purchases (§9.5), which can also be bought
// without an account.

const pool = require('../db');

// A contestant's name, wherever it lives.
//
// An entry is either a member's profile or an admin-created manual entry, so
// both routes are needed — an entry showing as blank is indistinguishable from
// a broken page.
const CONTESTANT_NAME = `COALESCE(NULLIF(ce.manual_name, ''), p.display_name, 'Contestant')`;

// Votes this member cast while signed in, newest first.
//
// bundle_size is how many votes the row represents: one for an ordinary online
// vote, more when it came from a paid bundle. It is shown rather than collapsed
// so the numbers on the page add up to the numbers in the competition.
async function votesFor(userId, client = pool) {
  const id = Number(userId);
  if (!Number.isInteger(id)) return [];
  const r = await client.query(
    `SELECT v.id,
            v.bundle_size,
            v.created_at,
            ${CONTESTANT_NAME} AS contestant,
            c.name AS competition,
            c.slug AS competition_slug,
            v.vote_bundle_id IS NOT NULL AS from_bundle
       FROM votes v
       JOIN competition_entries ce ON ce.id = v.entry_id
       JOIN competitions c ON c.id = ce.competition_id
       LEFT JOIN profiles p ON p.id = ce.profile_id
      WHERE v.voter_user_id = $1
      ORDER BY v.created_at DESC, v.id DESC
      LIMIT 200`,
    [id]
  );
  return r.rows.map((row) => ({
    id: row.id,
    votes: Number(row.bundle_size),
    castAt: row.created_at,
    contestant: row.contestant,
    competition: row.competition,
    competitionSlug: row.competition_slug,
    fromBundle: row.from_bundle,
  }));
}

// What a bulk vote purchase is called, for the member who bought it.
//
// vote_bundles has its OWN status vocabulary, separate from both the submission
// one and the payment one, so it is worded here rather than borrowed from
// either. All four values the CHECK allows are covered — `rejected` and
// `reversed` arrived later (migration 095) and were missing from the first
// version of this map, which a test comparing it against the live constraint
// caught. A member with a reversed bundle would have been shown the word
// "reversed" straight out of the database.
const BUNDLE_STATUS_LABEL = {
  awaiting_payment: 'Awaiting payment',
  confirmed: 'Paid',
  // The purchase was not accepted — payment never arrived, or it was refused.
  rejected: 'Not accepted',
  // Votes that had been credited were taken back afterwards, which is what the
  // admin vote-bundle reversal does. Worth its own word rather than being
  // lumped in with a refusal: these votes counted, and then stopped counting.
  reversed: 'Reversed',
};

function bundleStatusLabel(status) {
  const key = String(status || '');
  return Object.prototype.hasOwnProperty.call(BUNDLE_STATUS_LABEL, key)
    ? BUNDLE_STATUS_LABEL[key] : key;
}

// Bulk vote packages this member bought (§9.5), newest first.
//
// The reference matters: §9.6 says the contestant's code is what goes on the
// EFT, and a member who has paid needs to be able to quote what they used.
async function bundlesFor(userId, client = pool) {
  const id = Number(userId);
  if (!Number.isInteger(id)) return [];
  const r = await client.query(
    `SELECT vb.id, vb.vote_count, vb.price, vb.status, vb.reference, vb.created_at,
            ${CONTESTANT_NAME} AS contestant,
            c.name AS competition
       FROM vote_bundles vb
       JOIN competition_entries ce ON ce.id = vb.entry_id
       JOIN competitions c ON c.id = ce.competition_id
       LEFT JOIN profiles p ON p.id = ce.profile_id
      WHERE vb.buyer_user_id = $1
      ORDER BY vb.created_at DESC, vb.id DESC
      LIMIT 100`,
    [id]
  );
  return r.rows.map((row) => ({
    id: row.id,
    votes: Number(row.vote_count),
    price: Number(row.price),
    status: row.status,
    statusLabel: bundleStatusLabel(row.status),
    reference: row.reference || null,
    boughtAt: row.created_at,
    contestant: row.contestant,
    competition: row.competition,
  }));
}

// Everything, plus the totals a member would otherwise count by hand.
//
// totalVotes counts VOTES, not rows: a bundle row of 50 is fifty votes. Summing
// rows instead would tell a member who bought the Ultimate package that they
// had cast one vote.
async function activityFor(userId, client = pool) {
  const [votes, bundles] = await Promise.all([
    votesFor(userId, client),
    bundlesFor(userId, client),
  ]);
  return {
    votes,
    bundles,
    totalVotes: votes.reduce((n, v) => n + v.votes, 0),
    totalSpent: bundles
      .filter((b) => b.status === 'confirmed')
      .reduce((n, b) => n + b.price, 0),
  };
}

module.exports = {
  votesFor, bundlesFor, activityFor, BUNDLE_STATUS_LABEL, bundleStatusLabel,
};
