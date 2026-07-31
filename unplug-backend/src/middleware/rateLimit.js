const rateLimit = require('express-rate-limit');

// The automated tests drive these endpoints far harder than any real person
// would, and would otherwise rate-limit themselves out. Keyed on an explicit
// variable rather than NODE_ENV so it can only ever be on when something
// deliberately sets it — the hosting platform sets NODE_ENV, never this.
const RATE_LIMITS_DISABLED = process.env.UNPLUG_DISABLE_RATE_LIMITS === '1';
if (RATE_LIMITS_DISABLED) {
  console.warn('[rateLimit] DISABLED via UNPLUG_DISABLE_RATE_LIMITS — this must never be set in production.');
}
const skipWhenDisabled = () => RATE_LIMITS_DISABLED;

// Login: prevents brute-forcing a password. Keyed by IP, so a single
// attacker can't just retry forever, while still allowing normal typos.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipWhenDisabled,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
});

// Registration: prevents mass-account creation / signup spam.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipWhenDisabled,
  message: { error: 'Too many accounts created from this address. Please try again later.' },
});

// Verification code / password reset requests: prevents email-bombing a
// victim's inbox with repeated codes or reset links.
const emailActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipWhenDisabled,
  message: { error: 'Too many requests. Please wait a few minutes before trying again.' },
});

// Public, unauthenticated submissions (shout-out nominations, job/passport
// posts, birthday submissions, passport comments, newsletter, contact form).
// Caps how many an IP can send in a window so the moderation queues can't be
// flooded by a bot. Generous enough for genuine repeat use.
const publicSubmitLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipWhenDisabled,
  message: { error: 'You\'re doing that too often. Please wait a few minutes and try again.' },
});

module.exports = { loginLimiter, registerLimiter, emailActionLimiter, publicSubmitLimiter };
