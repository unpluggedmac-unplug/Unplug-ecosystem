// What the magazine's domain is allowed to serve.
//
// Cloudflare Pages publishes the REPOSITORY ROOT, so every file committed here
// is reachable by URL unless something says otherwise. Before this was noticed,
// the live site was serving:
//
//   /SECURITY.md            what protects the site, and where each weak point is
//   /PUNCH-LIST.md          every known unfinished thing
//   /docs/progress-log.md   a 70KB engineering log
//   /unplug-backend/**      the entire backend source, payments.js included
//
// No secrets: .env is gitignored and was never committed — a request for it
// returned the ordinary fallback page, which was checked rather than assumed.
// But a description of where the soft spots are is a starting point nobody else
// needs to be handed.
//
// These tests read _redirects rather than the network, so they fail in CI before
// a deploy rather than after one.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const redirects = fs.readFileSync(path.join(ROOT, '_redirects'), 'utf8');

// Rule lines only, in order.
const rules = redirects.split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => {
    const [from, to, status] = l.split(/\s+/);
    return { from, to, status };
  });

const blocked = rules.filter((r) => r.status === '404').map((r) => r.from);

test('THE INTERNAL DOCUMENTATION IS NOT PUBLISHED', () => {
  for (const p of ['/docs/*', '/CLAUDE.md', '/SECURITY.md', '/PUNCH-LIST.md']) {
    assert.ok(blocked.includes(p), `${p} must be blocked — it is served otherwise`);
  }
});

test('THE BACKEND SOURCE IS NOT PUBLISHED', () => {
  assert.ok(blocked.includes('/unplug-backend/*'),
    'the backend is deployed to Render; it must not be fetchable from the magazine');
});

test('dependency manifests are not published', () => {
  // Versions make it quick to look up which known vulnerabilities apply.
  for (const p of ['/package.json', '/package-lock.json', '/node_modules/*']) {
    assert.ok(blocked.includes(p), `${p} should not be public`);
  }
});

test('the developer component demo is not published', () => {
  assert.ok(blocked.includes('/unplug-components-demo.html'),
    'it has no inbound links and is not part of the magazine');
});

test('every markdown file added later is caught too', () => {
  // The named rules cover today; this catches the next one somebody commits.
  assert.ok(blocked.includes('/*.md'),
    'a wildcard is needed, or the next .md added to the root is published');
});

test('THE 404 RULES COME BEFORE THE REWRITES', () => {
  // Pages matches in order. A rewrite listed first would win, and the block
  // would silently do nothing.
  const firstRewrite = rules.findIndex((r) => r.status === '200');
  const lastBlock = rules.map((r) => r.status).lastIndexOf('404');
  assert.ok(firstRewrite === -1 || lastBlock < firstRewrite,
    'a 404 rule appears after a 200 rewrite and will never be reached');
});

test('the block page is NOT called 404.html', () => {
  // Pages serves a file of that name for EVERY unmatched request. Using it here
  // would change how the whole site answers unknown paths, which is a different
  // decision from hiding these files.
  for (const r of rules.filter((x) => x.status === '404')) {
    assert.notEqual(r.to, '/404.html',
      'use a differently-named page, or unmatched paths change behaviour too');
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'not-found.html')),
    'the page the rules point at must exist');
  assert.ok(!fs.existsSync(path.join(ROOT, '404.html')),
    'adding 404.html would make Pages adopt it as the catch-all');
});

test('no real page of the site is blocked by accident', () => {
  // Everything except the component demo, which is deliberate.
  const pages = fs.readdirSync(ROOT)
    .filter((f) => f.endsWith('.html'))
    .map((f) => '/' + f)
    .filter((p) => p !== '/unplug-components-demo.html' && p !== '/not-found.html');

  const wrongly = pages.filter((p) => blocked.includes(p));
  assert.deepEqual(wrongly, [], `these are real pages and must stay reachable: ${wrongly.join(', ')}`);
});
