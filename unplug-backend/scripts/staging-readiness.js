#!/usr/bin/env node
const PROD_SITE = 'https://www.unplugnews.com';
const PROD_API = 'https://unplug-ecosystem.onrender.com';
let failed = false;

function ok(msg) { console.log('OK   ' + msg); }
function fail(msg) { failed = true; console.error('FAIL ' + msg); }
function present(name) {
  const yes = !!String(process.env[name] || '').trim();
  (yes ? ok : fail)(name + (yes ? ' is set' : ' is missing'));
  return yes;
}

console.log('Unplug staging readiness check\n');
if (String(process.env.UNPLUG_ENV || '').toLowerCase() === 'staging') ok('UNPLUG_ENV=staging');
else fail('UNPLUG_ENV must equal staging');

if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') ok('NODE_ENV=production');
else fail('NODE_ENV should equal production so staging exercises production behavior');

present('JWT_SECRET');
present('DATABASE_URL');
present('STAGING_DATABASE_URL');
present('CORS_ORIGINS');
present('SITE_URL');
present('PUBLIC_API_URL');

if (process.env.DATABASE_URL && process.env.STAGING_DATABASE_URL) {
  if (process.env.DATABASE_URL === process.env.STAGING_DATABASE_URL) ok('DATABASE_URL matches STAGING_DATABASE_URL guard');
  else fail('DATABASE_URL does not match STAGING_DATABASE_URL — refusing to treat this as isolated staging');
}
if (process.env.SITE_URL) {
  if (process.env.SITE_URL.replace(/\/$/, '') !== PROD_SITE) ok('SITE_URL is not production');
  else fail('SITE_URL points to production');
}
if (process.env.PUBLIC_API_URL) {
  if (process.env.PUBLIC_API_URL.replace(/\/$/, '') !== PROD_API) ok('PUBLIC_API_URL is not production');
  else fail('PUBLIC_API_URL points to production');
}
if (String(process.env.ADMIN_PASSWORD_RESET || '').toLowerCase() === 'true') fail('ADMIN_PASSWORD_RESET must not be true');
else ok('ADMIN_PASSWORD_RESET is off');

const cors = String(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
if (cors.some(v => /localhost|127\.0\.0\.1/.test(v))) fail('CORS_ORIGINS contains localhost in staging');
else if (cors.length) ok('CORS_ORIGINS has explicit non-local origins');

if (process.env.UNPLUG_DISABLE_RATE_LIMITS === 'true') fail('UNPLUG_DISABLE_RATE_LIMITS must not be true');
else ok('rate limiting is not disabled');

console.log('');
if (failed) {
  console.error('Staging readiness FAILED. Fix the items above before deploying.');
  process.exit(1);
}
console.log('Staging readiness PASSED. No secret values were printed.');
