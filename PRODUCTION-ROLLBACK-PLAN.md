# Unplug Control Centre — Production Rollback Plan

Use this only after staging has passed and immediately before/after a production release.

## Before deploying
- Take and verify a PostgreSQL backup.
- Record the current production Git commit SHA.
- Record the current Render successful deploy ID.
- Record the current Cloudflare Pages successful deployment.
- Confirm `ADMIN_PASSWORD_RESET` is absent/false.
- Confirm production `UNPLUG_ENV=production` and `UNPLUG_API=https://unplug-ecosystem.onrender.com` in Pages.
- Run production `npm run preflight`.

### RELEASE-BLOCKING MEMBER PRESERVATION GATE
The new Control Centre must reuse the existing production database. Never create a new empty production member database and never copy real production members into staging just to make staging look populated.

Immediately before rollout, capture the live production baseline from the existing Users screen / database. At minimum record the current total account count. Also record the aggregate counts for users with phone numbers, confirmed payments, published articles and approved profiles when available.

Then run the read-only guard from `unplug-backend/` against the production database:

```bash
UNPLUG_ENV=production \
EXPECTED_MIN_PRODUCTION_USERS=<fresh production count> \
node scripts/verify-production-members.js
```

Optional stricter minimums can also be supplied:

- `EXPECTED_MIN_USERS_WITH_PHONE`
- `EXPECTED_MIN_CONFIRMED_PAYMENTS`
- `EXPECTED_MIN_PUBLISHED_ARTICLES`
- `EXPECTED_MIN_APPROVED_PROFILES`

If the script fails, **stop the release**. Do not work around it by importing/copying real members into staging.

After the new production backend is live, run the same guard again before completing the frontend cutover. Then open **Users & Members** in the production Control Centre and spot-check several known existing accounts. Confirm name, phone, role, member type, account credit and existing payment/content ownership still display correctly. Existing members must not be recreated or duplicated.

## Release order
1. Merge approved staging branch to production branch.
2. Deploy Render backend first.
3. Confirm `/health` and `/health/ready` are 200.
4. Run the production member preservation gate above. If it fails, stop.
5. Run a read-only Admin check and spot-check known existing members.
6. Deploy Cloudflare frontend.
7. Run one controlled commercial smoke test.
8. Check Activity Log, Checkout Health and Business Reports.

## Roll back frontend
Use Cloudflare Pages Deployments to roll back/promote the last known-good production deployment, or revert the production Git commit and redeploy.

## Roll back backend code
Use Render's deploy history to redeploy the last known-good Git commit/deploy.

## Database warning
Code rollback does **not** automatically reverse database migrations. Do not run ad-hoc `DROP`/reverse SQL during an incident.

Phases 3–10 were designed mainly as additive migrations. If a newly added table/column causes a problem, first roll back application code while leaving additive schema in place. Restore the database backup only when data/schema corruption makes that necessary and you understand the data-loss window.

## Immediate stop conditions
Stop/rollback if any of these occur after release:
- `/health/ready` fails
- Admin cannot authenticate
- Member authentication fails broadly
- Production member count falls below the captured pre-release baseline
- Existing members are missing, duplicated, or lose their saved role/member type/credit/content ownership
- Production frontend calls staging API
- Payment confirmations fail
- Confirmed payments do not fulfil
- Public content unexpectedly disappears
- Staff can access unauthorized Finance/System routes
- Error rate spikes or Render repeatedly restarts
