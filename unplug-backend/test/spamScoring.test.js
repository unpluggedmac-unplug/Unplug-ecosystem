// Spam scoring, against a REAL PostgreSQL.
//
// THE FAILURE THAT MATTERS IS THE FALSE POSITIVE, and it is not close. This is
// a South African community magazine. Its readers write in several languages,
// type on cheap phones, sometimes in capitals, often very briefly. Every one of
// those traits appears on somebody's list of spam indicators.
//
// If this system loses a nomination from somebody's grandmother, nobody ever
// finds out: not the moderator, not the magazine, and least of all the person
// who submitted it. A spam message sitting in a queue costs a moderator three
// seconds. The two are not comparable, and most of this file is about the
// first one.
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
let scorer;
let classifier;
let signals;
let spamCheck;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-spam-'));
const port = 38800 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

// A submission as it arrives: filled in slowly, by a browser that ran the
// page's JavaScript. Individual tests override what they are about.
function submission(fields, over = {}) {
  return {
    targetType: 'contact enquiry',
    fields,
    elapsedMs: 45000,
    jsTokenValid: true,
    ip: '41.2.3.4',
    ...over,
  };
}

before(async () => {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port,
    persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('unplug_test');

  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${port}/unplug_test`;
  process.env.JWT_SECRET = 'test-secret-for-spam';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  scorer = require('../src/utils/spamScorer');
  classifier = require('../src/utils/spamClassifier');
  signals = require('../src/utils/spamSignals');
  spamCheck = require('../src/middleware/spamCheck');
});

after(async () => {
  if (pool) await pool.end();
  await stopPostgres(pg, dataDir);
});

// ---------------------------------------------------------------------------
// The people this must not fail
// ---------------------------------------------------------------------------

test('A REAL NOMINATION IS NOT FLAGGED', async () => {
  const r = await scorer.assess(submission({
    name: 'Thandi Nkosi', email: 'thandi.nkosi@gmail.com',
    message: 'I would like to nominate my gogo. She has cooked for forty children '
           + 'in Soweto every Saturday for eleven years and has never asked anyone for anything.',
  }));
  assert.equal(r.verdict, 'clean', `scored ${r.score}: ${JSON.stringify(r.signals)}`);
});

test('A VERY SHORT COMMENT IS NOT FLAGGED', async () => {
  // "Beautiful." is a real comment. Length is not evidence of anything.
  const r = await scorer.assess(submission({ message: 'Beautiful.' }));
  assert.equal(r.verdict, 'clean');
});

test('SOMEBODY TYPING ENTIRELY IN CAPITALS IS NOT FLAGGED', async () => {
  // Common among older readers and on phones. It is a hint, worth a few
  // points, and must never be close to enough on its own.
  const r = await scorer.assess(submission({
    name: 'MARIA VAN WYK', email: 'maria@telkomsa.net',
    message: 'PLEASE CAN YOU TELL ME HOW MUCH IT COSTS TO ADVERTISE MY SMALL '
           + 'BUSINESS IN YOUR MAGAZINE. THANK YOU VERY MUCH.',
  }));
  assert.equal(r.verdict, 'clean', `scored ${r.score}`);
});

test('AN ADVERTISER MENTIONING LOANS IS A CUSTOMER, NOT SPAM', async () => {
  // This site sells advertising. A finance company asking for a rate card is
  // the business working, and a keyword list containing "loan" would refuse it.
  const r = await scorer.assess(submission({
    name: 'FinCo', email: 'ads@finco.co.za',
    message: 'We are a loan company based in Durban and would like to advertise '
           + 'in your magazine. Could you send your rate card please?',
  }));
  assert.equal(r.verdict, 'clean', `scored ${r.score}`);
});

test('a submission in Afrikaans or isiZulu is not penalised', async () => {
  // A filter that only recognises English would treat most of this readership
  // as unfamiliar.
  for (const message of [
    'Baie dankie vir die pragtige artikel oor die skool in Mitchells Plain. Ek wil graag my ma nomineer.',
    'Ngicela ukuncoma umama wami. Usebenza kanzima ukondla izingane zakithi eSoweto.',
  ]) {
    const r = await scorer.assess(submission({ name: 'Reader', message }));
    assert.equal(r.verdict, 'clean', `"${message.slice(0, 30)}..." scored ${r.score}`);
  }
});

test('two links in a nomination are normal', async () => {
  // Somebody's Facebook page and their shop. Perfectly ordinary.
  const r = await scorer.assess(submission({
    message: 'Please look at her page https://facebook.com/gogoskitchen and her '
           + 'shop www.gogoskitchen.co.za — she deserves this.',
  }));
  assert.equal(r.verdict, 'clean');
});

// ---------------------------------------------------------------------------
// The things that should be caught
// ---------------------------------------------------------------------------

test('OBVIOUS SPAM SCORES HIGH', async () => {
  const r = await scorer.assess(submission({
    name: 'SEO Expert', email: 'x@mailinator.com',
    message: 'Buy viagra cheap! SEO services and backlink packages, rank #1 on google. '
           + 'http://a.com http://b.com http://c.com http://d.com http://e.com',
  }, { elapsedMs: 800, jsTokenValid: false }));
  assert.equal(r.verdict, 'spam', `scored ${r.score}`);
});

test('THE HONEYPOT ALONE IS CONCLUSIVE', async () => {
  // A field no person can see. Filling it takes a program, and nothing
  // legitimate does it — the one signal that is allowed to decide by itself.
  const r = await scorer.assess(submission({
    message: 'Hello', website: 'http://spam.example.com',
  }));
  assert.equal(r.verdict, 'spam');
  assert.ok(r.signals.some((s) => s.name === 'honeypot'));
});

test('a form submitted in under a second is suspicious', async () => {
  const r = await scorer.assess(submission(
    { message: 'Nice article, please visit my site' },
    { elapsedMs: 400, jsTokenValid: false }));
  assert.ok(r.score >= 40, `scored ${r.score}, expected the timing and missing token to add up`);
});

test('the score is capped, so nothing runs away', async () => {
  const r = await scorer.assess(submission({
    name: 'x', email: 'x@guerrillamail.com', website: 'filled',
    message: 'viagra cialis porn backlink guest post earn $ make $ '
           + 'http://a.com http://b.com http://c.com http://d.com http://e.com http://f.com AAAAAAAAAAAA',
  }, { elapsedMs: 100, jsTokenValid: false }));
  assert.ok(r.score <= 100, `score was ${r.score}`);
});

// ---------------------------------------------------------------------------
// What a verdict actually causes
// ---------------------------------------------------------------------------

test('NOTHING IS AUTO-REJECTED BY DEFAULT', async () => {
  // The whole default posture: score it, sort it, let a person decide. A
  // 'spam' verdict is a label, not a fate.
  const r = await scorer.assess(submission({
    message: 'viagra backlink seo services', website: 'trap',
  }, { elapsedMs: 100, jsTokenValid: false }));
  assert.equal(r.verdict, 'spam');
  assert.equal(r.shouldAutoReject, false, 'auto-rejection is off unless an admin turns it on');
});

test('auto-rejection only happens when switched on AND the score clears the bar', async () => {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('spam_autoreject_enabled', 'true')
     ON CONFLICT (key) DO UPDATE SET value = 'true'`);
  scorer.invalidate();

  const spam = await scorer.assess(submission({ message: 'x', website: 'trap' }));
  assert.equal(spam.shouldAutoReject, true);

  const ordinary = await scorer.assess(submission({ message: 'Lovely piece, thank you.' }));
  assert.equal(ordinary.shouldAutoReject, false, 'a clean submission is never rejected');

  await pool.query(`UPDATE settings SET value = 'false' WHERE key = 'spam_autoreject_enabled'`);
  scorer.invalidate();
});

test('a broken signal never stops a submission', async () => {
  // The worst outcome here must be a missed spam message, never a contact form
  // that returns 500.
  const r = await scorer.assess({ targetType: 'x', fields: null, elapsedMs: 'nonsense' });
  assert.ok(['clean', 'suspect', 'spam'].includes(r.verdict));
});

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

test('THE CLASSIFIER STAYS SILENT UNTIL IT HAS EVIDENCE', async () => {
  // With no history it must contribute nothing at all, rather than guessing.
  const r = await classifier.score('a message about nothing in particular whatsoever');
  assert.equal(r.points, 0);
});

test('it learns from moderator decisions', async () => {
  // Enough repetitions to pass the evidence bar.
  for (let i = 0; i < 8; i++) {
    await classifier.learn('cryptoscheme guaranteed doubler wallet investment', 'spam');
    await classifier.learn('nomination gogo community soweto kitchen children', 'ham');
  }
  const spammy = await classifier.score('cryptoscheme doubler wallet guaranteed');
  const hammy = await classifier.score('nomination gogo community kitchen');
  assert.ok(spammy.points > 0, `learned spam words score positive, got ${spammy.points}`);
  assert.ok(hammy.points < 0, `learned ham words score negative, got ${hammy.points}`);
});

test('ITS INFLUENCE IS CAPPED, so it can never condemn on its own', async () => {
  // A classifier trained on a few hundred decisions is confident long before
  // it is right. It may nudge; it must not decide.
  for (let i = 0; i < 200; i++) {
    await classifier.learn('zzzspamword', 'spam');
  }
  const r = await classifier.score('zzzspamword zzzspamword zzzspamword');
  assert.ok(r.points <= classifier.MAX_INFLUENCE,
    `contributed ${r.points}, cap is ${classifier.MAX_INFLUENCE}`);
  assert.ok(r.points < 40, 'and stays below the suspect threshold by itself');
});

test('A CHANGED DECISION UNDOES THE OLD LESSON', async () => {
  // A moderator correcting a mistake must not teach the filter both answers.
  const word = 'reversalcheck';
  await classifier.learn(word, 'spam');
  let row = (await pool.query('SELECT spam_count, ham_count FROM spam_tokens WHERE token = $1', [word])).rows[0];
  assert.equal(row.spam_count, 1);

  await classifier.learn(word, 'ham', 'spam');
  row = (await pool.query('SELECT spam_count, ham_count FROM spam_tokens WHERE token = $1', [word])).rows[0];
  assert.equal(row.spam_count, 0, 'the original lesson was withdrawn');
  assert.equal(row.ham_count, 1, 'and replaced');
});

test('counts never go negative', async () => {
  const word = 'floorcheck';
  await classifier.learn(word, 'ham', 'spam'); // undoing something never recorded
  const row = (await pool.query('SELECT spam_count FROM spam_tokens WHERE token = $1', [word])).rows[0];
  assert.ok(row.spam_count >= 0);
});

// ---------------------------------------------------------------------------
// The form token
// ---------------------------------------------------------------------------

test('A FORGED TOKEN IS NOT TRUSTED', async () => {
  // Without a signature, a bot claims the form was open for an hour and the
  // timing signal is worthless.
  const forged = `${Date.now() - 60000}.abcdef.0000000000000000000000000000000`;
  assert.equal(spamCheck.readFormToken(forged).valid, false);
});

test('a real token carries how long the form was open', async () => {
  const token = spamCheck.issueFormToken();
  const read = spamCheck.readFormToken(token);
  assert.equal(read.valid, true);
  assert.ok(read.elapsedMs >= 0 && read.elapsedMs < 5000);
});

test('a missing token is a signal, not a refusal', async () => {
  assert.equal(spamCheck.readFormToken(undefined).valid, false);
  assert.equal(spamCheck.readFormToken('').valid, false);
  // And on its own it is worth well under the threshold.
  const r = await scorer.assess(submission({ message: 'Hello there' }, { jsTokenValid: false, elapsedMs: null }));
  assert.equal(r.verdict, 'clean', `scored ${r.score}`);
});

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

test('an assessment is recorded with the reasons, not just a number', async () => {
  // "Why was my message flagged?" must have an answer. A score with no
  // explanation is not something anyone can argue with or improve.
  const sub = submission({ message: 'buy viagra backlink now', website: 'trap' });
  const assessment = await scorer.assess(sub);
  const id = await scorer.record(assessment, sub);
  assert.ok(id);

  const row = (await pool.query('SELECT * FROM spam_assessments WHERE id = $1', [id])).rows[0];
  assert.equal(row.verdict, 'spam');
  assert.ok(Array.isArray(row.signals) && row.signals.length > 0);
  assert.ok(row.signals.every((s) => s.name && typeof s.points === 'number'));
  assert.ok(row.sample.includes('viagra'), 'the text is kept so a person can judge it');
});

test('a moderator ruling is stored and teaches the classifier', async () => {
  const sub = submission({ message: 'uniquephrase alpha beta gamma delta epsilon' });
  const assessment = await scorer.assess(sub);
  const id = await scorer.record(assessment, sub);

  const result = await scorer.teach(id, 'spam', null);
  assert.equal(result.ok, true);

  const row = (await pool.query('SELECT moderator_verdict FROM spam_assessments WHERE id = $1', [id])).rows[0];
  assert.equal(row.moderator_verdict, 'spam');

  const learned = await pool.query(
    'SELECT spam_count FROM spam_tokens WHERE token = $1', ['uniquephrase']);
  assert.equal(learned.rows[0].spam_count, 1);
});
