const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const dashboard = fs.readFileSync(
  path.join(__dirname, '..', '..', 'unplug-admin-dashboard.html'),
  'utf8',
);

test('Control Centre exposes the safe backup status and create actions', () => {
  assert.match(dashboard, /data-section="backups">Backups</);
  assert.match(dashboard, /id="section-backups"/);
  assert.match(dashboard, /id="backupRunBtn"/);
  assert.match(dashboard, /api\('\/backups'\)/);
  assert.match(dashboard, /api\('\/backups\/run', \{ method:'POST' \}\)/);
  assert.match(dashboard, /backups:\['system\.manage'\]/);
});

test('browser backup controls do not expose a destructive restore action', () => {
  const section = dashboard.match(/<!-- BACKUPS -->([\s\S]*?)<!-- REDIRECTS & 404s -->/);
  assert.ok(section, 'backup section must be present');
  assert.doesNotMatch(section[1], /(?:button|data-section|id)=[^>]*restore/i);
  assert.doesNotMatch(dashboard, /api\([^\n]*restore-backup/);
});
