// THE SUBMISSION LIFECYCLE, WRITTEN DOWN.
//
// Nine tables carry a `status` that means the same thing — an article, an
// event, a profile, a gallery bundle, gallery images, a marketplace listing, a
// highlight, a Top 10 entry, a competition entry. Every one of them already
// uses awaiting_payment / pending / approved / rejected, and articles adds
// draft.
//
// That was never written down anywhere. It was discovered by reading 155
// migrations, because each table's CREATE TABLE tells you what the vocabulary
// USED to be — 36 later migrations extend those constraints, and reading only
// the create statement gets the wrong answer. This file is that answer, in one
// place, so nobody has to derive it again.
//
// NOTHING IMPORTS THIS YET. It is Phase A of the spine: write down what is
// already true, and name the four values Phase B will add. No table is touched
// and no behaviour changes.
//
// ---------------------------------------------------------------------------
// THE RULE THAT GOVERNS EVERY CHANGE HERE
// ---------------------------------------------------------------------------
//
// Changing a status CHECK means DROP CONSTRAINT then ADD CONSTRAINT, and the
// ADD re-validates the ENTIRE table. These migrations re-run on every deploy,
// so a list that omits a value some row already holds does not fail when it is
// written — it fails on the next deploy, as an outage. Migration 008 says so in
// as many words.
//
// Therefore: values are only ever ADDED, and a status is never renamed.
// `approved` stays `approved` forever, whatever the specification calls it.

// The tables that share this vocabulary. Constants, never from a request.
const SUBMISSION_TABLES = [
  'articles',
  'events',
  'profiles',
  'gallery_bundles',
  'gallery_images',
  'marketplace_listings',
  'highlights',
  'top10_entries',
  'competition_entries',
];

// Services migrated so far, in Phase B order.
//
// GALLERY is both of the gallery's tables: a bundle and its photos are one
// submission, so they move together.
const GALLERY = ['gallery_bundles', 'gallery_images'];              // B1, migration 156
const MARKETPLACE = ['marketplace_listings'];                        // B2, migration 157
const EVENTS = ['events'];                                           // B3, migration 158

// Services that have taken the three review statuses.
const REVIEWED = [...GALLERY, ...MARKETPLACE, ...EVENTS];

// Services that can actually run out.
//
// A marketplace listing has duration_days and an active_to date; an event has
// a date it happens on, and the public feed already drops it afterwards. A
// gallery submission has neither — the photos stay published — which is why it
// is the one service without `expired`.
const EXPIRING = [...MARKETPLACE, ...EVENTS];

// Each status, what it means, and WHERE IT IS CURRENTLY ALLOWED.
//
// `live` is the honest part. A value with `live: []` is declared here but is
// NOT yet in any database constraint — writing it would violate the CHECK and
// throw. Phase B adds them, one service per migration, and moves them into
// `live`. Until then this file tells you the truth rather than the intention.
const STATUSES = {
  draft: {
    live: ['articles'],
    meaning: 'Started and saved, never submitted. Only articles support this today.',
  },
  awaiting_payment: {
    live: SUBMISSION_TABLES,
    meaning: 'Submitted, and the money has not arrived. Nothing is reviewed until it has.',
  },
  pending: {
    live: SUBMISSION_TABLES,
    meaning: 'Waiting for an admin to look at it. The spec calls this UNDER_REVIEW.',
  },
  approved: {
    live: SUBMISSION_TABLES,
    meaning: 'Admin said yes. For most services this also means it is published.',
  },
  rejected: {
    live: SUBMISSION_TABLES,
    meaning: 'Admin said no. If it was paid for, credit follows — see credit_issued.',
  },

  // ---- Phase B is adding these, one service at a time. ----
  //
  // `live` grows as each service's migration lands. A status is only added to a
  // service it can actually reach: a value nothing can ever set is a branch
  // every filter and report carries for nothing.
  changes_requested: {
    live: REVIEWED,
    phase: 'B',
    meaning: 'Admin wants specific fields changed before deciding (spec §10.14).',
  },
  resubmitted: {
    live: REVIEWED,
    phase: 'B',
    meaning: 'The member has answered a changes_requested and it is back in the queue.',
  },
  credit_issued: {
    live: REVIEWED,
    phase: 'B',
    meaning: 'Rejected after payment, and Unplug Credit was issued for it (spec §10.7).',
  },
  expired: {
    live: EXPIRING,
    phase: 'B',
    // NOT EVERY SERVICE CAN EXPIRE. This belongs to the ones that run for a
    // term — highlights, ad banners, marketplace listings, directory packages.
    // A gallery submission is a one-off purchase of photos that stay published;
    // it has no term to run out, so `expired` is deliberately not added there.
    onlyFor: 'services that run for a fixed period',
    meaning: 'Ran its term and is no longer showing. The row stays for history and renewal.',
  },
};

// What may follow what.
//
// Deliberately not exhaustive of everything an admin CAN do — an admin can put
// a row almost anywhere, and this is not an attempt to stop them. It is the
// ordinary path, so a report can say "this went backwards" and a future
// workflow has something to check against.
const TRANSITIONS = {
  draft: ['awaiting_payment', 'pending'],
  awaiting_payment: ['pending', 'rejected'],
  pending: ['approved', 'rejected', 'changes_requested'],
  changes_requested: ['resubmitted'],
  resubmitted: ['approved', 'rejected', 'changes_requested'],
  approved: ['expired'],
  rejected: ['credit_issued'],
  credit_issued: [],
  expired: [],
};

const ALL = Object.keys(STATUSES);

// Is this a status this vocabulary knows about at all?
function isKnown(status) {
  return Object.prototype.hasOwnProperty.call(STATUSES, status);
}

// Can this status be written to this table TODAY without violating its CHECK?
// The question worth asking before a write, and the reason `live` exists.
function isLiveFor(status, table) {
  const s = STATUSES[status];
  return !!s && s.live.includes(table);
}

// Every status a given table currently accepts.
function liveStatusesFor(table) {
  return ALL.filter((s) => STATUSES[s].live.includes(table));
}

// Is `to` the ordinary next step after `from`? Unknown statuses answer false
// rather than throwing — a caller checking a transition wants an answer.
function canTransition(from, to) {
  if (!isKnown(from) || !isKnown(to)) return false;
  return TRANSITIONS[from].includes(to);
}

// The statuses that are declared but not yet in any constraint — what Phase B
// still has to do. Useful in a test, and as a progress check.
function notYetLive() {
  return ALL.filter((s) => STATUSES[s].live.length === 0);
}

module.exports = {
  SUBMISSION_TABLES, STATUSES, TRANSITIONS, ALL,
  isKnown, isLiveFor, liveStatusesFor, canTransition, notYetLive,
};
