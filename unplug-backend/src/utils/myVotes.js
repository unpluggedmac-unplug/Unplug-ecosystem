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
            c.slug AS competition_slug
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
  }));
}

// Everything, plus the totals a member would otherwise count by hand.
//
// rows instead would tell a member who bought the Ultimate package that they
// had cast one vote.
async function activityFor(userId, client = pool) {
  const votes = await votesFor(userId, client);
  return {
    votes,
    totalVotes: votes.reduce((n, v) => n + v.votes, 0),
  };
}

module.exports = { votesFor, activityFor };
