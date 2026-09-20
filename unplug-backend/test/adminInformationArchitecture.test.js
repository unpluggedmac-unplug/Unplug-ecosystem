'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function modelSource() {
  const hierarchy = read('media/scripts/admin-control-centre-hierarchy.js');
  const start = hierarchy.indexOf('    var model = [');
  const end = hierarchy.indexOf('\n\n    function keyFor', start);
  assert.ok(start >= 0 && end > start, 'Control Centre navigation model must be present');
  return hierarchy.slice(start, end);
}

test('Admin Control Centre uses the approved 13 purpose-based primary groups', () => {
  const model = modelSource();
  const topLevel = [...model.matchAll(/^      branch\('([^']+)', '([^']+)'/gm)].map((m) => m[2]);
  assert.deepEqual(topLevel, [
    'Dashboard',
    'People',
    'Content',
    'Community',
    'Gamification',
    'Opportunities',
    'Deaf Community',
    'Directory & Marketplace',
    'Payments & Commerce',
    'Communications',
    'Media & Pages',
    'Analytics & Reports',
    'Administration'
  ]);
});

test('Every primary Admin Control Centre group explains its purpose', () => {
  const model = modelSource();
  const topLevelCount = [...model.matchAll(/^      branch\(/gm)].length;
  const descriptions = [...model.matchAll(/\], \{ description: '[^']+' \}\),?$/gm)].length;
  assert.equal(topLevelCount, 13);
  assert.equal(descriptions, 13);
});

test('Admin Control Centre keeps existing high-value destinations discoverable', () => {
  const model = modelSource();
  [
    'Members & Users',
    'Directory Profiles',
    'Stories & Articles',
    'Gallery Submissions',
    'Competitions',
    'Top 10',
    'Growth Applications',
    'Deaf Jobs',
    'Opportunity Passports',
    'Marketplace Listings',
    'Payments',
    'Credits',
    'Notifications',
    'Page Content & Sections',
    'Platform Overview',
    'Agreement Generator',
    'Master Form Builder',
    'Form Templates',
    'Published Forms',
    'Archived Forms',
    'Free Votes',
    'Bulk Votes',
    'Vote Codes',
    'Competition Settings',
    'Homepage Banners',
    'Scheduled Banners',
    'Banner Faces',
    'Backups',
    'Permissions',
    'Unplug Live'
  ].forEach((label) => assert.match(model, new RegExp(label.replace(/[.*+?^$()|[\]\\]/g, '\\$&'))));
});

test('primary navigation descriptions are rendered as text and hidden with collapsed groups', () => {
  const hierarchy = read('media/scripts/admin-control-centre-hierarchy.js');
  const css = read('media/styles/admin-control-centre-hierarchy.css');
  assert.match(hierarchy, /description\.className = 'cc-group-description'/);
  assert.match(hierarchy, /description\.textContent = node\.description/);
  assert.match(css, /\.cc-group-description\{/);
  assert.match(css, /\.cc-nav-group:not\(\.open\)>\.cc-group-description/);
});


test('Admin Dashboard landing page keeps quick actions focused and ordered after attention', () => {
  const hierarchy = read('media/scripts/admin-control-centre-hierarchy.js');
  const start = hierarchy.indexOf('function addOverviewCards()');
  const end = hierarchy.indexOf('addOverviewCards();', start);
  const overview = hierarchy.slice(start, end);
  assert.match(overview, /Platform status/);
  assert.match(overview, /Requires attention/);
  assert.match(overview, /Quick actions/);
  const quickCards = [...overview.matchAll(/^        \['[^']+',/gm)];
  assert.equal(quickCards.length, 8, 'Quick Actions must stay within the 4–8 item clarity target');
  assert.match(overview, /pendingPanel\.insertAdjacentElement\('afterend', quickLabel\)/);
});


test('Admin dashboard root hides the redundant Back control and uses current wording', () => {
  const hierarchy = read('media/scripts/admin-control-centre-hierarchy.js');
  assert.match(hierarchy, /setContext\(\['Dashboard', 'Platform Overview'\]\)/);
  assert.match(hierarchy, /atDashboardRoot/);
  assert.match(hierarchy, /back\.hidden = state\.currentPath\.length < 2 \|\| atDashboardRoot/);
});

test('sidebar recents stay compact and prefer current node labels over stale stored labels', () => {
  const hierarchy = read('media/scripts/admin-control-centre-hierarchy.js');
  assert.match(hierarchy, /b\.textContent = node\?\.label \|\| item\.label \|\| 'Item'/);
  assert.match(hierarchy, /recent\.slice\(0, 3\)/);
  assert.match(hierarchy, /favBlock\.hidden = !favNodes\.length/);
});

test('wide Admin overview keeps all seven live totals in one balanced row', () => {
  const css = read('media/styles/admin-control-centre-hierarchy.css');
  assert.match(css, /#section-overview #ovTotals\{grid-template-columns:repeat\(7,minmax\(0,1fr\)\)\}/);
});
