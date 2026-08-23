# Operations

How to deploy, what needs setting up by hand, and how to undo each thing.

`src/app.js` has referred to this file for a while without it existing. It does
now.

---

## Deploying the performance work (B1)

Everything in B1 is already safe to deploy as-is. The site behaves exactly as
it does today until the two steps below are taken — that is deliberate, so the
risky parts are separate decisions rather than a single change that either
works or does not.

### Step 1 — deploy the backend (nothing to configure)

Push to `main`. Render runs the migrations and restarts.

What starts happening immediately:

- New image uploads get AVIF and WebP derivatives at four widths.
- Every file stored from now on carries a one-year `Cache-Control` instead of
  Supabase's default `no-cache`.
- The daily database cleanup runs while the instance is awake.

What does NOT change: existing images. They keep being served exactly as they
are until step 3.

### Step 2 — switch Cloudflare Pages to the build (needs you)

**This is the only step that can break the site, so it is worth reading twice.**

Until it is done, Pages serves the repository root and the site is unchanged.
After it, Pages serves `dist/` — the same pages with their CSS and JavaScript
lifted into hashed, cacheable files.

In the Cloudflare dashboard → Workers & Pages → your Pages project → Settings →
Builds & deployments:

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | *(leave empty)* |

Then **Save**, and use *Retry deployment* on the latest deployment to build
with the new settings.

**Check before trusting it.** Open the deploy preview URL Cloudflare gives you,
not the live domain, and confirm:

- the homepage renders with its styling intact,
- clicking a story opens it,
- the admin dashboard loads and its buttons respond.

**To undo:** clear the build command and output directory, save, retry the
deployment. Pages goes back to serving the repository root. Nothing else has to
be reverted, because the source files were never modified.

### Step 3 — optimise the images already in the library (needs you)

With the backend deployed, from a machine with the production `DATABASE_URL`,
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY` and `SUPABASE_BUCKET` set:

```bash
cd unplug-backend
node scripts/optimise-existing-images.js --dry-run
```

That only counts and prints. When the list looks right:

```bash
node scripts/optimise-existing-images.js --limit 25
```

A batch at a time is recommended for the first run: each image takes a few
seconds, and this way you see real numbers before committing to the whole
library. Re-run without `--limit` once you are happy. It is safe to stop with
Ctrl-C and safe to run again — it picks up where it left off.

The script reports what a reader now downloads versus what they downloaded
before, and warns if the stored files come back without a cache header.

**To undo:** `DROP TABLE image_derivatives;`. The frontend only offers a
responsive version for images listed there, so with the table gone every image
returns to being served as the original. The derivative files can be left in
storage; they cost nothing and nothing points at them.

---

## Scheduled work

Render's free tier sleeps when idle and has no cron, so every recurring job in
this codebase runs on an in-process timer AND is exposed as an endpoint an
external scheduler can call. The timer covers the common case; the endpoint is
there when a guarantee is needed.

| Job | Timer | Endpoint | Secret |
|---|---|---|---|
| Birthday greetings | hourly | `POST /birthdays/send-greetings` | `BIRTHDAY_CRON_SECRET` |
| Database cleanup | daily | `POST /maintenance/cleanup` | `UNPLUG_CLEANUP_SECRET` |

Both are idempotent — calling them repeatedly does no extra work — so an uptime
pinger hitting them on a schedule is safe.

```bash
curl -X POST https://unplug-ecosystem.onrender.com/maintenance/cleanup \
  -H "Authorization: Bearer $UNPLUG_CLEANUP_SECRET"
```

To see what the cleanup would remove without removing it, as an admin:
`GET /maintenance/cleanup/preview`. To read the policy in words, including the
list of tables it must never touch: `GET /maintenance/cleanup/rules`.

### What the cleanup will never delete

Votes, payments, orders, edition purchases, articles, profiles, comments, and
the admin activity log. Votes in particular carry the link to what somebody
paid for, so an old vote is a financial record, not clutter. This is enforced
by a test that reads the policy directly, so adding one of these fails the
suite rather than production.

---

## Environment variables added by B1

| Name | Default | What it does |
|---|---|---|
| `UNPLUG_CLEANUP_SECRET` | *(unset)* | Lets an external scheduler run the cleanup. Without it, only an admin can. |
| `UNPLUG_ANALYTICS_RETENTION_DAYS` | `400` | How long raw analytics rows are kept. The longest report on the site looks back 30 days, so this is generous on purpose. |
| `UNPLUG_TOKEN_GRACE_DAYS` | `7` | How long an expired sign-in or reset token is kept after it stops working, so a support question about it can still be answered. |

None are required. Every one has a working default.

---

## Why there is no separate mobile cache

The brief that prompted this work asked for one, and it should not be built.

What makes the site slow on a phone is not the absence of a phone-specific
cache — it is being sent desktop-sized images. A 1,911 KB photograph is 1,911 KB
whether or not it came from a cache labelled "mobile". The fix is to send a
correctly-sized picture, which is what the responsive image work does.

Adding a second cache keyed on the user agent would split every cached page
into two copies, halve the hit rate for both, and still deliver the same
oversized image. It would also make every caching bug twice as hard to
reproduce, because the answer would depend on which bucket you landed in.
