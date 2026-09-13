const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('Control Centre exposes the standalone Agreement Generator and exact required actions', () => {
  const html = read('unplug-agreement-generator-admin.html');
  for (const label of [
    'Edit Agreement','Edit Form','Duplicate','Preview','Send','Remind','View responses',
    'Download PDF','Archive','Restore','View audit history',
  ]) assert.match(html, new RegExp(label, 'i'), `missing admin action: ${label}`);
  assert.doesNotMatch(html, />\s*Questions\s*</i, 'old confusing Questions button must not return');
  assert.match(html, /Agreement Details — Master/);
  assert.match(html, /Party B first, then Party A/);
  assert.match(html, /Party A first, then Party B/);
});

test('Agreement Generator identifies templates by their admin name, not only the inherited legal title', () => {
  const html = read('unplug-agreement-generator-admin.html');
  assert.match(html, /esc\(t\.name\|\|t\.title\)/);
  assert.match(html, /currentTemplate\.name\|\|currentTemplate\.title/);
  assert.match(html, /t\.title&&t\.title!==t\.name/);
  assert.match(html, /Agreement title:/);
});

test('Agreement Generator restores the saved admin session before loading templates after refresh', () => {
  const html = read('unplug-agreement-generator-admin.html');
  assert.match(html, /function adminToken\(\)/, 'session token must be resolved when each request is made');
  assert.match(html, /await api\('\/auth\/me'\)/, 'a refreshed page must validate the restored session first');
  assert.match(html, /\['admin','staff'\]\.includes\(session\.user\.role\)/, 'restored sessions must remain role-gated');
  assert.match(html, /Promise\.all\(\[api\('\/agreement-forms\/generator\/meta'\),loadPresets\(\),loadTemplates\(\)\]\)/,
    'templates must load only after session restoration succeeds');
  assert.match(html, /Could not load agreement templates\./, 'template failures must replace the Loading state');
  assert.match(html, /Your Control Centre session has expired\. Please sign in again\./);
  assert.doesNotMatch(html, /const TOKEN=/, 'a page-load token snapshot breaks late session restoration');

  const enhancements = read('media','scripts','agreement-generator-admin-enhancements.js');
  assert.match(enhancements, /const adminToken=\(\)=>/);
  assert.doesNotMatch(enhancements, /const TOKEN=/);
});

test('advanced Control Centre enhancement exposes conditional rules, reordering, reminders and multi-signer administration', () => {
  const js = read('media','scripts','agreement-generator-admin-enhancements.js');
  assert.match(js, /Field order & conditional fields/);
  assert.match(js, /Move up/);
  assert.match(js, /Conditional clauses & exclusions/);
  assert.match(js, /Reminder days/);
  assert.match(js, /Party B signers/);
  assert.match(js, /Guardian/);
  assert.match(js, /Authorised business representative/);
  assert.match(js, /Override reference/);
  assert.match(js, /Assign staff/);
});

test('secure Party B browser flow includes save/resume, OTP, all signature modes, uploads and PDF download', () => {
  const html = read('unplug-agreement-generator.html');
  for (const phrase of [
    'Save & resume later','Send code by email','Send code by mobile','Typed name','Draw signature',
    'Upload signature','Upload securely','Submit & sign agreement','Download completed PDF',
  ]) assert.match(html, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `missing signer UI: ${phrase}`);
  assert.match(html, /POPIA notice/);
  assert.match(html, /Party B — Individual/);
  assert.match(html, /Party B — Business/);
  const enhancement = read('media','scripts','agreement-generator-signer-enhancements.js');
  assert.match(enhancement, /Agreement details are frozen/);
  assert.match(enhancement, /Signing progress/);
});

test('release packager always includes both Agreement Generator pages', () => {
  const build = read('scripts', 'build-release-pages.js');
  assert.match(build, /unplug-agreement-generator\.html/);
  assert.match(build, /unplug-agreement-generator-admin\.html/);
});

test('runtime Control Centre navigation and enhancement scripts point to Agreement Generator while legacy agreement page remains in repo', () => {
  const runtime = read('functions', 'runtime-config.js');
  // The literal label "Agreement Generator" itself now lives in the
  // hierarchical Control Centre sidebar's own nav model
  // (media/scripts/admin-control-centre-hierarchy.js), not runtime-config.js.
  // runtime-config.js used to also inject a duplicate "Agreement Generator"
  // link of its own into the pre-hierarchy flat sidebar — confirmed live as
  // two separate links on one page — so that injector was removed rather
  // than kept as a second source of the same label. What still belongs here
  // is runtime-config.js loading the hierarchy script and the Agreement
  // Generator enhancement scripts, which this keeps asserting.
  assert.match(runtime, /admin-control-centre-hierarchy\.js/);
  assert.match(runtime, /unplug-agreement-generator-admin(?:\.html)?/);
  assert.match(runtime, /agreement-generator-admin-enhancements\.js/);
  assert.match(runtime, /agreement-generator-signer-enhancements\.js/);
  assert.match(runtime, /Edit Form/);
  assert.ok(fs.existsSync(path.join(ROOT, 'unplug-agreements-admin.html')));
  assert.ok(fs.existsSync(path.join(ROOT, 'unplug-agreement.html')));

  const hierarchy = read('media', 'scripts', 'admin-control-centre-hierarchy.js');
  assert.match(hierarchy, /Agreement Generator/, 'the hierarchy sidebar itself must still carry this label');
});

test('runtime-config emits syntactically valid browser JavaScript for staging', async () => {
  const source = read('functions', 'runtime-config.js')
    .replace('export async function onRequest', 'async function onRequest')
    .concat('\n;this.__onRequest = onRequest;');
  const context = { URL, Response };
  vm.createContext(context);
  new vm.Script(source, { filename: 'runtime-config.js' }).runInContext(context);
  const response = await context.__onRequest({
    env: { UNPLUG_ENV: 'staging' },
    request: new Request('https://unplug-staging.pages.dev/runtime-config'),
  });
  const browserJavaScript = await response.text();
  assert.doesNotThrow(
    () => new vm.Script(browserJavaScript, { filename: 'generated-runtime-config.js' }),
    'the live /runtime-config response must be valid browser JavaScript'
  );
});

test('migration is additive: it creates lifecycle structures but never truncates or drops signed agreement data', () => {
  const migration = read('unplug-backend','db','migrations','202_agreement_generator.sql');
  const multi = read('unplug-backend','db','migrations','205_agreement_multi_signer_tokens.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS agreement_audit_log/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS agreement_form_versions/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS agreement_signatures/i);
  assert.match(multi, /signing_token/i);
  for (const sql of [migration,multi]) {
    assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
    assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i);
    assert.doesNotMatch(sql, /\bDELETE\s+FROM\s+agreement_submissions\b/i);
    assert.doesNotMatch(sql, /\bALTER\s+TABLE\s+signed_agreements\b/i);
  }
});

test('signed-agreement protection is implemented as archive/supersede/reopen, not hard delete', () => {
  const route = read('unplug-backend','src','routes','agreementGeneratorRecordAdmin.js');
  assert.match(route, /signed_agreement_superseded/);
  assert.match(route, /superseded_by_id/);
  assert.match(route, /agreement_archived/);
  assert.match(route, /agreement_restored/);
  assert.doesNotMatch(route, /DELETE FROM agreement_submissions/i);
});

test('public multi-signer flow uses signer-specific tokens and freezes shared content after the first signature', () => {
  const route = read('unplug-backend','src','routes','agreementGeneratorPartyB.js');
  const service = read('unplug-backend','src','utils','agreementGeneratorService.js');
  assert.match(service, /resolveSignerAccess/);
  assert.match(service, /hasAnySignature/);
  assert.match(route, /contentLocked/);
  assert.match(route, /party_b_signer_signed/);
  assert.match(route, /allRequiredPartyBSigned/);
});
