const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

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

test('secure Party B browser flow includes save/resume, OTP, all signature modes, uploads and PDF download', () => {
  const html = read('unplug-agreement-generator.html');
  for (const phrase of [
    'Save & resume later','Send code by email','Send code by mobile','Typed name','Draw signature',
    'Upload signature','Upload securely','Submit & sign agreement','Download completed PDF',
  ]) assert.match(html, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `missing signer UI: ${phrase}`);
  assert.match(html, /POPIA notice/);
  assert.match(html, /Party B — Individual/);
  assert.match(html, /Party B — Business/);
});

test('release packager always includes both Agreement Generator pages', () => {
  const build = read('scripts', 'build-release-pages.js');
  assert.match(build, /unplug-agreement-generator\.html/);
  assert.match(build, /unplug-agreement-generator-admin\.html/);
});

test('runtime Control Centre navigation points to Agreement Generator while legacy agreement page remains in repo', () => {
  const runtime = read('functions', 'runtime-config.js');
  assert.match(runtime, /Agreement Generator/);
  assert.match(runtime, /unplug-agreement-generator-admin\.html/);
  assert.ok(fs.existsSync(path.join(ROOT, 'unplug-agreements-admin.html')));
  assert.ok(fs.existsSync(path.join(ROOT, 'unplug-agreement.html')));
});

test('migration is additive: it creates lifecycle structures but never truncates or drops signed agreement data', () => {
  const migration = read('unplug-backend','db','migrations','202_agreement_generator.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS agreement_audit_log/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS agreement_form_versions/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS agreement_signatures/i);
  assert.doesNotMatch(migration, /\bTRUNCATE\b/i);
  assert.doesNotMatch(migration, /\bDROP\s+TABLE\b/i);
  assert.doesNotMatch(migration, /\bDELETE\s+FROM\s+agreement_submissions\b/i);
  assert.doesNotMatch(migration, /\bALTER\s+TABLE\s+signed_agreements\b/i);
});

test('signed-agreement protection is implemented as archive/supersede/reopen, not hard delete', () => {
  const route = read('unplug-backend','src','routes','agreementGenerator.js');
  assert.match(route, /signed_agreement_superseded/);
  assert.match(route, /superseded_by_id/);
  assert.match(route, /agreement_archived/);
  assert.match(route, /agreement_restored/);
  assert.doesNotMatch(route, /DELETE FROM agreement_submissions/i);
});
