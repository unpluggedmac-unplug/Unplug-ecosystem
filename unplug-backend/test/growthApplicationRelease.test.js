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
  const m202 = fs.readFileSync(path.join(BACKEND, 'db/migrations/202_growth_application_v2.sql'), 'utf8');
  for (const sql of [m195, m196, m202]) {
    assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
    assert.doesNotMatch(sql, /DROP\s+TABLE/i);
    assert.doesNotMatch(sql, /DELETE\s+FROM\s+users/i);
  }
  assert.match(m195, /CREATE TABLE IF NOT EXISTS growth_applications/i);
  assert.match(m195, /growth_application_short_links/i);
  assert.match(m196, /stage_schema_version/i);
  assert.match(m202, /CREATE TABLE IF NOT EXISTS growth_form_versions/i);
  assert.match(m202, /CREATE TABLE IF NOT EXISTS growth_application_answer_revisions/i);
  assert.match(m202, /CREATE TABLE IF NOT EXISTS growth_information_requests/i);
  assert.match(m202, /CREATE TABLE IF NOT EXISTS growth_assessments/i);
  assert.match(m202, /CREATE TABLE IF NOT EXISTS growth_plans/i);
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

test('backend mounts legacy Growth plus isolated V2 member/admin APIs', () => {
  const app = fs.readFileSync(path.join(BACKEND, 'src/app.js'), 'utf8');
  assert.match(app, /app\.use\('\/growth-application\/v2',\s*require\('\.\/routes\/growthApplicationV2'\)\)/);
  assert.match(app, /app\.use\('\/growth-admin',\s*require\('\.\/routes\/growthAdmin'\)\)/);
  assert.match(app, /app\.use\('\/growth-application',\s*growthApplicationRoutes\.router\)/);
  assert.match(app, /app\.use\('\/grow',\s*growthApplicationRoutes\.shortLinkRouter\)/);
});

test('Growth uploads are member-only, private R2, 10MB and fail closed', () => {
  const route = fs.readFileSync(path.join(BACKEND, 'src/routes/growthApplicationUpload.js'), 'utf8');
  const upload = fs.readFileSync(path.join(BACKEND, 'src/middleware/upload.js'), 'utf8');
  assert.match(route, /requireAuth/);
  assert.match(route, /req\.user\.role !== 'member'/);
  assert.match(route, /if \(!uploads\.r2PrivateConfigured\)/);
  assert.match(route, /status\(503\)/);
  assert.match(route, /uploadPrivateBuffer/);
  assert.doesNotMatch(route, /uploadPublicBuffer/);
  assert.match(route, /growth\.sensitive/);
  assert.match(route, /external_sharing_allowed/);
  assert.match(upload, /MAX_GROWTH_IMAGE_SIZE_BYTES = 10 \* 1024 \* 1024/);
});

test('Growth V2 is member-only, resumable, append-only and status-only after submission', () => {
  const route = fs.readFileSync(path.join(BACKEND, 'src/routes/growthApplicationV2.js'), 'utf8');
  assert.match(route, /router\.use\(requireAuth\)/);
  assert.match(route, /req\.user\.role !== 'member'/);
  assert.match(route, /status='draft'/);
  assert.match(route, /growth_application_answer_revisions/);
  assert.match(route, /revision_number/);
  assert.match(route, /growth_application_field_reopens/);
  assert.match(route, /Only fields specifically reopened by Unplug/);
  assert.match(route, /POPIA consent is required before submission/);
  assert.match(route, /informationRequests/);
  assert.match(route, /status='withdrawn'/);
  assert.doesNotMatch(route, /growth_assessments|growth_plans|internal_notes/);
});

test('Growth V2 separates ordinary and sensitive staff capabilities', () => {
  const permissions = fs.readFileSync(path.join(BACKEND, 'src/utils/staffPermissions.js'), 'utf8');
  const admin = fs.readFileSync(path.join(BACKEND, 'src/routes/growthAdmin.js'), 'utf8');
  const migration = fs.readFileSync(path.join(BACKEND, 'db/migrations/202_growth_application_v2.sql'), 'utf8');
  assert.match(permissions, /'growth\.view'/);
  assert.match(permissions, /'growth\.manage'/);
  assert.match(permissions, /'growth\.sensitive'/);
  assert.match(permissions, /\/growth-admin/);
  assert.match(admin, /\/sensitive/);
  assert.match(migration, /'support', 'growth\.view'/);
  assert.match(migration, /'support', 'growth\.manage'/);
  assert.doesNotMatch(migration, /'support', 'growth\.sensitive'/);
});

test('Growth V2 preserves stable form versions, field ids, selective sensitive fields and relational links', () => {
  const sql = fs.readFileSync(path.join(BACKEND, 'db/migrations/202_growth_application_v2.sql'), 'utf8');
  assert.match(sql, /UNIQUE\(form_id, version_number\)/i);
  assert.match(sql, /UNIQUE\(version_id, field_key\)/i);
  assert.match(sql, /sensitive_enabled/);
  assert.match(sql, /allow_external_sharing/);
  assert.match(sql, /growth_application_entity_links/);
  assert.match(sql, /'agreement'/);
  assert.match(sql, /'service_order'/);
});

test('final submission enforces legacy schema versions, all three stages, galleries and POPIA consent', () => {
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

test('legacy pipeline requires messages for Contacted/In progress/Closed and a private closed reason', () => {
  const route = fs.readFileSync(path.join(BACKEND, 'src/routes/growthApplication.js'), 'utf8');
  assert.match(route, /MESSAGE_STATUSES = new Set\(\['contacted', 'in_progress', 'closed'\]\)/);
  assert.match(route, /An applicant-facing message is required/);
  assert.match(route, /A private closed_reason is required/);
});

test('public Growth config never exposes the private current short code', () => {
  const route = fs.readFileSync(path.join(BACKEND, 'src/routes/growthApplication.js'), 'utf8');
  const publicBlock = route.slice(route.indexOf("router.get('/public-config'"), route.indexOf("router.get('/entry-access'"));
  assert.ok(publicBlock.length > 0);
  assert.doesNotMatch(publicBlock, /growth_application_short_code|current_short_code|shortCode/);
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

test('Growth integration covers admin, member journey, resume links, member popup and public placements', () => {
  const integration = read('growth-integration.js');
  assert.match(integration, /Growth Applications/);
  assert.match(integration, /My Growth Journey/);
  assert.match(integration, /Show my resume link/);
  assert.match(integration, /resume-link/);
  assert.match(integration, /applications\/me/);
  assert.match(integration, /member_dashboard/);
  assert.match(integration, /addMemberJourneyLink\(config\)/);
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