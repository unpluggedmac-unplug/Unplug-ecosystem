'use strict';

// My Orders needs TWO truths at once:
//   1) payment state belongs to orders/payments;
//   2) service/review state belongs to the purchased submission itself.
//
// Never copy review state onto orders: one cart may contain several services
// which can be approved, rejected or sent back for changes independently.

const pool = require('../db');
const { statusLabel } = require('./mySubmissions');

const STANDARD = Object.freeze({
  article_publish:       { table: 'articles',             column: 'status' },
  event_listing:         { table: 'events',               column: 'status' },
  profile_package:       { table: 'profiles',             column: 'status' },
  competition_entry:     { table: 'competition_entries',  column: 'status' },
  highlight:             { table: 'highlights',           column: 'status' },
  marketplace_listing:   { table: 'marketplace_listings', column: 'status' },
  gallery_bundle:        { table: 'gallery_bundles',      column: 'status' },
  top10_entry:           { table: 'top10_entries',        column: 'status' },
});

const SUMMARY_PRIORITY = Object.freeze([
  'processing_issue',
  'changes_requested',
  'rejected',
  'credit_issued',
  'approved',
  'pending',
  'resubmitted',
  'completed',
  'expired',
  'awaiting_payment',
  'not_started',
  'processing',
  'unavailable',
]);

function paymentStatusLabel(status) {
  if (status === 'confirmed') return 'Paid';
  if (status === 'failed') return 'Payment failed';
  return 'Awaiting payment';
}

function normaliseStandard(status) {
  const key = String(status || '');
  return { key: key || 'unavailable', label: key ? statusLabel(key) : 'Status unavailable' };
}

function advertStatus(status) {
  if (status === 'approved') return { key: 'approved', label: 'Approved' };
  if (status === 'rejected') return { key: 'rejected', label: 'Not approved' };
  if (status === 'pending_approval' || status === 'pending') {
    return { key: 'pending', label: 'Awaiting approval' };
  }
  if (status === 'pending_payment') return { key: 'awaiting_payment', label: 'Waiting for payment' };
  return { key: 'unavailable', label: 'Status unavailable' };
}

function preSourceStatus(payment) {
  if (payment.status === 'pending') return { key: 'awaiting_payment', label: 'Waiting for payment' };
  if (payment.status === 'failed') return { key: 'not_started', label: 'Not started' };
  if (payment.fulfillment_status === 'failed') {
    return { key: 'processing_issue', label: 'Processing issue — we’re attending to it' };
  }
  if (payment.status === 'confirmed' && payment.fulfillment_status === 'pending') {
    return { key: 'processing', label: 'Processing' };
  }
  return null;
}

async function loadRows(table, column, ids, client) {
  if (!ids.length) return new Map();
  const result = await client.query(
    `SELECT id, ${column} AS service_status FROM ${table} WHERE id = ANY($1::int[])`,
    [ids]
  );
  return new Map(result.rows.map((row) => [Number(row.id), row.service_status]));
}

async function loadOrderServiceStatuses(payments, client = pool) {
  const rows = Array.isArray(payments) ? payments : [];
  const byType = new Map();
  for (const payment of rows) {
    if (!byType.has(payment.linked_type)) byType.set(payment.linked_type, []);
    byType.get(payment.linked_type).push(payment);
  }

  const sourceMaps = new Map();

  for (const [type, descriptor] of Object.entries(STANDARD)) {
    const typeRows = byType.get(type) || [];
    const ids = [...new Set(typeRows.map((p) => Number(p.linked_id)).filter(Number.isInteger))];
    sourceMaps.set(type, await loadRows(descriptor.table, descriptor.column, ids, client));
  }

  const adverts = byType.get('ad_banner') || [];
  sourceMaps.set(
    'ad_banner',
    await loadRows('ad_slots', 'moderation_status',
      [...new Set(adverts.map((p) => Number(p.linked_id)).filter(Number.isInteger))], client)
  );

  const upgrades = byType.get('profile_upgrade') || [];
  const upgradeIds = [...new Set(upgrades.map((p) => Number(p.linked_id)).filter(Number.isInteger))];
  if (upgradeIds.length) {
    const result = await client.query(
      'SELECT id, paid_at FROM profile_upgrades WHERE id = ANY($1::int[])',
      [upgradeIds]
    );
    sourceMaps.set('profile_upgrade', new Map(result.rows.map((row) => [Number(row.id), row.paid_at])));
  } else {
    sourceMaps.set('profile_upgrade', new Map());
  }

  return rows.map((payment) => {
    const early = preSourceStatus(payment);
    let service = early;

    if (!service) {
      const id = Number(payment.linked_id);
      if (Object.prototype.hasOwnProperty.call(STANDARD, payment.linked_type)) {
        const raw = sourceMaps.get(payment.linked_type).get(id);
        service = raw == null
          ? { key: 'unavailable', label: 'Status unavailable' }
          : normaliseStandard(raw);
      } else if (payment.linked_type === 'ad_banner') {
        service = advertStatus(sourceMaps.get('ad_banner').get(id));
      } else if (payment.linked_type === 'profile_upgrade') {
        service = sourceMaps.get('profile_upgrade').get(id)
          ? { key: 'completed', label: 'Completed' }
          : { key: 'processing', label: 'Processing' };
      } else {
        service = { key: 'unavailable', label: 'Status unavailable' };
      }
    }

    return {
      ...payment,
      paymentStatusLabel: paymentStatusLabel(payment.status),
      serviceStatus: service.key,
      serviceStatusLabel: service.label,
    };
  });
}

function summariseServiceStatuses(items) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return {
    key: 'empty',
    label: 'No services',
    counts: [],
  };

  const counts = new Map();
  for (const item of rows) {
    const key = item.serviceStatus || 'unavailable';
    const label = item.serviceStatusLabel || 'Status unavailable';
    const current = counts.get(key) || { key, label, count: 0 };
    current.count += 1;
    counts.set(key, current);
  }

  const ordered = [...counts.values()].sort((a, b) => {
    const ai = SUMMARY_PRIORITY.indexOf(a.key);
    const bi = SUMMARY_PRIORITY.indexOf(b.key);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.label.localeCompare(b.label);
  });

  if (ordered.length === 1) {
    return { key: ordered[0].key, label: ordered[0].label, counts: ordered };
  }

  return {
    key: 'mixed',
    label: 'Mixed status · ' + ordered.map((x) => `${x.count} ${x.label}`).join(' · '),
    counts: ordered,
  };
}

module.exports = {
  STANDARD,
  paymentStatusLabel,
  loadOrderServiceStatuses,
  summariseServiceStatuses,
};
