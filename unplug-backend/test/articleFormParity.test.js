// A member submits an article on the same form an editor publishes one on.
//
// The two screens were built at different times and drifted: the admin editor
// grew a subtitle, a category, an SEO title, a meta description, a conclusion
// and a call to action, and the member form never did. The server accepted all
// of them from either side the whole time — the fields simply were not offered,
// so every member's article arrived missing parts an editor then had to write
// for them, or publish without.
//
// This reads both files and compares what each SENDS when it CREATES an
// article. Not a rendering test: the point is the shape of the submission.
//
// WHY "WHEN IT CREATES". The admin editor sends slug, keywords, tags and key
// takeaways too, but only when EDITING an existing article — on a new one the
// server generates them, for admins and members alike. Comparing everything the
// admin screen can ever send would demand fields of the member form that the
// editor does not have at this point either.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ADMIN = path.join(ROOT, 'unplug-admin-dashboard.html');
const MEMBER = path.join(ROOT, 'unplug-member-dashboard.html');

// Editorial decisions about the publication, not parts of the story. The server
// ignores each of these from anyone who is not an admin, so a member form that
// offered them would be offering something that cannot work.
const ADMIN_ONLY = new Set([
  'contributorId',      // who the byline links to
  'requiresAccount',    // whether reading it needs a sign-in
  'saveAsDraft',        // publish / draft / delete
  'status',
  'bodyFormat',         // the member form is plain text by design; see below
]);

function read(file) {
  assert.ok(fs.existsSync(file), `${path.basename(file)} should exist`);
  // Normalised: these files are edited on Windows and carry CRLF, which would
  // otherwise make every multi-line anchor below miss.
  return fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
}

// The keys of the object literal a screen posts. Taken from the payload block
// rather than the whole file so unrelated request bodies are not swept in.
function keysIn(block) {
  return new Set(
    [...block.matchAll(/^\s{4,}([A-Za-z][A-Za-z0-9]*)\s*:/gm)].map((m) => m[1])
  );
}

function adminCreateKeys() {
  const src = read(ADMIN);
  // Located from a line only the ARTICLE payload has. The dashboard builds a
  // `payload` object on several screens and the first one in the file is a
  // different form entirely.
  const marker = src.indexOf("subtitle: document.getElementById('artSubtitle')");
  assert.ok(marker > -1, 'the admin editor should still send a subtitle');
  const start = src.lastIndexOf('const payload = {', marker);
  assert.ok(start > -1, 'the admin editor should build a payload object');
  // Stops at the ART_EDITING_ID guard: everything after it is sent only when
  // editing an article that already exists.
  const end = src.indexOf('if (ART_EDITING_ID) {', start);
  assert.ok(end > start, 'the edit-only block should still be there');
  return keysIn(src.slice(start, end));
}

function memberCreateKeys() {
  const src = read(MEMBER);
  const start = src.indexOf("      body: JSON.stringify({\n        title, body,");
  assert.ok(start > -1, 'the member form should build an article body');
  const end = src.indexOf('      }),', start);
  assert.ok(end > start);
  const block = src.slice(start, end);
  const keys = keysIn(block);
  // `title, body,` is shorthand, so it has no colon to match.
  keys.add('title');
  keys.add('body');
  return keys;
}

test('THE MEMBER FORM SENDS EVERYTHING THE ADMIN EDITOR SENDS', () => {
  const admin = adminCreateKeys();
  const member = memberCreateKeys();

  const missing = [...admin].filter((k) => !member.has(k) && !ADMIN_ONLY.has(k));
  assert.deepEqual(missing, [],
    'these are on the admin publish screen but not on the member form: ' + missing.join(', '));
});

test('and the fields that stay with the editor are named, not forgotten', () => {
  // The guard against this test being satisfied by quietly adding a field to
  // ADMIN_ONLY: each one has to be a field the admin screen actually sends.
  const admin = adminCreateKeys();
  for (const k of ADMIN_ONLY) {
    if (k === 'saveAsDraft' || k === 'status') continue;   // sent below the payload
    assert.ok(admin.has(k), `${k} is listed as admin-only but the admin screen no longer sends it`);
  }
});

test('THE FIELDS ARE IN THE SAME ORDER ON BOTH SCREENS', () => {
  // "The exact same structure" is about what a writer sees, not only what is
  // posted. Both screens ask for the headline and category first, then the
  // subtitle, the SEO title and the social summary, then who wrote it, then the
  // story itself, and close with the conclusion and the call to action.
  const order = ['title', 'category', 'subtitle', 'seo', 'meta',
    'author', 'kicker', 'body', 'video', 'conclusion', 'cta'];

  const member = read(MEMBER);
  const block = member.slice(member.indexOf('<div id="fields-article">'),
    member.indexOf('<!-- Event fields -->'));

  let at = -1;
  for (const field of order) {
    const idx = block.indexOf(`id="art-${field}`);
    assert.ok(idx > -1, `the member form should have an art-${field} field`);
    assert.ok(idx > at, `art-${field} is out of order on the member form`);
    at = idx;
  }
});

test('the member form stays plain text', () => {
  // The admin editor has an HTML toggle because an editor pastes prepared
  // markup. The member form does not, and sends 'text' unconditionally — this
  // is the one deliberate difference in what the two screens post, and it is a
  // narrowing rather than a gap.
  const member = read(MEMBER);
  assert.match(member, /bodyFormat: 'text'/);
  assert.ok(!/id="art-plain-?text"/i.test(member),
    'the member form should not offer an HTML mode');
});

test('the category list comes from the same place as the admin editor', () => {
  // Two screens reading one endpoint, rather than a second list to keep in step.
  assert.match(read(MEMBER), /api\('\/news\/categories'\)/);
  assert.match(read(ADMIN), /api\('\/news\/categories'\)/);
});
