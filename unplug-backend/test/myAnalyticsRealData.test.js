// My Analytics must show the member's real visibility and publishing data,
// not repeat the separate View Score page or fill the screen with demo
// numbers. These source-level checks complement profileAnalytics.test.js,
// which proves the endpoint against real PostgreSQL rows.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DASHBOARD = path.join(__dirname, '..', '..', 'unplug-member-dashboard.html');

function readDashboard() {
  assert.ok(fs.existsSync(DASHBOARD), 'member dashboard should exist');
  return fs.readFileSync(DASHBOARD, 'utf8').split('\r\n').join('\n');
}

test('My Analytics is wired to the signed-in member private endpoint and its selectable range', () => {
  const source = readDashboard();
  const start = source.indexOf('async function loadMyAnalytics()');
  assert.ok(start > -1, 'My Analytics loader should exist');
  const loader = source.slice(start, start + 7000);
  assert.match(loader, /profile-analytics\/me\/private\?range=\$\{MYAN_RANGE\}/);
  assert.match(loader, /data\.audience/);
  assert.match(loader, /data\.dailyAudience/);
  assert.match(loader, /data\.topArticles/);
});

test('My Analytics shows real visibility metrics and does not duplicate View Score', () => {
  const source = readDashboard();
  const sectionStart = source.indexOf('data-ms-section="myanalytics"');
  const sectionEnd = source.indexOf('data-ms-section="services"', sectionStart);
  assert.ok(sectionStart > -1 && sectionEnd > sectionStart, 'My Analytics section should be present');
  const section = source.slice(sectionStart, sectionEnd);

  assert.match(section, /Profile views/);
  assert.match(section, /Article reads/);
  assert.match(section, /Top articles in this period/);
  assert.match(section, /All-time profile and publishing/);
  assert.doesNotMatch(section, /Unplug Score|Day Streak|Rank\b/,
    'score, streak and rank belong on the separate View Score page');
});

test('audience limitations come from the API instead of an invented claim in the page', () => {
  const source = readDashboard();
  const start = source.indexOf('async function loadMyAnalytics()');
  const loader = source.slice(start, start + 7000);
  assert.match(loader, /noteEl\.textContent = data\.audienceNote \|\| ''/);
  assert.match(loader, /Number\(audience\.profileViews\) \|\| 0/);
  assert.match(loader, /Number\(audience\.articleReads\) \|\| 0/);
});

