# Unplug — operations notes

Practical notes for keeping the site up and the data safe. Written for whoever
is on the hook at the time, not just whoever built it.

## Where everything runs

| Piece | Where | Notes |
| --- | --- | --- |
| Website (frontend) | Cloudflare Pages — `unplug-magazine.pages.dev` | Auto-deploys from `main` on GitHub |
| API (backend) | Render — `unplug-ecosystem.onrender.com` | Auto-deploys from `main`; runs migrations on every boot |
| Database + file storage | Supabase (PostgreSQL + Storage) | Connected via the **Session Pooler** string, not the direct host |

Deploying is just pushing to `main`. There is no separate build step for the
frontend — the HTML files are served as-is.

## Backups

**Supabase runs automatic daily backups on the free plan, with 7 days of
retention.** That covers "someone deleted the wrong thing yesterday". It does
not cover "we need last month", so before anything irreversible — a big
content import, a schema change, deleting a batch of records — take a manual
snapshot first:

- Supabase dashboard → Database → Backups → download, **or**
- `pg_dump "$DATABASE_URL" > unplug-$(date +%F).sql` from a machine with
  `psql` installed.

Keep at least one copy somewhere that is not Supabase. A backup that lives
only in the system it is meant to protect is not a backup.

**Uploaded images live in the Supabase `uploads` bucket**, not on Render.
This matters: Render's filesystem is wiped on every deploy, so anything
written to local disk would vanish. Storage buckets are not included in the
database backup — export the bucket separately if the images matter.

## Uptime monitoring

Render's free tier **spins the API down after ~15 minutes of inactivity**, and
the next request takes roughly 50 seconds to wake it. That is expected
behaviour, not an outage, and it is the single most likely thing to be
reported as "the site is broken".

To monitor properly, point a free checker (UptimeRobot, Better Stack, or
Cloudflare Health Checks) at:

```
https://unplug-ecosystem.onrender.com/health
```

It returns `{"status":"ok"}` and does not touch the database, so it stays
cheap to poll. A 5-minute interval also has the side effect of keeping the
instance warm during the day, which removes most cold starts for real
visitors.

Worth checking separately, because a green health check does not prove these
work:

- `https://unplug-magazine.pages.dev/` — the site itself
- `https://unplug-ecosystem.onrender.com/articles` — proves the database is
  actually reachable, not just the web process

## Security posture

Already in place:

- **Rate limiting** on login, registration, email actions and every public
  submission form, plus honeypot fields to absorb bot spam.
- **JWT auth** with role checks; member-scoped routes always read the user id
  from the verified token, never from the request body.
- **CORS** locked to the site's origin via `CORS_ORIGINS`.
- **Security headers** on every API response (`nosniff`, `DENY` framing,
  `strict-origin-when-cross-origin`, a restrictive `Permissions-Policy`, and
  HSTS in production).
- **Audit log** of consequential admin actions — moderation decisions, CMS
  edits, poll deletions, and listing-ownership transfers — visible in the
  admin dashboard under Activity Log.
- **Moderation before publication** for comments and reviews.
- **POPIA consent** for analytics: nothing is tracked, and no session id is
  even created, until a visitor actively accepts.

Known gaps, honestly stated:

- **Email is not configured.** No `SMTP_*` variables are set on Render, so
  signup verification codes and password resets are written to the server log
  instead of being sent. New members cannot verify their accounts. This is the
  most important thing to fix before a real launch.
- **Payment webhooks are unverified** until `PAYFAST_PASSPHRASE` /
  `OZOW_PRIVATE_KEY` are set — do not accept live card payments until they are.
- **No automated tests**, so regressions are caught by review and manual
  checking rather than CI.

## Environment variables (Render)

Required: `DATABASE_URL`, `JWT_SECRET`.

Also set: `CORS_ORIGINS`, `ADMIN_PASSWORD`, `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, `SUPABASE_BUCKET`.

Not yet set: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`,
`PAYFAST_PASSPHRASE`, `OZOW_PRIVATE_KEY`, `SITE_URL`.

`SITE_URL` controls the domain used in the generated sitemap — set it when
unplugnews.com goes live so search engines are pointed at the real domain.

**`ADMIN_PASSWORD_RESET` should stay unset.** Setting it to `true` forces the
admin password back to `ADMIN_PASSWORD` on *every* restart, which on a free
instance means every cold start. Use it once to recover a lost password, then
remove it.
