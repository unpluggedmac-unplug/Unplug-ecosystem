// Fails fast at startup with a clear message if a required env var is
// missing, instead of booting fine and only breaking later with a cryptic
// error (e.g. a JWT_SECRET-less app crashing on the first login attempt).
const REQUIRED_VARS = ['DATABASE_URL', 'JWT_SECRET'];

function validateEnv() {
  const missing = REQUIRED_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(
      `Cannot start: missing required environment variable(s): ${missing.join(', ')}.\n` +
      `Copy .env.example to .env and fill them in.`
    );
    process.exit(1);
  }
}

module.exports = validateEnv;
