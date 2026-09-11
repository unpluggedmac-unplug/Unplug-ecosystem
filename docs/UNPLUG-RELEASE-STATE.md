# UNPLUG RELEASE STATE — AUTHORITATIVE MEMORY

Last updated: 2026-09-12

This file is the operational source of truth for active Unplug release/recovery work.
Do not reconstruct release state from memory when this file is available. Update it as gates change.

## Mandatory operating contract

Use these skills together, not independently:

- release-orchestrator
- CI/CD failure resolver
- merge-conflict resolver
- production-build validator
- git synchronisation guard
- staging validation / staging-gatekeeper
- Render deployment operator
- production deployment & verification
- rollback & recovery
- migration-safety
- environment-config auditor
- production-safety
- autonomous completion loop
- release-state memory
- no-premature-completion
- production-route-feature-inventory
- release-gatekeeper
- build-configuration-drift-guard

`build-configuration-drift-guard` is enforced by
`deploy/build-config.contract.json`, `scripts/verify-build-configuration.js`
and `.github/workflows/build-configuration-gate.yml`. It must block release
when the Cloudflare project root, build command, output directory, ordered
packaging pipeline or required production artifacts drift from the contract.

Core rule:

> DEPLOYED != WORKING. CI GREEN != PRODUCTION HEALTHY. RENDER LIVE != VERIFIED LIVE.

A task is complete only after the actual public application is verified.

## Current production release

Repository: `unpluggedmac-unplug/Unplug-ecosystem`

Production branch: `main`

Current production merge SHA: `55f8a50d1b045d818efa36e6f6bca31d7105fa41`

Previous known production SHA: `4181e846994af219d261ae012ed628ea3cbc8273`

Production Render service: `Unplug-ecosystem` / `srv-d9cqt62hil2s73amk07g`

Staging Render service: `Unplug-ecosystem-staging` / `srv-daembcmq1p3s739v6sog`

Cloudflare Pages project: `unplug-magazine`

Public production URL: `https://www.unplugnews.com`

Staging alias: `https://staging-control-centre.unplug-magazine.pages.dev`

## Active workstreams

### 1. Growth Application

State: DEPLOYED but final release certification is BLOCKED by wider live-site incident.

Implemented and migrated:

- migrations 195 and 196
- individual + business Deep Discovery
- Quick Profile + Growth Assessment
- autosave/resume
- member ownership
- Growth-specific R2 image uploader
- admin review workspace
- statuses/tasks/messages/notes
- PDFs/previews
- short links/placements
- member/admin Growth pages

Exact Deep Discovery source is preserved in:
`docs/proposals/growth-application-deep-discovery.md`

Growth release passed feature CI, independent staging CI, Render staging, Cloudflare staging smoke, merge and production backend/frontend deployment.

Do NOT mark Growth fully complete while the public frontend incident remains unresolved.

### 2. Live-site functionality — ACTIVE PRODUCTION INCIDENT

User-observed failures:

- live site does not behave as intended
- data appears broken
- buttons do not work
- functions do not work
- expected visit/sign-up/login popup does not appear
- menu bar cannot be accessed

Current release state: DEGRADED / BLOCKED

#### Proven frontend artifact mismatch

The production build (`npm run build`) generates a clean `dist/` artifact with executable inline scripts externalised.

Diagnostic result on 2026-09-11/12 before the Cloudflare configuration correction:

- built `dist/` executable inline scripts: **0**
- actual live production homepage executable inline scripts: **2**
  - ~398,700 bytes
  - ~3,908 bytes

The enforced Cloudflare CSP blocks inline `<script>` elements.

Therefore the live homepage had been serving the raw/unbuilt source artifact rather than the intended built `dist` homepage. This can directly break menus, popups, buttons and page initialisation while the HTML itself still returns HTTP 200.

Cloudflare Production configuration was corrected on 2026-09-12 to:

- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: blank

Production `main` commit `55f8a50` was redeployed successfully after that configuration change.

**Verification of the newly rebuilt public artifact is now mandatory and in progress.** Do not assume the incident is fixed merely because Cloudflare reports Success.

Do NOT weaken CSP to make raw source execute. Fix the artifact/output configuration instead.

#### CSP evidence

Production `csp_reports` has recent homepage `script-src-elem` / `inline` violations from the period when raw source was served.

CSP reporting is evidence, but historical report rows must not be confused with the current enforced policy. Always correlate `last_seen_at` with the release being investigated.

### 3. Supabase -> Cloudflare — PART OF THE PRODUCTION INCIDENT

Reason for migration:

The owner is on a limited/free Supabase account and has experienced data/usage/storage limits. This is not an optional future optimisation; remaining Supabase dependencies can cause production failures and must be removed safely.

Current known architecture:

- application authentication is custom JWT/bcrypt, not Supabase Auth
- active upload code writes to Cloudflare R2
- live backend still uses PostgreSQL through generic `pg` / `DATABASE_URL`
- legacy Supabase Storage references remain in production data
- old Supabase Storage project contains historical upload objects
- legacy Supabase Edge Functions exist but current public frontend audit found no direct runtime calls

Known historical storage baseline from the migration audit:

- legacy public `uploads` bucket: 246 objects, ~270.7 MB
- old private edition bucket: 0 objects
- production database still contains legacy Supabase Storage URL references

Migration safety rules:

- preserve IDs and relationships
- copy before rewrite
- rewrite a database reference only after its target object is confirmed in R2
- migration must be restartable/idempotent
- keep Supabase as rollback source until verification completes
- do not delete source objects merely to free quota before target integrity is proven
- production R2 must fail closed; never silently fall back to local disk

Database migration:

Do NOT blindly convert the existing PostgreSQL application to D1.
The application uses PostgreSQL-specific schema/features and plain `pg` with `DATABASE_URL`.
A PostgreSQL-compatible replacement is the lower-risk path if/when the database itself is moved away from Supabase.

## Release-gatekeeper state

Current overall state: **DEGRADED / BLOCKED — public artifact verification in progress**

Do not issue VERIFIED LIVE while any of the following remain unresolved:

- newly rebuilt production homepage has not yet been proven to serve `dist`
- menu/buttons/popups are not proven functional in the actual public browser
- remaining production data/media failures are not reconciled against legacy Supabase dependencies and quota limitations
- authenticated critical workflows remain unverified after the frontend artifact fix

## Current hotfix branch

`hotfix/frontend-runtime-csp-20260912`

Created from production SHA:
`55f8a50d1b045d818efa36e6f6bca31d7105fa41`

Diagnostic workflow:
`.github/workflows/frontend-runtime-diagnostic.yml`

## Immediate execution order

1. Verify the newly rebuilt public Production artifact actually serves `dist` with 0 executable inline scripts.
2. Re-run public interaction/runtime smoke: menu, buttons, popups, data sections, login/signup CTA, member/admin shells.
3. Check production logs and new CSP report timestamps after verification.
4. Reconcile broken data/media against remaining Supabase URLs and quota-limited legacy services.
5. Migrate historical Supabase Storage objects/references to R2 in verified batches.
6. Verify authenticated workflows, R2 upload, EFT/payment-proof upload and Growth journey.
7. Re-run production route/feature inventory.
8. Only release-gatekeeper may issue `VERIFIED LIVE`.

## Completion rule

Never report DONE, LIVE, FIXED or PRODUCTION READY based only on CI/build/deployment state.
The actual functioning public website is the source of truth.
