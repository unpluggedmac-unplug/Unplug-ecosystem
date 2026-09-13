'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const page = fs.readFileSync(path.join(ROOT, 'unplug-member-dashboard.html'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'media', 'scripts', 'member-dashboard-control-centre.js'), 'utf8');
const polish = fs.readFileSync(path.join(ROOT, 'media', 'scripts', 'member-dashboard-control-centre-polish.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'media', 'styles', 'member-dashboard-control-centre.css'), 'utf8');
const helpCss = fs.readFileSync(path.join(ROOT, 'media', 'styles', 'member-dashboard-control-centre-help.css'), 'utf8');
const runtime = fs.readFileSync(path.join(ROOT, 'functions', 'runtime-config.js'), 'utf8');

const TOP_LEVEL = [
  ['g-home', 'Home'],
  ['g-id', 'My Identity'],
  ['g-journey', 'My Unplug Journey'],
  ['g-growth', 'My Growth'],
  ['g-content', 'My Content'],
  ['g-services', 'Services'],
  ['g-money', 'Money & Purchases'],
  ['g-agreements', 'Agreements'],
  ['g-community', 'Community'],
  ['g-account', 'Account & Privacy'],
];

const SOURCE_KEYS = [
  'profile', 'unplug', 'notifications', 'leaderboard', 'myanalytics', 'services',
  'myservices', 'submissions', 'reading', 'editions', 'myorders', 'mycredits',
  'myinvoices', 'myvotes', 'account', 'payments', 'privacy', 'myreferrals',
  'myagreements', 'availableagreements', 'myclients',
];

test('member control-centre JavaScript parses before browser execution', () => {
  assert.doesNotThrow(() => new Function(script));
  assert.doesNotThrow(() => new Function(polish));
});

test('member enhancement is guarded so it cannot initialise on admin pages', () => {
  assert.match(script, /if\(!\/unplug-member-dashboard\/i\.test\(location\.pathname\)\)return/);
  assert.match(polish, /if\(!\/unplug-member-dashboard\/i\.test\(location\.pathname\)\)return/);
  assert.match(runtime, /p\.indexOf\(\"unplug-member-dashboard\"\)===-1/);
  assert.match(runtime, /member-dashboard-control-centre\.js\?v=/);
  assert.match(runtime, /member-dashboard-control-centre-polish\.js\?v=/);
  assert.match(runtime, /member-dashboard-control-centre\.css\?v=/);
});

test('the existing dashboard remains the source of truth for member functions', () => {
  for (const key of SOURCE_KEYS) {
    assert.match(page, new RegExp(`data-ms=\\"${key}\\"`), `missing native source nav: ${key}`);
  }
  assert.match(script, /\.ms-navlink\[data-ms=/);
  assert.match(script, /x\.click\(\)/);
  assert.doesNotMatch(script, /fetch\(/, 'hierarchy should not duplicate backend data loading');
  assert.doesNotMatch(polish, /fetch\(/, 'polish layer should not create a second data source');
});

test('all approved top-level member groups are represented', () => {
  for (const [id, label] of TOP_LEVEL) {
    assert.match(script, new RegExp(`id:'${id}'[^\\n]*label:'${label.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}'`));
  }
});

test('identity, journey, content, money and account children are grouped as approved', () => {
  const labels = [
    'Directory Profile', 'My Unplug Community Profile', 'Preview as Public', 'Profile Completion', 'My Analytics',
    'Status & Score', "Today\'s Missions", "This Week\'s Mission", "This Month\'s Challenge", 'Achievements', 'Unplug Passport', 'Leaderboard', 'Referral Progress',
    'My Submissions', 'My Articles', 'My Events', 'My Listings', 'My Advertising', 'My Competitions', 'Reading List', 'My Editions',
    'My Orders', 'Payments', 'My Credits', 'My Invoices', 'My Votes',
    'Account Settings', 'Your Data', 'Download My Data', 'View Official Site', 'Logout',
  ];
  for (const label of labels) assert.ok(script.includes(label), `missing hierarchy label: ${label}`);
});

test('notifications have root-level quick access and remain inside Community', () => {
  assert.match(script, /id:'notifications',label:'Notifications'/);
  assert.match(polish, /data-node=\"notifications-quick\"/);
  assert.match(polish, /data-node=\"g-community\"\] \[data-id=\"notifications\"\]/);
  assert.match(polish, /notifCountBadge/);
});

test('services stay compact and quick create is provided instead of listing every service in the tree', () => {
  assert.match(script, /label:'Browse Services'/);
  assert.match(script, /label:'My Services'/);
  assert.match(script, /label:'Create \/ Submit'/);
  assert.match(script, /id='ccMemberQuickCreate'|ccMemberQuickCreate/);
  assert.match(script, /Publish an article/);
  assert.match(script, /Submit an event/);
});

test('search, favourites, recent items, breadcrumbs and remembered UI state are present', () => {
  assert.match(script, /Find something in My Unplug/);
  assert.match(script, /unplug_member_cc_favourites_v1/);
  assert.match(script, /unplug_member_cc_recent_v1/);
  assert.match(script, /unplug_member_cc_open_v1/);
  assert.match(script, /unplug_member_cc_home_collapsed_v1/);
  assert.match(script, /cc-member-crumb/);
  assert.match(script, /Back to/);
});

test('member home is personalised from live DOM state without inventing a second data model', () => {
  assert.match(script, /function priority\(/);
  assert.match(script, /function pct\(/);
  assert.match(script, /function notif\(/);
  assert.match(script, /function actions\(/);
  assert.match(script, /function submissions\(/);
  assert.match(script, /function agreements\(/);
  assert.match(script, /Your personal Unplug home/);
  assert.match(script, /Profile completion/);
  assert.match(script, /My Growth/);
});

test('role-aware and conditional areas stay conditional', () => {
  assert.match(page, /id=\"msMyReferralsNav\"[^>]*section-hidden|section-hidden[^>]*id=\"msMyReferralsNav\"/);
  assert.match(page, /id=\"msMyAgreementsNav\"[^>]*section-hidden|section-hidden[^>]*id=\"msMyAgreementsNav\"/);
  assert.match(page, /id=\"msAvailableAgreementsNav\"[^>]*section-hidden|section-hidden[^>]*id=\"msAvailableAgreementsNav\"/);
  assert.match(page, /id=\"msMyClientsNav\"[^>]*section-hidden|section-hidden[^>]*id=\"msMyClientsNav\"/);
  assert.match(script, /when:function\(\)\{return avail\('myreferrals'\)\}/);
  assert.match(script, /when:function\(\)\{return avail\('myclients'\)\}/);
});

test('agreement status shortcuts filter only the already-rendered agreement workspace', () => {
  for (const label of ['Awaiting My Signature', 'Signed', 'Completed', 'Archived', 'Available Agreements']) {
    assert.ok(script.includes(label), `missing agreement shortcut: ${label}`);
  }
  assert.match(script, /cc-member-agreement-filter-note/);
  assert.match(script, /cc-member-filtered-out/);
});

test('accessibility polish covers expandable navigation, home panels, search and quick-create dialog', () => {
  assert.match(polish, /aria-expanded/);
  assert.match(polish, /aria-controls/);
  assert.match(polish, /aria-current/);
  assert.match(polish, /aria-modal/);
  assert.match(polish, /aria-labelledby/);
  assert.match(polish, /ev\.key!==?'Escape'|ev\.key==='Escape'/);
});

test('responsive member styling preserves the existing mobile drawer model', () => {
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(css, /#msSidebar/);
  assert.match(css, /cc-home-cards/);
  assert.match(css, /cc-member-create-grid/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(helpCss, /cc-member-nav-help/);
});

test('member visual identity stays within the existing Unplug token system', () => {
  for (const token of ['var(--cream)', 'var(--ink)', 'var(--red)', 'var(--paper)', 'var(--paper-line)']) {
    assert.ok(css.includes(token), `expected existing brand token ${token}`);
  }
  assert.doesNotMatch(css, /#[0-9a-fA-F]{6}/, 'feature CSS should reuse shared brand tokens rather than invent a parallel palette');
});
