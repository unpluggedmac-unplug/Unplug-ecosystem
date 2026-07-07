# Unplug Backend — Phase 3, Steps 1–14

Step 1 (Users, Auth & Roles) is the foundation. Steps 2–14 all build directly
on it — same `requireAuth` / `requireRole` / `requireOwnerOrAdmin`
middleware throughout, no changes needed to earlier steps' code.

## What's included

**Step 1 — Users, Auth & Roles**
- `db/migrations/001_users.sql` — the `users` table.
- `src/db.js` — shared PostgreSQL connection pool.
- `src/middleware/auth.js` — JWT verification, `requireAuth`, `requireRole`,
  and `requireOwnerOrAdmin`.
- `src/routes/auth.js` — `POST /auth/register`, `POST /auth/login`,
  `POST /auth/logout`, `GET /auth/me`.

**Step 2 — Profiles + Directory**
- `db/migrations/002_profiles.sql` — `profiles`, `profile_upgrades`,
  `social_links` (polymorphic — also used by Investors later),
  `gallery_images` (polymorphic), and the 27 Directory `categories`, seeded.
- `src/routes/profiles.js`:
  - `GET /directory?category=&package=` — public, approved profiles only.
  - `GET /profiles/:slug` — public, full profile + socials + approved gallery.
  - `POST /profiles` — member creates their own profile (status: pending).
  - `PATCH /profiles/:id` — owner or admin edits.
  - `POST /profiles/:id/upgrade` — owner requests a higher tier; flat R250
    fee, downgrades rejected, per the locked Master Blueprint. Creates a
    `profile_upgrades` record; the tier itself changes once payment is
    confirmed (Step 3).
- `src/routes/gallery.js` — `GET /gallery` (public, approved only),
  `POST /gallery` (member submits, status: pending).
- `src/routes/admin.js` — extended with:
  - `GET /admin/profiles/pending`, `PATCH /admin/profiles/:id/approve|reject`
  - `GET /admin/gallery/pending`, `PATCH /admin/gallery/:id/approve|reject`

**Step 3 — Payments**
- `db/migrations/003_payments.sql` — the `payments` table, plus an update to
  `profiles.status` adding `awaiting_payment` as the very first state (before
  `pending`), so a profile only enters the Admin Approval Queue once its
  package has actually been paid for.
- `src/routes/payments.js`:
  - `POST /payments/initiate` — member starts a payment for something they
    already created (a profile package or an upgrade). The server looks up
    the correct price itself (`PACKAGE_PRICES` / the upgrade's flat R250) —
    it never trusts an amount sent by the client. Returns bank details for
    EFT, or a checkout redirect URL for PayFast/Ozow.
  - `POST /payments/payfast/webhook`, `POST /payments/ozow/webhook` — the
    server-to-server callbacks that confirm a payment. **Both are stubbed
    with a clear `TODO`**: real signature/hash verification per each
    gateway's docs must be added before going live — this scaffold trusts
    the payload shape but not yet its authenticity.
  - `PATCH /payments/:id/confirm-eft` — admin-only, since EFT has no
    automatic callback; confirms after checking the bank statement.
  - `GET /payments/pending-eft` — admin-only, the EFT tab of the Approval Queue.
  - Once any method confirms, `applyPaymentEffect()` moves the linked
    profile from `awaiting_payment` to `pending`, or completes a tier
    upgrade — the exact same effect regardless of which of the three
    payment methods was used.

**Step 4 — Articles, Events, Birthdays**
- `db/migrations/004_content.sql` — `articles`, `events`, and `birthdays` tables.
- `src/routes/articles.js`:
  - `GET /articles?category=`, `GET /articles/:id` — public, published only.
  - `POST /articles` — member submits, including the `kickerSuppliedBy`
    byline confirmed earlier for Latest News (status: pending).
  - `PATCH /articles/:id` — owner or admin edits.
- `src/routes/events.js`:
  - `GET /events/upcoming` — public, approved + from today onward; this is
    exactly what the homepage's "Upcoming Events" section calls.
  - `POST /events` — member submits (status: pending).
- `src/routes/birthdays.js`:
  - `GET /birthdays/today` — public, powers the homepage's "Celebrating
    Today" strip.
  - `GET /birthdays/month?month=7` — public, powers "View The Full Month".
  - `POST /birthdays`, `DELETE /birthdays/:id` — **admin-only**. Per the
    locked Blueprint, birthdays are a once-off admin entry, not something
    members submit themselves — there's deliberately no public POST route
    for this one.
- `src/routes/admin.js` — extended with pending-queue and approve/reject
  endpoints for both Articles and Events, following the identical shape
  already used for Profiles and Gallery.

**Step 5 — Competitions, Top 10, Voting**
- `db/migrations/005_competitions.sql` — `competitions`, `competition_entries`,
  `votes`, and `top10_rankings`.
- `src/routes/competitions.js`:
  - `GET /competitions`, `GET /competitions/:slug` — public. The slug view
    includes every approved entry with its live vote count, ready to render
    as a leaderboard directly.
  - `POST /competitions` — admin creates a competition (e.g. The Arena).
  - `POST /competitions/:id/entries` — member enters their own Directory
    profile; starts as `awaiting_payment`, same pattern as Profile packages.
  - `POST /entries/:id/vote` — one free vote per logged-in user OR per
    guest browser session, enforced by two partial unique indexes in the
    migration (not just application logic) so double-voting isn't possible
    even if the API is called directly.
  - `GET /top10` — public, current period only (no historical archive, per
    the locked Blueprint).
  - `POST /top10/publish` — admin replaces the entire Top 10 in one
    transaction (delete + reinsert), matching "current period only."
- `src/routes/payments.js` — extended to resolve pricing and apply the
  payment effect for `competition_entry` (moves an entry from
  `awaiting_payment` to `pending`), using the exact same pattern as
  Profile packages and upgrades.
- `src/routes/admin.js` — extended with `GET /admin/entries/pending` and
  approve/reject for competition entries.

**Left deliberately unbuilt — Bundle Vote pricing**
The homepage mockup's "Bundle Vote" button (paid extra votes) isn't wired
to payments yet, because a price per extra vote was never confirmed during
planning — same category of open item as the PayFast/Ozow fee check. The
`votes` table already has `bundle_size` and `payment_id` columns ready for
it; see the `TODO` note in `competitions.js` and `005_competitions.sql` for
exactly what to add once that price is set.

**Step 6 — Investors, Marketplace, Highlights**
- `db/migrations/006_investors_marketplace.sql` — `investors`, `advertisers`,
  `marketplace_listings`, and `highlights`.
- `src/routes/investors.js`:
  - `GET /investors`, `GET /investors/:id` — public. The detail view
    returns About, contact details, social channels, and the approved
    collaboration gallery in one response — the four pieces confirmed for
    the Investors page. Reuses the same polymorphic `social_links` and
    `gallery_images` tables from Step 2 (`owner_type = 'investor'`).
  - `POST /investors` — self-submission (status: pending); `PATCH /investors/:id`
    — owner or admin edits; `POST /investors/:id/social-links` — add/update
    a social channel.
- `src/routes/marketplace.js`:
  - `GET /marketplace/listings` — public, approved AND currently within
    its paid active window — this is what both the Marketplace page and
    the homepage poster slideshow pull from.
  - `POST /marketplace/listings` — advertiser submits a poster + duration;
    creates their advertiser record on first use. Starts `awaiting_payment`.
- `src/routes/highlights.js`:
  - `GET /highlights/active` — public, powers the "Highlighted" badge on
    boosted articles/directory listings.
  - `POST /highlights` — member requests a highlight on their **own**
    article or Directory profile (ownership checked server-side); starts
    `awaiting_payment`.
- `src/routes/payments.js` — extended with the exact Highlights &
  Promotions pricing locked in the Blueprint (Individual Articles R150–R450,
  Directory Listings R100–R250, both flat across package tiers) and Business
  Banner pricing (R300–R1,000) applied to Marketplace listings. Confirming
  payment on a highlight automatically sets its `start_date`/`end_date` to
  today + the paid duration.
- `src/routes/admin.js` — extended with pending-queue and approve/reject
  endpoints for Investors, Marketplace listings, and Highlights — the
  final three tabs of the Approval Queue from the Admin Dashboard mockup.

With this step, every `payments.linked_type` from the original Backend Spec
is now implemented: `profile_package`, `profile_upgrade`, `competition_entry`,
`highlight`, and `marketplace_listing`.

**Step 8 — Sales Consultants & Referral Tracking**
- `db/migrations/007_sales_consultants.sql`:
  - `sales_consultants` — name, email, commission percentage, active flag.
  - `payments.referral_source` — one of `google`, `facebook`, `instagram`,
    `linkedin`, `tiktok`, `sales_consultant`, `other`. Collected at checkout.
  - `payments.sales_consultant_id` — set only when `referral_source` is
    `sales_consultant`.
  - `admin_notifications` — a simple feed; a confirmed payment linked to a
    consultant automatically creates one, so commission-relevant activity
    surfaces without digging through the payments table.
- `src/routes/salesConsultants.js` — `GET /sales-consultants` — public,
  active consultants only (id + name), for the checkout dropdown. Email and
  commission rate are admin-only information.
- `src/routes/payments.js`, extended:
  - `POST /payments/initiate` now accepts `referralSource` and (when it's
    `sales_consultant`) a required `salesConsultantId`, validated against
    the active consultants list.
  - When such a payment is confirmed — via either gateway webhook or manual
    EFT confirmation — `notifySalesConsultantPayment()` fires automatically
    and writes a row into `admin_notifications`.
- `src/routes/admin.js`, extended with the full consultant management set:
  - `GET /admin/sales-consultants`, `POST /admin/sales-consultants`,
    `PATCH /admin/sales-consultants/:id` (edit details or toggle active).
  - `GET /admin/sales-consultants/:id/payments` — every confirmed payment
    attributed to that consultant, with total sales and commission owed
    computed on the fly (amount × current commission %) — so changing a
    consultant's rate later doesn't require rewriting historical payments.
  - `GET /admin/notifications`, `PATCH /admin/notifications/:id/read`.
- **`unplug-admin-dashboard.html` updated** with two new sections: **Sales
  Consultants** (add a consultant, toggle active/inactive, click a name to
  see their live commission report) and **Notifications** (with an unread
  count badge in the sidebar, checked immediately after login).

**Note for whoever builds the member-facing checkout UI**: the "How did you
hear about us?" question needs to appear at the point of payment and pass
`referralSource` (and `salesConsultantId` when applicable, populated from
`GET /sales-consultants`) into the existing `POST /payments/initiate` call —
no backend changes are needed for that, the fields are already accepted.

**Step 9 — File Uploads**
- `src/middleware/upload.js` — Multer configured for local disk storage
  (`/uploads` folder), random filenames (not the uploader's original
  filename, to avoid path-traversal tricks and collisions), restricted to
  JPEG/PNG/WEBP/GIF, capped at 8MB.
- `src/routes/uploads.js` — `POST /uploads` (any authenticated user),
  multipart field name `file`. Returns `{ url, filename, sizeBytes }` —
  the `url` is exactly what you pass as `imageUrl` / `posterImageUrl` /
  `photoUrl` to every other endpoint that needs one (Gallery, Marketplace
  listings, Birthdays, etc).
- `app.js` also serves the uploaded files back out via
  `express.static` at that same `/uploads` path.
- **This is genuinely tested end-to-end** (not just syntax-checked, unlike
  the DB-dependent routes in this sandbox): a real PNG was uploaded with a
  valid JWT, retrieved back successfully (`200`), and a non-image file was
  correctly rejected.
- **Swapping to S3 later**: only `upload.js` needs to change (swap
  Multer's `diskStorage` for `multer-s3`) — every route that accepts an
  `imageUrl` string doesn't care where the file actually lives, so nothing
  else in the codebase needs to change.

**Both steps**
- `db/migrate.js` — runs every file in `db/migrations/` in order, then
  seeds one admin account from environment variables.
- `src/app.js` — the Express app wiring everything together.

## Setup

1. Install PostgreSQL locally (or use a hosted instance) and create an empty database.
2. Copy the environment file and fill in real values:
   ```
   cp .env.example .env
   ```
   You'll need `DATABASE_URL`, a random `JWT_SECRET`, and (for the migration
   step below) `ADMIN_EMAIL` + `ADMIN_PASSWORD` — add those two to `.env` as well.
3. Install dependencies:
   ```
   npm install
   ```
4. Apply all migrations and seed the admin account:
   ```
   npm run migrate
   ```
5. Start the API:
   ```
   npm run dev
   ```
   The server runs on the port set in `.env` (default `4000`).

## Trying it out

```
# Register a member account
curl -X POST http://localhost:4000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"naledi@example.com","password":"a-real-password"}'

# Log in — save the returned token
curl -X POST http://localhost:4000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"naledi@example.com","password":"a-real-password"}'

# Create a profile (Pro tier) — enters as 'awaiting_payment'
curl -X POST http://localhost:4000/profiles \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"displayName":"Naledi Mokoena","packageTier":"pro","bio":"Youth mentorship in Soweto."}'

# Pay for it via EFT (server works out the R280 price itself)
curl -X POST http://localhost:4000/payments/initiate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"linkedType":"profile_package","linkedId":1,"method":"eft"}'
# → returns bank details + a reference like UNPLUG-A1B2C3D4

# Admin confirms the EFT after checking the bank statement
curl -X PATCH http://localhost:4000/payments/1/confirm-eft \
  -H "Authorization: Bearer <admin token>"
# → profile automatically moves from awaiting_payment to pending

# Now it shows up in the Admin approval queue
curl -X GET http://localhost:4000/admin/profiles/pending \
  -H "Authorization: Bearer <admin token>"

curl -X PATCH http://localhost:4000/admin/profiles/1/approve \
  -H "Authorization: Bearer <admin token>"

# Now it's publicly visible
curl http://localhost:4000/directory
curl http://localhost:4000/profiles/naledi-mokoena

# Request an upgrade to Premium, then pay the flat R250 fee the same way
curl -X POST http://localhost:4000/profiles/1/upgrade \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"toTier":"premium"}'

curl -X POST http://localhost:4000/payments/initiate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"linkedType":"profile_upgrade","linkedId":1,"method":"payfast"}'
# → returns a stub PayFast redirect URL; in production, PayFast's own
#   webhook confirms payment and the tier updates automatically.

# Submit an article with a supplied-by kicker
curl -X POST http://localhost:4000/articles \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"title":"New after-school program launch","body":"...","kickerSuppliedBy":"Naledi Mokoena"}'

# Admin approves it — published_at is set automatically
curl -X PATCH http://localhost:4000/admin/articles/1/approve \
  -H "Authorization: Bearer <admin token>"

# Submit and approve an event the same way
curl -X POST http://localhost:4000/events \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"name":"Youth Impact Summit","eventDate":"2026-08-02","venue":"Johannesburg"}'

curl -X PATCH http://localhost:4000/admin/events/1/approve \
  -H "Authorization: Bearer <admin token>"

curl http://localhost:4000/events/upcoming

# Admin schedules a once-off birthday — no member-facing route for this one
curl -X POST http://localhost:4000/birthdays \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin token>" \
  -d '{"name":"Naledi Mokoena","birthMonth":7,"birthDay":4}'

curl http://localhost:4000/birthdays/today
```

## Trying out Competitions & Voting

```
# Admin creates a competition
curl -X POST http://localhost:4000/competitions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin token>" \
  -d '{"name":"The Arena — 2026","slug":"the-arena-2026","opensAt":"2026-07-01T00:00:00Z","closesAt":"2026-09-30T23:59:59Z"}'

# Member enters (requires an existing Directory profile) — starts awaiting_payment
curl -X POST http://localhost:4000/competitions/1/entries \
  -H "Authorization: Bearer <token>"

# Pay the R50 entry fee via EFT (or payfast/ozow)
curl -X POST http://localhost:4000/payments/initiate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"linkedType":"competition_entry","linkedId":1,"method":"eft"}'

# Admin confirms payment, then approves the entry
curl -X PATCH http://localhost:4000/payments/1/confirm-eft -H "Authorization: Bearer <admin token>"
curl -X PATCH http://localhost:4000/admin/entries/1/approve -H "Authorization: Bearer <admin token>"

# Anyone can now vote (guest needs a stable sessionId; members just need their token)
curl -X POST http://localhost:4000/entries/1/vote \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"guest-abc-123"}'

# See the live leaderboard
curl http://localhost:4000/competitions/the-arena-2026

# Admin publishes the Top 10 (wipes and replaces — current period only)
curl -X POST http://localhost:4000/top10/publish \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin token>" \
  -d '{"periodLabel":"Q3 2026","rankings":[{"profileId":1,"rank":1,"causeText":"Youth mentorship, Soweto"}]}'

curl http://localhost:4000/top10
```

## Trying out Investors, Marketplace & Highlights

```
# Submit an investor profile
curl -X POST http://localhost:4000/investors \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"name":"David Khumalo","about":"Technology & Media Investor.","contactEmail":"d.khumalo@example.com"}'

curl -X PATCH http://localhost:4000/admin/investors/1/approve -H "Authorization: Bearer <admin token>"

# Add a social channel and check the full public profile
curl -X POST http://localhost:4000/investors/1/social-links \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"platform":"li","url":"https://www.linkedin.com/in/davidkhumalo"}'

curl http://localhost:4000/investors/1

# Advertiser submits a poster (28 days = R1,000, resolved server-side)
curl -X POST http://localhost:4000/marketplace/listings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"businessName":"Cape Coffee Co.","posterImageUrl":"https://example.com/poster.jpg","headline":"Fuel your morning","durationDays":28}'

curl -X POST http://localhost:4000/payments/initiate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"linkedType":"marketplace_listing","linkedId":1,"method":"eft"}'

curl -X PATCH http://localhost:4000/payments/1/confirm-eft -H "Authorization: Bearer <admin token>"
curl -X PATCH http://localhost:4000/admin/marketplace/1/approve -H "Authorization: Bearer <admin token>"

curl http://localhost:4000/marketplace/listings

# Highlight your own article for 14 days (R250, resolved server-side)
curl -X POST http://localhost:4000/highlights \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"targetType":"article","targetId":1,"durationDays":14}'

curl -X POST http://localhost:4000/payments/initiate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"linkedType":"highlight","linkedId":1,"method":"eft"}'

curl -X PATCH http://localhost:4000/payments/2/confirm-eft -H "Authorization: Bearer <admin token>"
curl -X PATCH http://localhost:4000/admin/highlights/1/approve -H "Authorization: Bearer <admin token>"

curl http://localhost:4000/highlights/active
```

## Trying out Sales Consultants & Referral Tracking

```
# Admin adds a consultant
curl -X POST http://localhost:4000/admin/sales-consultants \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin token>" \
  -d '{"name":"Thabo Nkosi","email":"thabo@unplugnews.com","commissionPct":10}'

# Anyone can see the active list (for the checkout dropdown)
curl http://localhost:4000/sales-consultants

# Member pays for a package, attributing it to that consultant
curl -X POST http://localhost:4000/payments/initiate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"linkedType":"profile_package","linkedId":1,"method":"eft","referralSource":"sales_consultant","salesConsultantId":1}'

# Admin confirms the EFT — this both moves the profile forward AND creates
# an admin_notifications row automatically
curl -X PATCH http://localhost:4000/payments/1/confirm-eft -H "Authorization: Bearer <admin token>"

# See the notification
curl http://localhost:4000/admin/notifications -H "Authorization: Bearer <admin token>"

# See the consultant's commission report
curl http://localhost:4000/admin/sales-consultants/1/payments -H "Authorization: Bearer <admin token>"
```

## Trying out File Uploads

```
# Upload an image (any authenticated user)
curl -X POST http://localhost:4000/uploads \
  -H "Authorization: Bearer <token>" \
  -F "file=@/path/to/photo.jpg"
# → { "url": "http://localhost:4000/uploads/<random-name>.jpg", ... }

# Use that url anywhere an imageUrl/posterImageUrl/photoUrl is expected
curl -X POST http://localhost:4000/gallery \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"imageUrl":"http://localhost:4000/uploads/<random-name>.jpg","caption":"Award ceremony"}'
```

## Trying out Bundle Vote & Settings

```
# Admin checks/sets the price per extra vote (placeholder default is R10)
curl http://localhost:4000/admin/settings -H "Authorization: Bearer <admin token>"

curl -X PATCH http://localhost:4000/admin/settings/bundle_vote_price \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin token>" \
  -d '{"value":"15.00"}'

# Guest buys 5 extra votes for an entry (uses whatever price is currently set)
curl -X POST http://localhost:4000/entries/1/vote-bundle \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"guest-abc-123","voteCount":5}'

# Pay for it, then confirm — the votes are inserted automatically on confirmation
curl -X POST http://localhost:4000/payments/initiate \
  -H "Content-Type: application/json" \
  -d '{"linkedType":"vote_bundle","linkedId":1,"method":"eft"}'

curl -X PATCH http://localhost:4000/payments/1/confirm-eft -H "Authorization: Bearer <admin token>"

# Leaderboard now reflects the bundle
curl http://localhost:4000/competitions/the-arena-2026
```

**Step 13 — Rate Limiting**
- `src/middleware/rateLimit.js` — three limiters, keyed by IP:
  - Login: 10 attempts per 15 minutes (prevents brute-forcing a password).
  - Registration: 5 accounts per hour (prevents signup spam).
  - Email actions (verify-email, resend-verification, forgot-password):
    5 per 15 minutes (prevents brute-forcing the 6-digit verification code
    and prevents email-bombing someone's inbox with repeated codes/resets).
- **Tested live**: 11 rapid login attempts against a running server
  returned `500` (expected — no database in this sandbox) for the first
  10, then a real `429 Too Many Requests` on the 11th, confirming the
  limiter fires exactly at the configured threshold.

**Step 14 — New Pricing Model & Bulk Email**

Pricing changes (all in `db/migrations/010_new_pricing_model.sql` and
`src/routes/payments.js` unless noted):

- **Articles**: now cost **R95** to publish. `POST /articles` creates it
  as `awaiting_payment`; pay via `linkedType: "article_publish"` before it
  enters the admin queue.
- **Directory packages**: unchanged — Basic R150 / Pro R280 / Premium R400,
  flat R250 upgrade fee.
- **Marketplace**: now a **flat R500 for a fixed 30-day run** (replaces the
  old 7/14/21/28-day tiered Business Banner pricing). `POST
  /marketplace/listings` accepts an optional `requestedStartDate` — the
  30-day window starts there once payment confirms, or today if omitted.
- **Events**: now cost **R300 (once-off)** to list on the calendar. Same
  `awaiting_payment` gate as articles. Also added an optional
  `displayStartDate` field for calendar promotion ahead of the event date.
- **Highlights** (optional, homepage boost): unchanged — Articles
  R150–R450, Directory R100–R250, across 7/14/21/28 days.
- **Competitions**: each competition now sets **its own** entry fee at
  creation (`POST /competitions` takes an `entryFee`) instead of one
  global constant — The Arena is R250; a different competition could be
  priced differently.
- **Gallery**: now **R100 per bundle of up to 3 images**, not free/per-image.
  `POST /gallery` takes an `images` array (1-3 items) and creates one
  `gallery_bundles` row plus one `gallery_images` row per photo.
- **Top 10 entry**: new — **R100** for a member to submit their own profile
  for Top 10 consideration (`POST /top10/enter`), separate from the
  admin-curated rankings themselves (`POST /top10/publish`).
- **Bundle Vote**: replaced the single admin-configurable price-per-vote
  with **fixed tiers**: 10 votes/R10, 50/R20, 70/R50, 150/R100, 200/R150,
  300/R200 (`vote_bundle_tiers` table, `GET /vote-bundle-tiers` to list
  them, `POST /entries/:id/vote-bundle` takes a `votes` count matching one
  of the tiers exactly).
- **Sales Consultants**: default commission raised from 10% to **50%** for
  newly-added consultants (existing ones keep whatever rate they already had).

**Bulk Email**
- `db/migrations/010...` — `bulk_email_campaigns` table logs every
  campaign sent (segment, subject, body, recipient count, who sent it).
- `src/routes/bulkEmail.js`:
  - `GET /admin/bulk-email/preview?segment=individuals|businesses|all` —
    check recipient count before committing to a send.
  - `POST /admin/bulk-email` — sends **individually** (not one big BCC), so
    recipients never see each other's addresses. Segments: **individuals**
    (Directory profiles with `type='individual'`), **businesses** (Directory
    profiles with `type='business'`, plus anyone with an Advertiser record),
    or **all**.
  - `GET /admin/bulk-email/history` — past campaigns.
  - **Scaling note, flagged directly in the code**: sending happens
    synchronously in the request. Fine for a few hundred recipients; a
    genuinely large list should move to a background job queue instead, to
    avoid the request timing out.

## What's next

Steps 1–10 cover the full backend build order, commission tracking, file
uploads, and Bundle Vote. Only one genuinely open item remains:

1. Replace the two `TODO` stubs in `payments.js` with real PayFast ITN and
   Ozow **signature verification using live merchant credentials** —
   I implemented the actual verification logic per each gateway's
   documented algorithm (see Step 11 below), but it can't be tested for
   real without an actual PayFast/Ozow merchant account, since the
   signature check depends on a merchant-specific passphrase/key.

**Step 10 — Platform Settings & Bundle Vote**
- `db/migrations/008_settings_bundle_vote.sql`:
  - `settings` — a generic key/value table for admin-configurable values
    that don't need their own dedicated table. Seeded with
    `bundle_vote_price = 10.00` as a **placeholder default**, not a
    business decision — change it via the admin endpoint below whenever
    a real price is decided.
  - `payments.linked_type` now also accepts `vote_bundle`.
  - `vote_bundles` — a pending bundle purchase (how many extra votes, for
    which entry, at what total price), same `awaiting_payment` → paid
    pattern as everything else.
- `src/routes/admin.js` — `GET /admin/settings`, `PATCH /admin/settings/:key`
  (generic, so future settings don't each need a bespoke endpoint).
- `src/routes/competitions.js` — `POST /entries/:id/vote-bundle` — buys
  extra votes at whatever `bundle_vote_price` is currently set to.
- `src/routes/payments.js` — extended so a confirmed `vote_bundle` payment
  **upserts** into `votes` rather than plain-inserting: if the voter already
  cast their one free vote for that entry, the unique index from Step 5
  would otherwise reject a duplicate row, so the bundle purchase instead
  *adds* to that existing row's `bundle_size`. Handles both logged-in
  voters and guest sessions.

**Step 11 — Real Payment Signature Verification**
- `src/routes/payments.js` — the PayFast and Ozow webhook handlers now run
  each gateway's actual documented verification algorithm:
  - **PayFast**: rebuilds the parameter string from the ITN payload
    (URL-encoded, in the order received, passphrase appended if
    configured) and compares an MD5 hash against the `signature` field
    PayFast sends, per their published ITN validation steps.
  - **Ozow**: rebuilds the same concatenated-fields string Ozow uses to
    generate their `HashCheck`, hashes it with SHA512, and compares.
  - Both read merchant credentials from `.env`
    (`PAYFAST_PASSPHRASE`, `OZOW_PRIVATE_KEY`) — **left unset by default**,
    in which case verification is skipped with a loud console warning
    rather than silently trusting unverified payloads. This is safe for
    local development but **must** have real credentials configured
    before accepting real payments.
  - I cannot test either against a live gateway without a real merchant
    account, so treat this as "correct per the documented spec, not yet
    proven against production traffic" — verify with a PayFast/Ozow
    sandbox account before going live.
