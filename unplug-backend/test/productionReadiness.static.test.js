const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const payments = fs.readFileSync(path.join(root, 'src/routes/payments.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
const roles = fs.readFileSync(path.join(root, 'db/migrations/185_staff_roles_permissions.sql'), 'utf8');

test('gateway callbacks fail closed when verification secrets are missing', () => {
  assert.match(payments, /PAYFAST_PASSPHRASE is not set — refusing unverifiable ITN callback/);
  assert.match(payments, /OZOW_PRIVATE_KEY is not set — refusing unverifiable Ozow callback/);
  assert.doesNotMatch(payments, /skipping ITN signature verification/);
  assert.doesNotMatch(payments, /skipping HashCheck verification/);
});

test('production startup validates core environment and CORS fails closed', () => {
  assert.match(app, /require\('\.\/utils\/validateEnv'\)\(\)/);
  assert.match(app, /process\.env\.NODE_ENV === 'production' \? false : true/);
  assert.match(app, /app\.get\('\/health\/ready'/);
  assert.match(app, /SELECT 1/);
});

test('staff role migration does not erase Super Admin permission customisations on deploy', () => {
  assert.doesNotMatch(roles, /DELETE FROM staff_role_permissions/);
  assert.match(roles, /ON CONFLICT DO NOTHING/);
});
