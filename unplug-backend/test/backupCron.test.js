'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('human backup route remains admin-only', () => {
  const src = read('src/routes/backups.js');
  assert.match(src, /router\.post\('\/run', requireRole\('admin'\)/);
});

test('scheduled backup route fails closed and uses a dedicated secret', () => {
  const src = read('src/routes/backups.js');
  assert.match(src, /router\.post\('\/scheduled-run'/);
  assert.match(src, /process\.env\.UNPLUG_BACKUP_CRON_SECRET/);
  assert.match(src, /req\.get\('X-Backup-Cron-Secret'\)/);
  assert.match(src, /crypto\.timingSafeEqual/);
  assert.match(src, /return res\.status\(503\)/);
  assert.match(src, /return res\.status\(401\)/);
});

test('scheduled backup reuses the encrypted runner and records a system audit entry', () => {
  const src = read('src/routes/backups.js');
  const start = src.indexOf("router.post('/scheduled-run'");
  const end = src.indexOf("// GET /backups/:key/download", start);
  assert.ok(start >= 0 && end > start);
  const block = src.slice(start, end);
  assert.match(block, /await runner\.run\(\)/);
  assert.match(block, /'backup_taken'/);
  assert.match(block, /'system'/);
});

test('Render cron trigger holds only the scheduler secret, not backup/database credentials', () => {
  const src = read('scripts/run-backup-cron.js');
  assert.match(src, /UNPLUG_BACKUP_CRON_SECRET/);
  assert.match(src, /X-Backup-Cron-Secret/);
  assert.match(src, /\/backups\/scheduled-run/);
  assert.doesNotMatch(src, /DATABASE_URL/);
  assert.doesNotMatch(src, /UNPLUG_BACKUP_PASSPHRASE/);
  assert.doesNotMatch(src, /R2_SECRET_ACCESS_KEY/);
  assert.doesNotMatch(src, /R2_ACCESS_KEY_ID/);
});
