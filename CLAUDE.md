# CLAUDE.md — Unplug Magazine · Operating Manual

Standing instructions for every Claude session working in this repo.
Read `PUNCH-LIST.md` for current status and remaining tasks — trust that
file over anything remembered from previous conversations.

## The system (current truth — do not "fix" any of this)

- **Live site (the ONLY frontend):** https://unplug-magazine.pages.dev —
  Cloudflare Pages, auto-deploys on every push to `main`. Cloudflare serves
  "pretty URLs": `/unplug-magazine.html` redirects to `/unplug-magazine`.
  Both work. **Also live (2026-07-19):** `https://www.unplugnews.com` — a
  Cloudflare Pages custom domain pointed at the same project via a `www`
  CNAME at the registrar (domains.co.za). The bare/root `unplugnews.com`
  (no `www`) is NOT cut over yet — still serves the old WordPress site.
- **Backend API:** https://unplug-ecosystem.onrender.com — Render, NOT
  Railway (moved 2026-07-1x; if you see a `railway.app` URL anywhere, it's
  stale/retired — don't debug against it). Health check: `/health` →
  `{"status":"ok"}`. `unplug-shared.js`'s `LIVE_API_BASE` is the source of
  truth for this URL and also auto-clears any Railway URL cached in a
  returning visitor's `localStorage`.
- **Database:** Supabase (PostgreSQL), pooled connection string in
  Railway's `DATABASE_URL`. **Migrations run AUTOMATICALLY on every
  deploy** (the `start` script runs them before booting) — to change the
  schema, add a new numbered file in `unplug-backend/db/migrations/`
  using `IF NOT EXISTS` / `ON CONFLICT DO NOTHING`, then push.
- **This repo is PRIVATE and must stay private** — it contains pricing
  and business logic. NEVER suggest making it public.

## Dead things — never resurrect these

- **GitHub Pages** (`unpluggedmac-unplug.github.io/...`) returns 404 BY
  DESIGN — Pages needs a public repo and we don't use it. A 404 there is
  NOT an outage. Do not try to fix it, do not make the repo public.
- **Netlify** — the old site was deleted. Never reference `netlify.app`
  URLs.
- **Railway** — the backend was moved to Render. Never reference
  `railway.app` URLs as if they're live.

## Hard editing rules (each one prevented/caused a real incident)

1. **Never rewrite a whole file.** Small, targeted edits only. Never
   output a file containing "content omitted", "rest unchanged", or
   "omitted for brevity" — a GitHub Action (`file-guard.yml`)
   auto-reverts such commits within a minute, so they won't stick anyway.
2. **Money paths get extra care.** Anything touching payments (checkout,
   packages, editions, vote bundles, event listings) must be tested
   end-to-end before being called done. Prices are ALWAYS resolved
   server-side in `unplug-backend/src/routes/payments.js` — never trust
   a client-sent amount.
3. **Never show invented numbers.** The Investor Spotlight stats come
   from `/analytics/public-stats`; on failure they show em-dashes.
   Do not add hardcoded fallback figures (12K+/340+ etc.).
4. **The API base default** in the HTML pages is the live Railway URL —
   never change it back to `http://localhost:4000`.

## Architecture map

```
unplug-magazine.html        the whole public site (one-file SPA)
unplug-checkout.html        payment flow (login → package/item → pay)
unplug-member-dashboard.html  member area
unplug-admin-dashboard.html   admin panel (approvals, analytics, inquiries)
unplug-shared.js            UnplugAPI helper + analytics + shared loaders
unplug-backend/             Express API (src/routes/ = one file per feature)
unplug-backend/db/migrations/  schema, applied in filename order, auto-run
PUNCH-LIST.md               live status + what's left — read this first
```

## Run locally (optional — pushing to main deploys everything)

Backend: `cd unplug-backend && npm install && npm run dev` (port 4000;
needs a `.env` with `DATABASE_URL` + `JWT_SECRET` — copy `.env.example`).
Frontend: serve the repo root with any static server; to point pages at a
local backend run `localStorage.setItem('unplug_api_base','http://localhost:4000')`
in the browser console (remove it to go back to the live backend).

## Credentials

No passwords live in this repo. The admin login email is
`admin@unplugnews.com` — ask Pierre/Darius for the password. Never commit
secrets, tokens, or connection strings.
