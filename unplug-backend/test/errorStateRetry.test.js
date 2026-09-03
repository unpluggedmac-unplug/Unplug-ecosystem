// UX-001: every dynamic component's error state must offer a way forward,
// not just a dead-end "couldn't load" message that leaves reloading the
// whole page as the only option. Checked live and found genuinely missing —
// no component anywhere on the public site offered a Retry action before
// this. loading/empty states were already handled correctly per-component
// (verified separately during DEAF-001/MARKET-001 work); this closes the
// remaining error-state gap.
//
// A shared errorStateHtml(message, retryCall) helper is used everywhere so
// the button always looks and behaves the same, and retryCall is the exact
// call each component already uses to fetch itself — re-run verbatim on
// click, not a second, parallel "retry" code path that could drift from
// what a real load does.
//
// Website remediation punch-list (2026-09-03).
//
// Run with:  npm test   (from unplug-backend/)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'unplug-magazine.html');

function read() {
  assert.ok(fs.existsSync(FILE), 'unplug-magazine.html should exist');
  return fs.readFileSync(FILE, 'utf8').split('\r\n').join('\n');
}

test('errorStateHtml RENDERS A RETRY BUTTON THAT CALLS BACK THE EXACT SUPPLIED EXPRESSION', () => {
  const src = read();
  const start = src.indexOf('function errorStateHtml(message, retryCall)');
  assert.ok(start > -1);
  const body = src.slice(start, start + 400);
  assert.match(body, /onclick="\$\{retryCall\}"/, 'the retry call must be wired to the button, not just displayed');
  assert.match(body, />Retry</, 'the button must say Retry — not a bare icon or a vague label');
});

// Every data-driven component that fetches a list/detail on the homepage or
// a dedicated page, and previously left an error dead-ended, gets checked by
// name here — so a future refactor that quietly drops the retry call fails
// this test instead of shipping a silent regression.
const RETRY_SITES = [
  { label: 'Article detail', call: "loadArticleDetail(window.__currentArticleId)" },
  { label: 'Featured slider', call: 'loadFeaturedSlider()' },
  { label: 'New Stories', call: 'loadNewStories()' },
  { label: 'Highlighted profiles', call: 'loadHighlightedProfiles()' },
  { label: 'Investors', call: 'loadInvestors()' },
  { label: 'Marketplace', call: 'loadMarketplace()' },
  { label: 'Editions', call: 'loadEditions(true)' },
  { label: 'Homepage Top 10', call: 'loadHomeTop10Mini()' },
  { label: 'The Arena', call: 'loadArena()' },
  { label: 'Members directory', call: 'loadMembers(true)' },
  { label: 'Site search', call: 'runSitePageSearch()' },
  { label: 'Calendar events', call: 'loadCalendarEvents()' },
];

RETRY_SITES.forEach(({ label, call }) => {
  test(`${label.toUpperCase()}'S ERROR STATE OFFERS RETRY, CALLING ITS OWN LOADER BACK`, () => {
    const src = read();
    const line = src.split('\n').find((l) => l.includes(`'${call}'`));
    assert.ok(line, `${label} should re-run "${call}" from somewhere in the file`);
    assert.match(line, /errorStateHtml\(/, `"${call}" must be wired through errorStateHtml on the same line, not just present as text`);
  });
});
