# Unplug Magazine — Punch List
*Last updated: 2026-07-07 (updated same day, phase 2)*

This is the working status doc for the Unplug Ecosystem build (backend + public
site). Read this first before picking work back up — it replaces having to
re-derive context from scratch.

---

## Current setup (so anyone can run this locally)

- **Database:** Supabase project "unplug-production" (Pierre's account), connected
  via the **pooled** connection string (the direct `db.<ref>.supabase.co` host
  fails DNS resolution on most home networks — use the Transaction Pooler string
  from Supabase's "Connect" panel instead).
- **Backend:** `unplug-backend/` — copy `.env.example` to `.env`, fill in
  `DATABASE_URL` (pooled string above) and a random `JWT_SECRET`, then:
  ```
  npm install
  npm run migrate   # applies all 16 migrations + seeds one admin account
  npm run dev        # runs on http://localhost:4000
  ```
- **Public site:** `unplug-magazine.html` (plus `unplug-shared.js` for the
  `UnplugAPI` helper) — serve the folder with any static server and open the
  file. It talks to the backend at `http://localhost:4000` by default.
- **Admin login (seeded):** `admin@unplugnews.com` / password set via
  `ADMIN_PASSWORD` in `.env` at migration time — check with Darius/Pierre for
  the actual value, it isn't stored in this file.
- **CORS:** the backend's `.env` needs whatever origin the static site is served
  from listed in `CORS_ORIGINS`, or requests silently fail.

---

## ✅ Done and verified this session (2026-07-07)

All of the following were wired to the real backend and tested against the
live Supabase database with real inserted/deleted test rows — not just
visual checks:

- **Directory** — full listing, 27-category filter, pagination
- **Directory profile detail** — tier-gated rendering (Basic/Pro/Premium),
  real gallery images for Premium
- **Articles / Latest News** — listing, category filter (had to seed 21 news
  categories that existed in the schema but were never seeded), pagination
- **Gallery** — listing, pagination
- **Top 10 voting** — required a real product decision (see below); wired to
  a genuine live-voting competition, not the admin-curated table
- **Homepage teasers** — Highlighted Articles, Highlighted Directory
  Profiles (both via the real Highlights paid-boost system), New Stories
- **Investors** — listing with real bio/contact/socials/Collaboration Gallery
- **Marketplace** — "Businesses On The Marketplace" grid
- **Editions** — Latest Edition + Past Editions + pagination, "View Online"
  opens the real PDF
- **Account-gating** — every action needing a login (submit a photo/article,
  choose a Directory package, enter Top 10, download an edition) now links
  out to the Member Dashboard rather than this page having its own login

- **Homepage "This Month's Top 10" mini-list** — top 3 from the real
  top-10 competition
- **Competitions page ("The Arena")** — real competition (slug `the-arena`,
  R250 entry fee — the actual value already documented in the codebase's own
  comments, not invented). The "Hall of Impact — Past Winners" section
  showed 3 fully fabricated example winners with zero backing data (no
  historical-winners concept exists in the schema at all) — per Darius's
  decision, replaced with the real live Arena leaderboard instead of
  fabricated content.

### Small backend additions made along the way
- `db/migrations/012_news_categories.sql` — seeded the 21 missing news categories
- `db/migrations/013_top10_competition.sql` — seeded a real "Top 10" competition
- `db/migrations/014_the_arena_competition.sql` — seeded a real "The Arena"
  competition (R250 entry fee, dates are placeholders — real open/close
  schedule is an editorial decision, update once confirmed)
- `GET /competitions/:slug` now also returns `created_at` + category per entry
- `GET /directory` now supports `?ids=1,2,3` (needed for homepage highlights)

---

## ⬜ Not yet wired (still static demo content)

- Investors page's "Latest Project" / Arena blurb — probably fine as static
  editorial copy, worth a second look
- Everything else from the original static reference is now wired.

## ✅ Audit cleanup — done and verified (2026-07-07, phase 3)

- **Bulk email** no longer blocks the request — `POST /admin/bulk-email` now
  creates the campaign row (status `queued`) and responds immediately;
  sending happens in the background in batches of 10 concurrent sends, with
  `sent_count`/`status` updated as it progresses (`GET .../history` shows
  live progress). Migration `015_bulk_email_status.sql`.
- **Gallery bundle creation** now uses a single batch `INSERT` for all
  images instead of one query per image. Verified all rows share an
  identical `created_at` (proof of one query, not N).
- **Request logging** — every request now logs `METHOD /path STATUS Xms` to
  the console (`src/middleware/requestLogger.js`), no new dependency added.
- **Bonus bug found and fixed while testing:** `gallery_images.status` never
  had `'awaiting_payment'` added to its CHECK constraint when the paid
  gallery-bundle flow was built (migration 010) — every real gallery bundle
  submission has been failing since then. Fixed in
  `016_gallery_images_awaiting_payment.sql`.

### Still open (lower priority, not touched)
- Loading skeletons, optimistic UI (e.g. instant vote-button feedback),
  better offline/network-error messaging, shared form validation

## 🔴 Bigger decisions — need Darius + Pierre, not more code

1. **Going live at all.** Everything currently runs locally
   (`localhost:4000` backend, static file preview). Real deployment needs
   hosting picked for the backend (Supabase DB is already real/hosted) and
   the frontend, plus a domain decision.
2. **Real payment credentials.** PayFast/Ozow signature verification is real,
   tested code — but there are no live merchant credentials yet. No real
   money can move until that's set up.
3. **Replacing the live site.** `unplugnews.com` is still WordPress today.
   This build was always meant as "the design reference to build the real,
   connected version from" (per the audit) — that connecting work is now
   done, but nobody's decided *when/how* this actually replaces the live
   WordPress site.
4. **Real content.** The database is intentionally empty (all test data was
   cleaned up after each check) — someone needs to actually populate real
   profiles, articles, investors, and editions before this means anything
   to a real visitor.

---

## Suggested next session

All wiring work from the original static reference is done, and the medium-
priority audit items are cleaned up too. What's left is genuinely just:
- **Go-live planning:** a real conversation about hosting, payment
  credentials, and the WordPress migration timeline — this needs
  Darius + Pierre in the room, not just more Claude Code time
- Confirm **real dates** for The Arena (currently a placeholder year-long
  window in migration 014) once Pierre/Darius decide the actual schedule
- Lower-priority polish items (loading skeletons, optimistic UI, offline
  messaging, shared form validation) if there's appetite for it
