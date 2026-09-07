// Static regression guards for the member-facing Promote Existing Content flow.
// These deliberately do not need PostgreSQL: the database-backed highlights
// suite already exercises the router. This file protects the integration
// seams that are easy to break while editing the very large member dashboard.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const promotePath = path.join(root, 'unplug-promote-existing.js');
const highlightRoutePath = path.join(__dirname, '..', 'src', 'routes', 'highlights.js');
const buildPath = path.join(root, 'build.js');

const promote = fs.readFileSync(promotePath, 'utf8');
const highlights = fs.readFileSync(highlightRoutePath, 'utf8');
const build = fs.readFileSync(buildPath, 'utf8');

test('Promote Existing Content has one unified member form', () => {
  assert.match(promote, /id="promoteExistingType"/);
  assert.match(promote, /id="promoteExistingItem"/);
  assert.match(promote, /id="promoteExistingDuration"/);
  assert.match(promote, /id="promoteExistingBtn"/);

  // These are the only promotion products the backend genuinely supports.
  assert.match(promote, /option value="article">Published Article/);
  assert.match(promote, /option value="directory">Published Directory Profile/);
  assert.doesNotMatch(promote, /option value="event"/);
  assert.doesNotMatch(promote, /option value="gallery"/);
  assert.doesNotMatch(promote, /option value="marketplace"/);
});

test('eligibility comes from the backend, not browser date guesses', () => {
  assert.match(promote, /api\('\/highlights\/eligible'\)/);
  assert.match(highlights, /router\.get\('\/eligible', requireAuth/);
  assert.match(highlights, /scheduled_for::date <= CURRENT_DATE/);
  assert.match(highlights, /status = 'approved'/);
  assert.match(highlights, /supportedTypes: \['article', 'directory'\]/);
});

test('direct purchase requests cannot bypass public eligibility', () => {
  assert.match(highlights, /Only content that is approved and publicly live can be promoted/);
  assert.match(highlights, /approved but scheduled for later/);
  assert.match(highlights, /availablePackages\.some/);
  assert.match(highlights, /You can only highlight your own content/);
});

test('the new shortcut really opens Browse Services before scrolling', () => {
  // The promotion shortcut is installed after msSetupNav wired the original
  // buttons. browse.click() is therefore intentional: data-ms alone would not
  // switch a hidden Services section for this dynamically-added button.
  assert.match(promote, /if \(browse\) browse\.click\(\)/);
  assert.match(promote, /card\.scrollIntoView/);
  assert.match(promote, /Promote Existing Content<\/span><span class="d">/);
});

test('legacy split highlight loader cannot rewrite the unified card', () => {
  assert.match(promote, /window\.loadHighlightServices = wrappedLoadHighlightServices/);
  assert.match(promote, /data-promote-existing-content/);
  assert.equal(fs.existsSync(path.join(root, 'unplug-promote-existing-guard.js')), false,
    'the obsolete second compatibility shim should stay deleted');
});

test('production build injects the promotion module only into the member dashboard', () => {
  assert.match(build, /'unplug-promote-existing\.js'/);
  assert.match(build, /file === 'unplug-member-dashboard\.html'/);
  assert.match(build, /report\.moduleMap\['unplug-promote-existing\.js'\]/);
});
