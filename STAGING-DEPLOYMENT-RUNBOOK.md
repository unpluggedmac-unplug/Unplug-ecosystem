# Unplug Control Centre — Staging Deployment Runbook (Phase 12)

**Purpose:** deploy Phases 1–12 to an isolated, no-production-data staging environment before any production rollout.

## Golden rules
1. Do **not** deploy this branch to the production Render service or production Cloudflare Pages project yet.
2. Staging must use its own PostgreSQL database. Never reuse the production `DATABASE_URL`.
3. Staging must show the **UNPLUG STAGING** ribbon. If it says **STAGING — API NOT CONFIGURED**, stop and fix the Pages variables.
4. Use fake names, fake submissions and test payments only.
5. Keep PayFast/Ozow initiation disabled. Use EFT flow for commercial staging tests.

## Zero-extra-cost staging path
The preferred zero-cost setup is:
- GitHub branch: `staging-control-centre`
- Render: separate **Free** staging web service
- Database: separate **Free Render Postgres** if available in the workspace (temporary; Render free Postgres expires after 30 days), or a separate free Supabase Postgres project if you have a free project slot
- Cloudflare Pages: separate staging Pages project (free) connected to the same GitHub repo/branch

Do not create paid resources for this test unless you independently choose to.

---

## A. GitHub — create the isolated branch

Repository: `unpluggedmac-unplug/Unplug-ecosystem`

### Easiest route for a non-developer: GitHub Desktop
1. Install/open GitHub Desktop and sign in.
2. Clone `Unplug-ecosystem` to the PC.
3. Create branch: `staging-control-centre` from the current production/default branch.
4. Make a backup copy of the cloned folder before replacing files.
5. Copy the contents of the Phase 12 release ZIP into the cloned repository folder, replacing matching files.
6. In GitHub Desktop review the changed files.
7. Commit message: `Control Centre Phase 12 staging candidate`.
8. Push **only** `staging-control-centre`.
9. Confirm the branch exists on GitHub and `main` has not changed.

Do not merge this branch into `main` yet.

---

## B. Create isolated staging database

### Preferred: Render Free Postgres (when available)
1. Render Dashboard → **New** → **Postgres**.
2. Name: `unplug-staging-db`.
3. Choose the same region as the staging backend.
4. Choose **Free**.
5. After creation, copy its connection URL for staging only.
6. This value will be set as **both** `DATABASE_URL` and `STAGING_DATABASE_URL` on the staging backend.

### Alternative: separate Supabase free project
Use a new project, not the production project. Copy its Postgres connection string and use it as both variables above.

### Never do this
- Do not copy production `DATABASE_URL` into staging.
- Do not clone real member/payment data into the first staging test.
- Do not run Phase 12 migrations manually against production.

---

## C. Render — create staging backend

Render Dashboard → **New → Web Service → Git Provider** and select the Unplug repository.

Use:
- **Name:** `unplug-ecosystem-staging`
- **Branch:** `staging-control-centre`
- **Root Directory:** `unplug-backend`
- **Language:** Node
- **Build Command:** `npm ci --omit=dev && npm run preflight:staging`
- **Start Command:** `npm start`
- **Health Check Path:** `/health/ready`
- **Plan:** Free for staging if available

### Staging environment variables
Use `unplug-backend/.env.staging.example` as the checklist. At minimum set:
- `UNPLUG_ENV=staging`
- `NODE_ENV=production`
- `DATABASE_URL=<staging DB>`
- `STAGING_DATABASE_URL=<the exact same staging DB>`
- `JWT_SECRET=<new staging-only strong secret>`
- `CORS_ORIGINS=<staging Pages origin>`
- `SITE_URL=<staging Pages origin>`
- `PUBLIC_API_URL=<staging Render URL>`
- `ADMIN_EMAIL=<test admin email>`
- `ADMIN_PASSWORD=<new staging-only password>`

Then configure staging-safe Resend/storage variables as available.

`npm start` runs migrations before starting the Express app. The first boot should therefore create the full staging schema and seed the test Super Admin when `ADMIN_PASSWORD` is present.

### Backend acceptance checks
Open:
- `<staging-api>/health` — must be 200
- `<staging-api>/health/ready` — must be 200 and confirm database readiness

If `/health` works but `/health/ready` fails, stop. The Node app is alive but PostgreSQL is not ready.

---

## D. Cloudflare Pages — create a staging frontend

Recommended: create a **separate Pages project** rather than changing production Pages settings.

Cloudflare → **Workers & Pages → Create → Pages → Import existing Git repository**.

Use:
- **Project name:** `unplug-staging` (or another clearly staging-only name)
- **Production branch for this staging project:** `staging-control-centre`
- **Root directory:** repository root
- **Build command:** `npm ci && npm run build`
- **Build output directory:** `dist`

### Pages environment variables
Set these for the staging Pages project:
- `UNPLUG_ENV=staging`
- `UNPLUG_API=https://<your-staging-render-service>.onrender.com`

The `/runtime-config` Pages Function converts these into browser-safe runtime values. No secret is exposed.

### What you must see
Every staging page using `unplug-shared.js` should display a fixed:

**UNPLUG STAGING**

ribbon at the top.

If it displays:

**STAGING — API NOT CONFIGURED**

stop testing. The staging frontend is deliberately prevented from falling back to production.

---

## E. CORS finalisation
Once the staging Pages URL exists, copy its exact origin into the staging Render service:

`CORS_ORIGINS=https://unplug-staging.pages.dev`

Then redeploy/restart the staging backend if required.

Do not use `*` for CORS.

---

## F. First staging login
1. Open the staging Admin Dashboard.
2. Confirm **UNPLUG STAGING** is visible.
3. Sign in with the staging `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
4. Open Advanced/System → health/status areas.
5. Confirm Universal Search loads without CORS errors.
6. Confirm production members/payments are **not** present.

If real production data appears, stop immediately: the staging DB/API connection is wrong.

---

## G. Run smoke tests
Use `STAGING-SMOKE-TEST-MATRIX.md` in order. Do not skip straight to checkout.

The minimum release gate is:
- Auth works
- Approval workflow works
- Content trash/restore works
- Page draft/preview/publish works
- Staff permissions block unauthorized areas
- Media Library works
- Reports export
- Banner analytics record
- EFT payment confirmation applies fulfilment
- Checkout Health has no unexplained failures

---

## H. Production gate
Production remains untouched until all critical smoke tests are PASS and a production backup has been verified.

When that happens, create a pull request from `staging-control-centre` to the production branch, review the exact diff, and follow `PRODUCTION-ROLLBACK-PLAN.md` during rollout.

## CSP / security headers (Phase 13)

Cloudflare Pages now sets CSP dynamically in `functions/_middleware.js`. Do **not** add another CSP in `_headers` or HTML meta tags.

Set `UNPLUG_API` to the exact staging Render API origin. If you use a custom R2/media host, optionally set `UNPLUG_MEDIA_ORIGINS` to a comma-separated list of HTTPS origins.

Before deployment run:

```bash
npm run security:check
```

A staging deployment with a missing or production `UNPLUG_API` fails closed and does not receive production API permission in CSP.
