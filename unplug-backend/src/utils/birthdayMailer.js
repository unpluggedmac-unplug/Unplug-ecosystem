const pool = require('../db');
const { sendEmail, isConfigured } = require('./email');

// The birthday greeting, exactly as the editorial team wrote it.
const BIRTHDAY_MESSAGE = `Dear Unplugger.

Happy Birthday from all of us at Unplug Magazine!

Today is all about celebrating you.

As you begin another chapter, we hope this year brings you new opportunities, meaningful connections, unforgettable moments, and the courage to chase every goal that matters to you.

Thank you for being part of the Unplug Magazine community. Together, we're building a movement that inspires people to unplug from the noise and plug into their purpose.

May your year ahead be filled with happiness, success, good health, and endless inspiration.

Have an amazing birthday and enjoy every moment, we celebrate it with YOU!

Warm birthday wishes,

The Unplug Magazine Team
Unplug from the noise. Plug into your purpose.`;

// Today in South African time. The server runs in UTC, and for two hours
// each night that is the previous day here — which would send greetings a
// day early, on the wrong date, to South African readers.
function todayInSA() {
  const parts = new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

// Sends today's greetings. Safe to call repeatedly: the sent-log is written
// BEFORE the send and keyed per person per year, so a second run finds
// nothing to do rather than sending again.
async function sendDueBirthdayEmails() {
  const { year, month, day } = todayInSA();

  if (!isConfigured()) {
    return { skipped: true, reason: 'No email provider is configured, so nothing was sent.', sent: 0, failed: 0, date: `${year}-${month}-${day}` };
  }

  const due = await pool.query(
    `SELECT b.id, b.name, b.email
       FROM birthdays b
      WHERE b.status = 'approved'
        AND b.birth_month = $1
        AND b.birth_day = $2
        AND b.email IS NOT NULL
        AND b.email <> ''
        AND NOT EXISTS (
          SELECT 1 FROM birthday_emails_sent s
           WHERE s.birthday_id = b.id AND s.sent_year = $3
        )`,
    [month, day, year]
  );

  let sent = 0;
  const failures = [];
  for (const row of due.rows) {
    // Claim it first. If the send then fails we'd rather miss a greeting than
    // risk sending two — and a failure is reported, not swallowed.
    const claim = await pool.query(
      `INSERT INTO birthday_emails_sent (birthday_id, sent_year) VALUES ($1, $2)
       ON CONFLICT (birthday_id, sent_year) DO NOTHING RETURNING birthday_id`,
      [row.id, year]
    );
    if (claim.rowCount === 0) continue; // another run got there first

    try {
      await sendEmail({
        to: row.email,
        subject: 'Happy Birthday from Unplug Magazine!',
        text: BIRTHDAY_MESSAGE,
      });
      sent += 1;
    } catch (err) {
      // Release the claim so tomorrow's run can retry — the greeting is
      // still worth sending late if today's attempt failed for a transient
      // reason. Same-day retries will pick it up too.
      await pool.query(
        'DELETE FROM birthday_emails_sent WHERE birthday_id = $1 AND sent_year = $2',
        [row.id, year]
      );
      failures.push({ name: row.name, error: err.message });
      console.error(`[birthday] failed to send to ${row.name}:`, err.message);
    }
  }

  return {
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    due: due.rowCount,
    sent,
    failed: failures.length,
    failures,
  };
}

module.exports = { sendDueBirthdayEmails, BIRTHDAY_MESSAGE, todayInSA };
