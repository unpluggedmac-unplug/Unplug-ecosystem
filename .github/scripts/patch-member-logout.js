const fs = require('fs');

const pagePath = 'unplug-member-dashboard.html';
const testPath = 'unplug-backend/test/passwordResetAndLogoutUiGuard.test.js';
let text = fs.readFileSync(pagePath, 'utf8');

const oldLogout = `function memberLogoutToSignIn() {
  AUTH_TOKEN = null;
  CURRENT_USER = null;
  localStorage.removeItem('unplug_auth_token');
  const dash = document.getElementById('dashboard');
  if (dash) dash.classList.add('section-hidden');
  const sidebar = document.getElementById('msSidebar');
  if (sidebar) sidebar.classList.remove('open');
  const password = document.getElementById('loginPassword');
  if (password) password.value = '';
  const banner = document.getElementById('loginError');
  if (banner) {
    banner.textContent = '';
    banner.classList.remove('show');
  }
  document.getElementById('topRight').textContent = '';
  showCard('loginCard');
}
`;

const newLogout = `function memberLogoutToSignIn() {
  AUTH_TOKEN = null;
  CURRENT_USER = null;
  localStorage.removeItem('unplug_auth_token');

  // A full navigation makes logout a clean boundary even if dashboard work is
  // still running. The next load consumes the flag and paints Sign In first.
  const target = location.pathname + '?signin=1';
  location.replace(target);
}
`;

if ((text.match(new RegExp(oldLogout.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'), 'g')) || []).length !== 1) {
  if (!text.includes(oldLogout)) throw new Error('logout function changed unexpectedly');
}
text = text.replace(oldLogout, newLogout);

const oldRestore = `  if (await consumeMagicLinkIfPresent()) return;
  const savedToken = localStorage.getItem('unplug_auth_token');
  if (!savedToken) return;
`;
const newRestore = `  if (await consumeMagicLinkIfPresent()) return;

  // Logout reloads through ?signin=1 so Sign In is rendered on a clean page.
  // Consume and remove the flag immediately so refreshes/bookmarks stay tidy.
  const startupParams = new URLSearchParams(location.search);
  if (startupParams.get('signin') === '1') {
    history.replaceState({}, '', location.pathname);
    showCard('loginCard');
    return;
  }

  const savedToken = localStorage.getItem('unplug_auth_token');
  if (!savedToken) return;
`;
if (!text.includes(oldRestore)) throw new Error('restore-session block changed unexpectedly');
text = text.replace(oldRestore, newRestore);
fs.writeFileSync(pagePath, text);

let test = fs.readFileSync(testPath, 'utf8');
const oldAssertions = `  assert.match(ui, /showCard\\('loginCard'\\);/);
  assert.doesNotMatch(ui, /removeItem\\('unplug_auth_token'\\);\\s*location\\.reload\\(\\)/);
`;
const newAssertions = `  assert.match(ui, /localStorage\\.removeItem\\('unplug_auth_token'\\);[\\s\\S]{0,500}location\\.replace\\(target\\)/);
  assert.match(ui, /location\\.pathname \\+ '\\?signin=1'/);
  assert.match(ui, /startupParams\\.get\\('signin'\\) === '1'/);
  assert.match(ui, /history\\.replaceState\\(\\{\\}, '', location\\.pathname\\);[\\s\\S]{0,120}showCard\\('loginCard'\\)/);
  assert.doesNotMatch(ui, /removeItem\\('unplug_auth_token'\\);\\s*location\\.reload\\(\\)/);
`;
if (!test.includes(oldAssertions)) throw new Error('logout regression assertions changed unexpectedly');
test = test.replace(oldAssertions, newAssertions);
fs.writeFileSync(testPath, test);
