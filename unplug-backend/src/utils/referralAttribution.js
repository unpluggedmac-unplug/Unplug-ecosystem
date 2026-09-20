// Referral click -> signup attribution.
//
// The public acquisition endpoint records the click before a visitor has an
// account. Registration later supplies the referral code plus that click id,
// and this utility joins the two without making signup depend on attribution.
//
// Important rules:
// - best-effort: callers catch failures; a referral problem must never block
//   account creation;
// - idempotent referral processing is delegated to process_member_referral();
// - an exact click id is preferred so one browser visit is the conversion;
// - a click is converted only when the browser supplies its exact id; guessing
//   the latest click for a popular code could credit one visitor with another
//   visitor's signup;
// - a click can be converted only once.
const pool = require('../db');

function cleanCode(value) {
  return String(value || '').trim().slice(0, 20);
}

function cleanClickId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function recordSignupReferral({ userId, referralCode, referralClickId } = {}, client = pool) {
  const code = cleanCode(referralCode);
  const memberId = Number(userId);
  if (!code || !Number.isInteger(memberId) || memberId <= 0) {
    return { ok: false, reason: 'missing referral data', clickMarked: false };
  }

  const processed = await client.query(
    `SELECT * FROM process_member_referral($1, 'registered', $2)`,
    [code, memberId]
  );
  const row = processed.rows[0];

  // process_member_referral also awards points. A point cap can make its
  // success flag false after the member_referrals row was validly inserted,
  // and an idempotent retry reports referral_already_recorded. Neither should
  // erase a genuine signup from the acquisition funnel, so the relationship
  // row is the authority for whether attribution exists.
  let relationshipExists = Boolean(row && row.success);
  if (!relationshipExists) {
    const existing = await client.query(
      `SELECT 1
         FROM member_referrals
        WHERE referred_user_id = $1
          AND referral_code = $2
        LIMIT 1`,
      [memberId, code]
    );
    relationshipExists = existing.rowCount > 0;
  }
  if (!relationshipExists) {
    return {
      ok: false,
      reason: row && row.blocked_reason ? row.blocked_reason : 'referral not recorded',
      clickMarked: false,
    };
  }

  let marked = 0;
  const clickId = cleanClickId(referralClickId);
  if (clickId) {
    const exact = await client.query(
      `UPDATE referral_clicks
          SET converted_user_id = $1
        WHERE id = $2
          AND referral_code = $3
          AND converted_user_id IS NULL
        RETURNING id`,
      [memberId, clickId, code]
    );
    marked = exact.rowCount;
  }

  return {
    ok: true,
    clickMarked: Boolean(marked),
    pointsEarnedByReferrer: Number(row.points_earned) || 0,
  };
}

module.exports = { recordSignupReferral, cleanCode, cleanClickId };
