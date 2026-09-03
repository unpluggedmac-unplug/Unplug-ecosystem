// The monthly record of what happened (approvals, votes, credits, submissions).
//
// admin_activity_log has recorded every staff decision since it was built, and
// now records member submissions too. What it did not have was a way to keep
// that record OUTSIDE the database — a log you can only read by logging in is
// not much use as a record, and a free-tier database with no backups is not a
// place to keep the only copy of one.
//
// So: one PDF per calendar month, emailed on the 1st, and downloadable at any
// time from the Activity Log screen.
//
// THE MONTH IS A SOUTH AFRICAN MONTH. Render runs in UTC and SAST is UTC+2, so
// a month boundary taken in UTC puts everything between midnight and 02:00 on
// the 1st into the wrong report. Every boundary here is computed in
// Africa/Johannesburg for the same reason the daily vote rule is.

const pool = require('../db');
const PDFDocument = require('pdfkit');

// What the report groups by. Order is the order they appear.
//
// Written out rather than derived from the data so the report has a stable
// shape month to month: a section that is empty says "none", which is itself
// worth reading. An action that matches nothing here still appears, under
// "Everything else" — a record that silently drops rows is not a record.
const GROUPS = [
  {
    key: 'approvals',
    title: 'Approvals and rejections',
    match: /_(approved|rejected)$/,
  },
  {
    key: 'changes',
    title: 'Changes requested and resubmitted',
    match: /^changes_/,
  },
  {
    key: 'submissions',
    title: 'Submitted by members',
    match: /_submitted$/,
  },
  {
    key: 'votes',
    title: 'Votes added, reversed and adjusted',
    match: /vote/,
  },
  {
    key: 'money',
    title: 'Payments, credits and orders',
    match: /^(payment_|order_|credit_|voucher_|cancellation_)/,
  },
  {
    key: 'access',
    title: 'Accounts and access',
    match: /^(user_|two_factor|login_|admin_created|password_)/,
  },
];

function groupFor(action) {
  const found = GROUPS.find((g) => g.match.test(action));
  return found ? found.key : 'other';
}

// The first instant of a South African month, as a UTC timestamp.
//
// SAST is UTC+2 with no daylight saving, which is what makes this safe to do
// by arithmetic rather than with a timezone library: midnight on the 1st in
// Johannesburg is 22:00 on the last day of the previous month in UTC.
function monthBounds(year, month) {
  const startUtc = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0) - 2 * 60 * 60 * 1000);
  const endUtc = new Date(Date.UTC(year, month, 1, 0, 0, 0) - 2 * 60 * 60 * 1000);
  return { startUtc, endUtc };
}

// The month before the one containing `now`, in SA terms.
function previousMonth(now = new Date()) {
  const sa = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  let year = sa.getUTCFullYear();
  let month = sa.getUTCMonth();          // 0-based; this IS the previous month 1-based
  if (month === 0) { year -= 1; month = 12; }
  return { year, month };
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function monthLabel(year, month) {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

// Everything recorded in one month, already grouped and counted.
async function gather(year, month, client = pool) {
  const { startUtc, endUtc } = monthBounds(year, month);

  const rows = await client.query(
    `SELECT a.id, a.action, a.details, a.created_at, a.actor_role, a.high_risk,
            u.email AS actor_email, u.full_name AS actor_name
       FROM admin_activity_log a
       LEFT JOIN users u ON u.id = a.admin_user_id
      WHERE a.created_at >= $1 AND a.created_at < $2
      ORDER BY a.created_at ASC, a.id ASC`,
    [startUtc, endUtc]
  );

  const entries = rows.rows.map((r) => ({
    ...r,
    group: groupFor(r.action),
  }));

  const counts = {};
  for (const e of entries) counts[e.action] = (counts[e.action] || 0) + 1;

  return {
    year,
    month,
    label: monthLabel(year, month),
    from: startUtc,
    to: endUtc,
    total: entries.length,
    byAdmin: entries.filter((e) => e.actor_role !== 'member').length,
    byMember: entries.filter((e) => e.actor_role === 'member').length,
    highRisk: entries.filter((e) => e.high_risk).length,
    counts,
    entries,
  };
}

// The document. Same house style as the invoices, deliberately: a member and an
// accountant should not have to learn two layouts.
function render(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).font('Helvetica-Bold').fillColor('#d20709').text('Unplug Magazine');
    doc.fontSize(10).font('Helvetica').fillColor('#454545')
      .text('Record of activity');
    doc.moveDown(1.2);

    doc.fontSize(16).font('Helvetica-Bold').fillColor('#0f0e0e').text(report.label);
    doc.fontSize(10).font('Helvetica').fillColor('#454545')
      .text(`${report.total} recorded action${report.total === 1 ? '' : 's'}`
        + ` — ${report.byAdmin} by Unplug, ${report.byMember} by members`
        + (report.highRisk ? `, ${report.highRisk} flagged high risk` : ''));
    doc.moveDown(1);

    if (report.total === 0) {
      doc.fontSize(11).fillColor('#0f0e0e')
        .text('Nothing was recorded in this month.');
      doc.end();
      return;
    }

    // A summary first: what happened, how often. Somebody checking the month
    // should not have to read every line to see the shape of it.
    doc.fontSize(12).font('Helvetica-Bold').fillColor('#0f0e0e').text('Summary');
    doc.moveDown(0.4);
    doc.fontSize(10).font('Helvetica');
    const summary = Object.entries(report.counts).sort((a, b) => b[1] - a[1]);
    for (const [action, n] of summary) {
      doc.fillColor('#454545').text(`${readable(action)}   ${n}`);
    }
    doc.moveDown(1);

    // Then the detail, grouped.
    for (const group of [...GROUPS, { key: 'other', title: 'Everything else' }]) {
      const rows = report.entries.filter((e) => e.group === group.key);
      if (!rows.length) continue;

      if (doc.y > 700) doc.addPage();
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#0f0e0e').text(group.title);
      doc.moveDown(0.3);
      doc.fontSize(9).font('Helvetica');

      for (const r of rows) {
        if (doc.y > 770) doc.addPage();
        const when = new Date(r.created_at).toLocaleString('en-ZA',
          { timeZone: 'Africa/Johannesburg', dateStyle: 'short', timeStyle: 'short' });
        const who = r.actor_name || r.actor_email || 'unknown';
        const line = `${when}   ${readable(r.action)}   ${who}`
          + (r.details ? `   ${String(r.details).slice(0, 90)}` : '');
        doc.fillColor(r.high_risk ? '#8a1013' : '#454545').text(line, { width: 495 });
      }
      doc.moveDown(0.8);
    }

    doc.fontSize(8).fillColor('#79726a').moveDown(1)
      .text('Generated automatically by Unplug Magazine. Times are South African.',
        50, doc.y, { width: 495 });

    doc.end();
  });
}

// 'vote_bundle_reversed' -> 'Vote bundle reversed'
function readable(action) {
  const words = String(action).replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

async function buildForMonth(year, month, client = pool) {
  const report = await gather(year, month, client);
  const pdf = await render(report);
  return { report, pdf, filename: `unplug-activity-${year}-${String(month).padStart(2, '0')}.pdf` };
}

module.exports = {
  GROUPS, groupFor, monthBounds, previousMonth, monthLabel,
  gather, render, buildForMonth, readable,
};
