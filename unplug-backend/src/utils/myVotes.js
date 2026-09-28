// My Votes / Competition Activity.
//
// Online voting requires no account, so this view can only show votes cast
// while the member was signed in. Guest/session votes remain anonymous.
const pool = require('../db');

const CONTESTANT_NAME = `COALESCE(NULLIF(ce.manual_name, ''), p.display_name, 'Contestant')`;

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

async function activityFor(userId, client = pool) {
  const votes = await votesFor(userId, client);
  return {
    votes,
    totalVotes: votes.reduce((n, v) => n + v.votes, 0),
  };
}

module.exports = { votesFor, activityFor };
