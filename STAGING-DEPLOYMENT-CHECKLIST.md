# Unplug Staging Deployment Checklist — Phase 12

## Isolation first
- [ ] GitHub branch is `staging-control-centre`; production branch unchanged
- [ ] Separate staging PostgreSQL database exists
- [ ] `DATABASE_URL` equals `STAGING_DATABASE_URL` on staging only
- [ ] No production member/payment data copied into first staging pass

## Render staging
- [ ] Root directory `unplug-backend`
- [ ] Build: `npm ci --omit=dev && npm run preflight:staging`
- [ ] Start: `npm start`
- [ ] Health check path `/health/ready`
- [ ] `UNPLUG_ENV=staging`
- [ ] `NODE_ENV=production`
- [ ] Staging-only `JWT_SECRET`
- [ ] Exact staging `CORS_ORIGINS`
- [ ] Staging `SITE_URL` and `PUBLIC_API_URL`
- [ ] Test Super Admin seed configured
- [ ] `/health` = 200
- [ ] `/health/ready` = 200

## Cloudflare staging
- [ ] Separate staging Pages project connected to staging branch
- [ ] Build `npm ci && npm run build`
- [ ] Output `dist`
- [ ] `UNPLUG_ENV=staging`
- [ ] `UNPLUG_API=<staging Render API>`
- [ ] Staging ribbon visible
- [ ] No `STAGING — API NOT CONFIGURED` warning
- [ ] Browser network calls go only to staging API

## Tests
- [ ] Complete `STAGING-SMOKE-TEST-MATRIX.md`
- [ ] Critical release-gate rows all PASS
- [ ] Checkout Health has no unexplained failure
- [ ] Audit log records staff/admin actions
- [ ] Reports and export totals match

## Before production
- [ ] Verified production backup
- [ ] Current production commit/deploy IDs recorded
- [ ] `ADMIN_PASSWORD_RESET` absent/false
- [ ] Production preflight passes
- [ ] Production rollback plan reviewed
- [ ] Backend deploy first, frontend second
