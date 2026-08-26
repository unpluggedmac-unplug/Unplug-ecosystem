// The tick: scheduled campaigns that have come due, and drip steps that are ready.
//
// THIS IS THE MOST DANGEROUS FILE IN THE EMAIL PLATFORM, because it is the
// only part that sends mail with nobody watching. Everything else needs an
// admin to press a button and see the result. This runs at three in the
// morning, and if it gets it wrong four hundred people get the same email
// twice before anybody notices.
//
// SO EVERY SEND IS CLAIMED BEFORE IT HAPPENS.
//
// A campaign is moved out of 'scheduled' by the same UPDATE that finds it:
//
//   UPDATE ... SET status='sending' WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)
//
// If two ticks overlap — and they will, because a send to four hundred
// addresses takes longer than the interval between ticks — the second one
// finds nothing, because the first already changed the row. The naive version
// (select the due ones, then send, then mark them sent) sends everything twice
// the first time a send runs long. Same shape for an automation step: the
// enrolment is moved forward before the mail goes out, not after.
//
// WHICH MEANS A CRASH MID-SEND LOSES MAIL RATHER THAN DUPLICATING IT, and that
// is the deliberate choice. A campaign stuck in 'sending' is visible in the
// admin screen and can be looked at by a person. Four hundred duplicate emails
// cannot be taken back.
//
// IT ONLY RUNS WHILE THE INSTANCE IS AWAKE. Render's free tier sleeps when
// idle, so this is the same caveat the birthday mailer and the backup runner
// carry: for a guarantee, point an external scheduler at POST /admin/email/tick
// with UNPLUG_CLEANUP_SECRET. Missing a tick delays a send, it does not lose
// it — the next tick picks up anything still due.

const pool = require('../db');
const marketing = require('./emailMarketing');
const renderer = require('./emailRenderer');

// How long a campaign may sit in 'sending' before it is treated as abandoned.
// Long enough that a genuinely large send is never interrupted, short enough
// that a restart mid-send does not leave a campaign stuck for a day.
const STUCK_AFTER_MINUTES = 60;

// Sends are spaced rather than fired all at once. A free-tier instance opening
// four hundred simultaneous HTTPS requests to the mail provider is how you get
// rate-limited by the provider and memory-killed by the host in the same
// minute.
const CONCURRENCY = 4;

async function inBatches(items, worker, size = CONCURRENCY) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...await Promise.all(items.slice(i, i + size).map(worker)));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Scheduled campaigns
// ---------------------------------------------------------------------------

// Claims ONE due campaign, atomically. Returns null when there is nothing to do.
//
// SKIP LOCKED rather than a plain FOR UPDATE: if another connection is already
// looking at this row, move on to the next one instead of waiting for it. On a
// single instance that is belt and braces; it becomes the thing that works if
// this ever runs on two.
async function claimDueCampaign() {
  const r = await pool.query(`
    UPDATE email_campaigns
       SET status = 'sending', started_at = now()
     WHERE id = (
       SELECT id FROM email_campaigns
        WHERE status = 'scheduled' AND scheduled_for IS NOT NULL AND scheduled_for <= now()
        ORDER BY scheduled_for
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
    RETURNING *`);
  return r.rowCount ? r.rows[0] : null;
}

// Sends a campaign that has already been claimed.
//
// Never throws: a campaign that fails must end up marked and visible, not
// bring down the tick and leave the next one unattempted.
async function sendClaimedCampaign(campaign) {
  try {
    const { html, text } = renderer.render({
      subject: campaign.subject,
      preheader: campaign.preheader,
      blocks: campaign.blocks,
    });

    if (!campaign.list_id) throw new Error('The campaign has no list.');
    const audience = await marketing.audienceFor(campaign.list_id);

    const results = await inBatches(audience.willSend, (email) => marketing.sendOne({
      campaignId: campaign.id,
      email,
      subject: campaign.subject,
      html,
      text,
    }));

    await pool.query(
      `UPDATE email_campaigns SET status = 'sent', sent_at = now() WHERE id = $1`, [campaign.id]);

    return {
      campaignId: campaign.id,
      sent: results.filter((r) => r.status === 'sent').length,
      failed: results.filter((r) => r.status === 'failed').length,
      // Suppressed at the moment of sending — somebody who unsubscribed while
      // this was running. audience.willSkip is the count from before it began.
      skipped: results.filter((r) => r.status === 'skipped').length + audience.willSkip.length,
    };
  } catch (err) {
    // BACK TO 'draft', not to 'scheduled'. Returning it to scheduled would
    // have the next tick try again immediately and fail the same way for ever,
    // sending a partial campaign each time. A draft is a thing a person looks
    // at.
    await pool.query(
      `UPDATE email_campaigns SET status = 'draft' WHERE id = $1`, [campaign.id]);
    console.error(`[email] campaign ${campaign.id} failed:`, err.message);
    return { campaignId: campaign.id, error: err.message };
  }
}

// Anything left in 'sending' long after it started — the instance restarted
// mid-send. Put back to draft so somebody can see it and decide, rather than
// resent automatically: some of it already went out, and the system has no way
// to know how much.
async function releaseStuckCampaigns() {
  const r = await pool.query(`
    UPDATE email_campaigns
       SET status = 'draft'
     WHERE status = 'sending'
       AND started_at IS NOT NULL
       AND started_at < now() - ($1 || ' minutes')::interval
    RETURNING id`, [String(STUCK_AFTER_MINUTES)]);
  if (r.rowCount) {
    console.warn(`[email] ${r.rowCount} campaign(s) were interrupted mid-send and are back in drafts: `
      + r.rows.map((x) => x.id).join(', '));
  }
  return r.rows.map((x) => x.id);
}

// ---------------------------------------------------------------------------
// Automation steps
// ---------------------------------------------------------------------------

// Claims up to `limit` due enrolments, moving each one forward in the same
// statement. After this returns, none of these rows can be claimed again by
// another tick — the mail has not been sent yet, and that is the point.
async function claimDueEnrolments(limit = 50) {
  const r = await pool.query(`
    WITH due AS (
      SELECT e.id,
             -- WHICH STEP COMES NEXT is worked out here, in the claim, and
             -- NULL means there isn't one. Leaving last_position unchanged in
             -- that case would have the sender look up the step it just sent
             -- and send it a second time — which is the exact failure this
             -- whole file exists to prevent, so the end of a sequence is
             -- decided in the same statement rather than afterwards.
             (SELECT min(s.position) FROM email_automation_steps s
               WHERE s.automation_id = e.automation_id AND s.position > e.last_position)
               AS next_position
        FROM email_automation_enrolments e
        JOIN email_automations a ON a.id = e.automation_id
       WHERE e.status = 'active'
         AND e.next_run_at <= now()
         AND a.active = true
       ORDER BY e.next_run_at
       FOR UPDATE OF e SKIP LOCKED
       LIMIT $1)
    UPDATE email_automation_enrolments e
       SET last_position = COALESCE(due.next_position, e.last_position),
           status = CASE WHEN due.next_position IS NULL THEN 'completed' ELSE 'active' END,
           stopped_reason = CASE WHEN due.next_position IS NULL
                                 THEN 'reached the end' ELSE e.stopped_reason END,
           updated_at = now(),
           -- Parked a long way out. The real next_run_at is set once the step
           -- has been sent and the following step's delay is known; until then
           -- this stops a second tick picking the row up while the first is
           -- still working on it.
           next_run_at = now() + interval '1 year'
      FROM due
     WHERE e.id = due.id
    RETURNING e.*`, [limit]);
  return r.rows;
}

// Sends the step an enrolment has just been moved onto, then schedules the one
// after it — or completes the enrolment when there is none.
async function runEnrolment(enrolment) {
  // The claim already decided this one had no step left and completed it.
  // Nothing to send, and nothing to put right.
  if (enrolment.status !== 'active') return { enrolmentId: enrolment.id, done: true };

  try {
    const step = await pool.query(
      `SELECT * FROM email_automation_steps WHERE automation_id = $1 AND position = $2`,
      [enrolment.automation_id, enrolment.last_position]);

    // The step existed when the claim ran and does not now — an admin deleted
    // it in between. Finished rather than retried, because retrying would hunt
    // for a step that is not coming back.
    if (step.rowCount === 0) {
      await pool.query(
        `UPDATE email_automation_enrolments
            SET status = 'completed', stopped_reason = 'the step was removed', updated_at = now()
          WHERE id = $1`, [enrolment.id]);
      return { enrolmentId: enrolment.id, done: true };
    }

    const row = step.rows[0];
    const { html, text } = renderer.render({
      subject: row.subject, preheader: row.preheader, blocks: row.blocks,
    });

    const result = await marketing.sendOne({
      automationStepId: row.id,
      email: enrolment.email,
      subject: row.subject,
      html,
      text,
    });

    // Somebody who unsubscribed between being claimed and being sent to. The
    // send was correctly skipped; the sequence should stop as well rather than
    // walking through the remaining steps producing skipped rows.
    if (result.status === 'skipped') {
      await pool.query(
        `UPDATE email_automation_enrolments
            SET status = 'cancelled', stopped_reason = $2, updated_at = now()
          WHERE id = $1`, [enrolment.id, String(result.skip_reason || 'suppressed').slice(0, 40)]);
      return { enrolmentId: enrolment.id, skipped: true };
    }

    const next = await pool.query(
      `SELECT delay_hours FROM email_automation_steps
        WHERE automation_id = $1 AND position > $2 ORDER BY position LIMIT 1`,
      [enrolment.automation_id, enrolment.last_position]);

    if (next.rowCount === 0) {
      await pool.query(
        `UPDATE email_automation_enrolments
            SET status = 'completed', stopped_reason = 'reached the end', updated_at = now()
          WHERE id = $1`, [enrolment.id]);
      return { enrolmentId: enrolment.id, sent: result.status === 'sent', done: true };
    }

    await pool.query(
      `UPDATE email_automation_enrolments
          SET next_run_at = now() + ($2 || ' hours')::interval, updated_at = now()
        WHERE id = $1`, [enrolment.id, String(Math.max(0, Number(next.rows[0].delay_hours) || 0))]);

    return { enrolmentId: enrolment.id, sent: result.status === 'sent' };
  } catch (err) {
    // Try again in an hour rather than never, and rather than immediately.
    // The common cause is the mail provider being briefly unreachable, and an
    // immediate retry would hammer it; the enrolment has already been moved
    // forward, so the retry sends the step it is now on exactly once.
    await pool.query(
      `UPDATE email_automation_enrolments
          SET next_run_at = now() + interval '1 hour', updated_at = now()
        WHERE id = $1`, [enrolment.id]).catch(() => {});
    console.error(`[email] automation enrolment ${enrolment.id} failed:`, err.message);
    return { enrolmentId: enrolment.id, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// One tick
// ---------------------------------------------------------------------------

// ONE CAMPAIGN PER TICK. A campaign send is the long operation here; doing two
// at once on a 512 MB instance while the magazine is also serving readers is
// how the process gets killed. The next tick takes the next one, and a
// schedule that queues two campaigns for the same minute sends the second a
// few minutes late — which nobody notices, unlike an outage.
async function tick() {
  const out = { campaigns: [], enrolments: [], released: [] };

  out.released = await releaseStuckCampaigns().catch((err) => {
    console.error('[email] releasing stuck campaigns failed:', err.message);
    return [];
  });

  try {
    const campaign = await claimDueCampaign();
    if (campaign) out.campaigns.push(await sendClaimedCampaign(campaign));
  } catch (err) {
    console.error('[email] scheduled campaign tick failed:', err.message);
  }

  try {
    const due = await claimDueEnrolments();
    for (const enrolment of due) out.enrolments.push(await runEnrolment(enrolment));
  } catch (err) {
    console.error('[email] automation tick failed:', err.message);
  }

  return out;
}

// Every five minutes. A scheduled campaign is set for a time somebody chose to
// the minute, so a longer interval would visibly miss it; a shorter one is
// query traffic for nothing, because nobody schedules mail to the second.
const TICK_MS = 5 * 60 * 1000;
let timer = null;

function start() {
  if (timer) return timer;
  timer = setInterval(() => {
    tick()
      .then((r) => {
        const sent = r.campaigns.reduce((n, c) => n + (c.sent || 0), 0)
          + r.enrolments.filter((e) => e.sent).length;
        if (sent) console.log(`[email] tick sent ${sent} message(s)`);
      })
      .catch((err) => console.error('[email] tick failed:', err.message));
  }, TICK_MS);
  // Does not hold the process open on its own — the HTTP server does that,
  // and a timer that keeps a dying process alive is a restart that hangs.
  if (timer.unref) timer.unref();
  return timer;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  tick, start, stop,
  claimDueCampaign, sendClaimedCampaign, claimDueEnrolments, runEnrolment,
  releaseStuckCampaigns,
  TICK_MS, STUCK_AFTER_MINUTES, CONCURRENCY,
};
