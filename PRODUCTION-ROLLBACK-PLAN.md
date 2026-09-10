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

## Release order
1. Merge approved staging branch to production branch.
2. Deploy Render backend first.
3. Confirm `/health` and `/health/ready` are 200.
4. Run a read-only Admin check.
5. Deploy Cloudflare frontend.
6. Run one controlled commercial smoke test.
7. Check Activity Log, Checkout Health and Business Reports.

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
- Production frontend calls staging API
- Payment confirmations fail
- Confirmed payments do not fulfil
- Public content unexpectedly disappears
- Staff can access unauthorized Finance/System routes
- Error rate spikes or Render repeatedly restarts
