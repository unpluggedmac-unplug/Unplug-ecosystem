// What a contestant sees about their own entry.
//
// Vote totals are derived from vote rows. Administrative adjustments remain
// separate from public online votes so the contestant is not told an admin
// correction came from a voter.
const pool = require('../db');

const ADJUSTMENT = `v.session_id LIKE 'admin-adjust:%'`;

async function entriesFor(userId, client = pool) {
  const id = Number(userId);
  if (!Number.isInteger(id)) return [];

  const r = await client.query(
    `WITH entry_totals AS (
       SELECT ce.id AS entry_id,
              ce.competition_id,
              COALESCE(SUM(v.bundle_size), 0)::int AS total_votes,
              COALESCE(SUM(v.bundle_size) FILTER (WHERE ${ADJUSTMENT}), 0)::int AS adjustment_votes
         FROM competition_entries ce
         LEFT JOIN votes v ON v.entry_id = ce.id
        GROUP BY ce.id, ce.competition_id
     ),
     ranked AS (
       SELECT t.entry_id,
              t.competition_id,
              t.total_votes,
              t.adjustment_votes,
              RANK() OVER (PARTITION BY t.competition_id ORDER BY t.total_votes DESC) AS position,
              COUNT(*) OVER (PARTITION BY t.competition_id) AS contestants
         FROM entry_totals t
         JOIN competition_entries ce ON ce.id = t.entry_id
        WHERE ce.status = 'approved'
     )
     SELECT ce.id, ce.status, ce.entry_fee, ce.created_at, ce.entry_code,
            c.name AS competition_name, c.slug AS competition_slug,
            c.status AS competition_status, c.closes_at,
            COALESCE(r.total_votes, 0) AS total_votes,
            COALESCE(r.adjustment_votes, 0) AS adjustment_votes,
            r.position, r.contestants
       FROM competition_entries ce
       JOIN competitions c ON c.id = ce.competition_id
       LEFT JOIN ranked r ON r.entry_id = ce.id
      WHERE ce.profile_id IN (SELECT id FROM profiles WHERE user_id = $1)
      ORDER BY ce.created_at DESC`,
    [id]
  );

  return r.rows.map((row) => {
    const total = Number(row.total_votes);
    const adjustments = Number(row.adjustment_votes);
    return {
      id: row.id,
      status: row.status,
      entryFee: row.entry_fee === null ? null : Number(row.entry_fee),
      enteredAt: row.created_at,
      entryCode: row.entry_code || null,
      competition: row.competition_name,
      competitionSlug: row.competition_slug,
      competitionStatus: row.competition_status,
      closesAt: row.closes_at,
      verifiedVotes: total,
      onlineVotes: total - adjustments,
      adjustmentVotes: adjustments,
      ranking: row.position === null ? null : Number(row.position),
      contestants: row.contestants === null ? null : Number(row.contestants),
    };
  });
}

module.exports = { entriesFor };
