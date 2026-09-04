// INV-001, frontend half: the Investors page must actually call the new
// /analytics/investor-snapshot endpoint and render its real fields —
// checked against the real unplug-magazine.html source, not assumed from
// the backend route alone.
//
// Website remediation punch-list (2026-09-03), INV-001.
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

test('THE INVESTORS PAGE FETCHES THE REAL SNAPSHOT ENDPOINT, NOT A HARDCODED SET OF NUMBERS', () => {
  const src = read();
  const fnIdx = src.indexOf('async function loadInvestorSnapshot()');
  assert.ok(fnIdx > -1);
  const body = src.slice(fnIdx, fnIdx + 600);
  assert.match(body, /api\('\/analytics\/investor-snapshot'\)/);
});

test('LOADING THE INVESTORS PAGE CALLS loadInvestorSnapshot(), NOT JUST loadInvestors()', () => {
  const src = read();
  const idx = src.indexOf("if (pageId === 'investors' && !investorsLoaded)");
  assert.ok(idx > -1);
  const block = src.slice(idx, idx + 200);
  assert.match(block, /loadInvestorSnapshot\(\)/);
});

test('THE SNAPSHOT RENDERS AUDIENCE, COMMUNITY AND CONTENT GROUPS — NOT A COMMERCIAL/REVENUE ONE', () => {
  const src = read();
  const fnIdx = src.indexOf('async function loadInvestorSnapshot()');
  const body = src.slice(fnIdx, fnIdx + 2000);
  assert.match(body, />Audience</);
  assert.match(body, />Community</);
  assert.match(body, />Content</);
  assert.ok(!/Commercial|Revenue/i.test(body), 'a revenue/commercial section was explicitly decided against for this public page');
});

test('A GROWTH FIGURE OF null IS OMITTED FROM DISPLAY, NOT SHOWN AS "null%"', () => {
  const src = read();
  const fnIdx = src.indexOf('async function loadInvestorSnapshot()');
  const body = src.slice(fnIdx, fnIdx + 900);
  assert.match(body, /growth !== null \? invStatHtml/, 'a null growth value must be excluded, not rendered literally');
});
