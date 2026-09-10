/*
 * TEMPORARY STAGING-ONLY release gate for smoke-test row #32.
 *
 * Verifies the four member-facing Page Banner durations against the independent
 * server quote endpoint. It writes only one synthetic verified member to the
 * isolated staging database and never creates a payment or banner.
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../db');

const EXPECTED_STAGING_DB = 'dpg-daemau1t0dsc73ar5de0-a';
const EXPECTED_DURATIONS = [7, 14, 21, 28];
const PREFIX = 'PHASE11';

function safeTag(raw) {
  return String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'run';
}
function fail(message) { throw new Error(message); }
function sameNumber(a, b) { return Number(a) === Number(b); }

async function jsonRequest(base, method, pathname, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = text; }
  if (!res.ok) fail(`${method} ${pathname} returned ${res.status}: ${String(text).slice(0, 200)}`);
  return parsed;
}

async function run() {
  const marker = process.env.PHASE11_AUTH_STAGING_RUN;
  if (!marker) return;

  const dbUrl = String(process.env.DATABASE_URL || '');
  const siteUrl = String(process.env.SITE_URL || '');
  if (!dbUrl.includes(EXPECTED_STAGING_DB) || !/staging/i.test(siteUrl)) {
    console.log(`${PREFIX}|BLOCKED|pricing-page-banner-32|environment guard refused non-staging run`);
    return;
  }

  const tag = safeTag(marker);
  const email = `phase11-pricing-${tag}@example.invalid`;
  const password = `S11-${crypto.randomBytes(18).toString('base64url')}!a9`;
  const passwordHash = await bcrypt.hash(password, 10);
  const base = `http://127.0.0.1:${process.env.PORT || 4000}`;

  const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
  if (existing.rowCount) {
    console.log(`${PREFIX}|SKIP|pricing-page-banner-32|already ran for ${tag}`);
    return;
  }

  await pool.query(
    `INSERT INTO users (email, phone, password_hash, role, full_name, member_type, email_verified)
     VALUES ($1, '0820000032', $2, 'member', $3, 'individual', true)`,
    [email, passwordHash, `Phase 11 Pricing Gate ${tag}`]
  );

  const login = await jsonRequest(base, 'POST', '/auth/login', { body: { email, password } });
  if (!login || !login.token) fail('pricing gate login returned no token');
  const token = login.token;

  const options = await jsonRequest(base, 'GET', '/ad-banners/options');
  const paymentPackages = await jsonRequest(base, 'GET', '/payments/packages?service=ad_banner');
  const optionPackages = Array.isArray(options && options.packages) ? options.packages : [];
  const quotePackages = Array.isArray(paymentPackages && paymentPackages.packages) ? paymentPackages.packages : [];

  const optionDurations = optionPackages.map(p => Number(p.durationDays ?? p.duration_days)).sort((a, b) => a - b);
  if (JSON.stringify(optionDurations) !== JSON.stringify(EXPECTED_DURATIONS)) {
    fail(`Page Banner durations are ${optionDurations.join('/')}; expected ${EXPECTED_DURATIONS.join('/')}`);
  }

  for (const days of EXPECTED_DURATIONS) {
    const displayed = optionPackages.find(p => Number(p.durationDays ?? p.duration_days) === days);
    const paymentPackage = quotePackages.find(p => Number(p.durationDays ?? p.duration_days) === days);
    if (!displayed || !paymentPackage) fail(`${days}-day Page Banner package missing from one server package endpoint`);
    if (!sameNumber(displayed.price, paymentPackage.price)) {
      fail(`${days}-day package endpoints disagree: ${displayed.price} vs ${paymentPackage.price}`);
    }

    const quote = await jsonRequest(base, 'POST', '/payments/quote', {
      token,
      body: { linkedType: 'ad_banner', durationDays: days, useCredit: false },
    });
    if (!sameNumber(quote.orderTotal, displayed.price)) {
      fail(`${days}-day server quote ${quote.orderTotal} does not match option ${displayed.price}`);
    }
    if (!sameNumber(quote.amountToPay, displayed.price)) {
      fail(`${days}-day cash quote ${quote.amountToPay} does not match option ${displayed.price}`);
    }
  }

  console.log(`${PREFIX}|PASS|pricing-page-banner-32|7/14/21/28 options match server quotes`);
}

function start() {
  if (!process.env.PHASE11_AUTH_STAGING_RUN) return;
  setTimeout(() => {
    run().catch((err) => {
      console.error(`${PREFIX}|FAIL|pricing-page-banner-32|${String(err.message || err).replace(/[\r\n]+/g, ' ').slice(0, 500)}`);
    });
  }, 12000);
}

module.exports = { start };
