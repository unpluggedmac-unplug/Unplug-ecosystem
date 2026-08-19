// ARTICLE METADATA — the derived fields readers actually see.
//
// tags and key_takeaways are printed on the public article page ("Topics in
// this story"). Derived text that reads as machine output is what makes a
// publication look unedited, so these tests pin the two specific ways that was
// happening on the live site:
//
//   1. A frequency-ranked tag list labelled a real article
//      "Journey · South · Road · SOMETHING · Africa".
//   2. A takeaway lifted mid-flow: "And it is one that makes this journey
//      worth watching." — a fragment referring to a sentence not shown.
//
// Pure functions, no database — this file runs in milliseconds.
//
// Run with:  npm test   (from unplug-backend/)

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { keywords, suggestedTags, keyTakeaways, cleanTopicTerms } = require('../src/utils/articleMeta');

// Repeats "something" and "someone" often enough to rank them, the way the
// real article did.
const CHATTY = `
  There is something about the road that changes someone. Something shifts when
  the kilometres add up, and someone who leaves is rarely someone who returns.
  The journey through the provinces teaches something no classroom can.
  Farmers in Limpopo spoke about drought. Teachers in Mpumalanga spoke about
  hope. The journey rewards someone willing to listen to something unfamiliar.
`;

test('an indefinite pronoun never becomes a tag, however often it is used', () => {
  const tags = suggestedTags(CHATTY, 8).map((t) => t.toLowerCase());
  assert.ok(!tags.includes('something'), 'THIS IS THE LIVE BUG: "Something" was a public topic tag');
  assert.ok(!tags.includes('someone'));
  assert.ok(!tags.includes('anything'));
});

test('the real topics survive the filter', () => {
  const tags = suggestedTags(CHATTY, 8).map((t) => t.toLowerCase());
  assert.ok(tags.includes('journey'), 'filtering junk must not throw away what the piece is about');
  assert.ok(tags.length > 0, 'an article must still get tags');
});

test('dropping a junk term promotes a real one rather than shortening the list', () => {
  // The filter runs after ranking and before the slice, so asking for 3 tags
  // returns 3 usable ones — not 3 minus however many were junk.
  const tags = suggestedTags(CHATTY, 3);
  assert.equal(tags.length, 3);
  tags.forEach((t) => assert.ok(!['Something', 'Someone'].includes(t)));
});

test('"South" alone is not a topic — it is half of a country', () => {
  // Every article here is South African; the fragment distinguishes nothing.
  assert.deepEqual(cleanTopicTerms(['South', 'Africa', 'Farming']), ['Africa', 'Farming']);
});

test('cleanTopicTerms is case-insensitive and survives odd input', () => {
  assert.deepEqual(cleanTopicTerms(['SOMETHING', 'someone', ' Else ']), []);
  assert.deepEqual(cleanTopicTerms([]), []);
  assert.equal(cleanTopicTerms(null), null, 'a null column is passed through, not turned into []');
  assert.equal(cleanTopicTerms(undefined), undefined);
});

test('a takeaway never opens with a conjunction', () => {
  // "And it is one that makes this journey worth watching." was live. Out of
  // order and on its own, it refers to a sentence the reader cannot see.
  const text = `
    The project began in a small workshop outside Bloemfontein with two people
    and one secondhand machine that barely worked at all.
    And it is one that makes this whole story worth watching closely.
    But the numbers tell a very different story about what happened next there.
    They now employ fourteen people and supply three provinces with their goods.
  `;
  const takeaways = keyTakeaways(text, 4);
  assert.ok(takeaways.length > 0, 'there must still be takeaways');
  takeaways.forEach((t) => {
    assert.doesNotMatch(t.trim(), /^(And|But|So|Or|Because|However|Which|That)[^a-z]/i,
      `takeaway reads as a fragment: ${t}`);
  });
});

test('a word that merely STARTS with a conjunction is not a fragment', () => {
  // "Android", "Sometimes", "Thato" must not be mistaken for "and", "so", "that".
  const text = `
    Android developers across Cape Town are quietly building for the continent.
    Sometimes the most interesting companies are the ones nobody writes about.
    Thato started the business at twenty three with savings from a part time job.
  `;
  const takeaways = keyTakeaways(text, 3);
  assert.equal(takeaways.length, 3, 'none of these three sentences may be discarded');
});

test('an article made only of fragments still yields nothing rather than throwing', () => {
  assert.deepEqual(keyTakeaways('And so it goes. But then again. However it was.', 3), []);
});

test('keywords are filtered too, not just the title-cased tags', () => {
  // The reader page falls back to keywords when tags are absent, so filtering
  // only tags would leave the same junk visible on those articles.
  const kw = keywords(CHATTY, 8);
  assert.ok(!kw.includes('something'));
  assert.ok(!kw.includes('someone'));
});
