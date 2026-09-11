# Unplug — Supabase to Cloudflare migration

Status: **IN PROGRESS — no Supabase decommissioning permitted yet**

## Objective

Remove Unplug's operational dependency on Supabase without rewriting or losing production data merely to fit a different database engine.

## Verified current state

### Authentication

Unplug authentication is application-owned (bcrypt/JWT in the Node backend), not Supabase Auth. Moving the database provider does not require moving Supabase Auth users.

### Object storage

New Unplug uploads already use Cloudflare R2. The remaining Supabase Storage work is historical data.

Current source baseline (2026-09-12):

- old Supabase Storage project: `fkuzbwysvyskhsskjmmi`
- public `uploads` bucket: **246 objects**
- source bytes: **270,732,016 bytes**
- private `edition-downloads` bucket: **0 objects**
- production database still contains legacy `*.supabase.co/storage/*` references that must reach zero before source storage can be retired.

The existing `scripts/migrate-supabase-to-r2.js` remains the copy engine for database-referenced legacy files. It uploads to R2 first and rewrites the database URL only after a successful R2 write. It never deletes source Supabase objects and is safe to rerun.

Because the source bucket contains more objects than current database references, the final migration must also reconcile **unreferenced/orphan source objects** before decommissioning. "No database references remain" is necessary but is not, by itself, proof that every source object was preserved.

### Database

The production database is PostgreSQL and the application uses the standard `pg` driver with a single `DATABASE_URL`. This makes the runtime provider-neutral **as long as the replacement remains PostgreSQL-compatible**.

Production baseline before database migration:

- 191 public base tables
- 97 public routines
- 13 user triggers
- 557 public indexes
- 262 foreign keys
- 151 public sequences
- PostgreSQL-specific extensions currently installed include `pg_trgm`, `pgcrypto`, `uuid-ossp`, `pg_stat_statements`, `plpgsql`, and Supabase's `supabase_vault`.

The app/migrations must be checked for actual dependency on each extension before the target is accepted.

## Database target decision

### D1 is NOT a drop-in target

Cloudflare D1 uses SQLite semantics. The existing PostgreSQL schema/dump cannot be imported directly and PostgreSQL-specific routines, triggers, sequence behavior and extensions would require a significant application/schema rewrite.

Therefore **do not cut production directly from Supabase PostgreSQL to D1** in this migration.

### Safe target class

Use a PostgreSQL-compatible managed database and keep Unplug's existing `pg`/`DATABASE_URL` contract. Cloudflare Hyperdrive can be used when/if the backend is moved to Cloudflare Workers; it accelerates a PostgreSQL origin but is not itself the database host.

Cloudflare currently supports provisioning PlanetScale Postgres through the Cloudflare dashboard/billing. A PostgreSQL target provisioned that way is the preferred low-rewrite path when the owner wants database procurement consolidated through Cloudflare.

The database target is not approved until it passes target compatibility validation and a full restore rehearsal.

## Required migration order

1. Keep Supabase production database and storage intact as recovery sources.
2. Preserve fresh production backup/snapshot.
3. Provision PostgreSQL-compatible target.
4. Verify target PostgreSQL version and required extensions/features.
5. Restore a production backup to the target in an isolated migration/staging environment.
6. Run all migrations/schema checks and the complete backend test suite against the target.
7. Compare table/schema counts and critical row counts.
8. Migrate/reconcile all legacy Supabase Storage objects to R2.
9. Run `verify-cloudflare-migration.js`; legacy Supabase Storage references must be zero.
10. Point **staging only** at the new PostgreSQL target and run full staging smoke/auth/payment/storage tests.
11. Take a fresh production backup immediately before cutover.
12. Change production `DATABASE_URL` only after staging is green.
13. Deploy and run production route/feature inventory plus release-gatekeeper.
14. Keep Supabase untouched through a rollback observation window.
15. Decommission Supabase only after the replacement is verified and rollback is no longer required.

## Fail-closed rules

- Never delete source Supabase files during copy.
- Never rewrite a database URL before the destination R2 object exists.
- Never replace production PostgreSQL with D1 merely to satisfy a vendor-name requirement.
- Never remove Supabase while legacy storage references remain.
- Never remove Supabase while the database target has not passed a restore rehearsal.
- Never expose database, R2, Supabase or email-provider credentials in logs or committed files.
- Any production cutover that cannot be proven healthy remains **DEPLOYED — UNVERIFIED** or is rolled back.
