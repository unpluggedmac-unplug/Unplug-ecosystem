from pathlib import Path

page = Path('unplug-admin-dashboard.html')
test = Path('unplug-backend/test/adminStagingRibbon.test.js')
text = page.read_text()

needle = '  <script src="/runtime-config"></script>\n'
if text.count(needle) != 1:
    raise SystemExit('runtime-config include changed unexpectedly')

ribbon = '''  <script src="/runtime-config"></script>
  <script>
  // The admin dashboard keeps its own auth/session helper instead of loading
  // unplug-shared.js, so mount the staging marker here as a safety guard.
  (function mountAdminEnvironmentRibbon() {
    if (!/^(staging|preview)$/i.test(String(window.UNPLUG_ENV || ''))) return;
    function mount() {
      if (document.getElementById('unplugEnvironmentRibbon')) return;
      const el = document.createElement('div');
      el.id = 'unplugEnvironmentRibbon';
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;background:#111;color:#fff;padding:5px 12px;border-radius:0 0 8px 8px;font:700 11px/1.2 system-ui;letter-spacing:.08em;box-shadow:0 2px 8px rgba(0,0,0,.25)';
      el.textContent = window.UNPLUG_RUNTIME_CONFIG_ERROR ? 'STAGING — API NOT CONFIGURED' : 'UNPLUG STAGING';
      document.body.appendChild(el);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  })();
  </script>
'''
page.write_text(text.replace(needle, ribbon))

test.write_text(r'''const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const admin = fs.readFileSync(path.join(ROOT, 'unplug-admin-dashboard.html'), 'utf8');

test('admin dashboard visibly marks staging and preview environments', () => {
  assert.match(admin, /<script src="\/runtime-config"><\/script>/);
  assert.match(admin, /\^\(staging\|preview\)\$/i);
  assert.match(admin, /id = 'unplugEnvironmentRibbon'/);
  assert.match(admin, /UNPLUG STAGING/);
  assert.match(admin, /STAGING — API NOT CONFIGURED/);
});
''')
