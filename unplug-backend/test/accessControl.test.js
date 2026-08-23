// Access rules and the request filter, against a REAL PostgreSQL.
//
// The two ways this feature goes wrong, in order of likelihood:
//
//   1. IT BLOCKS THE WRONG PEOPLE. A filter that refuses a writer publishing an
//      article about SQL injection, or a reader searching the directory for
//      "Select Motors", gets switched off within a week — and the site ends up
//      with less protection than if it had never been added. Most of this file
//      is about traffic that must NOT be refused.
//   2. AN ADMIN LOCKS THEMSELVES OUT. Blocking a range that contains your own
//      connection also removes the screen you would use to undo it.
//
// Run with:  npm test   (from unplug-backend/)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EmbeddedPostgres = require('embedded-postgres').default;

let pg;
let pool;
let access;
let waf;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unplug-acl-'));
const port = 38000 + (process.pid % 300); // bases are 400 apart so ranges cannot overlap

async function addRule(effect, kind, value, reason = 'test', expiresAt = null) {
  const r = await pool.query(
    `INSERT INTO access_rules (effect, kind, value, reason, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (effect, kind, LOWER(value)) DO UPDATE SET reason = EXCLUDED.reason
     RETURNING id`, [effect, kind, value, reason, expiresAt]);
  access.invalidate();
  return r.rows[0].id;
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
  process.env.JWT_SECRET = 'test-secret-for-acl';

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8'));
  }
  access = require('../src/middleware/accessControl');
  waf = require('../src/middleware/wafLite');
});

after(async () => {
  if (pool) await pool.end();
  // Windows can still hold a handle on the data directory when Postgres exits.
  try { if (pg) await pg.stop(); } catch (e) { /* the OS being slow to let go */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* as above */ }
});

// ---------------------------------------------------------------------------
// The request filter — mostly about what it must NOT catch
// ---------------------------------------------------------------------------

test('ORDINARY MAGAZINE TRAFFIC IS NEVER REFUSED', async () => {
  // Every one of these is a real thing a reader or writer does on this site.
  const ordinary = [
    ['/articles', { page: '2', limit: '6' }],
    ['/directory', { q: 'Nkosi & Sons' }],
    ['/directory', { q: 'Select Motors' }],          // contains SELECT
    ['/directory', { q: "O'Brien Plumbing" }],       // contains a quote
    ['/directory', { q: 'union of workers' }],       // contains UNION
    ['/articles', { q: 'how to script a video' }],   // contains "script"
    ['/articles', { q: '1=1 is a tautology' }],      // contains 1=1
    ['/', { p: 'article', id: '55' }],
    ['/articles', { q: 'R100 — 50% off' }],
    ['/profiles/ag-scott', {}],
    ['/?p=profile&slug=x', { p: 'profile', slug: 'nkosi-trading' }],
  ];
  for (const [p, q] of ordinary) {
    assert.equal(waf.inspect({ path: p, query: q }), null,
      `${p} ${JSON.stringify(q)} must be allowed through`);
  }
});

test('AN ARTICLE ABOUT SQL INJECTION CAN STILL BE PUBLISHED', async () => {
  // The single most likely false positive for a technology magazine, and the
  // reason bodies are not scanned at all. inspect() is never given a body;
  // this documents that decision as an executable fact.
  const articleBody = "Attackers type ' OR 1=1 -- into the login box, and a "
    + 'site that builds SQL by pasting strings together will run it. '
    + '<script>alert(1)</script> works the same way in a comment field.';
  assert.equal(waf.inspect({ path: '/articles', query: {} }), null,
    'the request itself is clean; what it carries is not inspected');
  assert.ok(articleBody.length > 0);
});

test('probes and injection attempts in the URL are refused', async () => {
  const attacks = [
    ['/articles', { q: "' OR '1'='1" }, 'sqli'],
    ['/articles', { q: '1 UNION SELECT password FROM users' }, 'sqli'],
    ['/articles', { q: '1; DROP TABLE users' }, 'sqli'],
    ['/x', { q: '<script>alert(1)</script>' }, 'xss'],
    ['/x', { redirect: 'javascript:alert(1)' }, 'xss'],
    ['/files/../../etc/passwd', {}, 'traversal'],
    ['/files/%2e%2e%2fetc/passwd', {}, 'traversal'],
    ['/wp-login.php', {}, 'probe'],
    ['/.env', {}, 'probe'],
    ['/xmlrpc.php', {}, 'probe'],
  ];
  for (const [p, q, expected] of attacks) {
    assert.equal(waf.inspect({ path: p, query: q }), expected, `${p} ${JSON.stringify(q)}`);
  }
});

test('AN ATTACK HIDDEN IN A PARAMETER NAME IS STILL SEEN', async () => {
  // Checking only values would leave the obvious hiding place open.
  assert.equal(waf.inspect({ path: '/x', query: { '<script>x</script>': '1' } }), 'xss');
});

test('a malformed percent-encoding does not crash the check', async () => {
  // decodeURIComponent throws on "%zz". The raw form must still be examined.
  assert.doesNotThrow(() => waf.inspect({ path: '/x%zz', query: { a: '%zz' } }));
  assert.equal(waf.inspect({ path: '/%zz../../etc', query: {} }), 'traversal');
});

test('a hostile user agent is caught', async () => {
  assert.equal(waf.inspect({ path: '/', query: {}, userAgent: '<script>alert(1)</script>' }), 'header');
  assert.equal(waf.inspect({ path: '/', query: {}, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' }), null);
});

// ---------------------------------------------------------------------------
// Access rules
// ---------------------------------------------------------------------------

test('with no rules at all, everyone is let through', async () => {
  const v = await access.decide({ ip: '41.2.3.4' });
  assert.equal(v.allowed, true);
  assert.equal(v.rule, null);
});

test('a blocked address is refused, and its neighbour is not', async () => {
  await addRule('block', 'ip', '198.51.100.7', 'kept probing the admin login');
  assert.equal((await access.decide({ ip: '198.51.100.7' })).allowed, false);
  assert.equal((await access.decide({ ip: '198.51.100.8' })).allowed, true);
});

test('a blocked RANGE catches everything inside it', async () => {
  await addRule('block', 'cidr', '203.0.113.0/24', 'a scanning network');
  assert.equal((await access.decide({ ip: '203.0.113.1' })).allowed, false);
  assert.equal((await access.decide({ ip: '203.0.113.254' })).allowed, false);
  assert.equal((await access.decide({ ip: '203.0.114.1' })).allowed, true, 'and nothing outside it');
});

test('ALLOW BEATS BLOCK — the way back in always works', async () => {
  // The whole reason allow is checked first. An admin inside a blocked range
  // must still be able to reach the screen that removes the block.
  await addRule('allow', 'ip', '203.0.113.9', 'the office, inside a blocked range');
  const v = await access.decide({ ip: '203.0.113.9' });
  assert.equal(v.allowed, true);
  assert.equal(v.rule.effect, 'allow');
  // ...while its neighbours in the same range stay blocked.
  assert.equal((await access.decide({ ip: '203.0.113.10' })).allowed, false);
});

test('an account block follows the person, not the machine', async () => {
  await addRule('block', 'account', 'nuisance@example.com', 'repeated abuse');
  assert.equal((await access.decide({ ip: '8.8.8.8', email: 'nuisance@example.com' })).allowed, false);
  assert.equal((await access.decide({ ip: '8.8.8.8', email: 'NUISANCE@example.com' })).allowed, false,
    'however they capitalise it');
  assert.equal((await access.decide({ ip: '8.8.8.8', email: 'someone@example.com' })).allowed, true);
});

test('AN EXPIRED RULE STOPS APPLYING ON ITS OWN', async () => {
  // A temporary block is the right answer more often than people reach for it,
  // and a rule that expires cannot be forgotten.
  await addRule('block', 'ip', '198.51.100.20', 'a bad afternoon',
    new Date(Date.now() - 60000).toISOString());
  assert.equal((await access.decide({ ip: '198.51.100.20' })).allowed, true);
});

test('a rule with a future expiry is still in force', async () => {
  await addRule('block', 'ip', '198.51.100.21', 'still going',
    new Date(Date.now() + 3600000).toISOString());
  assert.equal((await access.decide({ ip: '198.51.100.21' })).allowed, false);
});

test('a country rule matches nothing until a country is known', async () => {
  // Country blocking needs a GeoIP lookup, which needs a MaxMind licence key.
  // Until one is configured the rule must sit inert rather than quietly
  // blocking the wrong people.
  await addRule('block', 'country', 'XX', 'a country we do not serve');
  assert.equal((await access.decide({ ip: '41.2.3.4' })).allowed, true,
    'with no country supplied, the rule cannot match');
  assert.equal((await access.decide({ ip: '41.2.3.4', country: 'XX' })).allowed, false,
    'and it does match once one is');
});

test('a block cannot be walked around by writing the address differently', async () => {
  await addRule('block', 'ip', '198.51.100.30', 'notation test');
  assert.equal((await access.decide({ ip: '::ffff:198.51.100.30' })).allowed, false,
    'the v6-mapped form of a v4 address is the same address');
});

test('the rule cache clears when a rule changes', async () => {
  const ip = '198.51.100.40';
  assert.equal((await access.decide({ ip })).allowed, true);
  await addRule('block', 'ip', ip, 'added mid-flight');
  assert.equal((await access.decide({ ip })).allowed, false,
    'a new block applies immediately rather than in fifteen seconds');
});
