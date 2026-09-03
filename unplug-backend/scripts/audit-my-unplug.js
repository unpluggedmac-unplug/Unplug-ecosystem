// The combined pass across the whole My Unplug area (spec §4).
//
// The per-section smoke check proves each section works. This asks the
// different question the task's stop condition asks at the end: does the AREA
// hold together?
//
//   1. Every §4 menu item exists, once.
//   2. Every nav button points at a section that exists, and every section is
//      reachable from a nav button. An orphan either way is a dead end.
//   3. Every section that loads data has a loader, and every loader is wired to
//      a click. A section wired to nothing shows "Loading…" for ever, which is
//      exactly the bug found by hand during the invoices browser check.
//   4. Nothing was left duplicated by the sections that MOVED things.
//
// Static analysis of the shipped page, deliberately: this is about structure,
// and structure is checkable without a database.
//
//   node scripts/audit-my-unplug.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const page = fs.readFileSync(path.join(ROOT, 'unplug-member-dashboard.html'), 'utf8');

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -> ${detail}`}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------
// §4's menu, as written in the spec.
//
// "Dashboard" is the Profile landing, and Help/Support lives on the public
// site; both are noted rather than asserted so this does not claim to check
// something it is not checking.
const SPEC_MENU = [
  'My Profile', 'My Services', 'My Submissions', 'My Articles', 'My Events',
  'My Listings', 'My Advertising', 'My Competitions', 'My Votes',
  'My Orders', 'My Payments', 'My Credits', 'My Invoices',
  'Notifications', 'Reading List', 'Account Settings',
];

console.log('§4 menu items:');
for (const label of SPEC_MENU) {
  const count = (page.match(new RegExp(`>\\s*${label}\\s*<`, 'g')) || []).length
    + (page.match(new RegExp(`</span>\\s*${label}\\s*</button>`, 'g')) || []).length;
  check(`"${label}" is in the dashboard`, count > 0, 'not found');
}

// ---------------------------------------------------------------------------
console.log('\nnav and sections line up:');

const navKeys = [...page.matchAll(/class="ms-navlink[^"]*"\s+data-ms="([a-z]+)"/g)]
  .map((m) => m[1]);
// Only real <section> declarations. Matching the attribute anywhere counts the
// querySelector strings in the page's own JavaScript too, which made this
// report a duplicate section that does not exist — the audit's own bug, found
// by running it.
const sectionKeys = [...page.matchAll(/<section[^>]*data-ms-section="([a-z]+)"/g)].map((m) => m[1]);

const uniqueNav = [...new Set(navKeys)];
const uniqueSections = [...new Set(sectionKeys)];

const navWithoutSection = uniqueNav.filter((k) => !uniqueSections.includes(k));
check('every nav button points at a section that exists',
  navWithoutSection.length === 0, navWithoutSection.join(', '));

const sectionWithoutNav = uniqueSections.filter((k) => !uniqueNav.includes(k));
check('every section is reachable from the menu',
  sectionWithoutNav.length === 0, sectionWithoutNav.join(', '));

const dupeSections = uniqueSections.filter(
  (k) => sectionKeys.filter((x) => x === k).length > 1);
check('no section is declared twice', dupeSections.length === 0, dupeSections.join(', '));

// ---------------------------------------------------------------------------
console.log('\nevery section that loads data is wired to a loader:');

// section key -> the loader that fills it. A section listed here with no click
// handler is the "Loading… for ever" bug.
const LOADERS = {
  submissions: 'loadMySubmissions',
  myservices: 'loadMyServices',
  myorders: 'loadMyOrders',
  mycredits: 'loadCredits',
  myinvoices: 'loadMyInvoices',
  myvotes: 'loadMyVotes',
  account: 'loadNotifPrefs',
};

for (const [key, loader] of Object.entries(LOADERS)) {
  check(`${key}: the section exists`, page.includes(`data-ms-section="${key}"`));
  check(`${key}: ${loader}() is defined`,
    new RegExp(`(async\\s+)?function\\s+${loader}\\s*\\(`).test(page));
  // The click handler that calls it, inside msSetupNav.
  const wired = new RegExp(
    `data-ms="${key}"[\\s\\S]{0,400}?${loader}\\(`).test(page)
    || new RegExp(`${loader}\\([^)]*\\)[\\s\\S]{0,200}?data-ms="${key}"`).test(page);
  check(`${key}: clicking the menu item calls ${loader}()`, wired,
    'the section would sit on "Loading…" for ever');
}

// ---------------------------------------------------------------------------
console.log('\nthings that were MOVED are not still in two places:');

check('the password card lives in Account Settings only',
  (page.match(/id="cpwBtn"/g) || []).length === 1
    && page.indexOf('id="cpwBtn"') > page.indexOf('data-ms-section="account"'));
check('the credits card lives in My Credits only',
  (page.match(/id="creditsContent"/g) || []).length === 1
    && !page.includes('<h2>Account Credits</h2>'));
check('the retired Content section is gone',
  !page.includes('data-ms-section="content"') && !page.includes('contentPendingArticles'));
check('"Browse Services" is distinct from "My Services"',
  page.includes('Browse Services') && page.includes('>My Services<'));

// ---------------------------------------------------------------------------
console.log('\nthe shared pattern is still shared:');

// My Services and My Submissions must both draw rows with subsRow, or the
// "one renderer" claim is no longer true.
check('My Services draws rows with subsRow',
  /function svcRender[\s\S]{0,1500}subsRow\(/.test(page));
check('My Submissions draws rows with subsRow',
  /function subsRender[\s\S]{0,1500}subsRow\(/.test(page));

console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
