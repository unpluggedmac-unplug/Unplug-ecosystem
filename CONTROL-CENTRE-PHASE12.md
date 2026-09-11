# Control Centre Phase 12 — Staging Deployment Preparation

## Objective
Make the Phase 11 release candidate safe to stage without any possibility of a preview frontend silently talking to the production API.

## Added
- Cloudflare Pages `/runtime-config` Function.
- `UNPLUG_ENV` + `UNPLUG_API` browser runtime configuration.
- Fail-closed staging API fallback (`staging-api-not-configured.invalid`).
- Visible `UNPLUG STAGING` / misconfiguration ribbon.
- Runtime API support across shared/public helper scripts and Admin/Member dashboards.
- Staging backend preflight (`npm run preflight:staging`).
- `.env.staging.example` with no secrets.
- Frontend staging safety check (`npm run staging:check`).
- Deployment runbook, smoke-test matrix and production rollback plan.
- CSP connection allowance for dedicated `*.onrender.com` staging APIs.

## Cloudflare build safety correction
Cloudflare Pages Functions belong in `/functions` at the Pages project root, not inside the static output directory. The production build no longer copies `/functions` into `dist/`, preventing Function source from being published as static files. The catch-all also refuses `/functions/*` in case an older/root-output Pages configuration is used.

## Verification performed here
- Frontend staging safety check passes.
- Runtime-config Function syntax checked as an ES module.
- Modified shared JS helpers syntax checked.
- Admin, Member, Magazine and Checkout inline JS syntax checked.
- Package JSON parses successfully.

## Verification still required in real staging
- `npm ci` + frontend production build in Cloudflare build environment.
- Backend dependency installation and full PostgreSQL test suite.
- Real staging migrations against isolated PostgreSQL.
- Render `/health/ready` against staging DB.
- Resend/R2/Supabase staging credentials.
- Full smoke-test matrix.

## Production status
**NOT APPROVED FOR PRODUCTION YET.** Phase 12 is a staging-ready release candidate.
