// TRUST-003, frontend half. Also covers a fabricated testimonial found
// while building this: the homepage's Investor Spotlight fallback card
// attributed an invented quote to a named "David Khumalo, Strategic
// Partner" whenever no real project spotlight was active — exactly the
// thing this punch-list item warns against, live on the public homepage.
//
// Website remediation punch-list (2026-09-03), TRUST-003.
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

test('THE FABRICATED "DAVID KHUMALO" TESTIMONIAL IS GONE FROM THE ACTUAL CARD MARKUP', () => {
  const src = read();
  const idx = src.indexOf('id="spotlightFallbackCard"');
  assert.ok(idx > -1);
  // Forward from the card's own opening tag — this is after the
  // explanatory comment above it, which names the old fabrication on
  // purpose, as history, and is not part of what actually renders.
  const block = src.slice(idx, idx + 600);
  assert.ok(!block.includes('David Khumalo'), 'the invented name must not appear in the rendered card');
  assert.ok(!block.includes('infrastructure for community trust'), 'the invented quote must not appear in the rendered card');
  assert.ok(!/class="inv-title"/.test(block), 'a role/title line implies a real named person behind the quote');
});

test('THE TESTIMONIALS SECTION IS HIDDEN BY DEFAULT AND ONLY REVEALED WHEN THE FEED RETURNS SOMETHING', () => {
  const src = read();
  const secIdx = src.indexOf('id="testimonialsSection"');
  assert.ok(secIdx > -1);
  assert.match(src.slice(secIdx, secIdx + 60), /hidden/, 'the section must start hidden, not empty-but-visible');

  const fnIdx = src.indexOf('async function loadTestimonials()');
  assert.ok(fnIdx > -1);
  const body = src.slice(fnIdx, fnIdx + 500);
  assert.match(body, /api\('\/testimonials'\)/);
  assert.match(body, /section\.hidden = true/, 'an empty or failed feed must hide the section, not show it empty');
  assert.match(body, /section\.hidden = false/, 'a non-empty feed must reveal it');
});

test('EACH TESTIMONIAL CARD RENDERS THE REAL QUOTE AND AUTHOR NAME FROM THE API RESPONSE, ESCAPED', () => {
  const src = read();
  const fnIdx = src.indexOf('function testimonialCardHtml(t)');
  assert.ok(fnIdx > -1);
  const body = src.slice(fnIdx, fnIdx + 500);
  assert.match(body, /escapeHtml\(t\.quote\)/);
  assert.match(body, /escapeHtml\(t\.author_name\)/);
});

test('loadTestimonials() IS CALLED ON HOMEPAGE LOAD', () => {
  const src = read();
  const idx = src.indexOf("document.addEventListener('DOMContentLoaded'");
  assert.ok(idx > -1);
  const block = src.slice(idx, idx + 300);
  assert.match(block, /loadTestimonials\(\);/);
});
