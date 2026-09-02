// My Submissions, and every "My X" section that is a filter on it.
//
// Deliberately thin. The shape, the ownership and the status wording all live
// in utils/mySubmissions.js so that the six menu items §4 asks for cannot drift
// apart — this file only decides who is asking and hands back what it is given.

const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const {
  listFor, isType, TYPES, SUBMISSION_TYPES, SERVICE_TYPES,
  groupServices, EXPIRING_WITHIN_DAYS,
} = require('../utils/mySubmissions');

// GET /my/submissions          — everything this member has submitted
// GET /my/submissions?type=... — one menu item (My Articles, My Events, …)
//
// Always the logged-in member: there is no user parameter, so there is nothing
// to tamper with. An unknown ?type is refused rather than quietly ignored — a
// filter that stops filtering shows a member the wrong list while looking like
// it worked.
router.get('/submissions', requireAuth, async (req, res, next) => {
  try {
    const type = req.query.type ? String(req.query.type) : null;
    if (type && (!isType(type) || SUBMISSION_TYPES.indexOf(type) === -1)) {
      return res.status(400).json({
        error: 'Unknown submission type.',
        known: SUBMISSION_TYPES,
      });
    }

    const submissions = await listFor(req.user.id, { only: SUBMISSION_TYPES, type });
    res.json({ submissions });
  } catch (err) {
    next(err);
  }
});

// GET /my/services — the same data, read as §5 asks for it: active, pending,
// expiring, expired, requiring changes, awaiting payment.
//
// Competitions are excluded: an entry is not bought for a period and cannot be
// renewed — it ends when the competition closes, which is the competition's
// business. They stay in My Submissions.
router.get('/services', requireAuth, async (req, res, next) => {
  try {
    // TODAY COMES FROM THE DATABASE, not from Node. Whether a service has
    // expired is a question about the same clock that stored its dates, and
    // working it out here instead is a second clock that disagrees whenever the
    // server's local date is ahead of UTC.
    const now = await pool.query(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today`);
    const today = now.rows[0].today;

    const services = await listFor(req.user.id, { only: SERVICE_TYPES });
    res.json({
      today,
      expiringWithinDays: EXPIRING_WITHIN_DAYS,
      groups: groupServices(services, today),
    });
  } catch (err) {
    next(err);
  }
});

// GET /my/submission-types — what the menu can offer.
//
// The dashboard builds its own sections from this rather than repeating the
// list in HTML, so adding a service in one place adds it everywhere.
router.get('/submission-types', requireAuth, (req, res) => {
  res.json({
    types: SUBMISSION_TYPES.map((key) => ({
      type: key,
      label: TYPES[key].label,
      plural: TYPES[key].plural,
    })),
  });
});

module.exports = router;
