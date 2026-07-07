const rateLimit = require('express-rate-limit');

// Login: prevents brute-forcing a password. Keyed by IP, so a single
// attacker can't just retry forever, while still allowing normal typos.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
});

// Registration: prevents mass-account creation / signup spam.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this address. Please try again later.' },
});

// Verification code / password reset requests: prevents email-bombing a
// victim's inbox with repeated codes or reset links.
const emailActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes before trying again.' },
});

module.exports = { loginLimiter, registerLimiter, emailActionLimiter };
