# Unplug Control Centre — Phase 11: Staging & Production Readiness

## Status
**Release candidate. Do not deploy directly to production without the staging checklist below.**

Phase 11 consolidates Phases 1–10 and adds production safeguards discovered during deployment-readiness review.

## Production safeguards added

### 1. Startup environment validation is now active
`src/utils/validateEnv.js` already existed but was never called. `src/app.js` now calls it immediately after dotenv loads, so the backend refuses to boot without:
- `DATABASE_URL`
- `JWT_SECRET`

### 2. Production CORS fails closed
If `CORS_ORIGINS` is accidentally absent:
- local/dev remains permissive for developer convenience;
- `NODE_ENV=production` does **not** silently allow every cross-origin caller.

The preflight script treats missing production CORS as a failure.

### 3. Database-aware readiness endpoint
Existing: `GET /health` proves the Node process is alive.

New: `GET /health/ready` executes `SELECT 1` and returns:
- `200 { status: "ready", database: "ok" }` when PostgreSQL is reachable;
- `503 { status: "not_ready", database: "unavailable" }` otherwise.

Use `/health/ready` for deployment readiness/health checks where supported.

### 4. Payment callbacks now fail closed
PayFast/Ozow initiation remains intentionally disabled until real hosted checkout-session builders are implemented.

Previously, callback signature verification returned `true` when the corresponding secret was absent. Phase 11 changes this so unverifiable callbacks are rejected.

This prevents a public callback endpoint from trusting an unsigned/unverifiable notification.

### 5. Staff-role migration no longer overwrites Super Admin choices
Migration `185_staff_roles_permissions.sql` previously deleted/re-seeded built-in permissions on every deploy. Because this project re-runs migrations at startup, that would have erased any role customisation made in the Control Centre.

Phase 11 now seeds missing defaults only. Super Admin permission changes persist across deployments.

### 6. Production preflight command
New command:

```bash
cd unplug-backend
npm run preflight
```

The checker never prints secret values. It checks core production configuration including:
- database/JWT
- explicit CORS
- HTTPS public URLs
- outbound email provider
- Resend webhook signing secret
- persistent public/private storage
- cleanup/birthday scheduler secrets
- accidental `ADMIN_PASSWORD_RESET=true`
- accidental disabled rate limiting
- current PayFast/Ozow callback-secret readiness

An `.env.example` has also been added with no real credentials.

## Verification completed in this workspace

Passed:
- Phase 10 commercial checkout guards: 5/5
- Phase 11 production-readiness guards: 3/3
- Combined static tests: **8/8**
- Syntax checks on Phase 11 critical backend files
- Syntax checks on the large inline scripts in Admin Dashboard, Member Dashboard, Magazine and Checkout
- Migration 176/183/184/185/186/187 reviewed for repeat-deploy behaviour relevant to these phases

## Verification NOT completed here

This environment cannot fetch npm packages from npm registry, so `npm ci` cannot complete. It also has no access to your Render production/staging database or environment-variable values.

Therefore the following still require a real staging environment:
1. `npm ci` at repository root
2. `npm run build`
3. `npm ci` in `unplug-backend/`
4. full `npm test` in `unplug-backend/`
5. migrations against an isolated staging PostgreSQL database
6. `/health/ready` returning 200
7. email verification/reset through Resend
8. upload test through R2/Supabase
9. complete member + EFT + admin confirmation + approval + publication journey
10. CSV/Excel report export
11. banner impression/click tracking
12. permission tests with non-Super-Admin staff accounts

## Recommended staging strategy

Do **not** begin by cloning real member data unless necessary.

Safest first staging run:
1. Create an empty PostgreSQL staging database.
2. Deploy backend against that database.
3. Run all migrations.
4. Seed/create a test Super Admin.
5. Use test member accounts only.
6. Point a Cloudflare preview deployment at the staging API.
7. Use a Resend test-safe configuration/addressing strategy.
8. Run the journeys below.

Only use `npm run clone:staging -- --scrub` later if a production-data-shaped issue genuinely requires it. A synthetic staging database avoids unnecessary exposure of production personal/payment data.

## Staging test journeys — required before production

### Account
- Register a new member
- Receive verification email
- Verify code
- Sign in/out
- Forgot password
- Password reset

### Article
- Submit article
- Quote R amount from server
- EFT checkout
- Confirm EFT as Finance/Super Admin
- Verify fulfilment becomes applied
- Preview/edit in Approval Centre
- Request changes
- Resubmit
- Approve
- Confirm public article appears

### Directory
- Create package profile
- Checkout
- Confirm payment
- Approve
- Verify public listing
- Test highlight purchase

### Event
- Submit event
- Checkout/confirm
- Approve
- Verify public calendar/listing

### Advertising
- Submit banner
- Checkout/confirm
- Approve
- Confirm campaign appears
- Confirm impression increments
- Click banner
- Confirm click/CTR increments
- Confirm campaign value/reporting

### Cart
- Add multiple services
- Confirm duplicate-resource guard
- Confirm service-restricted voucher only discounts eligible line
- Complete EFT
- Confirm each service fulfils once

### Failure/recovery
- Force one service fulfilment failure in staging
- Confirm Checkout Health shows it
- Retry after correcting cause
- Confirm status becomes applied

### Permissions
Test at least:
- Editor
- Marketing
- Finance
- Support

Confirm UI is hidden **and** direct API calls are denied where capability is absent.

### Reports
- Today
- 7 Days
- This Month
- Custom range
- CSV export
- Excel-compatible export
- Revenue/service totals reconcile with test transactions

## Deployment order when staging passes

1. Take/verify a production database backup.
2. Confirm backup encryption passphrase is safely stored outside Render.
3. Confirm Render environment with `npm run preflight`.
4. Ensure `ADMIN_PASSWORD_RESET` is absent/false.
5. Deploy backend + migrations first.
6. Confirm `/health` and `/health/ready`.
7. Smoke-test admin login/API.
8. Deploy Cloudflare frontend build.
9. Smoke-test member login and public pages.
10. Execute one low-value/test-safe EFT journey.
11. Confirm Checkout Health, Analytics and Activity Log.
12. Monitor Render logs and admin alerts after deploy.

## Rollback principle
If backend migration/deploy fails, do not “fix forward” directly against production data without understanding the failure. Keep the previous frontend live, restore backend release where possible, and restore a database backup only when schema/data recovery actually requires it.

## Current gateway position
- EFT: live initiation method
- PayFast: callback code exists; hosted checkout initiation is intentionally disabled
- Ozow: callback code exists; hosted checkout initiation is intentionally disabled

Do not enable PayFast/Ozow simply by adding credentials. Implement and sandbox-test the real provider initiation flows first.
