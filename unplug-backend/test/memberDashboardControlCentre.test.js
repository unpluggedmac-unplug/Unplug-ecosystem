'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const page = fs.readFileSync(path.join(ROOT, 'unplug-member-dashboard.html'), 'utf8');
const loader = fs.readFileSync(path.join(ROOT, 'media', 'scripts', 'member-dashboard-control-centre-loader.js'), 'utf8');
const script = fs.readFileSync(path.join(ROOT, 'media', 'scripts', 'member-dashboard-control-centre.js'), 'utf8');
const polish = fs.readFileSync(path.join(ROOT, 'media', 'scripts', 'member-dashboard-control-centre-polish.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'media', 'styles', 'member-dashboard-control-centre.css'), 'utf8');
const helpCss = fs.readFileSync(path.join(ROOT, 'media', 'styles', 'member-dashboard-control-centre-help.css'), 'utf8');
const polishCss = fs.readFileSync(path.join(ROOT, 'media', 'styles', 'member-dashboard-control-centre-polish.css'), 'utf8');
const runtime = fs.readFileSync(path.join(ROOT, 'functions', 'runtime-config.js'), 'utf8');

const TOP_LEVEL = [
  ['g-home', 'Home'],
  ['g-unplug', 'My Unplug'],
  ['g-directory', 'My Directory'],
  ['g-content', 'My Content'],
  ['g-community', 'Community'],
  ['g-recognition', 'Recognition & Gamification'],
  ['g-opportunities', 'Opportunities'],
  ['g-services', 'Services & Marketplace'],
  ['g-money', 'Finance'],
  ['g-notifications', 'Notifications'],
  ['g-agreements', 'Agreements'],
  ['g-help', 'Help & Support'],
  ['g-account', 'Account & Settings'],
];

const SOURCE_KEYS = [
  'profile', 'unplug', 'notifications', 'leaderboard', 'myanalytics', 'services',
  'myservices', 'submissions', 'reading', 'editions', 'myorders', 'mycredits',
  'myinvoices', 'myvotes', 'account', 'payments', 'privacy', 'myreferrals',
  'myagreements', 'availableagreements', 'myclients',
];

test('member control-centre JavaScript parses before browser execution', () => {
  assert.doesNotThrow(() => new Function(loader));
  assert.doesNotThrow(() => new Function(script));
  assert.doesNotThrow(() => new Function(polish));
});

test('member enhancement is guarded and runtime has one isolated member integration point', () => {
  assert.match(loader, /if\(!\/unplug-member-dashboard\/i\.test\(location\.pathname\)\)return/);
  assert.match(script, /if\(!\/unplug-member-dashboard\/i\.test\(location\.pathname\)\)return/);
  assert.match(polish, /if\(!\/unplug-member-dashboard\/i\.test\(location\.pathname\)\)return/);
  assert.match(runtime, /p\.indexOf\(\"unplug-member-dashboard\"\)===-1/);
  assert.match(runtime, /member-dashboard-control-centre-loader\.js\?v=/);
  assert.doesNotMatch(runtime, /member-dashboard-control-centre-polish\.js\?v=/);
  assert.doesNotMatch(runtime, /member-dashboard-service-shortcuts\.js\?v=/);
  assert.match(loader, /member-dashboard-control-centre\.css\?v=/);
  assert.match(loader, /member-dashboard-control-centre-help\.css\?v=/);
  assert.match(loader, /member-dashboard-control-centre\.js\?v=/);
  assert.match(loader, /member-dashboard-control-centre-polish\.js\?v=/);
  assert.match(loader, /member-dashboard-service-shortcuts\.js\?v=/);
});

test('member asset loader keeps execution order explicit', () => {
  const core = loader.indexOf('member-dashboard-control-centre.js?v=');
  const polishPos = loader.indexOf('member-dashboard-control-centre-polish.js?v=');
  const services = loader.indexOf('member-dashboard-service-shortcuts.js?v=');
  assert.ok(core > -1 && polishPos > core && services > polishPos);
  assert.match(loader, /addEventListener\('load',finish/);
  assert.match(loader, /addEventListener\('error',finish/);
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

test('Phase 2 groups keep each existing function in one clear conceptual home', () => {
  const labels = [
    'My Profile', 'Profile Completion', 'Preview My Unplug Profile', 'My Growth Journey',
    'My Directory Profile', 'Directory Performance',
    'My Submissions', 'My Articles', 'My Events', 'My Listings', 'Reading List', 'My Editions',
    'Referral Progress', 'My Referrals', 'My Clients',
    'My Score & Level', 'Missions', "This Week\'s Mission", "This Month\'s Challenge", 'My Achievements', 'Unplug Passport', 'Leaderboard',
    'My Competitions', 'My Votes', 'Browse Competitions',
    'Browse Services', 'My Services', 'My Advertising',
    'My Orders', 'Payments', 'Unplug Credits', 'My Invoices',
    'All Notifications', 'Contact Support',
    'Account Details', 'Privacy & Your Data', 'Download My Data', 'Logout',
  ];
  for (const label of labels) assert.ok(script.includes(label), `missing hierarchy label: ${label}`);
  for (const oldLabel of ['My Identity', 'My Unplug Journey', 'Money & Purchases', 'Account & Privacy']) {
    assert.ok(!script.includes(`label:'${oldLabel}'`), `retired top-level label still present: ${oldLabel}`);
  }
});

test('notifications have one clear primary home and are not duplicated under Community', () => {
  assert.match(script, /id:'g-notifications',label:'Notifications'/);
  assert.match(script, /id:'notifications',label:'All Notifications'/);
  assert.doesNotMatch(polish, /notifications-quick/);
  const communityStart = script.indexOf("id:'g-community'");
  const recognitionStart = script.indexOf("id:'g-recognition'", communityStart);
  assert.ok(communityStart > -1 && recognitionStart > communityStart);
  assert.doesNotMatch(script.slice(communityStart, recognitionStart), /id:'notifications'/);
});

test('personal My Unplug and public My Directory are visibly separated', () => {
  assert.match(script, /id:'g-unplug',label:'My Unplug'/);
  assert.match(script, /id:'community-profile',label:'My Profile'/);
  assert.match(script, /id:'g-directory',label:'My Directory'/);
  assert.match(script, /id:'directory-profile',label:'My Directory Profile'/);
  assert.match(script, /id:'directory-performance',label:'Directory Performance'/);
  assert.doesNotMatch(script, /label:'My Identity'/);
});

test('commercial and opportunity functions are moved out of the generic submissions branch', () => {
  const contentStart = script.indexOf("id:'g-content'");
  const communityStart = script.indexOf("id:'g-community'", contentStart);
  const content = script.slice(contentStart, communityStart);
  assert.doesNotMatch(content, /My Advertising/);
  assert.doesNotMatch(content, /My Competitions/);
  assert.match(script, /id:'g-services'[\s\S]*id:'my-advertising',label:'My Advertising'/);
  assert.match(script, /id:'g-opportunities'[\s\S]*id:'my-competitions',label:'My Competitions'/);
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
  assert.match(script, /Find something in Member Dashboard/);
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
  assert.match(script, /Your UnplugNews member dashboard/);
  assert.match(script, /Profile completion/);
  assert.match(script, /My Growth/);
});

test('profile checklist mirrors existing completion state instead of inventing completion rules', () => {
  assert.match(page, /id=\"muCompletionPct\"/);
  assert.match(page, /id=\"muCompletionTodo\"/);
  assert.match(polish, /muCompletionPct/);
  assert.match(polish, /muCompletionTodo/);
  assert.match(polish, /Profile checklist/);
  assert.match(polishCss, /cc-home-profile-checklist/);
});

test('member home visibly connects identity, participation, growth and opportunities', () => {
  for (const label of ['Identity', 'Participate', 'Grow', 'Opportunities']) {
    assert.ok(polish.includes(label), `missing Unplug path step: ${label}`);
  }
  assert.match(polish, /Your Unplug path/);
  assert.match(polish, /unplugScore/);
  assert.match(polish, /unplugStatusBadge/);
  assert.match(polishCss, /cc-home-path/);
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
  assert.ok(polish.includes('Escape'));
});

test('responsive member styling preserves the existing mobile drawer model', () => {
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(css, /#msSidebar/);
  assert.match(css, /cc-home-cards/);
  assert.match(css, /cc-member-create-grid/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(helpCss, /cc-member-nav-help/);
  assert.match(polishCss, /@media\(max-width:760px\)/);
  assert.match(polishCss, /@media\(max-width:500px\)/);
});

test('member visual identity stays anchored to the existing Unplug token system', () => {
  for (const token of ['var(--cream)', 'var(--ink)', 'var(--red)', 'var(--paper)', 'var(--paper-line)']) {
    assert.ok(css.includes(token), `expected existing brand token ${token}`);
    assert.ok(polishCss.includes(token) || token === 'var(--cream)', `expected polish to reuse brand token ${token}`);
  }
});
