// Recording a member action into the participation engine, from server code.
//
// There is exactly one way to do this, and it lives here, because awarding
// points and advancing missions are TWO calls that must always happen
// together. POST /participation/action already does both; a new call site
// that remembered award_points() and forgot update_mission_progress() would
// pay the member their points while their missions sat at zero forever — and
// nothing would error, so nobody would notice.
//
// Every call is best-effort. A member's comment, follow or vote must never
// fail because the scoring engine had a bad moment, so callers use
// recordParticipation(...) without awaiting a result they need, and a failure
// is logged rather than thrown.
const pool = require('../db');

async function recordParticipation(userId, actionCode, opts = {}) {
  if (!userId || !actionCode) return { success: false, reason: 'missing user or action' };
  const { contentType = null, contentId = null, contentOwner = null } = opts;
  try {
    const result = await pool.query(
      'SELECT * FROM award_points($1, $2, $3, $4, $5)',
      [userId, actionCode, contentType, contentId, contentOwner]
    );
    const row = result.rows[0] || {};

    // Missions advance even when the points were blocked by a daily cap: the
    // member genuinely did the thing, and "you hit today's point limit" is a
    // scoring rule, not a reason their mission should ignore the action.
    let missionsCompleted = 0;
    try {
      const m = await pool.query('SELECT update_mission_progress($1, $2) AS n', [userId, actionCode]);
      missionsCompleted = Number(m.rows[0] && m.rows[0].n) || 0;
    } catch (err) {
      console.error(`[participation] mission progress failed for ${actionCode}:`, err.message);
    }

    return {
      success: row.success !== false,
      pointsEarned: row.points_earned || 0,
      blockedReason: row.blocked_reason || null,
      missionsCompleted,
    };
  } catch (err) {
    // An unknown action code lands here. Logged with the code so a typo in a
    // call site is findable, rather than silently doing nothing forever.
    console.error(`[participation] could not record "${actionCode}":`, err.message);
    return { success: false, reason: err.message };
  }
}

// Fire-and-forget wrapper for call sites inside a request that must not be
// slowed or broken by scoring. Named so it reads as deliberate at the call
// site rather than looking like a forgotten await.
function recordParticipationAsync(userId, actionCode, opts = {}) {
  recordParticipation(userId, actionCode, opts).catch(() => {});
}

module.exports = { recordParticipation, recordParticipationAsync };
