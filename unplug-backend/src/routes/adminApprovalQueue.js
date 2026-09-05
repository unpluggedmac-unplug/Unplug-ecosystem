// One Approval Queue for the whole site.
//
// Before this there were two queues that each showed half the picture: the
// content Approval Queue (ten tabs, no reference codes, no payment status)
// and the unified Payments queue (money only, no content). An admin matching
// an EFT to a submission had to hold both in their head, and four things that
// genuinely need approving — page banners, edition purchases, listing claims
// and self-serve highlights split by kind — appeared in neither.
//
// THIS ROUTER NEVER APPROVES OR REJECTS. It reads, and it lets an admin
// correct a submission before deciding on it — but the decision itself always
// goes to the source's own endpoint. It does not reimplement approving or
// rejecting anything: every source already has its own correct, tested
// endpoint, and
// each row carries an `actions` block naming the endpoint the frontend should
// call. That is deliberate — those endpoints are where the real effects live
// (publishing the article, allocating the votes, releasing the download), and
// duplicating any of that here is how two code paths drift apart until one of
// them starts double-charging somebody.
//
// Merging happens in JS rather than one SQL UNION for the same reason the
// payment queue does it: seventeen source tables are shaped far too
// differently to line up as UNION-able columns without either lying about
// types or writing a query nobody can safely change later.
const express = require('express');
const pool = require('../db');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('./activityLog');
const { isLiveFor } = require('../utils/submissionStatus');
const CR = require('../utils/changeRequests');
const { notifyMemberAsync } = require('../utils/memberNotify');

const router = express.Router();

// Every row the queue can produce, in the order they're offered in the filter.
// `group` drives the coloured pill in the UI: what kind of decision this is.
//   content — something to publish or refuse
//   service — a paid placement or listing to activate
//   payment — money to confirm before anything else can happen
//   access  — someone asking for rights over an existing record
const TYPES = {
  article:             { label: 'Article',             group: 'content' },
  directory_profile:   { label: 'Directory Listing',   group: 'service' },
  gallery:             { label: 'Gallery Image',       group: 'content' },
  event:               { label: 'Event',               group: 'content' },
  competition_entry:   { label: 'Competition Entry',   group: 'content' },
  top10_entry:         { label: 'Top 10 Entry',        group: 'content' },
  top10_votes:         { label: 'Top 10 Vote Purchase', group: 'payment' },
  investor:            { label: 'Investor',            group: 'content' },
  marketplace:         { label: 'Marketplace Poster',  group: 'service' },
  article_highlight:   { label: 'Article Highlight',   group: 'service' },
  directory_highlight: { label: 'Directory Highlight', group: 'service' },
  page_banner:         { label: 'Page Banner',         group: 'service' },
  shoutout:            { label: 'Shoutout',            group: 'content' },
  listing_claim:       { label: 'Listing Claim',       group: 'access'  },
  cart_order:          { label: 'Cart Order',          group: 'payment' },
  service_payment:     { label: 'Service Payment',     group: 'payment' },
  edition_purchase:    { label: 'Edition Purchase',    group: 'payment' },
  cancellation:        { label: 'Cancellation Request', group: 'access'  },
  share_card:          { label: 'Share Card',           group: 'content' },
};

// Comments are deliberately NOT here. Every comment on the site is reviewed
// in one place — GET /comments/pending, the admin Comments screen — because
// comments arrive in far greater volume than anything else in this queue, and
// mixing them in would bury the payments and submissions behind them.

// Finds the payment behind a submission so its reference code and payment
// status can be shown on the same row. Written as a LATERAL rather than a
// plain join because a resubmitted item can have more than one payment row
// and only the newest is the live one. The type list is a hardcoded constant
// in each source below — never a value from the request — so interpolating it
// cannot carry a request's strings into SQL.
function payLateral(types, idColumn) {
  return `LEFT JOIN LATERAL (
            SELECT p.gateway_reference, p.status AS pay_status, p.amount AS pay_amount,
                   p.pop_url, p.invoice_url, p.user_id AS payer_id,
                   pu.email AS payer_email, pu.full_name AS payer_name
              FROM payments p
              LEFT JOIN users pu ON pu.id = p.user_id
             WHERE p.linked_type IN (${types.map((t) => `'${t}'`).join(', ')})
               AND p.linked_id = ${idColumn}
             ORDER BY p.created_at DESC
             LIMIT 1
          ) pay ON TRUE`;
}

// WAITING FOR PAYMENT vs WAITING FOR YOU.
//
// A submission that has not been paid for sits at 'awaiting_payment'. Those
// used to be filtered out of this queue entirely, which meant an admin could
// not see them at all — the article was submitted, the member was waiting, and
// the dashboard showed nothing. They are now listed, but the approve action is
// withheld until the money is in: payment first, then approval.
//
// The test is deliberately on the PAYMENT, not on the item's own status. A
// confirmed payment whose fulfilment did not run leaves the item stranded at
// 'awaiting_payment' for ever (orders.js swallows a failing per-item effect so
// one bad item cannot block a whole cart). Reading the payment directly means
// such an item unblocks itself here the moment an admin looks at it, instead
// of needing someone to notice it in the database.
// ONLY applies to things an admin PUBLISHES. For anything in the 'payment'
// group — a bulk vote purchase, a cart order, a service payment, an edition
// purchase — approving IS the act of confirming the money arrived. Those rows
// sit at 'awaiting_payment' by definition: that is what an EFT waiting to be
// checked off looks like, and gating them would mean the admin could never
// confirm a payment at all. They are always approvable.
function approvability(r, source) {
  const actions = source.actions(r);
  const group = TYPES[source.type].group;
  if (group === 'payment') return { actions, awaitingPayment: false };
  if (r.item_status !== 'awaiting_payment') return { actions, awaitingPayment: false };

  const paid = r.pay_status === 'confirmed';
  if (paid) {
    // Paid but never promoted — worth flagging so it is obvious why an item
    // that has clearly been paid for is still sitting in the queue.
    return { actions, awaitingPayment: false, paidButNotPromoted: r.item_status === 'awaiting_payment' };
  }

  // Approve is REMOVED rather than merely flagged, so a screen that ignores
  // the flag still cannot publish something that has not been paid for.
  const { approve, ...rest } = actions;
  return {
    actions: rest,
    awaitingPayment: true,
    approveBlockedReason: r.pop_url
      ? 'Proof of payment uploaded but not yet confirmed — confirm the payment first, then approve.'
      : 'Not paid for yet. Approving becomes available once the payment is confirmed.',
  };
}

// Each source returns the same column names so the merge below stays dumb.
// Anything a source genuinely doesn't have is selected as NULL rather than
// omitted, so a missing column is never mistaken for a coding slip.
// WHAT COUNTS AS "WAITING".
//
// The Approval Queue shows what is waiting on an admin. Three statuses mean
// that, not two:
//
//   pending           submitted and never looked at
//   awaiting_payment  submitted, not paid, so nothing is reviewed yet
//   resubmitted       the member answered a change request and it is back
//
// `resubmitted` was missing. Nothing sets it yet — the request-changes pathway
// is task 05 — but the moment that ships, a member who answers a change
// request would have moved their submission into a status this queue does not
// select, and it would have vanished. Nobody would see it, and the member
// would wait for a decision that was never coming.
//
// Added everywhere a submission is reviewed, including the two highlight
// sources, which filter with equality rather than IN and were easy to miss.
// For services whose migration has not landed yet the extra value simply
// matches nothing, so the queue is correct as each one arrives rather than
// needing another pass.

const SOURCES = [
  {
    type: 'article',
    sql: `SELECT a.id, a.title AS title, c.name AS subtitle,
                 COALESCE(pay.payer_name, u.full_name) AS customer_name,
                 COALESCE(pay.payer_email, u.email) AS customer_email,
                 a.author_user_id AS user_id, a.created_at AS submitted_at,
                 a.status AS item_status,
                 pay.gateway_reference AS reference, pay.pay_status, pay.pay_amount,
                 pay.pop_url, pay.invoice_url
            FROM articles a
            JOIN users u ON u.id = a.author_user_id
            LEFT JOIN categories c ON c.id = a.category_id
            ${payLateral(['article_publish'], 'a.id')}
           WHERE a.status IN ('pending', 'awaiting_payment', 'resubmitted')`,
    actions: (r) => ({
      approve: { method: 'PATCH', path: `/admin/articles/${r.id}/approve` },
      reject: { method: 'PATCH', path: `/admin/articles/${r.id}/reject` },
    }),
  },
  {
    // A "Seen and Heard by Unplug" card somebody made for themselves. The
    // masthead goes on it, so an editor sees it before it can be downloaded
    // clean — and that decision belongs in THIS queue with every other one,
    // not in an inbox with its own separate audit trail.
    type: 'share_card',
    sql: `SELECT sc.id, sc.name AS title,
                 COALESCE(sc.role_line, sc.category) AS subtitle,
                 sc.name AS customer_name, sc.submitter_email AS customer_email,
                 NULL::integer AS user_id, sc.created_at AS submitted_at,
                 sc.status AS item_status,
                 NULL AS reference, NULL AS pay_status, NULL::numeric AS pay_amount,
                 NULL AS pop_url, NULL AS invoice_url,
                 sc.photo_url
            FROM share_cards sc
           WHERE sc.status = 'pending'`,
    actions: (r) => ({
      approve: { method: 'PATCH', path: `/share-cards/admin/${r.id}/approve` },
      reject: { method: 'PATCH', path: `/share-cards/admin/${r.id}/reject` },
    }),
  },
  {
    type: 'directory_profile',
    sql: `SELECT p.id, p.display_name AS title, p.package_tier AS subtitle,
                 u.full_name AS customer_name, u.email AS customer_email,
                 p.user_id, p.created_at AS submitted_at, p.status AS item_status,
                 pay.gateway_reference AS reference, pay.pay_status, pay.pay_amount,
                 pay.pop_url, pay.invoice_url
            FROM profiles p
            JOIN users u ON u.id = p.user_id
            ${payLateral(['profile_package', 'profile_upgrade'], 'p.id')}
           WHERE p.status IN ('pending', 'awaiting_payment', 'resubmitted')`,
    actions: (r) => ({
      approve: { method: 'PATCH', path: `/admin/profiles/${r.id}/approve` },
      reject: { method: 'PATCH', path: `/admin/profiles/${r.id}/reject` },
    }),
  },
  {
    type: 'gallery',
    sql: `SELECT g.id, COALESCE(NULLIF(g.caption, ''), 'Gallery image') AS title,
                 g.supplied_by AS subtitle,
                 pay.payer_name AS customer_name, pay.payer_email AS customer_email,
                 pay.payer_id AS user_id, g.created_at AS submitted_at,
                 g.status AS item_status,
                 pay.gateway_reference AS reference, pay.pay_status, pay.pay_amount,
                 pay.pop_url, pay.invoice_url
            FROM gallery_images g
            ${payLateral(['gallery_bundle'], 'g.id')}
           WHERE g.status IN ('pending', 'awaiting_payment', 'resubmitted')`,
    actions: (r) => ({
      approve: { method: 'PATCH', path: `/admin/gallery/${r.id}/approve` },
      reject: { method: 'PATCH', path: `/admin/gallery/${r.id}/reject` },
    }),
  },
  {
    type: 'event',
    sql: `SELECT e.id, e.name AS title, e.venue AS subtitle,
                 u.full_name AS customer_name, u.email AS customer_email,
                 e.organizer_user_id AS user_id, e.created_at AS submitted_at,
                 e.status AS item_status,
                 pay.gateway_reference AS reference, pay.pay_status, pay.pay_amount,
                 pay.pop_url, pay.invoice_url
            FROM events e
            JOIN users u ON u.id = e.organizer_user_id
            ${payLateral(['event_listing'], 'e.id')}
           WHERE e.status IN ('pending', 'awaiting_payment', 'resubmitted')`,
    actions: (r) => ({
      approve: { method: 'PATCH', path: `/admin/events/${r.id}/approve` },
      reject: { method: 'PATCH', path: `/admin/events/${r.id}/reject` },
    }),
  },
  {
    // LEFT JOIN, not JOIN: admin-added entries carry manual_name and have no
    // profile row, and the old queue's inner join silently hid every one of
    // them from the admin who had just created them.
    type: 'competition_entry',
    sql: `SELECT ce.id, COALESCE(ce.manual_name, pr.display_name, 'Entry') AS title,
                 c.name AS subtitle,
                 pay.payer_name AS customer_name, pay.payer_email AS customer_email,
                 pr.user_id, ce.created_at AS submitted_at, ce.status AS item_status,
                 pay.gateway_reference AS reference, pay.pay_status,
                 COALESCE(pay.pay_amount, ce.entry_fee) AS pay_amount,
                 pay.pop_url, pay.invoice_url
            FROM competition_entries ce
            LEFT JOIN profiles pr ON pr.id = ce.profile_id
            LEFT JOIN competitions c ON c.id = ce.competition_id
            ${payLateral(['competition_entry'], 'ce.id')}
           WHERE ce.status IN ('pending', 'awaiting_payment', 'resubmitted')`,
    actions: (r) => ({
      approve: { method: 'PATCH', path: `/admin/entries/${r.id}/approve` },
      reject: { method: 'PATCH', path: `/admin/entries/${r.id}/reject` },
    }),
  },
  {
    type: 'top10_entry',
    sql: `SELECT te.id, pr.display_name AS title, NULL AS subtitle,
                 u.full_name AS customer_name, u.email AS customer_email,
                 pr.user_id, te.created_at AS submitted_at, te.status AS item_status,
                 pay.gateway_reference AS reference, pay.pay_status,
                 COALESCE(pay.pay_amount, te.entry_fee) AS pay_amount,
                 pay.pop_url, pay.invoice_url
            FROM top10_entries te
            JOIN profiles pr ON pr.id = te.profile_id
            LEFT JOIN users u ON u.id = pr.user_id
            ${payLateral(['top10_entry'], 'te.id')}
           WHERE te.status IN ('pending', 'awaiting_payment', 'resubmitted')`,
    actions: (r) => ({
      approve: { method: 'PATCH', path: `/admin/top10-entries/${r.id}/approve` },
      reject: { method: 'PATCH', path: `/admin/top10-entries/${r.id}/reject` },
    }),
  },
  {
    // Bulk vote purchases. The reference code is the contestant's entry code,
    // which is the whole point of showing them here: the admin can read the
    // bank statement and the queue in the same breath.
    type: 'top10_votes',
    sql: `SELECT vb.id, COALESCE(ce.manual_name, pr.display_name, 'Contestant') AS title,
                 vb.vote_count || ' votes' AS subtitle,
                 COALESCE(bu.full_name, 'Anonymous buyer') AS customer_name,
                 bu.email AS customer_email, vb.buyer_user_id AS user_id,
                 vb.created_at AS submitted_at, vb.status AS item_status,
                 vb.reference, vb.status AS pay_status, vb.price AS pay_amount,
                 vb.pop_url, vb.invoice_url,
                 ce.entry_code
            FROM vote_bundles vb
            JOIN competition_entries ce ON ce.id = vb.entry_id
            LEFT JOIN profiles pr ON pr.id = ce.profile_id
            LEFT JOIN users bu ON bu.id = vb.buyer_user_id
           WHERE vb.status = 'awaiting_payment'`,
    actions: (r) => ({
      approve: { method: 'PATCH', path: `/admin/vote-bundles/${r.id}/approve` },
      reject: { method: 'PATCH', path: `/admin/vote-bundles/${r.id}/reject` },
    }),
  },
  {
    type: 'investor',
    sql: `SELECT i.id, i.name AS title, i.contact_email AS subtitle,
                 u.full_name AS customer_name, u.email AS customer_email,
                 i.user_id, i.created_at AS submitted_at, i.status AS item_status,
                 NULL AS reference, NULL AS pay_status, NULL::numeric AS pay_amount,
                 NULL AS pop_url, NULL AS invoice_url
            FROM investors i
            JOIN users u ON u.id = i.user_id
           WHERE i.status IN ('pending', 'awaiting_payment', 'resubmitted')`,
    actions: (r) => ({
      approve: { method: 'PATCH', path: `/admin/investors/${r.id}/approve` },
      reject: { method: 'PATCH', path: `/admin/investors/${r.id}/reject` },
    }),
  },
  {
    type: 'marketplace',
    sql: `SELECT l.id, a.business_name AS title, l.headline AS subtitle,
                 COALESCE(pay.payer_name, a.business_name) AS customer_name,
                 pay.payer_email AS customer_email, pay.payer_id AS user_id,
                 l.created_at AS submitted_at, l.status AS item_status,
                 pay.gateway_reference AS reference, pay.pay_status, pay.pay_amount,
                 pay.pop_url, pay.invoice_url
            FROM marketplace_listings l
            JOIN advertisers a ON a.id = l.advertiser_id
            ${payLateral(['marketplace_listing'], 'l.id')}
           WHERE l.status IN ('pending', 'awaiting_payment', 'resubmitted')`,
    actions: (r) => ({
      approve: { method: 'PATCH', path: `/admin/marketplace/${r.id}/approve` },
      reject: { method: 'PATCH', path: `/admin/marketplace/${r.id}/reject` },
    }),
  },
  {
    // Highlights are one table with a target_type, but an article highlight
    // and a directory highlight are different decisions about different
    // things, so they are two rows in the filter and the target's real name
    // is resolved rather than shown as "article #58".
    type: 'article_highlight',
    sql: `SELECT h.id, COALESCE(ar.title, 'Article #' || h.target_id) AS title,
                 h.duration_days || ' days' AS subtitle,
                 pay.payer_name AS customer_name, pay.payer_email AS customer_email,
                 pay.payer_id AS user_id, h.created_at AS submitted_at,
                 h.status AS item_status,
                 pay.gateway_reference AS reference, pay.pay_status, pay.pay_amount,
                 pay.pop_url, pay.invoice_url
            FROM highlights h
            LEFT JOIN articles ar ON ar.id = h.target_id
            ${payLateral(['highlight'], 'h.id')}
           WHERE h.status IN ('pending', 'resubmitted') AND h.target_type = 'article'`,
    actions: (r) => ({
      approve: { method: 'PATCH', path: `/admin/highlights/${r.id}/approve` },
      reject: { method: 'PATCH', path: `/admin/highlights/${r.id}/reject` },
    }),
  },
  {
    type: 'directory_highlight',
    sql: `SELECT h.id, COALESCE(pr.display_name, 'Listing #' || h.target_id) AS title,
                 h.duration_days || ' days' AS subtitle,
                 pay.payer_name AS customer_name, pay.payer_email AS customer_email,
                 pay.payer_id AS user_id, h.created_at AS submitted_at,
                 h.status AS item_status,
                 pay.gateway_reference AS reference, pay.pay_status, pay.pay_amount,
                 pay.pop_url, pay.invoice_url
            FROM highlights h
            LEFT JOIN profiles pr ON pr.id = h.target_id
            ${payLateral(['highlight'], 'h.id')}
           WHERE h.status IN ('pending', 'resubmitted') AND h.target_type = 'directory'`,
    actions: (r) => ({
      approve: { method: 'PATCH', path: `/admin/highlights/${r.id}/approve` },
      reject: { method: 'PATCH', path: `/admin/highlights/${r.id}/reject` },
    }),
  },
  {
    // Self-serve page banners. moderation_status NULL means an admin created
    // it directly, which needs no approval and must not appear here.
    type: 'page_banner',
    sql: `SELECT b.id, COALESCE(NULLIF(b.name, ''), b.slot_key) AS title,
                 b.slot_key AS subtitle,
                 u.full_name AS customer_name, u.email AS customer_email,
                 b.owner_user_id AS user_id, b.created_at AS submitted_at,
                 b.moderation_status AS item_status,
                 pay.gateway_reference AS reference, pay.pay_status, pay.pay_amount,
                 pay.pop_url, pay.invoice_url
            FROM ad_slots b
            LEFT JOIN users u ON u.id = b.owner_user_id
            ${payLateral(['ad_banner'], 'b.id')}
           WHERE b.moderation_status = 'pending_approval'`,
    actions: (r) => ({
      approve: { method: 'PATCH', path: `/page-cms/admin/ad-slots/${r.id}/moderate`, body: { status: 'approved' } },
      reject: { method: 'PATCH', path: `/page-cms/admin/ad-slots/${r.id}/moderate`, body: { status: 'rejected' } },
    }),
  },
  {
    type: 'shoutout',
    sql: `SELECT s.id, s.nominee_name AS title, s.message AS subtitle,
                 NULL AS customer_name, s.submitted_by_email AS customer_email,
                 NULL::integer AS user_id, s.created_at AS submitted_at,
                 s.status AS item_status,
                 NULL AS reference, NULL AS pay_status, NULL::numeric AS pay_amount,
                 NULL AS pop_url, NULL AS invoice_url
            FROM shoutout_nominations s
           WHERE s.status = 'pending'`,
    actions: (r) => ({
      approve: { method: 'PATCH', path: `/admin/shoutouts/${r.id}/approve` },
      reject: { method: 'PATCH', path: `/admin/shoutouts/${r.id}/reject` },
    }),
  },
  {
    type: 'listing_claim',
    sql: `SELECT cl.id, pr.display_name AS title, cl.message AS subtitle,
                 u.full_name AS customer_name, u.email AS customer_email,
                 cl.user_id, cl.created_at AS submitted_at, cl.status AS item_status,
                 NULL AS reference, NULL AS pay_status, NULL::numeric AS pay_amount,
                 NULL AS pop_url, NULL AS invoice_url
            FROM profile_claims cl
            JOIN profiles pr ON pr.id = cl.profile_id
            JOIN users u ON u.id = cl.user_id
           WHERE cl.status = 'pending'`,
    actions: (r) => ({
      approve: { method: 'PATCH', path: `/claims/${r.id}/status`, body: { status: 'approved' } },
      reject: { method: 'PATCH', path: `/claims/${r.id}/status`, body: { status: 'rejected' } },
    }),
  },
  {
    // A cart order is N services bought together under one reference. The
    // titles of what's inside come from the joined payments rows so the admin
    // is not approving an opaque "Order #12".
    type: 'cart_order',
    sql: `SELECT o.id,
                 'Order ' || o.reference AS title,
                 (SELECT string_agg(DISTINCT ip.linked_type, ', ')
                    FROM payments ip WHERE ip.order_id = o.id) AS subtitle,
                 u.full_name AS customer_name, u.email AS customer_email,
                 o.user_id, o.created_at AS submitted_at, o.status AS item_status,
                 o.reference, o.status AS pay_status, o.total AS pay_amount,
                 o.pop_url, o.invoice_url
            FROM orders o
            JOIN users u ON u.id = o.user_id
           WHERE o.status = 'pending'`,
    actions: (r) => ({
      approve: { method: 'PATCH', path: `/orders/admin/${r.id}/confirm-eft` },
      reject: { method: 'PATCH', path: `/orders/admin/${r.id}/reject` },
    }),
  },
  {
    // Standalone service payments only. Anything belonging to an order shows
    // up as its parent order instead, so one purchase is never two rows.
    type: 'service_payment',
    sql: `SELECT p.id, p.linked_type AS title,
                 p.method AS subtitle,
                 u.full_name AS customer_name, u.email AS customer_email,
                 p.user_id, p.created_at AS submitted_at, p.status AS item_status,
                 p.gateway_reference AS reference, p.status AS pay_status,
                 p.amount AS pay_amount, p.pop_url, p.invoice_url
            FROM payments p
            JOIN users u ON u.id = p.user_id
           WHERE p.status = 'pending' AND p.order_id IS NULL`,
    actions: (r) => ({
      approve: { method: 'PATCH', path: `/payments/admin/${r.id}`, body: { status: 'confirmed' } },
      reject: { method: 'PATCH', path: `/payments/admin/${r.id}`, body: { status: 'failed' } },
    }),
  },
  {
    // A member asking to stop a service they pay for. Approving it here is
    // the same decision as approving it in its own screen — both call
    // PATCH /cancellations/admin/:id — but approving from the queue does NOT
    // set a refund amount, because that is a number a person has to choose
    // and a queue row is the wrong place to type it. The message the admin
    // gets back says so.
    type: 'cancellation',
    sql: `SELECT c.id, c.service_label AS title,
                 'Cancel ' || c.service_type || COALESCE(' — ' || c.reason, '') AS subtitle,
                 u.full_name AS customer_name, u.email AS customer_email, c.user_id,
                 c.created_at AS submitted_at, c.status AS item_status,
                 c.reference, NULL AS pay_status, NULL::numeric AS pay_amount,
                 NULL AS pop_url, NULL AS invoice_url
            FROM service_cancellations c
            JOIN users u ON u.id = c.user_id
           WHERE c.status IN ('requested', 'under_review')`,
    actions: (r) => ({
      approve: { method: 'PATCH', path: `/cancellations/admin/${r.id}`, body: { action: 'approve' } },
      reject: { method: 'PATCH', path: `/cancellations/admin/${r.id}`, body: { action: 'reject' } },
    }),
  },
  {
    type: 'edition_purchase',
    sql: `SELECT ep.id, e.title AS title, ep.customer_email AS subtitle,
                 ep.customer_name, ep.customer_email, ep.user_id,
                 ep.created_at AS submitted_at, ep.payment_status AS item_status,
                 ep.download_reference AS reference, ep.payment_status AS pay_status,
                 ep.amount AS pay_amount, NULL AS pop_url, NULL AS invoice_url
            FROM edition_purchases ep
            JOIN editions e ON e.id = ep.edition_id
           WHERE ep.payment_status IN ('awaiting_eft', 'pending_approval', 'awaiting_payment')`,
    actions: (r) => ({
      approve: { method: 'POST', path: `/editions/admin/purchases/${r.id}/approve` },
      reject: { method: 'POST', path: `/editions/admin/purchases/${r.id}/reject` },
    }),
  },
];

// A payment status of 'pending' on a submission means "we are still waiting
// for the money", which is a different thing from "no payment applies here"
// (an investor listing, a shoutout). Collapsing both to a blank cell was how
// the old queue let unpaid items look free.
function paymentLabel(row) {
  if (!row.reference && !row.pay_status) return 'Not payable';
  if (row.pay_status === 'confirmed') return 'Paid';
  if (row.pay_status === 'failed' || row.pay_status === 'rejected') return 'Payment failed';
  if (row.pay_status === 'approved') return 'Paid';
  return 'Awaiting payment';
}

function fileList(row) {
  const files = [];
  if (row.pop_url) files.push({ label: 'Proof of payment', url: row.pop_url });
  if (row.invoice_url) files.push({ label: 'Invoice', url: row.invoice_url });
  // A share card's photograph. THE EDITOR HAS TO SEE THIS BEFORE APPROVING —
  // the picture goes onto a card carrying the masthead, and approving an image
  // you were never shown is not approval, it is a rubber stamp.
  if (row.photo_url) files.push({ label: 'Card photo', url: row.photo_url });
  return files;
}

// GET /admin/approval-queue?type=a,b&q=&from=&to=
//
// Returns everything awaiting an admin decision, newest first, plus per-type
// counts so the filter can show how much is waiting behind each one without a
// second round trip.
router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const wanted = String(req.query.type || '').split(',').map((s) => s.trim()).filter(Boolean);
    const q = String(req.query.q || '').trim().toLowerCase();
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;

    const active = SOURCES.filter((s) => !wanted.length || wanted.includes(s.type));

    // Each source is queried independently. One failing source must not blank
    // the whole queue — an admin with a broken banner table still needs to
    // approve articles — so a failure is reported alongside the rows that did
    // load rather than thrown.
    const problems = [];
    const settled = await Promise.all(active.map(async (source) => {
      try {
        const result = await pool.query(source.sql);
        return result.rows.map((r) => ({
          key: `${source.type}:${r.id}`,
          type: source.type,
          typeLabel: TYPES[source.type].label,
          group: TYPES[source.type].group,
          id: r.id,
          title: r.title,
          subtitle: r.subtitle,
          customerName: r.customer_name || null,
          customerEmail: r.customer_email || null,
          userId: r.user_id || null,
          submittedAt: r.submitted_at,
          reference: r.reference || (r.entry_code || null),
          entryCode: r.entry_code || null,
          amount: r.pay_amount === null || r.pay_amount === undefined ? null : Number(r.pay_amount),
          paymentStatus: paymentLabel(r),
          itemStatus: r.item_status,
          files: fileList(r),
          ...approvability(r, source),
        }));
      } catch (err) {
        problems.push({ type: source.type, error: err.message });
        return [];
      }
    }));

    let items = settled.flat();

    if (q) {
      items = items.filter((i) =>
        [i.title, i.subtitle, i.customerName, i.customerEmail, i.reference, i.typeLabel]
          .some((v) => v && String(v).toLowerCase().includes(q)));
    }
    if (from && !isNaN(from)) items = items.filter((i) => new Date(i.submittedAt) >= from);
    if (to && !isNaN(to)) items = items.filter((i) => new Date(i.submittedAt) <= to);

    items.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

    const counts = {};
    items.forEach((i) => { counts[i.type] = (counts[i.type] || 0) + 1; });

    res.json({
      items,
      counts,
      total: items.length,
      types: Object.entries(TYPES).map(([key, v]) => ({ key, label: v.label, group: v.group })),
      problems,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// READING AND EDITING A SUBMISSION BEFORE DECIDING ON IT
//
// The list above deliberately returns a SUMMARY — title, who sent it, what was
// paid. Putting every article body and every bio in the list response would
// make the queue enormous to load for the one row an admin is actually looking
// at. So the full record is fetched one item at a time, here.
//
// That summary was also the bug this fixes. An admin approving from the queue
// could see an article's title and its author and nothing else: no body, no
// images, no links. They were approving things sight unseen, then finding out
// what they had published by reading the live site.
//
// EDITABLE COLUMNS ARE A WHITELIST, PER TYPE, and the list lives here rather
// than in the request. The table name and every column name below are constants
// in this file; nothing an admin sends can name a table or a column. Values are
// parameterised. So the worst a malformed request can do is be rejected.
//
// WHAT IS DELIBERATELY NOT EDITABLE:
//   - status, on anything. Approving is what the approve action is for, and a
//     status editable from two places is a status that ends up disagreeing
//     with itself.
//   - money. amount, price, entry_fee, order totals, payment_status,
//     gateway_reference. Those record what actually happened at the gateway;
//     an editable amount is how the books stop matching the bank. An admin who
//     needs to change what somebody paid should refund and re-take it, so
//     there is a trail.
//   - anything that identifies the submitter. Correcting somebody's own email
//     to something else, on a record they own, is not an edit.
// ---------------------------------------------------------------------------

const f = (col, label, type) => ({ col, label, type: type || 'text' });

const DETAILS = {
  article: {
    table: 'articles',
    fields: [f('title', 'Title'), f('subtitle', 'Standfirst'),
             f('kicker_supplied_by', 'Supplied by'), f('author_name', 'Written by'),
             f('meta_description', 'Search summary', 'textarea'),
             f('body', 'Body', 'html'),
             f('conclusion', 'In closing', 'html'),
             f('cta_label', 'Button label'), f('cta_url', 'Button link', 'url'),
             f('banner_image_url', 'Cover image', 'image')],
    // The one public endpoint that already lets an admin see a pending item.
    preview: (r) => `?p=article&id=${r.id}`,
  },
  share_card: {
    table: 'share_cards',
    fields: [f('name', 'Name'), f('role_line', 'Role or town'),
             f('quote', 'Their line', 'textarea'), f('category', 'Category')],
    // The card is drawn from these fields, and the review token renders the
    // real thing — the same link the approval email sends.
    preview: (r) => (r.review_token ? `?p=card&token=${r.review_token}` : null),
  },
  directory_profile: {
    table: 'profiles',
    fields: [f('display_name', 'Name'), f('bio', 'Bio', 'textarea'),
             f('achievements', 'Achievements', 'textarea'), f('career', 'Career', 'textarea'),
             f('quote', 'Quote', 'textarea'), f('contact_website', 'Website', 'url'),
             f('city', 'Town'), f('province', 'Province'),
             f('feature_image_url', 'Feature image', 'image')],
    preview: (r) => (r.slug ? `?p=profile&slug=${encodeURIComponent(r.slug)}` : null),
  },
  gallery: {
    table: 'gallery_images',
    fields: [f('title', 'Title'), f('caption', 'Caption', 'textarea'),
             f('alt_text', 'Image description'), f('supplied_by', 'Supplied by'),
             f('link_url', 'Link', 'url'), f('image_url', 'Image', 'image')],
    preview: () => '?p=gallery',
  },
  event: {
    table: 'events',
    fields: [f('name', 'Event name'), f('description', 'Description', 'textarea'),
             f('venue', 'Venue'), f('event_date', 'Date', 'date'),
             f('end_date', 'Last day (multi-day events)', 'date'),
             f('entrance_fee', 'Entrance fee'), f('contact_details', 'Contact'),
             f('event_link', 'Link', 'url'), f('image_url', 'Image', 'image')],
    preview: () => '?p=home',
  },
  competition_entry: {
    table: 'competition_entries',
    fields: [f('manual_name', 'Entrant name'), f('manual_image_url', 'Image', 'image')],
    preview: () => '?p=competitions',
  },
  top10_entry: {
    // Nothing editorial on the row itself — it points at a profile, and the
    // profile is edited as a Directory Listing.
    table: 'top10_entries',
    fields: [],
    preview: () => '?p=top10',
  },
  investor: {
    table: 'investors',
    fields: [f('name', 'Name'), f('about', 'About', 'textarea'),
             f('contact_website', 'Website', 'url')],
    preview: () => '?p=investors',
  },
  marketplace: {
    table: 'marketplace_listings',
    fields: [f('headline', 'Headline'), f('poster_image_url', 'Poster', 'image')],
    preview: () => '?p=brandplacement',
  },
  article_highlight: {
    table: 'highlights',
    fields: [f('start_date', 'Starts', 'date'), f('end_date', 'Ends', 'date'),
             f('priority', 'Order'), f('admin_image_url', 'Cover override', 'image')],
    preview: (r) => `?p=article&id=${r.target_id}`,
  },
  directory_highlight: {
    table: 'highlights',
    fields: [f('start_date', 'Starts', 'date'), f('end_date', 'Ends', 'date'),
             f('priority', 'Order'), f('admin_image_url', 'Cover override', 'image')],
    preview: () => '?p=directory',
  },
  page_banner: {
    table: 'ad_slots',
    fields: [f('name', 'Name'), f('image_url', 'Image', 'image'),
             f('mobile_image_url', 'Mobile image', 'image'), f('link_url', 'Link', 'url'),
             f('cta_text', 'Button text'), f('starts_at', 'Starts', 'date'),
             f('ends_at', 'Ends', 'date')],
    preview: () => '?p=home',
  },
  shoutout: {
    table: 'shoutout_nominations',
    fields: [f('nominee_name', 'Who'), f('message', 'Message', 'textarea'),
             f('nominee_social', 'Social handle'), f('nominee_social_url', 'Social link', 'url'),
             f('available_from', 'Show from', 'date')],
    preview: () => '?p=home',
  },
  listing_claim: {
    table: 'profile_claims',
    fields: [f('message', 'Their message', 'textarea')],
    preview: () => '?p=directory',
  },
  cancellation: {
    // The note an admin writes is theirs to edit. The refund amount is not:
    // see the money rule above.
    table: 'service_cancellations',
    fields: [f('admin_note', 'Admin note', 'textarea')],
    preview: () => null,
  },
  edition_purchase: {
    // Descriptive only. Not amount, not payment_status.
    table: 'edition_purchases',
    fields: [f('customer_name', 'Customer name'), f('customer_email', 'Customer email', 'email')],
    preview: () => '?p=editions',
  },
  cart_order: { table: 'orders', fields: [], preview: () => null },
  service_payment: { table: 'payments', fields: [], preview: () => null },
  top10_votes: { table: 'vote_bundles', fields: [], preview: () => '?p=top10' },
};

// Every column name that may appear in SQL, gathered once from the constants
// above. A column not in here never reaches a query.
function editableCols(type) {
  const d = DETAILS[type];
  return d ? d.fields.map((x) => x.col) : [];
}

// GET /admin/approval-queue/:type/:id — the whole record, plus what may be
// edited and where it can be previewed.
router.get('/:type/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const type = String(req.params.type);
    const d = DETAILS[type];
    if (!d) return res.status(404).json({ error: 'Unknown submission type.' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid id is required.' });

    // d.table is a constant in this file, never anything from the request.
    const result = await pool.query(`SELECT * FROM ${d.table} WHERE id = $1`, [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found.' });
    const item = result.rows[0];

    res.json({
      type,
      typeLabel: TYPES[type] ? TYPES[type].label : type,
      item,
      fields: d.fields,
      // Null where the thing has no public page of its own. Saying so beats a
      // button that opens the homepage and looks broken.
      previewUrl: d.preview ? d.preview(item) : null,
      editable: d.fields.length > 0,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/approval-queue/:type/:id — save an admin's corrections.
//
// Deliberately does NOT approve. Editing and deciding are two acts, and a save
// that also published would mean an admin could never fix a typo without
// committing to the whole thing.
router.patch('/:type/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const type = String(req.params.type);
    const d = DETAILS[type];
    if (!d) return res.status(404).json({ error: 'Unknown submission type.' });
    if (!d.fields.length) {
      return res.status(400).json({ error: 'Nothing on this kind of submission can be edited.' });
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid id is required.' });

    const sent = (req.body && req.body.fields) || {};
    const allowed = editableCols(type);
    const sets = [];
    const values = [];
    const changed = [];
    for (const [col, raw] of Object.entries(sent)) {
      if (!allowed.includes(col)) continue;          // silently ignored, not an error
      const spec = d.fields.find((x) => x.col === col);
      let value = raw;
      if (typeof value === 'string') value = value.trim();
      // An empty box means "clear it", except where a column cannot be null.
      if (value === '') value = null;
      if (spec.type === 'date' && value !== null && isNaN(new Date(value).getTime())) {
        return res.status(400).json({ error: `${spec.label} is not a date I can read.` });
      }
      values.push(value);
      sets.push(`${col} = $${values.length}`);
      changed.push(col);
    }
    if (!sets.length) return res.status(400).json({ error: 'No editable fields were sent.' });

    values.push(id);
    const result = await pool.query(
      `UPDATE ${d.table} SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`, values);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found.' });

    // An admin changing somebody else's submission before publishing it is
    // exactly what an audit trail is for.
    await logActivity(req.user.id, 'submission_edited',
      `Edited ${TYPES[type] ? TYPES[type].label : type} #${id} before approval (${changed.join(', ')})`);

    res.json({ item: result.rows[0], changed });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// ASKING FOR CHANGES INSTEAD OF DECIDING (spec 10.14)
// ---------------------------------------------------------------------------
//
// An admin reviewing a submission had two answers: approve, or reject. There
// was no way to say "the cover image is wrong, the rest is fine", so a fixable
// submission had to be refused outright and the member had to start again
// without being told what was wrong.
//
// This is the third answer. The admin ticks the fields that need changing, the
// submission goes to `changes_requested`, and the member gets it back with
// exactly that list.
//
// THE FIELDS ARE THE SAME WHITELIST AN ADMIN CAN EDIT. Reused from DETAILS
// rather than copied, so what can be REQUESTED and what can be EDITED cannot
// drift apart, and nothing in a request ever names a column.
//
// Not every kind of submission can be handed back — a gallery image belongs to
// a bundle and a share card is submitted without an account, so there is nobody
// to hand it to. Those are refused with the reason rather than silently
// missing; see src/utils/changeRequests.js.
router.post('/:type/:id/request-changes', requireRole('admin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const type = String(req.params.type);
    const d = DETAILS[type];
    if (!d) return res.status(404).json({ error: 'Unknown submission type.' });

    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'A valid id is required.' });

    if (!CR.canRequestChanges(type)) {
      return res.status(400).json({
        error: `This kind of submission cannot be sent back: ${CR.NOT_RETURNABLE[type] || 'it has no owner to return it to'}.`,
      });
    }
    if (!isLiveFor('changes_requested', d.table)) {
      // The status has to exist on the table before anything can be moved into
      // it. Services are migrated one at a time, so this is a real state.
      return res.status(400).json({
        error: 'This service has not been set up for change requests yet.',
      });
    }

    const fields = CR.cleanFields(req.body && req.body.fields, editableCols(type));
    const note = String((req.body && req.body.note) || '').trim();
    if (!CR.isSayingSomething(fields, note)) {
      return res.status(400).json({
        error: 'Say what needs changing: tick at least one field, or write a note.',
      });
    }

    await client.query('BEGIN');

    const owner = await CR.ownerOf(type, id, client);
    if (!owner) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That submission no longer exists.' });
    }

    // One open request at a time. A second would mean the member seeing two
    // different lists of what to fix, and nobody able to say which was answered.
    const open = await client.query(
      `SELECT id FROM change_requests
        WHERE submission_type = $1 AND submission_id = $2 AND answered_at IS NULL`,
      [type, id]
    );
    if (open.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'This submission is already waiting on the member for changes.',
      });
    }

    const updated = await client.query(
      `UPDATE ${d.table} SET status = 'changes_requested' WHERE id = $1 RETURNING id`, [id]
    );
    if (!updated.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That submission no longer exists.' });
    }

    const cr = await client.query(
      `INSERT INTO change_requests (submission_type, submission_id, fields, note, requested_by)
       VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING id, requested_at`,
      [type, id, JSON.stringify(fields), note || null, req.user.id]
    );

    await client.query('COMMIT');

    await logActivity(req.user.id, 'changes_requested',
      `Asked for changes on ${TYPES[type] ? TYPES[type].label : type} #${id}`
      + (fields.length ? ` (${fields.join(', ')})` : ''));

    // TELL THE MEMBER. After the commit, and not awaited.
    //
    // Until this, the pathway worked and was invisible: an admin asked for
    // changes, the database knew, and the member found out only if they
    // happened to open their dashboard. A request nobody is told about is a
    // submission that sits still while each side waits for the other.
    //
    // Deliberately outside the transaction. A notification is a side effect of
    // something that already happened; if the mail provider is down the change
    // request must still stand, or an admin would be certain they had asked and
    // the member would never have been asked at all.
    const fieldList = fields.length
      ? fields.map((c) => {
        const spec = d.fields.find((x) => x.col === c);
        return spec ? spec.label : c;
      }).join(', ')
      : null;

    notifyMemberAsync({
      userId: owner,
      type: 'changes_requested',
      isStatusChange: true,
      title: 'Action required on your submission',
      body: fieldList
        ? `Please change: ${fieldList}.` + (note ? ` ${note}` : '')
        : (note || 'A reviewer has asked for changes.'),
      linkUrl: '/unplug-member-dashboard.html',
      email: {
        subject: 'Your Unplug submission needs a change',
        text: [
          'Someone has reviewed your submission and asked for a change before it can be published.',
          '',
          fieldList ? `What to change: ${fieldList}` : null,
          note ? `Note from the reviewer: ${note}` : null,
          '',
          'Open My Account to make the change and send it back:',
          'https://www.unplugnews.com/unplug-member-dashboard.html',
        ].filter((x) => x !== null).join('\n'),
      },
    });

    res.status(201).json({
      changeRequest: {
        id: cr.rows[0].id,
        type,
        submissionId: id,
        fields,
        note: note || null,
        requestedAt: cr.rows[0].requested_at,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.DETAILS = DETAILS;

router.TYPES = TYPES;
router.SOURCES = SOURCES;

module.exports = router;