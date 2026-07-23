# Unplug Magazine — Handover

_Last updated: 2026-07-23. Supersedes the 2026-07-08 handover (pre-Render / pre-email)._

A comprehensive reference for anyone taking over or maintaining the Unplug
Magazine platform. **Read §13 (Gotchas & risks) before making any
infrastructure or money-related change.** A companion `PUNCH-LIST.md` tracks
fine-grained tasks; `OPERATIONS.md` covers backups/uptime.

---

## 1. What this is

Unplug Magazine is a South African lifestyle / community magazine and platform.
It is a broad good-news / community brand — **Deaf accessibility is one strand of
it, not the whole brand** (don't reframe the whole site around Deaf/accessibility).

It combines:
- A public **magazine** (articles, directory, gallery, editions, Top 10,
  competitions, investor relations, marketplace, Deaf Community hub).
- A **member area** — create a free account, submit content, pay for listings.
- An **admin dashboard** — approve/edit/manage everything, CMS, ad banners,
  analytics, email.

---

## 2. Live URLs

| What | URL |
|---|---|
| Public site (primary) | https://www.unplugnews.com |
| Public site (Cloudflare Pages) | https://unplug-magazine.pages.dev |
| Member area | https://www.unplugnews.com/unplug-member-dashboard.html |
| Admin dashboard | https://www.unplugnews.com/unplug-admin-dashboard.html |
| Backend API | https://unplug-ecosystem.onrender.com |
| GitHub repo | https://github.com/unpluggedmac-unplug/Unplug-ecosystem |

> **`unpluggedmac-unplug.github.io` returning 404 is CORRECT** — the repo is
> private and GitHub Pages is intentionally off (a prior incident exposed
> pricing/code). Never re-enable Pages or make the repo public to "fix" the 404.

---

## 3. Architecture & stack

- **Frontend:** static HTML/CSS/vanilla-JS, no build step. Single-page-app style
  routing inside `unplug-magazine.html` via `?p=<page>` query params and
  `history.pushState`.
- **Backend:** Node.js + Express (`unplug-backend/`), PostgreSQL via `pg`.
- **Auth:** JWT (bcrypt hashing), roles `member / investor / advertiser / admin /
  consultant`.
- **Database:** Supabase PostgreSQL — connect via the **Session Pooler** host
  (the direct host is IPv6-only, unreachable from Render).
- **File storage:** Supabase Storage + a local `/uploads` fallback.
- **Email:** Resend HTTPS API (SMTP is blocked from Render — see §10).

### Deployment topology
```
GitHub (source of truth, branch: main)
   ├─► Cloudflare Pages → frontend (www.unplugnews.com)                [auto-deploys, seconds]
   └─► Render           → backend  (unplug-ecosystem.onrender.com)     [auto-deploys, sometimes slow]
Supabase → PostgreSQL database + Storage
domains.co.za (registrar "Diamatrix") → DNS for unplugnews.com
```

- **A push to `main` auto-deploys both** frontend (Cloudflare, near-instant) and
  backend (Render). **Render can stall** — if a backend route still 404s ~10 min
  after push, trigger **Render → service → Manual Deploy → Deploy latest commit**.
- Backend **migrations run automatically on deploy** (`npm start` =
  `npm run migrate && node src/app.js`). A failing migration blocks boot, so
  Render keeps the previous deploy live — always verify a live endpoint after a
  migration change.

### DNS — important
`unplugnews.com` is **NOT** DNS-managed by Cloudflare. Nameservers are
`ns1-4.tld-ns.net/.com`; the real DNS panel is **domains.co.za** (Customer Portal
→ Manage Services → Domains → unplugnews.com → **Manage DNS Records**). The
Cloudflare zone shows "pending" and is a red herring. The Pages site works via a
`www` CNAME → `unplug-magazine.pages.dev` set at domains.co.za. **Any DNS record
(e.g. email) goes in domains.co.za, not Cloudflare.** That panel's Host field
expects the FULL host (e.g. `send.unplugnews.com`, not `send`).

---

## 4. Environment variables (set on Render — never commit real values)

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Supabase Postgres (Session Pooler host). **Key must be exactly `DATABASE_URL`** — a past outage was a lowercase `DATABASE_url`. |
| `JWT_SECRET` | Long random string for signing JWTs. |
| `ADMIN_EMAIL` | Admin email (default `admin@unplugnews.com`). |
| `ADMIN_PASSWORD` | Seeds/updates the admin account on migrate. |
| `ADMIN_PASSWORD_RESET` | Set `true` for ONE deploy to force-reset the admin password, then remove it. |
| `RESEND_API_KEY` | Resend HTTPS email key (active transport). |
| `SMTP_FROM` | Sending address — currently `no-reply@unplugnews.com`. |
| `BREVO_API_KEY` | Alternative HTTPS email provider (unused if Resend set). |
| `CORS_ORIGINS` | Comma-separated allowed frontend origins. |
| `SITE_URL` | Canonical site URL for emails/sitemap links. |
| `PAYFAST_PASSPHRASE` / `OZOW_PRIVATE_KEY` | Gateway webhook verification (set before real payments). |
| `BIRTHDAY_CRON_SECRET` | Guards the birthday-email trigger endpoint. |
| `SMTP_*` | Legacy SMTP — **do not use**, blocked from Render (§10). |

**Render build note:** the backend has a devDependency (`embedded-postgres`, for
tests). Set the Render **build command to `npm install --omit=dev`** (or
`NODE_ENV=production`) so the Postgres test binary isn't pulled into production.

---

## 5. Repository structure

```
/ (repo root = frontend, served by Cloudflare Pages)
  index.html                      entry/redirect
  unplug-magazine.html            the whole public magazine (SPA)
  unplug-member-dashboard.html    member area (register/sign-in/submit)
  unplug-admin-dashboard.html     admin dashboard
  unplug-checkout.html            payment/checkout
  unplug-shared.js                shared config (API_BASE etc.)
  i18n.js                         EN / Afrikaans / isiXhosa / isiZulu strings
  image-upload.js                 UnplugUpload file-upload widget
  accessibility.js, chatbot.js    accessibility toolbar, chatbot
  sitemap.xml                     static sitemap (dynamic one also served by API)
  HANDOVER.md, PUNCH-LIST.md, OPERATIONS.md, CLAUDE.md

/unplug-backend  (Node/Express API, deployed to Render)
  package.json                    scripts: start / migrate / test / dev
  TESTING.md                      how to run the credit-system tests
  db/migrate.js                   runs all migrations in order, seeds admin
  db/migrations/*.sql             52 numbered migrations (001…052)
  src/app.js                      route mounts, middleware
  src/db.js                       pg Pool from DATABASE_URL
  src/middleware/auth.js          attachUser / requireAuth / requireRole / requireOwnerOrAdmin
  src/routes/*.js                 one file per feature area (see §8)
  src/utils/*.js                  email, accountCredit, publishingRights, articleMeta, …
  test/credit.test.js             real-Postgres tests of the credit system
```

> **The Desktop `unplug files` folder is only a working copy and has diverged
> before.** Work from a fresh clone of the GitHub repo, push, then sync Desktop.
> A collaborator (**Darius**) also pushes to `main` — always `git pull --rebase
> origin main` before pushing.

---

## 6. Frontend pages (inside unplug-magazine.html, via `?p=`)

`home`, `news`, `article`, `directory`, `profile`, `gallery`, `editions`,
`top10`, `competitions`, `investors`, `brandplacement` (Marketplace), `about`,
`contact`, `deafcommunity`, `privacy`, `terms`, `refunds` (titled **Terms &
Policies**).

- A **welcome gate** overlay greets first-time homepage visitors (once per
  browser session).
- Multilingual: language switcher applies `i18n.js`; admin CMS wording overrides
  beat translations (`data-cms-applied`).

---

## 7. Payments & the credit system

- Paid services: Directory packages, article publishing (R95), event listings
  (R300), Top 10 entries (R100), competition entries, marketplace listings,
  highlights, edition downloads.
- Gateways: **PayFast**, **Ozow** (webhook-verified), manual **EFT** (FNB,
  admin-confirmed). Gateway checkout URLs are stubbed until merchant credentials
  are live.
- **Account credit** (`account_credits` ledger, migration 048): the Refund &
  Cancellation policy is credit-based, not cash. An admin **Decline & credit**
  (or a member cancel-before-active) turns the paid amount into **account
  credit**, spent automatically at the next checkout. DB-enforced and **tested
  against a real Postgres** (`test/credit.test.js`): a payment can be credited
  once only (unique index), concurrent checkouts can't overspend (row lock),
  credit+reject are atomic.
- Free publishing: `src/utils/publishingRights.js` — **admin** (approved
  instantly) and **consultant** (approved, still reviewed), never charged.

---

## 8. Backend route files (mounted in `src/app.js`)

| Mount | File | What |
|---|---|---|
| `/auth` | auth.js | register, login, magic-link, forgot/reset, verify |
| `/admin` | admin.js | users (+ guarded delete), vouchers, approval queues, profile gallery admin, shout-out mgmt, email status, SMTP probe |
| `/admin/content` | adminContent.js | generic list/edit/delete + **decline-with-credit** for every content type |
| `/` (directory) | profiles.js | `/directory`, `/profiles/:slug`, profile create/edit (feature image, category) |
| `/gallery` | gallery.js | member gallery uploads |
| `/payments` | payments.js | initiate, PayFast/Ozow webhooks, EFT confirm, `/payments/credit` |
| `/articles` | articles.js | article CRUD, sections, drafts, scheduled publish, admin list |
| `/events` | events.js | upcoming (public), submit, **admin add/edit/all** |
| `/birthdays` | birthdays.js | public submit + month list; birthday emails |
| `/` (competitions) | competitions.js | competitions, Top 10, votes, **manual Top 10 entries** |
| `/investors` `/marketplace` `/highlights` | … | investor/advertiser features |
| `/sales-consultants` | salesConsultants.js | public list + admin performance/submissions dashboard |
| `/uploads` | uploads.js | file upload to Supabase Storage |
| `/editions` | editions.js | editions + editions calendar (Save the Dates) |
| `/analytics` | analytics.js | page-view / event tracking |
| `/shoutouts` | shoutouts.js | daily "The Guy Says" + nominations (7-day wait) |
| `/search` | search.js | site-wide search |
| `/deaf-community` | deafCommunity.js | jobs board + Opportunity Passports |
| `/newsletter` | newsletter.js | subscribe |
| `/saved` `/comments` `/polls` `/feed` `/reviews` `/claims` | … | member engagement |
| `/directory` | directoryMap.js | map + "near me" search |
| `/page-cms` | pageContent.js | wording overrides, image blocks, **ad banners** |
| `/sitemap.xml` | sitemap.js | dynamic sitemap |

Middleware: `attachUser` (adds `req.user` if a valid token is present, on every
route), `requireAuth`, `requireRole('admin')`, `requireOwnerOrAdmin`.

---

## 9. Database & migrations

- **52 numbered SQL migrations** (`001_…` → `052_…`), run in filename order on
  every deploy; all idempotent (`IF NOT EXISTS` / `ON CONFLICT`).
- Recent ones worth knowing:
  - `046` consultant role + `sales_consultants.user_id`
  - `047` shout-out waiting period + admin-added source
  - `048` **account_credits** ledger + `payments.credited_at`
  - `049` article **drafts** + `scheduled_for`
  - `050` **manual competition/Top 10 entries** (nullable profile_id + manual_name/image)
  - `051` **ad_slots** (editable ad banners)
  - `052` `profiles.feature_image_url`

---

## 10. Email (Resend) — critical

- **SMTP is blocked from Render at the TCP level** (proven via port probe). Do
  not try SMTP host/port combos or Gmail app passwords — they never work from
  Render. Email uses the **Resend HTTPS API** (port 443).
- **`unplugnews.com` is verified in Resend** (region eu-west-1 / Ireland);
  `SMTP_FROM = no-reply@unplugnews.com`. Members receive verification / reset /
  birthday emails.
- The 4 DNS records that make this work live at **domains.co.za** (not
  Cloudflare): DKIM (`resend._domainkey` TXT), SPF (`send` TXT), MX (`send`),
  DMARC (`_dmarc` TXT).
- Admin email tools: `GET /admin/email-status`, `POST /admin/test-email` (sends
  only to the signed-in admin).

---

## 11. Admin dashboard capabilities

Sign in at `/unplug-admin-dashboard.html`. Sections:

- **Approval Queue** — approve/reject/verify across content types; article
  approval can carry a **scheduled publish date**; **Decline & credit R…**
  rejects a paid item and refunds it as account credit.
- **Manage Content** — list/edit/delete any content type at any status (articles
  incl. feature image + SEO fields, events, profiles, gallery, investors,
  marketplace, highlights, competition/Top-10 entries, editions calendar).
- **Directory Profiles** — per-profile editor: details, category, **feature
  image**, **gallery images** (add/remove).
- **Calendar Events** — add/edit homepage calendar events manually (approved,
  free); full fields incl. image, fee, times, link.
- **Shoutouts** — add directly; review nominations (7-day wait); all shout-outs
  with expected show dates.
- **Editions Calendar** — add/edit/remove "Save the Date" days.
- **Publish (Write an article)** — full editor: sections, cover + gallery, SEO
  fields, auto-metadata, draft / publish / schedule. Also **Add Top 10 entry**
  from a profile OR **manually** (name + photo).
- **Ad Banners** — upload a banner + link into any of 13 ad slots; clear to
  restore the placeholder.
- **Page Content** — reword any labelled text; add per-page image blocks (render
  as banners on every main page).
- **Users** — every account with its owned-content tally; **guarded delete**
  (refuses accounts owning published content or confirmed payments; blocks
  self/other-admin deletion).
- **Sales Consultants** — add consultants; performance table (referrals,
  revenue, commission owed); per-consultant detail.
- **Birthdays, Deaf Jobs, Deaf Passports, Hall of Fame, Site Settings, Payments
  (EFT), Notifications, Analytics, Comments, Reviews, Listing Claims, Vouchers.**
- **Undo & Discard** — most editors have **Discard changes** (reset the form to
  saved values) and an **Undo** bar after saving (reverts the last saved change
  for ~12s): Directory Profiles, Manage Content, Ad Banners, Page Content
  wording, Editions Calendar, Calendar Events. The article editor has Discard
  (full reload).

---

## 12. Running & deploying

**Deploy:** commit to `main` and push → Cloudflare + Render auto-deploy. Always
`git pull --rebase origin main` first (Darius pushes too).

**Backend locally:**
```bash
cd unplug-backend
cp .env.example .env      # DATABASE_URL, JWT_SECRET, ADMIN_PASSWORD, RESEND_API_KEY…
npm install
npm run migrate           # applies migrations + seeds admin
npm run dev               # nodemon, PORT default 4000
```

**Frontend locally:** serve the repo root (`npx http-server -p 4173 .`) and open
`unplug-magazine.html`. It points at the live Render API by default.

**Credit-system tests:**
```bash
cd unplug-backend
npm install               # installs embedded-postgres (downloads a real PG binary)
npm test                  # test/credit.test.js against a throwaway Postgres
```
See `unplug-backend/TESTING.md`.

---

## 13. Gotchas & risks (read before changing infra/money)

1. **Deleting content is not a refund.** `DELETE /admin/content/:resource/:id`
   removes the item and cascades dependents, but `payments.linked_id` has no FK,
   so the payment record survives and **no money is returned**. The confirm
   dialog warns it's permanent but doesn't mention money.
2. **Render deploys can stall.** If a backend route 404s long after a push, use
   Manual Deploy. A failed migration keeps the old deploy live — verify a live
   endpoint after migration changes.
3. **DNS is at domains.co.za, not Cloudflare** (§3).
4. **SMTP is blocked from Render** — email is Resend-only (§10).
5. **Don't reset the Supabase DB password** — it breaks the live site.
6. **Never commit whole-file rewrites containing "omitted"/"rest unchanged".**
7. **Repo stays private; github.io 404 is correct** (§2).
8. **Policy pages are templates** — have a professional review before relying on
   them commercially. The Refund/Terms & Policies page deliberately keeps two
   cash carve-outs (we-can't-deliver, duplicate charge) despite the general
   credit-only rule.
9. **Admin-only UI flows** built recently are verified via live click-throughs
   for the major ones (drafts/schedule, guarded user-delete, banners, shout-out
   admin, consultant dashboard); anything newer is verified to the auth/deploy
   boundary — spot-check after big changes.

---

## 14. Outstanding / not yet built

- **Members admin (partial):** user delete + content-ownership guard done. Still
  to build: industry categories at signup (incl. "explorer" for anonymous),
  credits/vouchers UI per member.
- **Categorised analytics** by content type (pages, articles, external links,
  banner clicks, directory/investor profiles, marketplace, events).
- **Editions upload** UI (cover + PDF link + edit/delete) — the editions
  *calendar* exists; edition *uploads* don't yet.
- **Undo for "add/create" actions** (undo currently covers edits, not new
  shout-outs/Top-10/gallery adds).
- **isiXhosa / isiZulu translations** — review by a first-language speaker
  (machine-drafted).
- **Live payment credentials** (PayFast/Ozow) — set gateway env vars and replace
  stubbed checkout URLs before taking real money.
- **End-to-end money-path testing** on the live site once gateways are live.

---

## 15. Access, collaborators, support

- **GitHub:** `unpluggedmac-unplug/Unplug-ecosystem` (private).
- **Collaborator:** Darius (dariusvanniekerk5) also pushes to `main`.
- **Dashboards:** Cloudflare (Pages), Render (backend), Supabase (DB + Storage),
  domains.co.za (DNS/registrar, support 011 640 9700), Resend (email).
- **Admin login:** `admin@unplugnews.com` (password in Render `ADMIN_PASSWORD`).
- **Owner email:** unpluggedmac@gmail.com.

---

_End of handover. Keep this file updated as the platform evolves._
