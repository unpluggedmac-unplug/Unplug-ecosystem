// DIR-001: "show exactly what customers receive" — a live example link
// under each Directory package tier, not a mockup. Reuses the existing
// GET /directory?type=&package= filter rather than adding a new endpoint.
//
// Website remediation punch-list (2026-09-03).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'unplug-magazine.html');

function read() {
  assert.ok(fs.existsSync(FILE), 'unplug-magazine.html should exist');
  return fs.readFileSync(FILE, 'utf8').split('\r\n').join('\n');
}

test('EACH TIER CARD HAS AN EXAMPLE SLOT, ONE PER TIER', () => {
  const src = read();
  for (const tier of ['basic', 'pro', 'premium']) {
    assert.ok(src.includes(`class="tier-example section-hidden" data-tier="${tier}"`),
      `${tier} should have a tier-example element, starting hidden`);
  }
});

test('EXAMPLES ARE FETCHED FROM THE EXISTING DIRECTORY FILTER, NOT A NEW ENDPOINT', () => {
  const src = read();
  const start = src.indexOf('async function loadTierExamples()');
  assert.ok(start > -1);
  const body = src.slice(start, start + 1200);
  assert.match(body, /api\('\/directory\?'/, 'should call the existing GET /directory');
  assert.match(body, /type:\s*PKG_TYPE/, 'should filter by the currently selected Individual/Business type');
  assert.match(body, /package:\s*tier/, 'should filter by tier');
});

test('A TIER WITH NO EXAMPLE YET STAYS HIDDEN — NEVER A LINK TO NOWHERE', () => {
  const src = read();
  const start = src.indexOf('async function loadTierExamples()');
  const body = src.slice(start, start + 1600);
  assert.match(body, /if \(!example\)/, 'should explicitly check for a missing example');
  assert.match(body, /el\.classList\.add\('section-hidden'\)/, 'and hide the element when there is none');
});

test('SWITCHING INDIVIDUAL/BUSINESS RE-FETCHES THE EXAMPLES, NOT JUST THE PRICES', () => {
  const src = read();
  const toggleStart = src.indexOf("getElementById('pkgTypeToggle').addEventListener('click'");
  assert.ok(toggleStart > -1);
  const handler = src.slice(toggleStart, toggleStart + 800);
  assert.match(handler, /loadTierExamples\(\)/, 'the toggle handler should refresh the examples for the new type');
});

test('THE LINK OPENS IN A NEW TAB — CHOOSING A PACKAGE ISN\'T LOST BY LOOKING AT AN EXAMPLE', () => {
  const src = read();
  const start = src.indexOf('async function loadTierExamples()');
  const body = src.slice(start, start + 1600);
  assert.match(body, /target="_blank"/);
});
