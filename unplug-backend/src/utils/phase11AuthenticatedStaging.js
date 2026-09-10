/*
 * TEMPORARY STAGING-ONLY Phase 11 authenticated journey harness.
 *
 * It runs only when PHASE11_AUTH_STAGING_RUN is set AND both the database URL
 * and site URL prove this is the isolated Unplug staging environment. It is
 * intentionally not part of the production release and is removed after the
 * staging evidence is collected.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const EXPECTED_STAGING_DB = 'dpg-daemau1t0dsc73ar5de0-a';
const PREFIX = 'PHASE11';

function note(kind, name, detail = '') {
  const clean = String(detail || '').replace(/[\r\n]+/g, ' ').slice(0, 500);
  console.log(`${PREFIX}|${kind}|${name}${clean ? '|' + clean : ''}`);
}

function must(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

async function request(base, method, path, { token, body, expected = [200], raw = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  } else if (body instanceof FormData) {
    payload = body;
  }
  const res = await fetch(base + path, { method, headers, body: payload });
  if (!expected.includes(res.status)) {
    let text = '';
    try { text = await res.text(); } catch (_) {}
    throw new Error(`${method} ${path} returned ${res.status}: ${text.slice(0, 300)}`);
  }
  if (raw) return res;
  const text = await res.text();
  if (!text) return { status: res.status, body: null, headers: res.headers };
  try { return { status: res.status, body: JSON.parse(text), headers: res.headers }; }
  catch (_) { return { status: res.status, body: text, headers: res.headers }; }
}

function randomPassword() {
  return `S11-${crypto.randomBytes(18).toString('base64url')}!a9`;
}

function safeRunTag(raw) {
  return String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'run';
}

function aliasFor(email, tag) {
  const [local, domain] = String(email || '').split('@');
  if (!local || !domain) return `phase11-${tag}@example.invalid`;
  if (domain.toLowerCase() === 'gmail.com') return `${local.split('+')[0]}+phase11-${tag}@gmail.com`;
  return `phase11-${tag}@${domain}`;
}

async function createSyntheticAdmin(tag) {
  const email = `phase11-superadmin-${tag}@example.invalid`;
  const password = randomPassword();
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO users (email, phone, password_hash, role, full_name, member_type, email_verified)
     VALUES ($1, '0820000001', $2, 'admin', $3, 'individual', true)
     RETURNING id, email`,
    [email, hash, `Phase 11 Super Admin ${tag}`]
  );
  return { id: r.rows[0].id, email, password };
}

async function createSyntheticMemberForStaff(tag, slug) {
  const email = `phase11-${slug}-${tag}@example.invalid`;
  const password = randomPassword();
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO users (email, phone, password_hash, role, full_name, member_type, email_verified)
     VALUES ($1, '0820000002', $2, 'member', $3, 'individual', true)
     RETURNING id, email`,
    [email, hash, `Phase 11 ${slug} ${tag}`]
  );
  return { id: r.rows[0].id, email, password };
}

async function login(base, email, password, expected = [200]) {
  const r = await request(base, 'POST', '/auth/login', { body: { email, password }, expected });
  if (expected.includes(200)) must(r.body && r.body.token, 'login did not return a token');
  return r;
}

async function uploadTinyPng(base, token, proof = false) {
  // Valid 1x1 transparent PNG. Synthetic bytes only; no customer data.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), proof ? 'phase11-proof.png' : 'phase11-image.png');
  return request(base, 'POST', proof ? '/uploads/proof' : '/uploads', {
    token: proof ? undefined : token,
    body: form,
    expected: [201],
  });
}

async function confirmEft(base, adminToken, paymentId) {
  const r = await request(base, 'PATCH', `/payments/${paymentId}/confirm-eft`, {
    token: adminToken,
    expected: [200],
  });
  must(r.body && /confirmed/i.test(r.body.message || ''), `payment ${paymentId} was not confirmed`);
  const db = await pool.query('SELECT status, fulfillment_status, fulfillment_error FROM payments WHERE id=$1', [paymentId]);
  eq(db.rows[0].status, 'confirmed', 'payment status');
  eq(db.rows[0].fulfillment_status, 'applied', 'payment fulfilment');
  return db.rows[0];
}

async function makePaidArticle(base, memberToken, adminToken, tag, imageUrl, withChanges = false) {
  const title = `PHASE11 STAGING Article ${tag}${withChanges ? ' Approval Journey' : ''}`;
  const created = await request(base, 'POST', '/articles', {
    token: memberToken,
    body: {
      title,
      body: '<p>This is synthetic Phase 11 staging content used only to verify the authenticated payment, approval and publication journey.</p>',
      subtitle: 'Synthetic staging verification',
      metaDescription: 'Synthetic Phase 11 staging verification article.',
      bannerImageUrl: imageUrl,
      emotion: 'business',
      bodyFormat: 'html',
      authorName: 'Phase 11 Staging Member',
    },
    expected: [201],
  });
  const article = created.body.article;
  must(article && article.id, 'article create returned no id');
  eq(article.status, 'awaiting_payment', 'new paid article status');

  const quote = await request(base, 'POST', '/payments/quote', {
    token: memberToken,
    body: { linkedType: 'article_publish', linkedId: article.id, useCredit: false },
  });
  eq(Number(quote.body.orderTotal), 95, 'article server quote');
  eq(Number(quote.body.amountToPay), 95, 'article cash quote');

  const pendingQueue = await request(base, 'GET', `/admin/approval-queue?type=article&q=${encodeURIComponent(title)}`, { token: adminToken });
  const pendingRow = (pendingQueue.body.items || pendingQueue.body.rows || []).find((x) => Number(x.id) === Number(article.id));
  must(pendingRow, 'awaiting-payment article not visible in approval queue');
  must(!pendingRow.actions || !pendingRow.actions.approve, 'unpaid article unexpectedly approvable');

  const paid = await request(base, 'POST', '/payments/initiate', {
    token: memberToken,
    body: { linkedType: 'article_publish', linkedId: article.id, method: 'eft', termsAccepted: true },
    expected: [201],
  });
  const payment = paid.body.payment;
  must(payment && payment.id, 'article EFT returned no payment id');
  eq(payment.method, 'eft', 'article payment method');
  eq(payment.status, 'pending', 'article payment initial status');

  return { article, title, quote: quote.body, payment };
}

async function run() {
  const marker = process.env.PHASE11_AUTH_STAGING_RUN;
  if (!marker) return;

  const dbUrl = String(process.env.DATABASE_URL || '');
  const siteUrl = String(process.env.SITE_URL || '');
  if (!dbUrl.includes(EXPECTED_STAGING_DB) || !/staging/i.test(siteUrl)) {
    note('BLOCKED', 'environment-guard', 'refusing to run outside the isolated staging database/site');
    return;
  }

  const tag = safeRunTag(marker);
  const base = `http://127.0.0.1:${process.env.PORT || 4000}`;
  const startedAt = new Date();
  const pass = [];
  const markPass = (name, detail = '') => { pass.push(name); note('PASS', name, detail); };

  // Same run marker is never executed twice after a restart.
  const prior = await pool.query("SELECT 1 FROM users WHERE email=$1", [`phase11-superadmin-${tag}@example.invalid`]);
  if (prior.rowCount) {
    note('SKIP', 'already-ran', tag);
    return;
  }

  note('START', 'authenticated-staging', tag);

  // 1) Health/readiness from the deployed process itself.
  const ready = await request(base, 'GET', '/health/ready');
  eq(ready.body.status, 'ready', 'readiness status');
  eq(ready.body.database, 'ok', 'readiness database');
  markPass('health-ready');

  // 2) Full member account lifecycle, including real Resend send calls.
  const existingAdmin = await pool.query("SELECT email FROM users WHERE role='admin' ORDER BY id LIMIT 1");
  must(existingAdmin.rowCount, 'no existing staging admin available to derive a test-safe mailbox alias');
  const memberEmail = aliasFor(existingAdmin.rows[0].email, tag);
  const memberPassword = randomPassword();
  const registered = await request(base, 'POST', '/auth/register', {
    body: {
      email: memberEmail,
      password: memberPassword,
      phone: '082 000 1111',
      role: 'member',
      fullName: 'Phase 11 Staging Member',
      memberType: 'individual',
    },
    expected: [201],
  });
  must(registered.body.emailSent === true, 'verification email provider did not accept the message');
  const memberId = registered.body.user.id;
  const codeRow = await pool.query(
    `SELECT code FROM email_verification_codes WHERE user_id=$1 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [memberId]
  );
  must(codeRow.rowCount, 'verification code was not persisted');
  await request(base, 'POST', '/auth/verify-email', { body: { email: memberEmail, code: codeRow.rows[0].code } });
  let memberLogin = await login(base, memberEmail, memberPassword);
  let memberToken = memberLogin.body.token;
  const me = await request(base, 'GET', '/auth/me', { token: memberToken });
  eq(Number(me.body.user.id), Number(memberId), 'auth/me member id');
  await request(base, 'POST', '/auth/logout', { token: memberToken });

  const forgot = await request(base, 'POST', '/auth/forgot-password', { body: { email: memberEmail } });
  must(/reset/i.test(forgot.body.message || ''), 'forgot-password generic response missing');
  const resetRow = await pool.query(
    `SELECT token FROM password_reset_tokens WHERE user_id=$1 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [memberId]
  );
  must(resetRow.rowCount, 'password reset token was not persisted');
  const newMemberPassword = randomPassword();
  await request(base, 'POST', '/auth/reset-password', { body: { token: resetRow.rows[0].token, newPassword: newMemberPassword } });
  memberLogin = await login(base, memberEmail, newMemberPassword);
  memberToken = memberLogin.body.token;
  markPass('member-register-verify-login-logout-reset');

  // 3) Synthetic Super Admin uses the normal login endpoint; no production or
  // real administrator password is read or changed.
  const syntheticAdmin = await createSyntheticAdmin(tag);
  const adminLogin = await login(base, syntheticAdmin.email, syntheticAdmin.password);
  const adminToken = adminLogin.body.token;
  const adminAccess = await request(base, 'GET', '/admin/staff/access', { token: adminToken });
  must(adminAccess.body.access && adminAccess.body.access.isSuperAdmin === true, 'synthetic admin not recognised as Super Admin');
  markPass('super-admin-authenticated');

  // 4) R2 public image upload.
  const image = await uploadTinyPng(base, memberToken, false);
  must(image.body && /^https:\/\//i.test(image.body.url || ''), 'public upload did not return an HTTPS URL');
  eq(image.body.storage, 'r2', 'public upload storage');
  const publicObject = await fetch(image.body.url);
  must(publicObject.ok, `uploaded public R2 object was not readable (${publicObject.status})`);
  markPass('r2-public-upload');

  // 5) Article -> server quote -> EFT -> private proof -> Finance/Admin confirm.
  const journey = await makePaidArticle(base, memberToken, adminToken, tag, image.body.url, true);
  const proof = await uploadTinyPng(base, memberToken, true);
  must(proof.body && /^https:\/\//i.test(proof.body.url || ''), 'private proof upload returned no URL');
  await request(base, 'PATCH', `/payments/${journey.payment.id}/proof`, {
    token: memberToken,
    body: { url: proof.body.url },
  });
  const paymentQueue = await request(base, 'GET', `/admin/payment-queue?source=payment&status=pending&q=${encodeURIComponent(journey.payment.gateway_reference)}`, { token: adminToken });
  const payRow = (paymentQueue.body.items || []).find((x) => Number(x.id) === Number(journey.payment.id));
  must(payRow, 'pending EFT missing from Admin Payment Queue');
  must(payRow.popUrl, 'proof URL missing from Payment Queue row');
  const proofRead = await request(base, 'GET', `/admin/payment-queue/payment/${journey.payment.id}/proof`, { token: adminToken, raw: true });
  must((proofRead.headers.get('content-type') || '').includes('image/'), 'admin private proof read did not return an image');
  await proofRead.arrayBuffer();
  await confirmEft(base, adminToken, journey.payment.id);
  const articleAfterPay = await pool.query('SELECT status FROM articles WHERE id=$1', [journey.article.id]);
  eq(articleAfterPay.rows[0].status, 'pending', 'paid article moderation status');
  markPass('eft-payment-proof-queue-confirm-fulfilment', `payment=${journey.payment.id}`);

  // 6) Approval Centre preview -> request changes -> member edit -> resubmit -> approve -> public.
  const preview = await request(base, 'GET', `/admin/approval-queue/article/${journey.article.id}`, { token: adminToken });
  must(preview.body && (preview.body.item || preview.body.article || preview.body.fields), 'approval preview returned no content');
  const change = await request(base, 'POST', `/admin/approval-queue/article/${journey.article.id}/request-changes`, {
    token: adminToken,
    body: { fields: ['title'], note: 'Synthetic Phase 11 staging change request.' },
  });
  must(change.body && change.body.request, 'request-changes returned no request');
  const mine = await request(base, 'GET', '/change-requests/mine', { token: memberToken });
  const changeRow = (mine.body.changeRequests || []).find((x) => Number(x.submissionId) === Number(journey.article.id));
  must(changeRow, 'member did not receive the change request');
  const revisedTitle = `${journey.title} — Revised`;
  await request(base, 'PATCH', `/articles/${journey.article.id}`, { token: memberToken, body: { title: revisedTitle } });
  await request(base, 'POST', `/change-requests/${changeRow.id}/resubmit`, { token: memberToken });
  const resubmitted = await pool.query('SELECT status FROM articles WHERE id=$1', [journey.article.id]);
  eq(resubmitted.rows[0].status, 'resubmitted', 'article resubmission status');
  await request(base, 'PATCH', `/admin/articles/${journey.article.id}/approve`, { token: adminToken, body: {} });
  const publicArticle = await request(base, 'GET', `/articles/${journey.article.id}`);
  eq(publicArticle.body.article.title, revisedTitle, 'public revised article title');
  eq(publicArticle.body.article.status, 'approved', 'public article status');
  markPass('approval-change-resubmit-publication', `article=${journey.article.id}`);

  // 7) Advertising payment + approval + public placement + impression/click tracking.
  const options = await request(base, 'GET', '/ad-banners/options');
  const firstPackage = must((options.body.packages || [])[0], 'no active ad-banner package available');
  const durationDays = Number(firstPackage.durationDays || firstPackage.duration_days);
  const bannerCreate = await request(base, 'POST', '/ad-banners', {
    token: memberToken,
    body: {
      slotKey: 'home-sponsor-1',
      durationDays,
      imageUrl: image.body.url,
      linkUrl: 'https://example.com/phase11-staging',
      name: `PHASE11 STAGING Banner ${tag}`,
      campaignName: `PHASE11 STAGING Campaign ${tag}`,
      advertiserName: 'Phase 11 Staging Member',
      startsAt: new Date().toISOString().slice(0, 10),
    },
    expected: [201],
  });
  const bannerId = bannerCreate.body.id;
  must(bannerId, 'banner create returned no id');
  const bannerPay = await request(base, 'POST', '/payments/initiate', {
    token: memberToken,
    body: { linkedType: 'ad_banner', linkedId: bannerId, method: 'eft', termsAccepted: true },
    expected: [201],
  });
  await confirmEft(base, adminToken, bannerPay.body.payment.id);
  await request(base, 'PATCH', `/page-cms/admin/ad-slots/${bannerId}/moderate`, {
    token: adminToken,
    body: { status: 'approved' },
  });
  const publicCms = await request(base, 'GET', '/page-cms');
  const homeAds = (publicCms.body.adSlots && publicCms.body.adSlots['home-sponsor-1']) || [];
  must(homeAds.some((x) => Number(x.id) === Number(bannerId)), 'approved banner not present in public page-cms payload');
  await request(base, 'POST', `/ad-banners/${bannerId}/event`, { body: { eventType: 'impression' }, expected: [204] });
  await request(base, 'POST', `/ad-banners/${bannerId}/event`, { body: { eventType: 'click' }, expected: [204] });
  const adStats = await pool.query('SELECT impressions, clicks FROM ad_banner_analytics WHERE ad_slot_id=$1 AND event_date=CURRENT_DATE', [bannerId]);
  must(adStats.rowCount, 'banner analytics row was not created');
  must(Number(adStats.rows[0].impressions) >= 1 && Number(adStats.rows[0].clicks) >= 1, 'banner impression/click counters did not increment');
  markPass('advertising-payment-approval-impression-click', `banner=${bannerId}`);

  // 8) Staff roles: use live role assignment and login, then prove both the
  // UI access contract (/admin/staff/access) and server-side denial/allow rules.
  const roles = await request(base, 'GET', '/admin/staff/roles', { token: adminToken });
  const roleBySlug = new Map((roles.body.roles || []).map((r) => [r.slug, r]));
  const roleChecks = {
    editor: {
      mustHave: ['content.manage', 'approvals.manage'],
      allow: ['GET', '/admin/approval-queue'],
      deny: ['GET', '/payments/admin/all'],
    },
    marketing: {
      mustHave: ['advertising.manage', 'marketing.manage'],
      allow: ['GET', '/page-cms/admin/ad-slots'],
      deny: ['GET', '/payments/admin/all'],
    },
    finance: {
      mustHave: ['finance.manage', 'reports.export'],
      allow: ['GET', '/payments/admin/all'],
      deny: ['GET', '/admin/approval-queue'],
    },
    support: {
      mustHave: ['members.manage', 'approvals.view'],
      allow: ['GET', '/admin/approval-queue'],
      deny: ['POST', `/admin/approval-queue/article/${journey.article.id}/request-changes`, { fields: ['body'], note: 'must be denied' }],
    },
  };
  for (const [slug, spec] of Object.entries(roleChecks)) {
    const role = must(roleBySlug.get(slug), `built-in staff role ${slug} is missing`);
    const u = await createSyntheticMemberForStaff(tag, slug);
    await request(base, 'POST', '/admin/staff/assign', {
      token: adminToken,
      body: { userId: u.id, staffRoleId: role.id },
    });
    const staffLogin = await login(base, u.email, u.password);
    const staffToken = staffLogin.body.token;
    const access = await request(base, 'GET', '/admin/staff/access', { token: staffToken });
    eq(access.body.access.staffRoleSlug, slug, `${slug} access role`);
    for (const p of spec.mustHave) must((access.body.access.permissions || []).includes(p), `${slug} missing ${p}`);
    await request(base, spec.allow[0], spec.allow[1], { token: staffToken, expected: [200] });
    await request(base, spec.deny[0], spec.deny[1], { token: staffToken, body: spec.deny[2], expected: [403] });
    markPass(`permissions-${slug}`);
  }

  // 9) Business reporting: presets/custom ranges + CSV/XLS + DB reconciliation.
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 60 * 1000);
  const todayStart = new Date(now); todayStart.setUTCHours(0, 0, 0, 0);
  const sevenStart = new Date(now.getTime() - 7 * 86400000);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const ranges = [
    ['today', todayStart], ['7-days', sevenStart], ['this-month', monthStart], ['custom', startedAt],
  ];
  let customReport;
  for (const [name, from] of ranges) {
    const r = await request(base, 'GET', `/admin/business-reports/summary?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(tomorrow.toISOString())}`, { token: adminToken });
    must(r.body && r.body.headline, `${name} report missing headline`);
    if (name === 'custom') customReport = r.body;
    markPass(`report-${name}`);
  }
  const direct = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status='confirmed')::int AS confirmed_count,
            COALESCE(SUM(amount) FILTER (WHERE status='confirmed'),0)::numeric AS revenue
       FROM payments WHERE COALESCE(confirmed_at, created_at) BETWEEN $1 AND $2`,
    [startedAt, tomorrow]
  );
  eq(Number(customReport.headline.confirmedPayments), Number(direct.rows[0].confirmed_count), 'custom report confirmed-payment reconciliation');
  eq(Number(customReport.headline.revenue), Number(direct.rows[0].revenue), 'custom report revenue reconciliation');

  const csv = await request(base, 'GET', `/admin/business-reports/export.csv?from=${encodeURIComponent(startedAt.toISOString())}&to=${encodeURIComponent(tomorrow.toISOString())}`, { token: adminToken, raw: true });
  must((csv.headers.get('content-type') || '').includes('text/csv'), 'CSV export content type incorrect');
  const csvText = await csv.text();
  must(csvText.includes('Category') && csvText.includes('Revenue'), 'CSV export missing expected report columns');
  const xls = await request(base, 'GET', `/admin/business-reports/export.xls?from=${encodeURIComponent(startedAt.toISOString())}&to=${encodeURIComponent(tomorrow.toISOString())}`, { token: adminToken, raw: true });
  const xlsText = await xls.text();
  must(/<table/i.test(xlsText) && /Revenue/i.test(xlsText), 'Excel-compatible export did not contain the report table');
  markPass('report-csv-xls-reconcile');

  // 10) Final public/auth isolation checks.
  await request(base, 'GET', '/admin/business-reports/summary', { expected: [401] });
  await request(base, 'GET', '/admin/staff/roles', { token: memberToken, expected: [403] });
  markPass('auth-boundaries');

  note('COMPLETE', 'authenticated-staging', `${pass.length} checks passed`);
  console.log(`${PREFIX}_RESULT=${JSON.stringify({ status: 'passed', marker: tag, checks: pass, articleId: journey.article.id, bannerId, paymentIds: [journey.payment.id, bannerPay.body.payment.id] })}`);
}

function start() {
  if (!process.env.PHASE11_AUTH_STAGING_RUN) return;
  setTimeout(() => {
    run().catch((err) => {
      note('FAIL', 'authenticated-staging', err && err.message ? err.message : String(err));
      console.error(err && err.stack ? err.stack : err);
    });
  }, 1500);
}

module.exports = { start };
