// Emails last month's record on the 1st, once.
//
// WHY A SETTING RATHER THAN A TIMER THAT REMEMBERS. Render restarts the process
// on every deploy and whenever the free instance sleeps, so anything held in
// memory about "already sent this month" is lost — and the report would go out
// again on the next restart, every restart, all month. The month that was last
// sent is written to `settings`, so a restart changes nothing.
//
// The check runs hourly rather than at a fixed moment for the same reason: an
// instance asleep at 00:05 on the 1st would miss a once-a-day appointment
// entirely.

const pool = require('../db');
const activityReport = require('./activityReport');
const { sendEmail } = require('./email');

const SETTING_KEY = 'activity_report_last_sent';
const CHECK_INTERVAL_MS = 60 * 60 * 1000;   // hourly

// Who gets it. A setting so it can be changed without a deploy; the address the
// site already uses elsewhere is the default.
const RECIPIENT_KEY = 'activity_report_email';
const DEFAULT_RECIPIENT = 'info@unplugnews.com';

async function readSetting(key) {
  try {
    const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return r.rows.length ? r.rows[0].value : null;
  } catch (err) {
    return null;
  }
}

async function writeSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}

// Send it, and record that it went. Exported so it can be tested and so an
// admin action could trigger it.
async function sendFor(year, month) {
  const { report, pdf, filename } = await activityReport.buildForMonth(year, month);
  const to = (await readSetting(RECIPIENT_KEY)) || DEFAULT_RECIPIENT;

  const lines = [
    `The record of everything that happened on Unplug Magazine in ${report.label}.`,
    '',
    `${report.total} recorded action${report.total === 1 ? '' : 's'}:`,
    `  ${report.byAdmin} by Unplug`,
    `  ${report.byMember} submitted by members`,
  ];
  if (report.highRisk) lines.push(`  ${report.highRisk} flagged high risk`);
  lines.push('', 'The full record is attached as a PDF.',
    'It is also downloadable at any time from the Activity Log screen in the admin dashboard.');

  const sent = await sendEmail({
    to,
    subject: `Unplug activity — ${report.label}`,
    text: lines.join('\n'),
    attachments: [{ filename, content: pdf }],
  });

  // WITH NO EMAIL PROVIDER CONFIGURED, sendEmail logs the message and returns
  // { simulated: true } rather than throwing. Writing the "already sent" mark
  // on the back of that would be the worst outcome available: the month would
  // be recorded as delivered, nothing would arrive, and nothing would say so
  // until somebody went looking for a report they believed they had.
  //
  // Raised instead, so the month stays due and goes out properly once a
  // provider is configured.
  if (sent && sent.simulated) {
    throw new Error(
      `no email provider is configured, so the record for ${report.label} was not sent`);
  }

  await writeSetting(SETTING_KEY, `${year}-${String(month).padStart(2, '0')}`);
  return { to, filename, total: report.total, label: report.label };
}

// Due when the previous SA month has not been sent yet.
async function due(now = new Date()) {
  const { year, month } = activityReport.previousMonth(now);
  const stamp = `${year}-${String(month).padStart(2, '0')}`;
  const last = await readSetting(SETTING_KEY);
  return last === stamp ? null : { year, month, stamp };
}

let timer = null;
let warned = false;

function start() {
  if (timer) return timer;
  timer = setInterval(() => {
    due()
      .then((d) => {
        if (!d) return null;
        return sendFor(d.year, d.month)
          .then((r) => console.log(`[activity report] ${r.label} sent to ${r.to} (${r.total} entries)`));
      })
      .catch((err) => {
        // Logged once rather than hourly: a message repeated every hour is one
        // everybody learns to scroll past.
        if (!warned) {
          console.error('[activity report] could not send:', err.message);
          warned = true;
        }
      });
  }, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return timer;
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, due, sendFor, SETTING_KEY, RECIPIENT_KEY, DEFAULT_RECIPIENT };
