#!/usr/bin/env node
'use strict';

// Dependency-free production preflight. It never prints secret values.
const env = process.env;
const failures = [];
const warnings = [];
const oks = [];

function present(name) { return Boolean(String(env[name] || '').trim()); }
function enabled(name) {
  const value = String(env[name] || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}
function ok(msg) { oks.push(msg); }
function fail(msg) { failures.push(msg); }
function warn(msg) { warnings.push(msg); }
function requireVar(name, note='') { present(name) ? ok(`${name} is set`) : fail(`${name} is missing${note ? ` — ${note}` : ''}`); }

requireVar('DATABASE_URL', 'backend cannot reach PostgreSQL without it');
requireVar('JWT_SECRET', 'authentication tokens are unsafe/unusable without it');
if (present('JWT_SECRET') && String(env.JWT_SECRET).length < 32) fail('JWT_SECRET is shorter than 32 characters');

requireVar('CORS_ORIGINS', 'the app otherwise fails closed for cross-origin browser calls');
if (present('CORS_ORIGINS')) {
  const origins = String(env.CORS_ORIGINS).split(',').map(s => s.trim()).filter(Boolean);
  if (origins.some(o => o === '*')) fail('CORS_ORIGINS contains *; production admin/member APIs should use explicit origins');
  const expected = ['https://www.unplugnews.com'];
  expected.forEach(o => origins.includes(o) ? ok(`CORS includes ${o}`) : warn(`CORS_ORIGINS does not include ${o}`));
}

for (const [name, expected] of [['SITE_URL','https://www.unplugnews.com'], ['PUBLIC_API_URL','https://unplug-ecosystem.onrender.com']]) {
  if (!present(name)) fail(`${name} is missing`);
  else if (!String(env[name]).startsWith('https://')) fail(`${name} must use https:// in production`);
  else { ok(`${name} is HTTPS`); if (String(env[name]).replace(/\/$/,'') !== expected) warn(`${name} differs from the current documented production value (${expected})`); }
}

const resend = present('RESEND_API_KEY');
const brevo = present('BREVO_API_KEY');
const smtp = present('SMTP_HOST') && present('SMTP_USER') && present('SMTP_PASS');
(resend || brevo || smtp) ? ok('At least one outbound email provider is configured') : fail('No outbound email provider is configured (Resend/Brevo/SMTP)');
if (resend && !present('RESEND_WEBHOOK_SECRET')) warn('RESEND_WEBHOOK_SECRET is missing; bounce/complaint webhooks will be refused');

// R2 is the active storage backend in routes/uploads.js. Supabase settings can
// exist for legacy migration/audit purposes, but must not make production
// preflight green because new public/private uploads no longer fall back there.
const r2Public = ['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET','R2_PUBLIC_URL'].every(present);
r2Public ? ok('Persistent public upload storage configured (R2)') : fail('Complete R2 public upload storage configuration is required');

const r2Private = ['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY'].every(present);
r2Private ? ok('Private R2 storage credentials are available for proofs/paid edition files') : fail('R2 private storage credentials are required for proofs/paid edition files');

present('UNPLUG_CLEANUP_SECRET') ? ok('UNPLUG_CLEANUP_SECRET is set') : warn('UNPLUG_CLEANUP_SECRET is missing; scheduled cleanup/email/recovery endpoints cannot be securely called');
present('BIRTHDAY_CRON_SECRET') ? ok('BIRTHDAY_CRON_SECRET is set') : warn('BIRTHDAY_CRON_SECRET is missing; birthday scheduled delivery may not run securely');

if (enabled('ADMIN_PASSWORD_RESET')) {
  fail('ADMIN_PASSWORD_RESET is still enabled; remove it after the one-time password reset');
}
if (enabled('UNPLUG_DISABLE_RATE_LIMITS')) {
  fail('UNPLUG_DISABLE_RATE_LIMITS must not be enabled in production');
}

// Gateways are intentionally not live yet; if callback secrets are absent the
// Phase 11 code rejects callbacks rather than trusting them.
if (!present('PAYFAST_PASSPHRASE')) warn('PAYFAST_PASSPHRASE is missing (acceptable while PayFast initiation remains disabled)');
if (!present('OZOW_PRIVATE_KEY')) warn('OZOW_PRIVATE_KEY is missing (acceptable while Ozow initiation remains disabled)');

console.log('UNPLUG PRODUCTION READINESS');
console.log('===========================');
for (const x of oks) console.log(`OK   ${x}`);
for (const x of warnings) console.log(`WARN ${x}`);
for (const x of failures) console.log(`FAIL ${x}`);
console.log(`\nSummary: ${oks.length} OK, ${warnings.length} warning(s), ${failures.length} failure(s)`);
process.exitCode = failures.length ? 1 : 0;
