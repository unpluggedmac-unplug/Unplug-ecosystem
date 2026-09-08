from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new)


auth_path = Path('unplug-backend/src/routes/auth.js')
rate_path = Path('unplug-backend/src/middleware/rateLimit.js')
ui_path = Path('unplug-member-dashboard.html')
test_path = Path('unplug-backend/test/passwordResetAndLogoutUiGuard.test.js')

auth = auth_path.read_text()
rate = rate_path.read_text()
ui = ui_path.read_text()

auth = replace_once(
    auth,
    "const { loginLimiter, registerLimiter, emailActionLimiter } = require('../middleware/rateLimit');",
    "const { loginLimiter, registerLimiter, emailActionLimiter, resetCodeLimiter } = require('../middleware/rateLimit');",
    'rate-limit import',
)

auth = replace_once(
    auth,
    "function generateCode() {\n  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits\n}",
    "function generateCode() {\n  return String(crypto.randomInt(100000, 1000000)); // cryptographically strong 6 digits\n}",
    'generateCode',
)

forgot_start = auth.index('// POST /auth/forgot-password')
reset_start = auth.index('// POST /auth/reset-password', forgot_start)
new_forgot = r'''// POST /auth/forgot-password
// Public — sends a short-lived 6-digit reset code to the account's primary
// email OR alternative email, whichever the requester specifies via
// `useAltEmail`. The response stays generic so registered addresses cannot be
// discovered through this endpoint.
router.post('/forgot-password', emailActionLimiter, async (req, res, next) => {
  try {
    const { email, useAltEmail } = req.body;
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
    }

    const userResult = await pool.query('SELECT id, email, alt_email FROM users WHERE email = $1', [email]);
    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];
      const destination = useAltEmail && user.alt_email ? user.alt_email : user.email;

      const code = generateCode();
      await pool.query(
        `INSERT INTO password_reset_tokens (user_id, token, expires_at)
         VALUES ($1, $2, now() + interval '15 minutes')`,
        [user.id, code]
      );
      try {
        await sendEmail({
          to: destination,
          subject: 'Reset your Unplug password',
          text: `Someone requested a password reset for your Unplug account.\n\nYour 6-digit reset code is: ${code}\n\nThis code expires in 15 minutes. If you didn't request this, you can ignore this email.`,
        });
      } catch (mailErr) {
        console.error('[auth] password reset email failed to send:', mailErr.message);
      }
    }

    res.json({ message: 'If that account exists, a 6-digit reset code has been sent.' });
  } catch (err) {
    next(err);
  }
});

'''
auth = auth[:forgot_start] + new_forgot + auth[reset_start:]

reset_start = auth.index('// POST /auth/reset-password')
logout_start = auth.index('// POST /auth/logout', reset_start)
new_reset = r'''// POST /auth/reset-password
// Public — completes a reset using the 6-digit code emailed above. The code
// is matched together with the account email, so the one-million-value code
// space is never treated as a globally unique credential. A rate limiter caps
// guessing attempts. Existing 64-character reset tokens remain valid for
// their original lifetime so an in-flight reset is not stranded by deploy.
router.post('/reset-password', resetCodeLimiter, async (req, res, next) => {
  try {
    const { email, code, token, newPassword } = req.body;
    const submittedCode = String(code || '').trim();
    const legacyToken = String(token || '').trim();
    const isSixDigitCode = /^\d{6}$/.test(submittedCode);
    const isLegacyToken = /^[a-f0-9]{64}$/i.test(legacyToken);

    if (!newPassword || newPassword.length < 8 || (!isSixDigitCode && !isLegacyToken)) {
      return res.status(400).json({ error: 'A valid 6-digit reset code and a new password of at least 8 characters are required.' });
    }

    let tokenResult;
    if (isSixDigitCode) {
      if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Your email and 6-digit reset code are required.' });
      }
      tokenResult = await pool.query(
        `SELECT prt.*
           FROM password_reset_tokens prt
           JOIN users u ON u.id = prt.user_id
          WHERE prt.token = $1
            AND lower(u.email) = lower($2)
            AND prt.used_at IS NULL
            AND prt.expires_at > now()
          ORDER BY prt.expires_at DESC
          LIMIT 1`,
        [submittedCode, email.trim()]
      );
    } else {
      tokenResult = await pool.query(
        `SELECT * FROM password_reset_tokens
          WHERE token = $1 AND used_at IS NULL AND expires_at > now()`,
        [legacyToken]
      );
    }

    if (tokenResult.rows.length === 0) {
      return res.status(400).json({ error: 'That reset code is invalid or has expired.' });
    }
    const resetRow = tokenResult.rows[0];

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, resetRow.user_id]);
    await pool.query(
      'UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
      [resetRow.user_id]
    );

    res.json({ message: 'Password updated — you can now log in with your new password.' });
  } catch (err) {
    next(err);
  }
});

'''
auth = auth[:reset_start] + new_reset + auth[logout_start:]

old_email_limiter = """const emailActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipWhenDisabled,
  message: { error: 'Too many requests. Please wait a few minutes before trying again.' },
});"""
new_email_limiter = old_email_limiter + """

// Six-digit password reset codes need their own guessing limit. This is
// separate from the email-sending limiter so requesting a code does not
// consume most of the attempts available to type it correctly.
const resetCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipWhenDisabled,
  message: { error: 'Too many reset-code attempts. Please wait 15 minutes and request a new code.' },
});"""
rate = replace_once(rate, old_email_limiter, new_email_limiter, 'emailActionLimiter')
rate = replace_once(
    rate,
    'module.exports = { loginLimiter, registerLimiter, emailActionLimiter, publicSubmitLimiter };',
    'module.exports = { loginLimiter, registerLimiter, emailActionLimiter, resetCodeLimiter, publicSubmitLimiter };',
    'rate-limit export',
)

ui = replace_once(
    ui,
    '<div class="field"><label for="resetToken">Reset Code (from your email)</label><input id="resetToken"></div>',
    '<div class="field"><label for="resetToken">6-Digit Reset Code</label><input id="resetToken" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000"></div>',
    'reset code input',
)
ui = replace_once(
    ui,
    "document.getElementById('forgotSub').textContent = 'If that account exists, a reset code has been sent — enter it below along with your new password.';",
    "document.getElementById('forgotSub').textContent = 'If that account exists, a 6-digit reset code has been sent. Enter the code below with your new password.';",
    'forgot-password text',
)

submit_start = ui.index("document.getElementById('submitResetBtn').addEventListener('click', async () => {")
become_start = ui.index('// ---------------------------------------------------------------------------\n// Become a Member', submit_start)
new_submit = r'''document.getElementById('submitResetBtn').addEventListener('click', async () => {
  const errorBanner = document.getElementById('forgotError');
  errorBanner.classList.remove('show');
  const email = document.getElementById('forgotEmail').value.trim();
  const code = document.getElementById('resetToken').value.trim();
  const newPassword = document.getElementById('resetNewPassword').value;

  if (!email || !/^\d{6}$/.test(code) || !newPassword) {
    errorBanner.textContent = 'Enter your email, the 6-digit reset code, and a new password.';
    errorBanner.classList.add('show');
    return;
  }
  if (newPassword.length < 8) {
    errorBanner.textContent = 'New password must be at least 8 characters.';
    errorBanner.classList.add('show');
    return;
  }

  const btn = document.getElementById('submitResetBtn');
  btn.disabled = true; btn.textContent = 'Updating...';

  try {
    await api('/auth/reset-password', { method: 'POST', body: JSON.stringify({ email, code, newPassword }) });
    showToast('Password updated — sign in with your new password.');
    document.getElementById('loginEmail').value = email;
    document.getElementById('loginPassword').value = '';
    document.getElementById('resetToken').value = '';
    document.getElementById('resetNewPassword').value = '';
    document.getElementById('resetStep2').classList.add('section-hidden');
    showCard('loginCard');
  } catch (err) {
    errorBanner.textContent = err.message;
    errorBanner.classList.add('show');
  } finally {
    btn.disabled = false; btn.textContent = 'Set New Password';
  }
});

'''
ui = ui[:submit_start] + new_submit + ui[become_start:]

welcome_marker = 'let CURRENT_USER = null;\nfunction showWelcome(user){'
logout_helper = r'''let CURRENT_USER = null;
function memberLogoutToSignIn() {
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
function showWelcome(user){'''
ui = replace_once(ui, welcome_marker, logout_helper, 'logout helper insertion')
ui = replace_once(
    ui,
    "if (lo) lo.addEventListener('click', () => { localStorage.removeItem('unplug_auth_token'); location.reload(); });",
    "if (lo) lo.addEventListener('click', memberLogoutToSignIn);",
    'welcome logout',
)
ui = replace_once(
    ui,
    "document.getElementById('logoutBtn').addEventListener('click', () => {\n    localStorage.removeItem('unplug_auth_token');\n    location.reload();\n  });",
    "document.getElementById('logoutBtn').addEventListener('click', memberLogoutToSignIn);",
    'dashboard logout',
)
ui = replace_once(
    ui,
    "if (lo) lo.addEventListener('click', function(){ localStorage.removeItem('unplug_auth_token'); location.reload(); });",
    "if (lo) lo.addEventListener('click', memberLogoutToSignIn);",
    'sidebar logout',
)

test_path.write_text(r'''const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const auth = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
const rate = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'rateLimit.js'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'unplug-member-dashboard.html'), 'utf8');

test('password reset uses a short six-digit code with guessing protection', () => {
  assert.match(auth, /crypto\.randomInt\(100000, 1000000\)/);
  assert.match(auth, /Your 6-digit reset code is:/);
  assert.match(auth, /router\.post\('\/reset-password', resetCodeLimiter/);
  assert.match(auth, /lower\(u\.email\) = lower\(\$2\)/);
  assert.match(rate, /const resetCodeLimiter = rateLimit\(/);
  assert.match(rate, /max: 8/);
  assert.match(ui, /id="resetToken"[^>]*maxlength="6"[^>]*pattern="\[0-9\]\{6\}"/);
  assert.match(ui, /JSON\.stringify\(\{ email, code, newPassword \}\)/);
});

test('member logout clears the session and returns directly to Sign In', () => {
  assert.match(ui, /function memberLogoutToSignIn\(\)/);
  assert.match(ui, /AUTH_TOKEN = null;/);
  assert.match(ui, /showCard\('loginCard'\);/);
  assert.doesNotMatch(ui, /removeItem\('unplug_auth_token'\);\s*location\.reload\(\)/);
  assert.match(ui, /logoutBtnTop[\s\S]{0,300}memberLogoutToSignIn/);
  assert.match(ui, /logoutBtn'\)\.addEventListener\('click', memberLogoutToSignIn\)/);
  assert.match(ui, /msLogout[\s\S]{0,500}memberLogoutToSignIn/);
});
''')

auth_path.write_text(auth)
rate_path.write_text(rate)
ui_path.write_text(ui)
