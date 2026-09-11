// Fails fast at startup with a clear message if a required env var is
// missing, instead of booting fine and only breaking later with a cryptic
// error (e.g. a JWT_SECRET-less app crashing on the first login attempt).
const CORE_REQUIRED_VARS = ['DATABASE_URL', 'JWT_SECRET'];
const PERSISTENT_STORAGE_VARS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_URL',
];

function validateEnv() {
  // Any production-mode process (including Unplug staging, which intentionally
  // runs NODE_ENV=production) must have persistent object storage. Render's
  // local filesystem is ephemeral and must never be accepted as a successful
  // upload destination on a release candidate or live deployment.
  const requiresPersistentStorage = process.env.NODE_ENV === 'production'
    || process.env.UNPLUG_ENV === 'staging';

  const required = requiresPersistentStorage
    ? [...CORE_REQUIRED_VARS, ...PERSISTENT_STORAGE_VARS]
    : CORE_REQUIRED_VARS;

  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(
      `Cannot start: missing required environment variable(s): ${missing.join(', ')}.\n` +
      `Copy .env.example to .env and fill them in.`
    );
    process.exit(1);
  }
}

module.exports = validateEnv;
