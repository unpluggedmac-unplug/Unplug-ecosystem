const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

function run(script, overrides = {}) {
  const env = {
    ...process.env,
    DATABASE_URL: 'postgres://test:test@localhost:5432/unplug_test',
    STAGING_DATABASE_URL: 'postgres://test:test@localhost:5432/unplug_test',
    JWT_SECRET: 'x'.repeat(48),
    CORS_ORIGINS: 'https://staging.example.test',
    SITE_URL: 'https://staging.example.test',
    PUBLIC_API_URL: 'https://unplug-staging.example.test',
    RESEND_API_KEY: 'test-only',
    RESEND_WEBHOOK_SECRET: 'test-only',
    R2_ACCOUNT_ID: 'test-account',
    R2_ACCESS_KEY_ID: 'test-access',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    R2_BUCKET: 'test-public',
    R2_PUBLIC_URL: 'https://cdn.example.test',
    UNPLUG_BACKUP_PASSPHRASE: 'test-only-backup-passphrase',
    UNPLUG_ENV: 'staging',
    NODE_ENV: 'production',
    ADMIN_PASSWORD_RESET: 'false',
    UNPLUG_DISABLE_RATE_LIMITS: 'false',
    ...overrides,
  };
  return spawnSync(process.execPath, [path.join(root, 'scripts', script)], {
    env,
    encoding: 'utf8',
  });
}

test('staging readiness refuses missing R2 instead of allowing ephemeral uploads', () => {
  const r = run('staging-readiness.js', { R2_ACCOUNT_ID: '' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /R2_ACCOUNT_ID is missing/);
});

test('staging readiness catches the actual rate-limit disable value used by middleware', () => {
  const r = run('staging-readiness.js', { UNPLUG_DISABLE_RATE_LIMITS: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /rate limiting/i);
});

test('production readiness does not accept legacy Supabase as a substitute for active R2 storage', () => {
  const r = run('production-readiness.js', {
    SITE_URL: 'https://www.unplugnews.com',
    PUBLIC_API_URL: 'https://unplug-ecosystem.onrender.com',
    CORS_ORIGINS: 'https://www.unplugnews.com',
    R2_ACCOUNT_ID: '',
    R2_ACCESS_KEY_ID: '',
    R2_SECRET_ACCESS_KEY: '',
    R2_BUCKET: '',
    R2_PUBLIC_URL: '',
    SUPABASE_URL: 'https://legacy.example.test',
    SUPABASE_SERVICE_KEY: 'legacy-test',
    SUPABASE_BUCKET: 'legacy-test',
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /R2 public upload storage configuration is required/);
});

test('production readiness catches UNPLUG_DISABLE_RATE_LIMITS=1', () => {
  const r = run('production-readiness.js', {
    SITE_URL: 'https://www.unplugnews.com',
    PUBLIC_API_URL: 'https://unplug-ecosystem.onrender.com',
    CORS_ORIGINS: 'https://www.unplugnews.com',
    UNPLUG_DISABLE_RATE_LIMITS: '1',
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /UNPLUG_DISABLE_RATE_LIMITS must not be enabled/);
});

test('production readiness refuses to deploy while encrypted backups are disabled', () => {
  const r = run('production-readiness.js', {
    SITE_URL: 'https://www.unplugnews.com',
    PUBLIC_API_URL: 'https://unplug-ecosystem.onrender.com',
    CORS_ORIGINS: 'https://www.unplugnews.com',
    UNPLUG_BACKUP_PASSPHRASE: '',
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /production backups are disabled/);
});
