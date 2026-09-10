#!/usr/bin/env node
'use strict';

// Dependency-free production preflight. It never prints secret values.
const env = process.env;
const failures = [];
const warnings = [];
const oks = [];

function present(name) { return Boolean(String(env[name] || '').trim()); }
function ok(msg) { oks.push(msg); }
function fail(msg) { failures.push(msg); }
function warn(msg) { warnings.push(msg); }
function requireVar(name, note='') { present(name) ? ok(`${name} is set`) : fail(`${name} is missing${note ? ` — ${note}` : ''}`); }

requireVar('DATABASE_URL', 'backend cannot reach PostgreSQL without it');
requireVar('JWT_SECRET', 'authentication tokens are unsafe/unusable without it');
if (present('JWT_SECRET') && String(env.JWT_SECRET).length < 32) fail('JWT_SECRET is shorter than 32 characters');

requireVar('CORS_ORIGINS', 'the app otherwise falls back to allowing any origin');
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

const r2Public = ['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET','R2_PUBLIC_URL'].every(present);
const supabasePublic = ['SUPABASE_URL','SUPABASE_SERVICE_KEY','SUPABASE_BUCKET'].every(present);
(r2Public || supabasePublic) ? ok(`Persistent public upload storage configured (${r2Public ? 'R2' : 'Supabase'})`) : fail('No complete persistent public upload storage configuration found');

const r2Private = ['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY'].every(present);
const supabasePrivate = ['SUPABASE_URL','SUPABASE_SERVICE_KEY'].every(present);
(r2Private || supabasePrivate) ? ok('Private storage credentials are available for proofs/paid edition files') : fail('No private storage credentials available for proofs/paid edition files');

present('UNPLUG_CLEANUP_SECRET') ? ok('UNPLUG_CLEANUP_SECRET is set') : warn('UNPLUG_CLEANUP_SECRET is missing; scheduled cleanup/email/recovery endpoints cannot be securely called');
present('BIRTHDAY_CRON_SECRET') ? ok('BIRTHDAY_CRON_SECRET is set') : warn('BIRTHDAY_CRON_SECRET is missing; birthday scheduled delivery may not run securely');

if (present('ADMIN_PASSWORD_RESET') && String(env.ADMIN_PASSWORD_RESET).toLowerCase() === 'true') {
  fail('ADMIN_PASSWORD_RESET=true is still enabled; remove it after the one-time password reset');
}
if (present('UNPLUG_DISABLE_RATE_LIMITS') && String(env.UNPLUG_DISABLE_RATE_LIMITS).toLowerCase() === 'true') {
  fail('UNPLUG_DISABLE_RATE_LIMITS=true must not be enabled in production');
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
