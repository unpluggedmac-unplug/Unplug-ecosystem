const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('Forms & Submissions loads the Agreement Generator integration on the canonical admin route', () => {
  const runtime = read('functions/runtime-config.js');
  const integration = read('media/scripts/agreement-control-centre-forms-routefix.js');

  assert.match(runtime, /unplug-admin-dashboard/);
  assert.match(runtime, /agreement-control-centre-forms-routefix\.js\?v=20260913-3/);
  assert.match(integration, /indexOf\('unplug-admin-dashboard'\)/);
  assert.match(integration, /agreementFormsControlCentrePanel/);
  assert.match(integration, /Agreement Templates/);
  assert.match(integration, /Agreement Details — Master/);
  assert.match(integration, /New Agreement From Master/);
  assert.match(integration, /New Standard Form/);
});

test('Agreement template cards expose full admin workflow without using generic forms', () => {
  const integration = read('media/scripts/agreement-control-centre-forms-routefix.js');

  assert.match(integration, /\/agreement-forms\/generator\/admin\/presets/);
  assert.match(integration, /\/agreement-forms\/generator\/admin\/templates/);
  assert.match(integration, /\/duplicate/);
  assert.match(integration, /\/preview\/document/);
  assert.match(integration, /\/agreement-forms\/generator\/admin\/agreements/);
  assert.match(integration, /Edit Master/);
  assert.match(integration, /Edit \/ Full Access/);
  assert.match(integration, /Create Agreement/);
});

test('Agreement Generator accepts focused navigation from the Control Centre', () => {
  const runtime = read('functions/runtime-config.js');
  const focus = read('media/scripts/agreement-generator-focus.js');
  const integration = read('media/scripts/agreement-control-centre-forms-routefix.js');

  assert.match(runtime, /location\.pathname\.indexOf\("unplug-agreement-generator-admin"\)/);
  assert.match(runtime, /agreement-generator-focus\.js\?v=20260913-1/);
  assert.match(focus, /searchParams\.get\(name\)/);
  assert.match(focus, /data-template/);
  assert.match(focus, /data-record/);
  assert.match(integration, /\/unplug-agreement-generator-admin\?template=/);
  assert.match(integration, /tab=agreements&agreement=/);
});

test('master remains separate from generic Forms and the legacy signed agreement system', () => {
  const integration = read('media/scripts/agreement-control-centre-forms-routefix.js');

  assert.doesNotMatch(integration, /fetch\([^\n]*['"]\/forms['"]/);
  assert.doesNotMatch(integration, /signed_agreements/);
  assert.doesNotMatch(integration, /\/agreements(?:['"`?])/);
  assert.match(integration, /generator\/admin/);
});

test('runtime route checks tolerate Cloudflare extensionless canonical URLs', () => {
  const runtime = read('functions/runtime-config.js');
  assert.doesNotMatch(runtime, /unplug-admin-dashboard\.html"\)\s*===\s*-1/);
  assert.match(runtime, /unplug-admin-dashboard/);
  assert.match(runtime, /unplug-agreement-generator-admin/);
  assert.match(runtime, /unplug-agreements-admin/);
});

test('Forms & Submissions resolves the current admin token after an in-page sign-in', () => {
  const integration = read('media/scripts/agreement-control-centre-forms-routefix.js');
  assert.match(integration, /function adminToken\(\)/);
  assert.doesNotMatch(integration, /const TOKEN\s*=/);
  assert.match(integration, /window\.addEventListener\('unplug:auth-changed'/);
  assert.match(integration, /if \(!adminToken\(\)\)/);
});
