// My Submissions, and every "My X" section that is a filter on it.
//
// Deliberately thin. The shape, the ownership and the status wording all live
// in utils/mySubmissions.js so that the six menu items §4 asks for cannot drift
// apart — this file only decides who is asking and hands back what it is given.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { listFor, isType, TYPES, TYPE_KEYS } = require('../utils/mySubmissions');

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
    if (type && !isType(type)) {
      return res.status(400).json({
        error: 'Unknown submission type.',
        known: TYPE_KEYS,
      });
    }

    const submissions = await listFor(req.user.id, type ? { type } : {});
    res.json({ submissions });
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
    types: TYPE_KEYS.map((key) => ({
      type: key,
      label: TYPES[key].label,
      plural: TYPES[key].plural,
    })),
  });
});

module.exports = router;
