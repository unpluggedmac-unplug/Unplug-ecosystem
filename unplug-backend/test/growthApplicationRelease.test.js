'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { schemaFor, validateStage, STAGE_SCHEMA_VERSION } = require('../src/data/growthApplicationStages');

const ROOT = path.join(__dirname, '..', '..');
const BACKEND = path.join(ROOT, 'unplug-backend');

function read(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

test('Growth migrations exist and remain additive', () => {
  const m195 = fs.readFileSync(path.join(BACKEND, 'db/migrations/195_growth_application.sql'), 'utf8');
  const m196 = fs.readFileSync(path.join(BACKEND, 'db/migrations/196_growth_application_stage_version.sql'), 'utf8');
  for (const sql of [m195, m196]) {
    assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
    assert.doesNotMatch(sql, /DROP\s+TABLE/i);
    assert.doesNotMatch(sql, /DELETE\s+FROM\s+users/i);
  }
  assert.match(m195, /CREATE TABLE IF NOT EXISTS growth_applications/i);
  assert.match(m195, /growth_application_short_links/i);
  assert.match(m196, /stage_schema_version/i);
});

test('Quick Profile and Growth Assessment enforce every required intake field', () => {
  const schema = schemaFor('individual');
  assert.equal(STAGE_SCHEMA_VERSION, '2026-09-11-intake-v1');
  assert.equal(schema.quick_profile.filter((field) => field.required).length, schema.quick_profile.length);
  assert.equal(schema.growth_assessment.filter((field) => field.required).length, schema.growth_assessment.length);

  const quick = {};
  for (const field of schema.quick_profile) {
    quick[field.key] = field.allow_unavailable ? { unavailable: true } : 'Complete answer';
  }
  assert.equal(validateStage('individual', 'quick_profile', quick).ok, true);
  delete quick.full_name;
  assert.equal(validateStage('individual', 'quick_profile', quick).ok, false);
});

test('Growth intake schema contains exactly six social channels and two 10-image galleries', () => {
  const schema = schemaFor('business');
  const social = schema.quick_profile.filter((field) => /_url$/.test(field.key) && !['website_url','portfolio_url'].includes(field.key));
  assert.deepEqual(social.map((field) => field.key), [
    'facebook_url','instagram_url','tiktok_url','linkedin_url','youtube_url','x_url',
  ]);
  assert.equal(schema.galleries.length, 2);
  assert.ok(schema.galleries.every((gallery) => gallery.max_images === 10));
  assert.ok(schema.galleries.every((gallery) => gallery.max_bytes_each === 10 * 1024 * 1024));
});

test('backend mounts Growth API and stable short-link namespace', () => {
  const app = fs.readFileSync(path.join(BACKEND, 'src/app.js'), 'utf8');
  assert.match(app, /app\.use\('\/growth-application',\s*growthApplicationRoutes\.router\)/);
  assert.match(app, /app\.use\('\/grow',\s*growthApplicationRoutes\.shortLinkRouter\)/);
});

test('Growth upload is member-only, 10MB and fails closed without R2', () => {
  const route = fs.readFileSync(path.join(BACKEND, 'src/routes/growthApplicationUpload.js'), 'utf8');
  const upload = fs.readFileSync(path.join(BACKEND, 'src/middleware/upload.js'), 'utf8');
  assert.match(route, /requireAuth/);
  assert.match(route, /if \(!uploads\.r2Configured\)/);
  assert.match(route, /status\(503\)/);
  assert.match(route, /uploadPublicBuffer/);
  assert.match(upload, /MAX_GROWTH_IMAGE_SIZE_BYTES = 10 \* 1024 \* 1024/);
});

test('final submission enforces schema versions, all three stages, galleries and POPIA consent', () => {
  const route = fs.readFileSync(path.join(BACKEND, 'src/routes/growthApplication.js'), 'utf8');
  assert.match(route, /question_bank_version !== QUESTION_BANK_VERSION/);
  assert.match(route, /stage_schema_version !== STAGE_SCHEMA_VERSION/);
  assert.match(route, /validateStage\(application\.applicant_type, 'quick_profile'/);
  assert.match(route, /validateStage\(application\.applicant_type, 'growth_assessment'/);
  assert.match(route, /validateDeepDiscovery\(application\.applicant_type/);
  assert.match(route, /brand_style_images/);
  assert.match(route, /applicant_team_images/);
  assert.match(route, /popia_consent !== true/);
});

test('pipeline requires messages for Contacted/In progress/Closed and a private closed reason', () => {
  const route = fs.readFileSync(path.join(BACKEND, 'src/routes/growthApplication.js'), 'utf8');
  assert.match(route, /MESSAGE_STATUSES = new Set\(\['contacted', 'in_progress', 'closed'\]\)/);
  assert.match(route, /An applicant-facing message is required/);
  assert.match(route, /A private closed_reason is required/);
});

test('Cloudflare resolves persistent Growth short links and only redirects same-origin', () => {
  const fn = read('functions', '[[path]].js');
  assert.match(fn, /\^\\\/grow\\\/\(/);
  assert.match(fn, /growth-application\/entry-access/);
  assert.match(fn, /unplug-growth-application\.html/);
  assert.match(fn, /Response\.redirect\(target\.toString\(\), 302\)/);
});

test('production build explicitly packages both Growth pages and the integration asset', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.build, /build-growth-pages\.js/);
  const builder = read('scripts', 'build-growth-pages.js');
  assert.match(builder, /unplug-growth-application\.html/);
  assert.match(builder, /unplug-growth-applications-admin\.html/);
  assert.match(builder, /growth-integration\.js/);
});

test('Growth integration covers admin, member journey, member popup and public placements', () => {
  const integration = read('growth-integration.js');
  assert.match(integration, /Growth Applications/);
  assert.match(integration, /My Growth Journey/);
  assert.match(integration, /applications\/me/);
  assert.match(integration, /member_dashboard/);
  assert.match(integration, /site_visibility !== 'visible'/);
  for (const key of ['homepage','latest_news','directory','gallery','editions','top10','competitions']) {
    assert.match(integration, new RegExp(key));
  }
});

test('admin preview remains clearly labelled and does not store placeholder data', () => {
  const route = fs.readFileSync(path.join(BACKEND, 'src/routes/growthApplication.js'), 'utf8');
  const admin = read('unplug-growth-applications-admin.html');
  assert.match(route, /PREVIEW — PLACEHOLDER DATA — NOTHING STORED/);
  assert.match(admin, /PREVIEW — PLACEHOLDER DATA — NOTHING STORED/);
});

test('automatic NEED/OFFER matching is not implemented in this release', () => {
  const route = fs.readFileSync(path.join(BACKEND, 'src/routes/growthApplication.js'), 'utf8');
  assert.doesNotMatch(route, /match(?:ing)?_engine|auto.?match|candidate_match/i);
});
