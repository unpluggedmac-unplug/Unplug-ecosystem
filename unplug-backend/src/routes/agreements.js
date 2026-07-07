const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const AGREEMENT_TYPES = ['directory_terms', 'investor_agreement', 'advertiser_terms', 'competition_rules'];

// POST /agreements/sign — records a digital signature: who, what (type +
// version), how (typed full legal name as their signature), and enough
// metadata to stand behind it if ever disputed. One signature per
// user/type/version — re-signing the same version is a no-op; a new
// version (e.g. updated Ts&Cs) requires a fresh signature.
router.post('/sign', requireAuth, async (req, res, next) => {
  try {
    const { agreementType, agreementVersion, signedName } = req.body;
    if (!AGREEMENT_TYPES.includes(agreementType)) {
      return res.status(400).json({ error: `agreementType must be one of: ${AGREEMENT_TYPES.join(', ')}` });
    }
    if (!agreementVersion || !signedName || !signedName.trim()) {
      return res.status(400).json({ error: 'agreementVersion and signedName are required.' });
    }

    const result = await pool.query(
      `INSERT INTO signed_agreements (user_id, agreement_type, agreement_version, signed_name, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, agreement_type, agreement_version) DO NOTHING
       RETURNING *`,
      [req.user.id, agreementType, agreementVersion, signedName.trim(), req.ip, req.get('user-agent') || null]
    );

    if (result.rows.length === 0) {
      return res.json({ message: 'This version was already signed by this account.', alreadySigned: true });
    }
    res.status(201).json({ signature: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /agreements/mine — every agreement the current user has signed.
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT agreement_type, agreement_version, signed_name, signed_at
       FROM signed_agreements WHERE user_id = $1 ORDER BY signed_at DESC`,
      [req.user.id]
    );
    res.json({ signatures: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /agreements/user/:userId — admin can pull up anyone's signature
// history (e.g. to resolve a dispute).
router.get('/user/:userId', requireRole('admin'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT * FROM signed_agreements WHERE user_id = $1 ORDER BY signed_at DESC`,
      [req.params.userId]
    );
    res.json({ signatures: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
