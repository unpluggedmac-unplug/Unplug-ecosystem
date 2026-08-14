// TOP 10 MONTHLY CAPTURE — freeze the month's final board, then let the new
// month start from zero with the placings carried over.
//
// See db/migrations/116_top10_monthly_archive.sql for why votes are stamped
// with a period rather than deleted. The short version: vote rows are tied to
// real payments, so they are never destroyed. The "reset" is the calendar
// turning over — on the 1st, no vote carries the new month's stamp yet, so
// every total reads zero on its own.
//
// WHICH MEANS THIS JOB CANNOT LOSE DATA BY RUNNING LATE. The Render instance
// sleeps when idle, so a job set for exactly 23:59 is not guaranteed to fire.
// It does not need to be. The votes for a finished month keep that month's
// stamp for ever, so a capture that happens at 23:59 on the 31st and one that
// happens at 09:00 on the 3rd compute the identical board. The hourly check
// catches up whenever the instance next wakes.
//
// What the capture actually does:
//   1. Ranks every approved entry by that month's votes (#1 to the last spot).
//   2. Writes that into the permanent archive, with names copied in so the
//      record survives the entry being deleted later.
//   3. Stamps each entry's carried_rank, so the new month opens in the closing
//      order instead of shuffling.
//   4. Awards the three placement badges for the month.

const pool = require('../db');

// The Top 10 is a built-in competition with a fixed slug, the same way
// competitions.js already treats it (BUILT_IN_SLUGS / MANAGED_ELSEWHERE_SLUGS).
// The monthly reset is a rule of THIS competition specifically — The Arena runs
// to its own dates and must never be reset by this job.
const TOP10_SLUG = 'top-10';

const PLACEMENT_BADGES = { 1: 'top10_champion', 2: 'top10_runner_up', 3: 'top10_third_place' };

// Months are decided in South African time, not the server's UTC — a capture
// must not think it is still last month because the server is two hours behind.
async function saPeriod(offsetMonths = 0) {
  const r = await pool.query(
    `SELECT EXTRACT(YEAR  FROM d)::int AS year,
            EXTRACT(MONTH FROM d)::int AS month,
            d::date AS period
       FROM (SELECT date_trunc('month', (now() AT TIME ZONE 'Africa/Johannesburg'))
                    + ($1::int || ' months')::interval AS d) t`,
    [offsetMonths]
  );
  return r.rows[0];
}

const currentPeriod = () => saPeriod(0);
const previousPeriod = () => saPeriod(-1);

function periodDate(year, month) {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

// The board for one month: every approved entry, ranked, including the ones on
// zero. "#1 to the last spot" is the whole list, not the top ten rows of it.
//
// The ordering is the same rule the live board uses, so the archived positions
// and what contestants saw on the site are never in disagreement:
//   votes first, then the position carried in from the previous month, then
//   who entered first, then id. Nothing is ever arbitrary.
async function standingsFor(client, competitionId, period) {
  const r = await client.query(
    `SELECT ce.id AS entry_id, ce.profile_id, ce.entry_code,
            COALESCE(p.display_name, ce.manual_name) AS display_name,
            p.slug AS profile_slug,
            COALESCE(ce.manual_image_url, p.feature_image_url) AS image_url,
            c.name AS category,
            COALESCE(SUM(v.bundle_size) FILTER (WHERE v.vote_period = $2::date), 0)::int AS vote_count
       FROM competition_entries ce
       LEFT JOIN profiles p ON p.id = ce.profile_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN votes v ON v.entry_id = ce.id
      WHERE ce.competition_id = $1 AND ce.status = 'approved'
        -- A contestant who only entered later was not on that month's board.
        -- Irrelevant for the normal month-end run, where every approved entry
        -- already existed; it matters when an admin back-captures an older
        -- month, which must not list people who had not entered yet.
        AND ce.created_at < ($2::date + INTERVAL '1 month')
      GROUP BY ce.id, p.display_name, p.slug, p.feature_image_url,
               ce.manual_name, ce.manual_image_url, c.name
      ORDER BY vote_count DESC, ce.carried_rank ASC NULLS LAST,
               ce.created_at ASC, ce.id ASC`,
    [competitionId, period]
  );
  return r.rows;
}

// Awarded outside the capture transaction, deliberately. The archive is the
// record and must stand; a badge problem is reported so an admin can award by
// hand, never rolled back over the top of a captured month.
async function awardPlacementBadges(rows, month, year, adminUserId) {
  // Re-capturing a corrected month must not leave the previous winner holding
  // "Champion — August" alongside the real one. Every placement badge for this
  // period is cleared first, then re-awarded from the board just captured.
  await pool.query(
    `DELETE FROM user_badges
      WHERE badge_code = ANY($1) AND award_month = $2 AND award_year = $3`,
    [Object.values(PLACEMENT_BADGES), month, year]
  );

  const awarded = [];
  for (const row of rows) {
    const code = PLACEMENT_BADGES[row.rank];
    if (!code) continue; // only the top three carry a badge

    // A badge belongs to a USER; the board ranks entries. A manual entry with
    // no profile behind it, or a profile with no account, simply cannot hold
    // one — that is not an error, just nobody to give it to.
    if (!row.profile_id) continue;
    const owner = await pool.query('SELECT user_id FROM profiles WHERE id = $1', [row.profile_id]);
    if (!owner.rows[0] || !owner.rows[0].user_id) continue;

    await pool.query('SELECT award_badge($1, $2, $3, $4, $5, $6)', [
      owner.rows[0].user_id, code, adminUserId || null,
      `Top 10 placement ${row.rank} for ${month}/${year}`, month, year,
    ]);
    awarded.push({ rank: row.rank, userId: owner.rows[0].user_id, badge: code, name: row.display_name });
  }
  return awarded;
}

// Capture one month. Idempotent: a month already in top10_monthly_captures is
// left alone unless force is set, which is what makes it safe to drive from a
// plain interval that may fire many times.
async function captureMonth({ year, month, adminUserId = null, auto = true, force = false } = {}) {
  const comp = await pool.query('SELECT id FROM competitions WHERE slug = $1', [TOP10_SLUG]);
  if (comp.rows.length === 0) {
    return { captured: false, reason: 'no-top10-competition' };
  }
  const competitionId = comp.rows[0].id;
  const period = periodDate(year, month);

  const already = await pool.query(
    'SELECT captured_at, entry_count FROM top10_monthly_captures WHERE period_year = $1 AND period_month = $2',
    [year, month]
  );
  if (already.rows.length > 0 && !force) {
    return {
      captured: false, reason: 'already-captured', year, month,
      capturedAt: already.rows[0].captured_at, entryCount: already.rows[0].entry_count,
    };
  }

  let rows;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    rows = (await standingsFor(client, competitionId, period))
      .map((r, i) => ({ ...r, rank: i + 1 }));

    // A re-capture replaces the month cleanly rather than stacking a second
    // set of positions on top of the first.
    await client.query(
      'DELETE FROM top10_monthly_rankings WHERE period_year = $1 AND period_month = $2',
      [year, month]
    );

    for (const r of rows) {
      await client.query(
        `INSERT INTO top10_monthly_rankings
           (period_year, period_month, rank, entry_id, profile_id, display_name,
            entry_code, category, image_url, profile_slug, vote_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [year, month, r.rank, r.entry_id, r.profile_id,
         r.display_name || 'Unnamed entry', r.entry_code, r.category,
         r.image_url, r.profile_slug, r.vote_count]
      );

      // The position the entry carries into the new month. Only a tie-breaker:
      // one real vote next month outranks any carried position.
      await client.query(
        'UPDATE competition_entries SET carried_rank = $1 WHERE id = $2',
        [r.rank, r.entry_id]
      );
    }

    const totalVotes = rows.reduce((sum, r) => sum + r.vote_count, 0);
    await client.query(
      `INSERT INTO top10_monthly_captures
         (period_year, period_month, entry_count, total_votes, captured_by, captured_auto)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (period_year, period_month) DO UPDATE
         SET entry_count = EXCLUDED.entry_count,
             total_votes = EXCLUDED.total_votes,
             captured_at = now(),
             captured_by = EXCLUDED.captured_by,
             captured_auto = EXCLUDED.captured_auto`,
      [year, month, rows.length, totalVotes, adminUserId, auto]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  let awardedBadges = [];
  let badgeError = null;
  try {
    awardedBadges = await awardPlacementBadges(rows, month, year, adminUserId);
  } catch (err) {
    // Reported, never thrown. The month is captured and that must stand.
    console.error('[top10] placement badges failed for', `${month}/${year}:`, err.message);
    badgeError = err.message;
  }

  return {
    captured: true, year, month,
    entryCount: rows.length,
    totalVotes: rows.reduce((sum, r) => sum + r.vote_count, 0),
    awardedBadges, badgeError,
  };
}

// Called on a plain hourly interval. Captures the month that has just ended,
// once, whenever the instance happens to be awake to do it.
async function runDueCapture() {
  const prev = await previousPeriod();
  return captureMonth({ year: prev.year, month: prev.month, auto: true });
}

module.exports = {
  TOP10_SLUG, PLACEMENT_BADGES,
  captureMonth, runDueCapture, currentPeriod, previousPeriod, periodDate,
};
