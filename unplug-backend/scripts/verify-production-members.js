#!/usr/bin/env node
// Read-only production cutover guard for the Control Centre.
//
// This script never copies or changes member data. It proves that the backend
// selected for production is looking at a database with at least the member
// baseline captured immediately before rollout, and prints aggregate signals
// that can be compared before/after without putting member PII in Git.
//
// Example:
//   UNPLUG_ENV=production EXPECTED_MIN_PRODUCTION_USERS=60 \
//     node scripts/verify-production-members.js

require('dotenv').config();
const { Pool } = require('pg');

function requiredMin(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`${name} must be a non-negative number.`);
    process.exit(2);
  }
  return n;
}

if (process.env.UNPLUG_ENV !== 'production') {
  console.error('REFUSED: this release gate only runs when UNPLUG_ENV=production.');
  console.error('It is intentionally not a staging-data population tool.');
  process.exit(2);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}

const expectedUsers = requiredMin('EXPECTED_MIN_PRODUCTION_USERS');
if (expectedUsers === null) {
  console.error('EXPECTED_MIN_PRODUCTION_USERS is required. Capture the current production member count immediately before rollout.');
  process.exit(2);
}

const optionalMinimums = {
  usersWithPhone: requiredMin('EXPECTED_MIN_USERS_WITH_PHONE'),
  confirmedPayments: requiredMin('EXPECTED_MIN_CONFIRMED_PAYMENTS'),
  publishedArticles: requiredMin('EXPECTED_MIN_PUBLISHED_ARTICLES'),
  approvedProfiles: requiredMin('EXPECTED_MIN_APPROVED_PROFILES'),
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');

    const users = (await client.query(`
      SELECT COUNT(*)::int AS total_users,
             COUNT(*) FILTER (WHERE phone IS NOT NULL AND btrim(phone) <> '')::int AS users_with_phone,
             COUNT(*) FILTER (WHERE member_type = 'individual')::int AS individuals,
             COUNT(*) FILTER (WHERE member_type = 'business')::int AS businesses,
             COUNT(*) FILTER (WHERE role = 'member')::int AS members,
             COUNT(*) FILTER (WHERE role = 'consultant')::int AS consultants,
             COUNT(*) FILTER (WHERE role = 'admin')::int AS admins,
             COUNT(*) FILTER (WHERE is_suspended = true)::int AS suspended
        FROM users
    `)).rows[0];

    const commercial = (await client.query(`
      SELECT
        (SELECT COUNT(*) FROM payments WHERE status = 'confirmed')::int AS confirmed_payments,
        (SELECT COUNT(*) FROM articles WHERE status = 'approved')::int AS published_articles,
        (SELECT COUNT(*) FROM profiles WHERE status = 'approved')::int AS approved_profiles,
        (SELECT COALESCE(SUM(amount), 0) FROM account_credits)::numeric AS total_account_credit
    `)).rows[0];

    await client.query('ROLLBACK');

    const summary = {
      totalUsers: users.total_users,
      usersWithPhone: users.users_with_phone,
      individuals: users.individuals,
      businesses: users.businesses,
      members: users.members,
      consultants: users.consultants,
      admins: users.admins,
      suspended: users.suspended,
      confirmedPayments: commercial.confirmed_payments,
      publishedArticles: commercial.published_articles,
      approvedProfiles: commercial.approved_profiles,
      totalAccountCredit: Number(commercial.total_account_credit),
    };

    console.log('Production member preservation check (read-only):');
    console.log(JSON.stringify(summary, null, 2));

    const failures = [];
    if (summary.totalUsers < expectedUsers) {
      failures.push(`total users ${summary.totalUsers} is below required baseline ${expectedUsers}`);
    }
    for (const [key, minimum] of Object.entries(optionalMinimums)) {
      if (minimum !== null && Number(summary[key]) < minimum) {
        failures.push(`${key} ${summary[key]} is below required baseline ${minimum}`);
      }
    }

    if (failures.length) {
      console.error('\nRELEASE BLOCKED: production member preservation check failed.');
      failures.forEach((f) => console.error(`- ${f}`));
      console.error('Do not deploy the new Control Centre against an empty/new database and do not copy production members into staging.');
      process.exitCode = 1;
      return;
    }

    console.log('\nPASS: production database meets the captured member baseline.');
    console.log('Next: open Users & Members in the production Control Centre and spot-check known existing accounts before completing rollout.');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore rollback failure */ }
    console.error('RELEASE BLOCKED: could not verify production members:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})().catch((err) => {
  console.error('RELEASE BLOCKED:', err.message);
  process.exit(1);
});
