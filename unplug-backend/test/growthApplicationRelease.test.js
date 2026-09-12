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
  const files = [
    '195_growth_application.sql',
    '196_growth_application_stage_version.sql',
    '202_growth_application_v2.sql',
    '203_growth_application_master_seed.sql',
    '204_growth_application_prefill.sql',
  ];
  const sql = files.map((file) => fs.readFileSync(path.join(BACKEND, 'db/migrations', file), 'utf8'));
  for (const body of sql) {
    assert.doesNotMatch(body, /\bTRUNCATE\b/i);
    assert.doesNotMatch(body, /DROP\s+TABLE/i);
    assert.doesNotMatch(body, /DELETE\s+FROM\s+users/i);
  }
  assert.match(sql[0], /CREATE TABLE IF NOT EXISTS growth_applications/i);
  assert.match(sql[0], /growth_application_short_links/i);
  assert.match(sql[1], /stage_schema_version/i);
  assert.match(sql[2], /CREATE TABLE IF NOT EXISTS growth_form_versions/i);
  assert.match(sql[2], /CREATE TABLE IF NOT EXISTS growth_application_answer_revisions/i);
  assert.match(sql[2], /CREATE TABLE IF NOT EXISTS growth_information_requests/i);
  assert.match(sql[2], /CREATE TABLE IF NOT EXISTS growth_assessments/i);
  assert.match(sql[2], /CREATE TABLE IF NOT EXISTS growth_plans/i);
  assert.match(sql[3], /Unplug Growth Application/);
  assert.match(sql[3], /identity_profile/);
  assert.match(sql[3], /declarations/);
  assert.match(sql[4], /'prefill'/);
});

test('seeded Growth master covers the six core questions and ships a published usable version', () => {
  const seed = fs.readFileSync(path.join(BACKEND, 'db/migrations/203_growth_application_master_seed.sql'), 'utf8');
  assert.match(seed, /'published','Unplug Growth Application'/);
  for (const step of [
    'identity_profile','current_situation','goals_priorities','challenges_needs',
    'credibility_visibility','portfolio_content','opportunities_collaboration',
    'partnerships_sponsorship','commercial_readiness','contribution','privacy_permissions','declarations',
  ]) assert.match(seed, new RegExp(step));
  for (const key of [
    'growth_display_name','growth_current_stage','growth_primary_goal','growth_biggest_challenge',
    'growth_support_needs','growth_credibility_assets','growth_portfolio_exists','growth_opportunities_sought',
    'growth_collaboration_interest','growth_sponsorship_interest','growth_funding_interest',
    'growth_contribution_skills','growth_contact_permission','growth_no_guarantee_declaration',
  ]) assert.match(seed, new RegExp(key));
  assert.match(seed, /does not guarantee funding, employment, sponsorship, media coverage/i);
});

test('Quick Profile and Growth Assessment enforce every required legacy intake field', () => {
  const schema = schemaFor('individual');
  assert.equal(STAGE_SCHEMA_VERSION, '2026-09-11-intake-v1');
  assert.equal(schema.quick_profile.filter((field) => field.required).length, schema.quick_profile.length);
  assert.equal(schema.growth_assessment.filter((field) => field.required).length, schema.growth_assessment.length);
  const quick = {};
  for (const field of schema.quick_profile) quick[field.key] = field.allow_unavailable ? { unavailable: true } : 'Complete answer';
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

test('Growth uploads are member-only, private R2, verified PDF/image, 10MB and fail closed', () => {
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
  assert.match(route, /ALLOWED_GROWTH_FILE_MIME_TYPES/);
  assert.match(upload, /uploadGrowthFile/);
  assert.match(upload, /application\/pdf/);
  assert.match(upload, /MAX_GROWTH_FILE_SIZE_BYTES = 10 \* 1024 \* 1024/);
});

test('Growth V2 is member-only, resumable, append-only and status-only after submission', () => {
  const route = fs.readFileSync(path.join(BACKEND, 'src/routes/growthApplicationV2.js'), 'utf8');
  assert.match(route, /router\.use\(requireAuth\)/);
  assert.match(route, /req\.user\.role !== 'member'/);
  assert.match(route, /growth_application_answer_revisions/);
  assert.match(route, /revision_number/);
  assert.match(route, /growth_application_field_reopens/);
  assert.match(route, /Only fields specifically reopened by Unplug/);
  assert.match(route, /POPIA consent is required before submission/);
  assert.match(route, /informationRequests/);
  assert.match(route, /status='withdrawn'/);
  assert.doesNotMatch(route, /growth_assessments|growth_plans|internal_notes/);
});

test('Growth V2 prefills only reusable My Unplug/member account data as auditable revisions', () => {
  const route = fs.readFileSync(path.join(BACKEND, 'src/routes/growthApplicationV2.js'), 'utf8');
  assert.match(route, /my_unplug_profiles/);
  assert.match(route, /mu_profile_skills/);
  assert.match(route, /mu_profile_interests/);
  assert.match(route, /growth_display_name/);
  assert.match(route, /growth_email/);
  assert.match(route, /growth_phone/);
  assert.match(route, /'prefill'/);
  assert.doesNotMatch(route, /profiles\s+p\s+ON/); // never prefill from paid Directory listings
});

test('Growth V2 conditional logic controls visible requirements server-side', () => {
  const route = fs.readFileSync(path.join(BACKEND, 'src/routes/growthApplicationV2.js'), 'utf8');
  assert.match(route, /function visibleByRules/);
  assert.match(route, /case 'equals'/);
  assert.match(route, /case 'not_equals'/);
  assert.match(route, /case 'includes'/);
  assert.match(route, /case 'truthy'/);
  assert.match(route, /case 'not_empty'/);
  assert.match(route, /requiredFields/);
  assert.match(route, /fieldComplete/);
  assert.match(route, /Complete all required visible fields before submitting/);
  assert.match(route, /\['checkbox', 'consent', 'declaration'\]/);
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

test('Growth V2 preserves stable form versions, expanded types, audiences and relational links', () => {
  const base = fs.readFileSync(path.join(BACKEND, 'db/migrations/202_growth_application_v2.sql'), 'utf8');
  const seed = fs.readFileSync(path.join(BACKEND, 'db/migrations/203_growth_application_master_seed.sql'), 'utf8');
  assert.match(base, /UNIQUE\(form_id, version_number\)/i);
  assert.match(base, /UNIQUE\(version_id, field_key\)/i);
  assert.match(base, /sensitive_enabled/);
  assert.match(base, /allow_external_sharing/);
  assert.match(base, /growth_application_entity_links/);
  assert.match(base, /'agreement'/);
  assert.match(base, /'service_order'/);
  assert.match(seed, /document_upload/);
  assert.match(seed, /portfolio_upload/);
  assert.match(seed, /declaration/);
  assert.match(seed, /admin_only/);
  assert.match(seed, /audience/);
});

test('Growth V2 master form builder exposes safe draft-edit, conditional and audience operations', () => {
  const admin = fs.readFileSync(path.join(BACKEND, 'src/routes/growthAdmin.js'), 'utf8');
  assert.match(admin, /router\.post\('\/form\/versions'/);
  assert.match(admin, /router\.patch\('\/versions\/:id'/);
  assert.match(admin, /router\.post\('\/versions\/:id\/steps'/);
  assert.match(admin, /router\.patch\('\/steps\/:id'/);
  assert.match(admin, /router\.post\('\/steps\/:id\/fields'/);
  assert.match(admin, /router\.patch\('\/fields\/:id'/);
  assert.match(admin, /router\.post\('\/fields\/:id\/options'/);
  assert.match(admin, /router\.patch\('\/options\/:id'/);
  assert.match(admin, /visibilityRules/);
  assert.match(admin, /AUDIENCES/);
  assert.match(admin, /document_upload/);
  assert.match(admin, /Published fields are immutable/);
  assert.match(admin, /router\.post\('\/versions\/:id\/publish'/);
});

test('legacy final submission still enforces its schema versions, stages, galleries and POPIA consent', () => {
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

test('Cloudflare resolves persistent legacy Growth short links and only redirects same-origin', () => {
  const fn = read('functions', '[[path]].js');
  assert.match(fn, /\^\\\/grow\\\/\(/);
  assert.match(fn, /growth-application\/entry-access/);
  assert.match(fn, /unplug-growth-application\.html/);
  assert.match(fn, /Response\.redirect\(target\.toString\(\), 302\)/);
});

test('production build packages legacy rollback pages plus both Growth V2 workspaces', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.build, /build-growth-pages\.js/);
  const builder = read('scripts', 'build-growth-pages.js');
  assert.match(builder, /unplug-growth-application\.html/);
  assert.match(builder, /unplug-growth-applications-admin\.html/);
  assert.match(builder, /unplug-growth-application-v2\.html/);
  assert.match(builder, /unplug-growth-applications-admin-v2\.html/);
  assert.match(builder, /growth-integration\.js/);
  assert.match(builder, /growth-private-upload-helper\.js/);
});

test('Growth integration routes member/admin journeys to V2 while retaining existing visibility controls', () => {
  const integration = read('growth-integration.js');
  assert.match(integration, /MEMBER_V2 = '\/unplug-growth-application-v2\.html'/);
  assert.match(integration, /ADMIN_V2 = '\/unplug-growth-applications-admin-v2\.html'/);
  assert.match(integration, /Growth Applications/);
  assert.match(integration, /My Growth Journey/);
  assert.match(integration, /growth-application\/v2\/applications/);
  assert.match(integration, /member_dashboard/);
  assert.match(integration, /addMemberJourneyLink\(config\)/);
  assert.match(integration, /site_visibility !== 'visible'/);
  assert.doesNotMatch(integration, /resume-link|applications\/me/);
  for (const key of ['homepage','latest_news','directory','gallery','editions','top10','competitions']) assert.match(integration, new RegExp(key));
});

test('Growth V2 member workspace renders conditional fields, declarations and private documents', () => {
  const member = read('unplug-growth-application-v2.html');
  assert.match(member, /\/growth-application\/v2\/applications/);
  assert.match(member, /\/growth-application\/upload/);
  assert.match(member, /function visibleByRules/);
  assert.match(member, /visibility_rules/);
  assert.match(member, /declaration/);
  assert.match(member, /application\/pdf/);
  assert.match(member, /POPIA/);
  assert.match(member, /information-requests/);
  assert.doesNotMatch(member, /growth_assessments|growth_plans|internal_notes/);
});

test('Growth V2 admin workspace remains an internal assessment and builder surface', () => {
  const admin = read('unplug-growth-applications-admin-v2.html');
  assert.match(admin, /\/growth-admin\/applications/);
  assert.match(admin, /Load sensitive data/);
  assert.match(admin, /\/growth-admin\/fields/);
  assert.match(admin, /\/growth-admin\/versions/);
  assert.match(admin, /Growth Plan/);
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