// What the magazine's domain is allowed to serve.
//
// Cloudflare Pages publishes the REPOSITORY ROOT, so every file committed here
// is reachable by URL unless something refuses it. The live site was serving:
//
//   /SECURITY.md            what protects the site, and where each weak point is
//   /PUNCH-LIST.md          every known unfinished thing
//   /docs/progress-log.md   a 70KB engineering log
//   /unplug-backend/**      the entire backend source, payments.js included
//   /package.json           dependency names and versions
//
// No secrets: .env is gitignored and was never committed — a request for it
// returned the ordinary fallback page, which was checked against a path known
// not to exist rather than assumed.
//
// WHY THE BLOCK LIVES IN A FUNCTION AND NOT IN _redirects, which is where it was
// put first: Pages serves a matching STATIC ASSET before it consults
// _redirects, so a rule there cannot hide a file that exists. That version was
// written, tested against the file, deployed — and changed nothing. A Pages
// Function runs ahead of the asset, so it is the only layer that can refuse.
//
// These read the function's source rather than the network, so a regression
// fails before a deploy rather than after one.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FN = path.join(ROOT, 'functions', '[[path]].js');
const source = fs.readFileSync(FN, 'utf8');

// Pull the rule list out of the function and rebuild it here, so the test
// exercises the ACTUAL patterns rather than a copy that could drift from them.
function rules() {
  const block = /const NOT_THE_SITE = \[([\s\S]*?)\];/.exec(source);
  assert.ok(block, 'NOT_THE_SITE should still be declared in the function');

  // Line by line, with any trailing // comment removed FIRST. Scanning the
  // whole block for /.../ shapes also matches the comment markers, which is
  // exactly what went wrong the first time this was written.
  const found = block[1].split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t.startsWith('/')) return null;                 // not a rule line
      const m = /^(\/(?:\\.|\[[^\]]*\]|[^/\\[])+\/[a-z]*)/.exec(t);
      return m ? m[1] : null;
    })
    .filter(Boolean);

  assert.ok(found.length >= 5,
    `expected the rule list, parsed ${found.length}: ${found.join(' ')}`);
  // eslint-disable-next-line no-eval
  return found.map((literal) => eval(literal));
}

const blocked = (pathname) => rules().some((r) => r.test(pathname));

test('THE INTERNAL DOCUMENTATION IS NOT SERVED', () => {
  for (const p of ['/SECURITY.md', '/PUNCH-LIST.md', '/CLAUDE.md', '/BACKUPS.md',
    '/OPERATIONS.md', '/docs/progress-log.md', '/docs/pricing-comparison.md',
    '/docs/spec-extracted.md']) {
    assert.ok(blocked(p), `${p} is served otherwise`);
  }
});

test('THE BACKEND SOURCE IS NOT SERVED', () => {
  for (const p of ['/unplug-backend/src/routes/payments.js',
    '/unplug-backend/src/utils/backupCrypto.js',
    '/unplug-backend/package.json']) {
    assert.ok(blocked(p), `${p} must not be fetchable from the magazine`);
  }
});

test('dependency manifests are not served', () => {
  assert.ok(blocked('/package.json'));
  assert.ok(blocked('/package-lock.json'));
  assert.ok(blocked('/node_modules/express/index.js'));
});

test('the developer component demo is not served', () => {
  assert.ok(blocked('/unplug-components-demo.html'),
    'it has no inbound links and is not part of the magazine');
});

test('a markdown file added later is caught too', () => {
  assert.ok(blocked('/SOMETHING-NEW.md'),
    'the next .md committed to the root would be published');
});

test('THE SITE ITSELF STILL WORKS', () => {
  // The failure that would matter most: over-blocking and taking pages down.
  for (const p of ['/', '/unplug-magazine.html', '/unplug-member-dashboard.html',
    '/unplug-checkout.html', '/unplug-shared.js', '/unplug-tokens.css',
    '/icons/icon-192.png', '/media/wedding.jpeg', '/robots.txt', '/sitemap.xml',
    '/nominate', '/form/bursary-2026']) {
    assert.equal(blocked(p), false, `${p} is part of the site and must be served`);
  }
});

test('every real page in the repository is still reachable', () => {
  const pages = fs.readdirSync(ROOT)
    .filter((f) => f.endsWith('.html'))
    .map((f) => '/' + f)
    .filter((p) => p !== '/unplug-components-demo.html');   // blocked on purpose

  const broken = pages.filter((p) => blocked(p));
  assert.deepEqual(broken, [], `these pages would 404: ${broken.join(', ')}`);
});

test('the refusal happens BEFORE the static asset is fetched', () => {
  // If the check ran after next(), Pages would already have returned the file.
  const guard = source.indexOf('isNotTheSite(url.pathname)');
  const serve = source.indexOf('await next()');
  assert.ok(guard > -1, 'the guard should still be called');
  assert.ok(serve > -1, 'the function should still serve the site');
  assert.ok(guard < serve,
    'the guard must run before next(), or the file is served before it is refused');
});

test('it answers 404, not 403', () => {
  // A 403 confirms the file is there. A 404 says nothing.
  assert.ok(/status:\s*404/.test(source), 'the refusal should be a 404');
  assert.ok(!/status:\s*403/.test(source), 'a 403 would confirm the file exists');
});
