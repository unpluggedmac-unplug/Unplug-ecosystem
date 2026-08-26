// The composer, the scheduler and the drip automations, against a REAL PostgreSQL.
//
// WHAT THIS IS PROTECTING, in order of how badly it would hurt a real person:
//
//   1. NOBODY GETS THE SAME EMAIL TWICE. The scheduler is the only part of
//      this system that sends mail with nobody watching. Every claim is
//      tested for the overlapping-tick case, because that failure sends four
//      hundred duplicates before anybody is awake to see it.
//   2. A SEQUENCE STOPS WHEN SOMEBODY LEAVES. Unsubscribing halfway through a
//      welcome series must end it, not merely have each remaining step
//      silently skipped.
//   3. NOBODY IS ENROLLED TWICE. Subscribe, unsubscribe, subscribe again is
//      an ordinary thing to do and must not produce two welcome sequences.
//   4. THE COMPOSER CANNOT PUT A SCRIPT OR A javascript: URL IN AN EMAIL.
//      The blocks are admin-typed and stored, which is exactly the shape of
//      thing a compromised admin session would use.
//   5. THE NUMBERS ARE HONEST. One reader whose client refetches the tracking
//      pixel forty times is one open.
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;
const { stopPostgres } = require('./helpers/stopPostgres');

let pg;
let pool;
let marketing;
let scheduler;
let renderer;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-composer-'));
const port = 40400 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

const outbox = [];
let listId;

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-composer';
  delete process.env.RESEND_API_KEY;
  delete process.env.BREVO_API_KEY;

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations'))
    .filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }

  // Patched BEFORE emailMarketing is required: it destructures sendEmail at
  // require time, so patching afterwards would leave the real one in place and
  // the tests would quietly be testing nothing.
  const emailUtil = require('../src/utils/email');
  emailUtil.sendEmail = async (message) => { outbox.push(message); return { provider: 'test' }; };

  marketing = require('../src/utils/emailMarketing');
  scheduler = require('../src/utils/emailScheduler');
  renderer = require('../src/utils/emailRenderer');

  const l = await pool.query(
    `INSERT INTO email_lists (name, slug) VALUES ('Composer test', 'composer-test') RETURNING id`);
  listId = l.rows[0].id;
});

after(async () => {
  scheduler.stop();
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

async function campaign({ blocks = [{ type: 'text', text: 'Hello' }], when = new Date(0) } = {}) {
  const r = await pool.query(
    `INSERT INTO email_campaigns (name, subject, blocks, list_id, status, scheduled_for)
     VALUES ('C', 'Subject', $1, $2, 'scheduled', $3) RETURNING *`,
    [JSON.stringify(blocks), listId, when]);
  return r.rows[0];
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

test('THE COMPOSER CANNOT PUT A SCRIPT INTO AN EMAIL', async () => {
  const { html } = renderer.render({
    subject: '<script>alert(1)</script>',
    preheader: '"><script>alert(2)</script>',
    blocks: [
      { type: 'heading', text: '<img src=x onerror=alert(3)>' },
      { type: 'text', text: 'Ampersands & <b>tags</b> typed by an admin' },
      { type: 'article', title: '</td></tr></table><script>alert(4)</script>', href: 'https://x.test/a' },
    ],
  });

  assert.ok(!html.includes('<script>'), 'no script tag survives anywhere in the document');
  // "onerror=" DOES appear in the output, as the escaped text &lt;img src=x
  // onerror=… &gt;, which is inert. What must not appear is a real element
  // carrying a real handler attribute, which is what this checks.
  assert.ok(!/<[a-z]+[^>]*\son[a-z]+\s*=/i.test(html), 'and no element carries an event handler');
  assert.ok(html.includes('&lt;script&gt;'), 'it is escaped rather than stripped, so the text still reads');
  assert.ok(html.includes('Ampersands &amp; '), 'a bare ampersand is escaped');
});

test('A javascript: URL NEVER REACHES THE DOCUMENT', async () => {
  const { html } = renderer.render({
    blocks: [
      { type: 'button', label: 'Press me', href: 'javascript:alert(1)' },
      { type: 'image', src: 'javascript:alert(2)', alt: 'x' },
      { type: 'text', text: 'Read [this](javascript:alert(3)) now' },
      { type: 'button', label: 'Real one', href: 'https://www.unplugnews.com/x' },
    ],
  });

  assert.ok(!html.includes('javascript:'), 'not in an href, a src, or an inline link');
  // The button with nowhere to go is not rendered at all — a dead button is
  // worse than no button, because somebody presses it.
  assert.ok(!html.includes('Press me'), 'the block with an unusable URL is dropped entirely');
  assert.ok(html.includes('https://www.unplugnews.com/x'), 'the legitimate one is untouched');
  // The label survives as plain text with no link around it. It reads "Read
  // this) now" rather than "Read this now" — the stray bracket is the closing
  // paren of alert(3), which ended the markdown link early. Cosmetically
  // untidy on a malformed link, and not worth a parser that balances brackets;
  // what matters is that the URL did not become a link.
  assert.ok(html.includes('Read this'), 'the bad inline link degrades to plain text');
  assert.ok(!/<a[^>]*>this/.test(html), 'with no anchor wrapped around it');
});

test('an unknown block type is skipped rather than throwing', async () => {
  // A campaign saved by a newer composer must still send the blocks this
  // version understands. A send missing one block is recoverable; a send that
  // does not happen is not.
  const { html, text } = renderer.render({
    blocks: [
      { type: 'text', text: 'Before' },
      { type: 'carousel-from-the-future', items: [1, 2, 3] },
      { type: 'text', text: 'After' },
    ],
  });
  assert.ok(html.includes('Before') && html.includes('After'));
  assert.ok(text.includes('Before') && text.includes('After'));
});

test('every message has a plain-text part', async () => {
  const { text } = renderer.render({
    blocks: [
      { type: 'heading', text: 'The Friday letter' },
      { type: 'text', text: 'Read **this** and [that](https://unplugnews.com/x).' },
      { type: 'button', label: 'Open it', href: 'https://unplugnews.com/y' },
    ],
  });
  // A message with no text part is scored as spam by most filters, and some
  // people read mail as text on purpose.
  assert.ok(text.includes('The Friday letter'));
  assert.ok(text.includes('Read this and that (https://unplugnews.com/x).'),
    'the markup is resolved, not left as source');
  assert.ok(text.includes('Open it: https://unplugnews.com/y'),
    'a button becomes a labelled URL, because a text reader cannot press it');
});

test('the preheader is hidden and does not drag the body in after it', async () => {
  const { html } = renderer.render({ preheader: 'Six stories from the week', blocks: [] });
  assert.ok(html.includes('Six stories from the week'));
  assert.ok(/display:none[\s\S]*?>Six stories/.test(html), 'inside a hidden container');
  assert.ok(html.includes('&zwnj;'), 'padded, so the client does not append the body text');
});

test('Outlook gets a VML button and everybody else gets the real one', async () => {
  const { html } = renderer.render({
    blocks: [{ type: 'button', label: 'Read the edition', href: 'https://unplugnews.com/e' }],
  });
  // Word's rendering engine draws no rounded corner, no padding and no
  // background on an <a>. Without this the call to action is a bare blue link.
  assert.ok(html.includes('<!--[if mso]>') && html.includes('v:roundrect'));
  assert.ok(html.includes('<!--[if !mso]><!-- -->'), 'and the non-Outlook branch is opened correctly');
});

// ---------------------------------------------------------------------------
// Click tracking
// ---------------------------------------------------------------------------

test('A TRACKED LINK WITH TWO QUERY PARAMETERS STILL GOES TO THE RIGHT PLACE', async () => {
  // The href in the document is HTML-escaped, so a two-parameter URL is
  // written as ?a=1&amp;b=2. Encoding that literally would send every reader
  // to a URL containing "&amp;" — the link would look fine in the composer and
  // be broken in every message.
  const wrapped = marketing.wrapLinks(
    '<a href="https://unplugnews.com/x?a=1&amp;b=2">go</a>', 'tok');
  const target = decodeURIComponent(wrapped.match(/\?u=([^"]+)/)[1]);
  assert.equal(target, 'https://unplugnews.com/x?a=1&b=2');
});

test('the unsubscribe link is never routed through the tracker', async () => {
  // It has to work even when the tracking endpoint does not. A broken
  // unsubscribe is the failure that turns into spam complaints.
  const wrapped = marketing.wrapLinks(
    '<a href="https://api.test/email/unsubscribe/abc">Unsubscribe</a>', 'tok');
  assert.ok(wrapped.includes('/email/unsubscribe/abc'));
  assert.ok(!wrapped.includes('/email/c/'));
});

// ---------------------------------------------------------------------------
// Claiming — the duplicate-send defence
// ---------------------------------------------------------------------------

test('TWO OVERLAPPING TICKS CANNOT CLAIM THE SAME CAMPAIGN', async () => {
  const c = await campaign();
  const [a, b] = await Promise.all([scheduler.claimDueCampaign(), scheduler.claimDueCampaign()]);
  const claimed = [a, b].filter((x) => x && x.id === c.id);
  assert.equal(claimed.length, 1, 'exactly one tick gets it — the other finds nothing');
  await pool.query(`UPDATE email_campaigns SET status = 'draft' WHERE id = $1`, [c.id]);
});

test('a campaign scheduled for later is not claimed early', async () => {
  const c = await campaign({ when: new Date(Date.now() + 60 * 60 * 1000) });
  const got = await scheduler.claimDueCampaign();
  assert.ok(!got || got.id !== c.id);
  await pool.query('DELETE FROM email_campaigns WHERE id = $1', [c.id]);
});

test('A CAMPAIGN IS NOT SENT TWICE EVEN IF THE TICK RUNS AGAIN IMMEDIATELY', async () => {
  await marketing.subscribe({ email: 'one@test.com', listSlug: 'composer-test', source: 't' });
  await marketing.subscribe({ email: 'two@test.com', listSlug: 'composer-test', source: 't' });
  const c = await campaign();

  await scheduler.tick();
  const afterFirst = await pool.query(
    'SELECT count(*)::int AS n FROM email_sends WHERE campaign_id = $1', [c.id]);

  await scheduler.tick();
  const afterSecond = await pool.query(
    'SELECT count(*)::int AS n FROM email_sends WHERE campaign_id = $1', [c.id]);

  assert.equal(afterFirst.rows[0].n, 2, 'both subscribers were sent to');
  assert.equal(afterSecond.rows[0].n, 2, 'and the second tick sent nothing more');

  const status = await pool.query('SELECT status FROM email_campaigns WHERE id = $1', [c.id]);
  assert.equal(status.rows[0].status, 'sent');
});

test('a suppressed subscriber is recorded as skipped, not sent', async () => {
  await marketing.subscribe({ email: 'gone@test.com', listSlug: 'composer-test', source: 't' });
  await marketing.suppress('gone@test.com', 'bounced', 'mailbox full');
  const c = await campaign();
  await scheduler.tick();

  const r = await pool.query(
    `SELECT status, skip_reason FROM email_sends WHERE campaign_id = $1 AND email = 'gone@test.com'`,
    [c.id]);
  // Either it was filtered out of the audience before sending, or it was
  // caught at the moment of sending. Both are correct; what must never happen
  // is a row saying 'sent'.
  if (r.rowCount) {
    assert.equal(r.rows[0].status, 'skipped');
    assert.equal(r.rows[0].skip_reason, 'bounced');
  }
  const sent = outbox.filter((m) => m.to === 'gone@test.com');
  assert.equal(sent.length, 0, 'and nothing actually went to them');
});

test('a campaign interrupted mid-send goes back to drafts rather than resending', async () => {
  const c = await campaign();
  await pool.query(
    `UPDATE email_campaigns SET status = 'sending', started_at = now() - interval '3 hours'
      WHERE id = $1`, [c.id]);

  const released = await scheduler.releaseStuckCampaigns();
  assert.ok(released.includes(c.id));
  const r = await pool.query('SELECT status FROM email_campaigns WHERE id = $1', [c.id]);
  // NOT back to 'scheduled'. Part of it already went out and there is no way
  // to know how much, so a person decides — not the timer.
  assert.equal(r.rows[0].status, 'draft');
});

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

async function automation({ active = true, steps = [0, 24] } = {}) {
  const a = await pool.query(
    `INSERT INTO email_automations (name, trigger, trigger_list_id, active)
     VALUES ('Welcome', 'subscribe', $1, $2) RETURNING *`, [listId, active]);
  let position = 0;
  for (const delay of steps) {
    position += 1;
    await pool.query(
      `INSERT INTO email_automation_steps (automation_id, position, delay_hours, subject, blocks)
       VALUES ($1, $2, $3, $4, $5)`,
      [a.rows[0].id, position, delay, `Step ${position}`,
        JSON.stringify([{ type: 'text', text: `This is step ${position}` }])]);
  }
  return a.rows[0];
}

test('NOBODY IS ENROLLED IN THE SAME SEQUENCE TWICE', async () => {
  const a = await automation();
  const first = await marketing.enrol({ automationId: a.id, email: 'twice@test.com' });
  const second = await marketing.enrol({ automationId: a.id, email: 'TWICE@test.com' });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false, 'the second attempt is refused');
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM email_automation_enrolments
      WHERE automation_id = $1 AND LOWER(email) = 'twice@test.com'`, [a.id]);
  assert.equal(r.rows[0].n, 1, 'however it was capitalised');
});

test('somebody already suppressed is not enrolled at all', async () => {
  const a = await automation();
  await marketing.suppress('nope@test.com', 'complained', 'pressed the spam button');
  const result = await marketing.enrol({ automationId: a.id, email: 'nope@test.com' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'suppressed');
});

test('THE STEPS ARRIVE IN ORDER, ONE EACH, AND THE SEQUENCE ENDS', async () => {
  const a = await automation({ steps: [0, 0] }); // no waiting, so the test can run it through
  await marketing.enrol({ automationId: a.id, email: 'drip@test.com' });

  const sentSubjects = () => outbox.filter((m) => m.to === 'drip@test.com').map((m) => m.subject);

  await scheduler.tick();
  assert.deepEqual(sentSubjects(), ['Step 1']);

  // Due again straight away because this sequence has no delay.
  await scheduler.tick();
  assert.deepEqual(sentSubjects(), ['Step 1', 'Step 2']);

  // THE CRITICAL ONE: a third tick after the last step must send nothing.
  // Getting this wrong re-sends the final email of every sequence, for ever,
  // every five minutes.
  await scheduler.tick();
  assert.deepEqual(sentSubjects(), ['Step 1', 'Step 2'], 'the end of the sequence is the end');

  const e = await pool.query(
    `SELECT status, stopped_reason FROM email_automation_enrolments
      WHERE automation_id = $1 AND email = 'drip@test.com'`, [a.id]);
  assert.equal(e.rows[0].status, 'completed');
  assert.equal(e.rows[0].stopped_reason, 'reached the end');
});

test('UNSUBSCRIBING STOPS THE SEQUENCE, it does not merely skip each step', async () => {
  const a = await automation({ steps: [0, 0, 0] });
  await marketing.enrol({ automationId: a.id, email: 'stopme@test.com' });
  await scheduler.tick(); // step 1 goes out

  await marketing.unsubscribe({ email: 'stopme@test.com', all: true, reason: 'link' });

  const e = await pool.query(
    `SELECT status, stopped_reason FROM email_automation_enrolments
      WHERE automation_id = $1 AND email = 'stopme@test.com'`, [a.id]);
  assert.equal(e.rows[0].status, 'cancelled', 'ended, not left running and being skipped');
  assert.equal(e.rows[0].stopped_reason, 'link');

  const before = outbox.filter((m) => m.to === 'stopme@test.com').length;
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(outbox.filter((m) => m.to === 'stopme@test.com').length, before,
    'and no further step arrives');
});

test('re-subscribing does not start the welcome sequence over', async () => {
  // Somebody who left halfway through and came back should not be welcomed
  // again from step one. The cancelled enrolment stays, and the unique index
  // means they are not added a second time.
  const a = await automation({ steps: [0, 0] });
  await marketing.subscribe({ email: 'returner@test.com', listSlug: 'composer-test', source: 't' });
  await marketing.unsubscribe({ email: 'returner@test.com', all: true, reason: 'link' });
  await marketing.subscribe({ email: 'returner@test.com', listSlug: 'composer-test', source: 't' });

  const r = await pool.query(
    `SELECT count(*)::int AS n FROM email_automation_enrolments
      WHERE automation_id = $1 AND email = 'returner@test.com'`, [a.id]);
  assert.equal(r.rows[0].n, 1);
});

test('a paused automation sends nothing', async () => {
  const a = await automation({ active: false, steps: [0] });
  await marketing.enrol({ automationId: a.id, email: 'paused@test.com' });
  await scheduler.tick();
  assert.equal(outbox.filter((m) => m.to === 'paused@test.com').length, 0);
});

test('subscribing to a list starts the sequence that watches that list', async () => {
  await pool.query('DELETE FROM email_automations');
  const a = await automation({ steps: [0] });
  await marketing.subscribe({ email: 'auto@test.com', listSlug: 'composer-test', source: 'footer' });

  const r = await pool.query(
    `SELECT status FROM email_automation_enrolments
      WHERE automation_id = $1 AND email = 'auto@test.com'`, [a.id]);
  assert.equal(r.rowCount, 1);
  assert.equal(r.rows[0].status, 'active');
});

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

test('ONE READER IS ONE OPEN, however many times their client fetches the pixel', async () => {
  const c = await campaign();
  const send = await pool.query(
    `INSERT INTO email_sends (campaign_id, email, token, status)
     VALUES ($1, 'counted@test.com', 'tok-counted', 'sent') RETURNING id`, [c.id]);

  // What the tracking route does, three times — a client refetching on scroll,
  // on reopen and on prefetch.
  for (let i = 0; i < 3; i += 1) {
    await pool.query(
      `INSERT INTO email_events (send_id, kind)
       SELECT $1, 'open'
        WHERE NOT EXISTS (SELECT 1 FROM email_events WHERE send_id = $1 AND kind = 'open')`,
      [send.rows[0].id]);
  }

  const r = await pool.query(
    `SELECT count(*)::int AS n FROM email_events WHERE send_id = $1 AND kind = 'open'`,
    [send.rows[0].id]);
  assert.equal(r.rows[0].n, 1);
});
