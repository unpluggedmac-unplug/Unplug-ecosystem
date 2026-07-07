# Unplug Magazine — Punch List
*Last updated: 2026-07-08 (deployment session)*

This is the working status doc for the Unplug Ecosystem build (backend + public
site). Read this first before picking work back up — it replaces having to
re-derive context from scratch.

---

## 🚀 DEPLOYMENT STATUS (as of 2026-07-08, ~1am)

- **GitHub:** https://github.com/unpluggedmac-unplug/Unplug-ecosystem (private).
  `main` branch. Auto-deploys to Railway on every push.
- **Backend: ✅ LIVE on Railway** at
  `https://unplug-ecosystem-production.up.railway.app` — verified reading real
  data from Supabase (`/health` → `{"status":"ok"}`, `/competitions/top-10`
  returns the seeded competition). Railway service settings:
  - **Root Directory:** `unplug-backend` (the app is in a subfolder)
  - **Variables set:** `DATABASE_URL` (Supabase pooled string) + `JWT_SECRET`.
    Nothing else — `CORS_ORIGINS` deliberately left unset (= allow all origins
    for now), `PORT` is auto-injected by Railway.
  - **GOTCHA — target port:** the app listens on Railway's injected `PORT`
    (8080), so the public domain's **target port must be 8080**, not 4000. A
    4000 target gives a 502 "Application failed to respond". If you ever
    regenerate the domain and get a 502, this is why.
- **Frontend: ⬜ NOT deployed yet** — the last remaining step. `unplug-shared.js`
  already defaults its API base to the live Railway URL (committed), so the
  moment it's on Netlify it'll talk to the live backend. Steps below.

### ⬜ Remaining deploy step — Netlify (frontend), ~5 min, needs Pierre's Netlify account
1. Netlify → **Add new site → Import from Git** → the `Unplug-ecosystem` repo
2. **Build command:** leave EMPTY (plain static HTML, no build step)
3. **Publish directory:** `.` (repo root — the HTML/CSS/JS sit at the top level)
4. Deploy → Netlify gives a URL like `something.netlify.app`
5. **Then tighten CORS (optional but recommended):** on Railway → Variables, add
   `CORS_ORIGINS` = the Netlify URL (e.g. `https://something.netlify.app`) so the
   API only accepts calls from the real site instead of everywhere. Redeploys
   automatically.
6. Visit the Netlify URL, open the site, click into Directory/Top 10/etc — they'll
   show empty states (DB is empty by design) but should load with no console
   errors, proving frontend→Railway→Supabase works end to end.

### 🔴 SECURITY — do this ASAP
- The **GitHub Personal Access Token** (`ghp_...`) used to push was pasted in
  plaintext during setup. Now that the push is done and the credential is cached
  in Windows Credential Manager, **revoke that token** on GitHub (Settings →
  Developer settings → Personal access tokens) and, if needed later, generate a
  fresh one. Leaving an exposed token active is a standing risk.
- The **Supabase database password** also appeared in chat + is stored in
  Railway's variables and the local `.env`. Lower urgency (it's not in a public
  place), but worth rotating eventually via Supabase → Settings → Database →
  Reset password, then updating Railway's `DATABASE_URL` + local `.env` to match.

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
  file. **It now defaults to the LIVE Railway backend** (changed at deploy). For
  local dev against a local backend, run this in the browser console once:
  `localStorage.setItem('unplug_api_base','http://localhost:4000')`.
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
