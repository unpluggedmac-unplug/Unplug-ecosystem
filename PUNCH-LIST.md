# Unplug Magazine — Punch List
*Last updated: 2026-07-19*

## ✅ DOMAIN CUTOVER — www live (2026-07-19)

- **`https://www.unplugnews.com` now serves the real Unplug Magazine site** —
  confirmed HTTP 200, real `<title>`. Path: `www` CNAME added at
  domains.co.za → `unplug-magazine.pages.dev`, then Cloudflare Pages →
  `unplug-magazine` project → Custom domains → "Check DNS records" to
  activate (it was sitting on "Inactive (Requires DNS setup)" even though
  the CNAME was already correct — clicking the recheck button is what
  flipped it to Active, not waiting).
- **Root/apex `unplugnews.com` — ALSO DONE (2026-07-19 afternoon):** solved
  with a cPanel 301 redirect on the old WordPress hosting (cPanel →
  Redirects: domain `unplugnews.com`, `/` → `https://www.unplugnews.com`,
  Permanent). DNS still points the apex at the old host (`169.239.218.73`)
  ON PURPOSE — the old server's only job now is issuing that redirect.
  Verified: `unplugnews.com` (http & https) → 301 → new site (200);
  `levvleup.co.za` + `ivorymuse.co.za` (same account) unaffected; email
  untouched.
  ⚠️ **Incident during setup:** the redirect was first added with the
  domain dropdown on "** All Public Domains **", which hijacked
  `levvleup.co.za` onto Unplug's site for a few minutes. Deleted and
  re-added scoped to `unplugnews.com` only. Lesson: NEVER use the
  all-domains option in that cPanel Redirects tool.
  **Deep links — ALSO DONE (2026-07-19 evening):** old WordPress URLs like
  `unplugnews.com/gallery/` now 301 to the same path on the new site,
  path preserved. The cPanel-generated redirect rule existed but sat BELOW
  the WordPress rewrite block in
  `/home/ivorymus/public_html/unplugnews.com/.htaccess`, so WordPress's
  catch-all (`RewriteRule . /index.php [L]`) swallowed every deep link
  first. Fixed by moving the redirect block to the TOP of that file
  (above `# BEGIN WordPress`) and removing the duplicate at the bottom.
  **SEO — DONE (2026-07-19):** canonical/OG/structured-data/sitemap/robots
  all now use `https://www.unplugnews.com` (72 sitemap URLs, the backend
  sitemap default in `src/routes/sitemap.js`, and the member-dashboard
  link). Verified live after deploy.
  **CORS — DONE (2026-07-19):** `CORS_ORIGINS` set on Render to
  `https://www.unplugnews.com,https://unplug-magazine.pages.dev`.
  Verified: both origins get the right `Access-Control-Allow-Origin`,
  unknown origins get none. (Note: `/health` never carries CORS headers —
  that's normal, it's outside the CORS middleware; test against a real
  route like `/directory` when checking.)
  **→ The old-site → new-site merge is fully COMPLETE.** Remaining ideas
  (old WordPress hosting can eventually be downgraded to email-only +
  redirect duty; submit the sitemap in Google Search Console for the new
  domain) are optional and non-urgent.
- **⚠️ Backend moved off Railway to Render** — `LIVE_API_BASE` in
  `unplug-shared.js` is now `https://unplug-ecosystem.onrender.com`, not the
  old Railway URL. `unplug-shared.js` auto-clears any cached Railway URL
  from returning visitors' `localStorage`. **CLAUDE.md's "Backend API" line
  is stale and needs updating too** (Railway is retired/no longer the
  backend — don't waste time debugging against the old Railway URL).

## ✅ CONTENT MIGRATION FROM unplugnews.com (2026-07-17) — done, verified live

Real content pulled from the old WordPress site via a full export (WXR/XML),
imported into the live database:
- **29 Directory profiles** (real people — actors, musicians, entrepreneurs,
  models, etc.), imported as Premium tier with rich formatted bios (headings,
  tables preserved), 50 real social links, 146 real gallery images.
  Each has a placeholder account (`legacy-<slug>@import.unplugnews.com`) the
  real person can claim later — not a paying member yet.
- **31 articles**, real published stories, banner images attached.
- **289 real images** downloaded and re-hosted at `media/legacy/` in this
  repo (served by Cloudflare Pages) — 11 Instagram/Facebook CDN embeds
  failed to download (expiring signed URLs, expected/unavoidable).
- **Frontend upgrade that made this possible:** profile bios and article
  bodies now render as sanitized rich HTML (DOMPurify) instead of plain
  escaped text — real formatting displays properly, and it's safe against
  script injection regardless of content source.
- **Skipped on purpose:** 2 old "Badge" program pages (superseded by the
  new deaf-owned verification system), the old Top 20 candidate roster
  (24 plain names, no bios — not migrated as profiles), the Gallery page's
  handful of named photos (not re-imported as structured gallery entries).
  None of these block anything — pick up later if wanted.
- Migration script (re-runnable, skips already-imported items):
  `unplug-backend/scripts/import-legacy-content.js`

**Still pending — Phase 2, domain cutover:** point unplugnews.com's DNS at
Cloudflare Pages, replacing the WordPress site. NOT done yet — needs the
domain registrar login and a check of whether email (MX records) runs
through this domain first. See conversation for details.

## 🚨 CURRENT HOSTING — READ FIRST (changed 2026-07-15, ~midnight)

- **Frontend: Cloudflare Pages** → https://unplug-magazine.pages.dev
  (Pierre's Cloudflare account, Unpluggedmac@gmail.com. Project
  `unplug-magazine`, connected to the GitHub repo, auto-deploys on every
  push to main. Framework preset None, no build command, output dir `/`.
  Note: Cloudflare serves "pretty URLs" — /unplug-magazine.html redirects
  to /unplug-magazine. Both work.)
- **Netlify is GONE** — the relaxed-cupcake site was deleted after the
  account's credits ran out. Do not reference any netlify.app URL.
- **GitHub Pages is DEAD and must stay dead** — the repo is PRIVATE again
  (correct). Any github.io URL 404s by design. Never make the repo public
  to revive Pages.
- **Backend unchanged: Railway** → https://unplug-ecosystem-production.up.railway.app
  `CORS_ORIGINS` deliberately deleted (allow-all) until launch; re-add
  with the final domain(s) later. ⚠️ Railway trial: ~$4.89/24 days left
  as of 2026-07-14 — needs the paid Hobby plan before it lapses.
- **Database unchanged: Supabase** (project jaywxegcxjgyqhcwzbte). The
  OTHER empty Supabase project (fkuzbwysvyskhsskjmmi) should be deleted.

## ✅ COMPLETED 2026-07-15 ~1am (do NOT redo these)

- **File guard installed** — `.github/workflows/file-guard.yml` auto-reverts
  any push to main that truncates a protected file or contains AI-truncation
  placeholders ("content omitted", "omitted for brevity", etc.). Detection
  logic verified. If a commit vanishes a minute after pushing, this is why —
  check the Actions tab.
- **P1 — Latest News category dropdown** — done, live, tested.
- **P2 part 1 — Directory clickable contacts** — done (mailto:/tel:/https
  links, tel strips spaces, bare www gets https:// prefixed), live, tested.
- **P2 part 3 — Directory category dropdown** — done, live, tested.
- **P3 — Editions View Online + Download R50** — done, tested end-to-end
  with a real purchase (browser → checkout → /payments/initiate → payment
  row in DB with server-resolved R50). Download buttons link to
  `unplug-checkout.html?type=edition_download&id=N`; checkout has an
  edition mode that skips the package step.
- **P2 part 2 — Business packages on the Directory page** — done, tested.
  Individual/Business toggle swaps prices (R150/280/400 vs R500/700/1000)
  and descriptions; "Choose X" goes to
  `unplug-checkout.html?ptype=business&tier=pro` and checkout preselects
  both. Backend already charges type-aware prices server-side
  (PACKAGE_PRICES[type][tier] in payments.js) — verified.
- **H2 — Birthday confetti surprise** — done (2026-07-15 morning). When
  the Birthdays section scrolls into view: gentle two-side confetti burst +
  soft top drift, ONCE per visit. Library (canvas-confetti) lazy-loads from
  CDN only at that moment; fully skipped for prefers-reduced-motion users.
  Dual trigger (IntersectionObserver + scroll fallback) for odd browsers.
  NOTE: untestable in automation browsers (zero-height/no-scroll viewports)
  — verify by scrolling to the Birthdays section on a real phone/browser.
- **TWO PRODUCTION PAYMENT BUGS FIXED (2026-07-15 ~1:30am):**
  (1) `CURRENT_PAYMENT_LINKED_TYPE` was referenced at Pay Now time but
  defined nowhere — EVERY checkout payment threw a ReferenceError. Money
  path was fully broken until tonight. (2) The visible "API Base URL"
  field on checkout + both dashboards defaulted to `http://localhost:4000`
  — any real visitor signing in was pointed at their own machine. Now all
  default to the live Railway URL; the field is hidden on the public
  checkout page.
- **H4 — Investor Spotlight live stats** — done earlier (2026-07-14 eve):
  GET /analytics/public-stats + centralized loader in unplug-shared.js.
  On API failure it keeps em-dash placeholders — NEVER re-add hardcoded
  fake-number fallbacks.

## 🚨 INCIDENT LOG — 2026-07-14/15 night (for future sessions)

1. A chat-tool edit replaced the entire 3,136-line unplug-magazine.html
   with a 144-line "content omitted for brevity" excerpt (commit 5a7459d),
   deleting the whole public site. RESTORED from commit a499db1 in commit
   b48ade3, preserving Pierre's stats wiring + centralized loader.
   **RULE: never commit a whole-file rewrite containing "omitted"/"rest
   unchanged" placeholder comments.**
2. Netlify site deleted (credits exhausted) → migrated frontend to
   Cloudflare Pages (free, no credit system, private-repo OK).
3. Stats fallback: on API failure the site now keeps honest em-dash
   placeholders — it must NOT fall back to the old invented numbers
   (12K+/340+/R2M+).


This is the working status doc for the Unplug Ecosystem build (backend + public
site). Read this first before picking work back up — it replaces having to
re-derive context from scratch.

---

## ⚠️ 2026-07-14 incident + fix — READ THIS IF ANYTHING LOOKS BROKEN AGAIN

**What happened:** Pierre built real, solid new features himself (verification
badges, per-tier free credits, a voucher system, second Directory category for
Business Premium, article banners, demo reel URLs, activity log, inquiries/
contact form, site analytics) across migrations 018–024. But two things went
wrong in parallel:

1. **Railway's `DATABASE_URL` got pointed at a second, different Supabase
   project** (`fkuzbwysvyskhsskjmmi`, not our real one `jaywxegcxjgyqhcwzbte`)
   — two very similar-looking connection strings, easy mix-up. The live site
   was silently running against an empty database with an out-of-date schema.
   **Confirmed zero real data was lost** — the wrong database had 0 users, 0
   of everything.
2. **The repo was made public** (probably to enable GitHub Pages as a free
   host) and several commits pointed canonical/OG/sitemap URLs at the GitHub
   Pages URL instead of Netlify. Public repo = your pricing, schema, and
   business logic all publicly readable.

**Fixed:** ran migrations 018–024 against the correct database, pointed
Railway's `DATABASE_URL` back at the real Supabase project (verified with an
actual write-then-read round trip, not just a health check), made the repo
private again, and fixed the SEO/sitemap URLs to point at Netlify.

**⚠️ IMPORTANT — GitHub Pages will not work while this repo stays private,
and it should stay private.** Netlify is the one true frontend host. If you
ever see a GitHub Pages URL (`*.github.io`) mentioned anywhere, that's a dead
end — the real site is always the Netlify URL below.

**The actual lesson for Pierre, worth repeating:** every time you add a new
migration file, you must run `npm run migrate` — but ALSO double-check which
database you're running it against (`unplug-backend/.env`'s `DATABASE_URL`)
matches what's in Railway's Variables tab. Two databases existing at all was
the root confusion. Consider deleting the second, empty Supabase project
entirely to remove the trap (Supabase → that project → Settings → General →
Delete project) — nothing of value is in it.

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
- **Frontend: ✅ LIVE on Netlify** at `https://relaxed-cupcake-2e5b2e.netlify.app`
  (Netlify project name `relaxed-cupcake-2e5b2e` — can be renamed in Netlify →
  Project configuration). Settings used: import from GitHub repo, branch `main`,
  no build command, publish directory `.`. Auto-deploys on every push to `main`.
  Verified end-to-end: root URL redirects into the magazine, and a
  cross-origin API call from the Netlify origin to Railway returns 200 with the
  right `Access-Control-Allow-Origin` header (CORS passes).
- **`index.html`** at repo root is a tiny redirect to `unplug-magazine.html`
  (the real homepage), so the bare Netlify URL opens the site cleanly instead
  of 404ing (Netlify serves `index.html` at `/` by default).

### ⬜ Optional deploy polish (not blocking — site works now)
- **Tighten CORS:** currently `CORS_ORIGINS` is unset on Railway = accepts ALL
  origins. Fine and working, but to lock it down, add `CORS_ORIGINS` on Railway =
  the live site origin(s), comma-separated, e.g.
  `https://relaxed-cupcake-2e5b2e.netlify.app` (and later the real
  `https://www.unplugnews.com` once a custom domain is attached). Redeploys auto.
- **Custom domain / rename:** the `relaxed-cupcake-2e5b2e` name is a random
  Netlify default — rename the Netlify project, and/or attach a real domain
  (unplugnews.com) when ready to actually replace the WordPress site.

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
