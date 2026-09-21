const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function readSite(filename) {
  return fs.readFileSync(path.join(ROOT, filename), 'utf8').split('\r\n').join('\n');
}

function readBackend(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8').split('\r\n').join('\n');
}

const {
  MAX_MEMBER_OPENING_STORY_CHARS,
  validateMemberOpeningStory,
} = require('../src/utils/articleOpeningStory');

test('member Opening Story validator accepts 299 and exactly 300 characters', () => {
  assert.equal(MAX_MEMBER_OPENING_STORY_CHARS, 300);
  const member = { role: 'member' };
  assert.equal(validateMemberOpeningStory(member, 'a'.repeat(299)), null);
  assert.equal(validateMemberOpeningStory(member, 'a'.repeat(300)), null);
});

test('member Opening Story validator rejects 301+ characters without truncating', () => {
  const member = { role: 'member' };
  const value = 'a'.repeat(301);
  const error = validateMemberOpeningStory(member, value);
  assert.match(error, /300 characters or fewer/);
  assert.equal(value.length, 301, 'validation must reject rather than mutate/truncate the submitted text');
});

test('admin/editor article bodies remain compatible with longer legacy main-story bodies', () => {
  assert.equal(validateMemberOpeningStory({ role: 'admin' }, 'a'.repeat(1200)), null);
});

test('member dashboard clearly teaches Opening Story = introduction and Sections = full article', () => {
  const src = readSite('unplug-member-dashboard.html');
  assert.match(src, /OPENING STORY — INTRODUCTION ONLY/);
  assert.match(src, /Your Opening Story is limited to 300 characters\. Use this space to introduce your article and capture the reader's attention\./);
  assert.match(src, /To write the complete article, use the “\+ Add section” option below to add additional sections, headings, paragraphs and images\./);
  assert.match(src, /Build your complete article using sections/);
  assert.match(src, /The Opening Story is only your introduction\. Use “\+ Add section” to continue writing the full article and divide your story into clear sections\./);
  assert.match(src, /1\. Opening Story — Introduction \(maximum 300 characters\)/);
  assert.match(src, /2\. Add Section — Continue your article/);
  assert.match(src, /3\. Add additional sections as needed/);
  assert.match(src, /4\. Conclusion — Optional/);
});

test('Opening Story field has a native 300-character cap and visible counter', () => {
  const src = readSite('unplug-member-dashboard.html');
  const start = src.indexOf('<textarea id="art-body"');
  assert.ok(start > -1);
  const tag = src.slice(start, src.indexOf('></textarea>', start) + '></textarea>'.length);
  assert.match(tag, /maxlength="300"/);
  assert.match(tag, /aria-describedby="art-opening-note art-body-count art-body-limit-message"/);
  assert.match(src, /id="art-body-count"[^>]*>0 \/ 300 characters</);
});

test('oversized paste is prevented and submission is blocked before the API call', () => {
  const src = readSite('unplug-member-dashboard.html');
  const pasteStart = src.indexOf("articleOpeningBox.addEventListener('paste'");
  assert.ok(pasteStart > -1);
  const pasteBlock = src.slice(pasteStart, src.indexOf("articleOpeningBox.addEventListener('beforeinput'", pasteStart));
  assert.match(pasteBlock, /nextLength > ARTICLE_OPENING_MAX_CHARS/);
  assert.match(pasteBlock, /event\.preventDefault\(\)/);

  const submitStart = src.indexOf("async function createSubmission(type)");
  const submitBlock = src.slice(submitStart, src.indexOf("if (type === 'event')", submitStart));
  assert.match(submitBlock, /openingStory\.length > ARTICLE_OPENING_MAX_CHARS/);
  assert.match(submitBlock, /throw new Error\('Opening Story must be 300 characters or fewer\./);
});

test('draft save and restore keep the Opening Story validation/counter in sync', () => {
  const src = readSite('unplug-member-dashboard.html');
  const restoreStart = src.indexOf('function restoreDraftForType(type, data)');
  const restoreBlock = src.slice(restoreStart, src.indexOf('function saveDraftNow()', restoreStart));
  assert.match(restoreBlock, /renderArticleOpeningCounter\(\);/);
  assert.match(restoreBlock, /updateArticleReadtime\(\);/);

  const saveStart = src.indexOf('function saveDraftNow()');
  const saveBlock = src.slice(saveStart, src.indexOf('function clearDraft(type)', saveStart));
  assert.match(saveBlock, /type === 'article' && !articleOpeningWithinLimit\(\)/);
  assert.match(saveBlock, /Draft not saved — shorten Opening Story to 300 characters\./);
});

test('600-1200 word guidance belongs to the complete article/sections area, not the introduction field', () => {
  const src = readSite('unplug-member-dashboard.html');
  const articleBlock = src.slice(src.indexOf('<div id="fields-article">'), src.indexOf('<!-- Event fields -->'));
  const openingStart = articleBlock.indexOf('id="art-opening-note"');
  const videoStart = articleBlock.indexOf('id="art-video"');
  const openingArea = articleBlock.slice(openingStart, videoStart);
  assert.doesNotMatch(openingArea, /600-1200 words/);

  const sectionsStart = articleBlock.indexOf('Build your complete article using sections');
  const sectionsEnd = articleBlock.indexOf('id="artSections"', sectionsStart);
  assert.match(articleBlock.slice(sectionsStart, sectionsEnd), /600-1200 words/);
  assert.match(src, /document\.querySelectorAll\('#artSections \.art-sec-para'\)/);
});

test('section paragraph fields remain unrestricted by the 300-character introduction rule', () => {
  const src = readSite('unplug-member-dashboard.html');
  const start = src.indexOf('function artSectionHtml(index, data)');
  assert.ok(start > -1);
  const end = src.indexOf('// One delegated listener', start);
  const block = src.slice(start, end);
  assert.match(block, /class="art-sec-para"/);
  assert.doesNotMatch(block, /art-sec-para[^>]*maxlength="300"/);
});

test('article API rejects oversized member openings on create and owner edit', () => {
  const src = readBackend('src/routes/articles.js');
  const postStart = src.indexOf("router.post('/', requireAuth");
  const patchStart = src.indexOf("router.patch('/:id'", postStart);
  assert.ok(postStart > -1 && patchStart > postStart);
  assert.match(src.slice(postStart, patchStart), /validateMemberOpeningStory\(req\.user, body\)/);

  const patchEnd = src.indexOf('// POST /articles/backfill-metadata', patchStart);
  assert.match(src.slice(patchStart, patchEnd), /validateMemberOpeningStory\(req\.user, body\)/);
});

test('database constraint is scoped to member Opening Story rows and preserves legacy/admin articles', () => {
  const migration = readBackend('db/migrations/218_member_article_opening_story_limit.sql');
  assert.match(migration, /member_opening_story_limited BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(migration, /NOT member_opening_story_limited\s+OR char_length\(body\) <= 300/);

  const routes = readBackend('src/routes/articles.js');
  assert.match(routes, /requires_account, member_opening_story_limited/);
  assert.match(routes, /req\.user\.role !== 'admin'/);
  assert.match(routes, /member_opening_story_limited = \$\$\{values\.length\}/);
});

test('mobile CSS keeps the instructional note and counter visible rather than hover-only', () => {
  const src = readSite('unplug-member-dashboard.html');
  assert.match(src, /@media\(max-width:700px\)\{\s*\.article-opening-note, \.article-writing-flow, \.article-sections-note/);
  assert.match(src, /#art-body-limit-message\{ display:block; margin-top:4px; \}/);
  assert.doesNotMatch(src, /\.article-opening-note[^}]*display\s*:\s*none/);
});
