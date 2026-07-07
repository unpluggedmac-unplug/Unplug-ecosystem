# Unplug Ecosystem — Handover Document

*Prepared 2026-07-08. For Pierre, to continue and maintain the Unplug website.*

This document explains how the whole system is set up, how to make changes and
see them go live, how to run it on your own machine, and what's still left to
do. If you only read one file, read this one. A second file, `PUNCH-LIST.md`,
tracks the detailed task list and config gotchas — this handover points to it
where useful.

---

## 1. What this is (30-second orientation)

The Unplug website is now a real, live, full-stack web application:

- A **public website** people visit (Directory, Latest News, Gallery, Top 10
  voting, Competitions, Investors, Marketplace, Editions).
- A **backend API** that stores and serves all the real data.
- A **database** holding everything (users, profiles, articles, payments, etc.).
- Three **dashboards** already built: Admin, Member, and Checkout.

Everything the public site shows is now real data pulled from the database — not
demo content. Right now the database is empty, so the site shows "no entries yet"
messages everywhere. It starts filling in the moment you add real content
(see Section 6).

---

## 2. The live system — URLs and what each piece does

| Piece | Where it lives | What it does |
|---|---|---|
| **Public website** | https://relaxed-cupcake-2e5b2e.netlify.app | What visitors see. Hosted on **Netlify**. |
| **Backend API** | https://unplug-ecosystem-production.up.railway.app | Serves/stores all data. Hosted on **Railway**. |
| **Database** | Supabase project `unplug-production` | PostgreSQL database. Holds everything. |
| **Source code** | https://github.com/unpluggedmac-unplug/Unplug-ecosystem (private) | The single source of truth. Everything deploys from here. |

All four are under **your accounts** (GitHub `unpluggedmac-unplug`, plus your
Railway, Netlify, and Supabase logins). You own and control all of it.

Quick health check any time: open
`https://unplug-ecosystem-production.up.railway.app/health` — it should show
`{"status":"ok"}`. If it does, the backend and database are up.

---

## 3. How deployment works (this is the important part)

**One rule: everything deploys from GitHub automatically.**

```
You change code  →  push to GitHub (main branch)  →  Railway + Netlify
                                                       rebuild automatically
                                                       (live in ~1-2 minutes)
```

- Push a change that touches the **backend** (`unplug-backend/`) → **Railway**
  rebuilds and redeploys the API.
- Push a change that touches the **frontend** (the `.html` / `.js` / `.css`
  files at the top level) → **Netlify** rebuilds and redeploys the site.

You never manually "upload" anything. You just push to GitHub and both hosts
update themselves. That's the whole mental model.

---

## 4. The everyday workflow — making a change and putting it live

### Option A — small text/content edits (easiest)
You can edit files directly on GitHub in the browser:
1. Go to the repo → open the file → click the pencil (Edit) icon.
2. Make your change → **Commit changes** to `main`.
3. Railway/Netlify auto-deploy within a couple of minutes. Done.

### Option B — real development on your laptop
1. Clone the repo once:
   ```
   git clone https://github.com/unpluggedmac-unplug/Unplug-ecosystem.git
   ```
2. Make your edits in a code editor (VS Code is great and free).
3. Commit and push:
   ```
   git add -A
   git commit -m "describe what you changed"
   git push
   ```
4. Auto-deploys. Done.

**Tip:** always describe your change in the commit message — future-you will
thank present-you when looking back at history.

---

## 5. Running it locally (for development and testing before you push)

You don't *have* to run locally — you can edit and push — but running locally
lets you test before it goes live.

### Backend
```
cd unplug-backend
npm install
```
Then create a file called `.env` inside `unplug-backend/` (copy `.env.example`
and fill it in). The two required values:
- `DATABASE_URL` — the Supabase **pooled** connection string (see note below).
- `JWT_SECRET` — any long random string.

Then:
```
npm run migrate    # first time only — builds the database tables
npm run dev        # starts the API at http://localhost:4000
```

> **Important — Supabase connection string:** use the **pooled** connection
> string (the "Transaction Pooler" option in Supabase's *Connect* panel, host
> looks like `...pooler.supabase.com:6543`). The *direct* connection
> (`db.<something>.supabase.co`) fails to connect on most home internet
> connections. This bit us during setup — save yourself the headache.

### Frontend
The public site is plain static files — no build step. Just open
`unplug-magazine.html` with any local web server. By default the site talks to
the **live Railway backend**. To point it at your **local** backend instead,
open the browser console on the page and run once:
```
localStorage.setItem('unplug_api_base', 'http://localhost:4000')
```
To switch back to live, run:
```
localStorage.removeItem('unplug_api_base')
```

---

## 6. Adding real content (making the site come alive)

Content flows through the **Admin Dashboard** (`unplug-admin-dashboard.html`)
and the **Member Dashboard** (`unplug-member-dashboard.html`).

- **Admin login:** `admin@unplugnews.com`. The password was set during setup —
  **ask Darius for it, then change it after your first login.** (It is
  deliberately not written in this file, since this file is in the repo.)
- Members/advertisers register through the Member Dashboard, submit content
  (profiles, articles, gallery photos, listings), and — where payment applies —
  pay. Submissions land in the Admin Dashboard's approval queue.
- As an admin you review and **approve** submissions. Approved content is what
  the public site displays.

So the public site fills up as real people register and submit, and as you
approve. Nothing on the public site is fake or seeded — it's all real.

---

## 7. Where things are in the code (map)

```
Unplug-ecosystem/
├── index.html                     redirect → unplug-magazine.html (so the bare URL works)
├── unplug-magazine.html           THE PUBLIC WEBSITE (one big self-contained page)
├── unplug-shared.js               API helper — how the frontend talks to the backend
├── unplug-shared.css              shared styles (used by the dashboards)
├── unplug-admin-dashboard.html    Admin dashboard (approvals, bulk email, etc.)
├── unplug-member-dashboard.html   Member dashboard (register, submit content, pay)
├── unplug-checkout.html           Checkout flow
├── HANDOVER.md                    this file
├── PUNCH-LIST.md                  detailed status + remaining tasks + config gotchas
└── unplug-backend/                THE BACKEND API
    ├── src/
    │   ├── app.js                 entry point — wires all the routes together
    │   ├── db.js                  database connection
    │   ├── middleware/            auth, rate limiting, uploads, request logging
    │   ├── routes/                one file per feature (profiles, articles, payments…)
    │   └── utils/                 pagination, email, env validation
    ├── db/
    │   ├── migrate.js             runs the migrations + seeds the admin account
    │   └── migrations/*.sql       the database schema, applied in number order
    ├── .env.example               template for your .env (never commit a real .env)
    └── package.json               dependencies + the npm scripts
```

**If you add a new database table or column:** add a new numbered file in
`db/migrations/` (e.g. `017_something.sql`) — never edit old migration files —
then run `npm run migrate`. Migrations run in filename order and are safe to
re-run.

---

## 8. Config facts worth knowing (the gotchas we hit)

- **Railway → Root Directory is `unplug-backend`.** The backend lives in a
  subfolder, so Railway is told to build from there (Settings → Root Directory).
- **Railway → domain target port must be `8080`.** The app listens on the port
  Railway injects (8080). If you ever regenerate the public domain and get a
  "502 Application failed to respond," the domain's target port is wrong — set
  it to 8080 (Settings → Networking).
- **Railway environment variables:** only `DATABASE_URL` and `JWT_SECRET` are
  set. `PORT` is provided automatically by Railway — don't set it. `CORS_ORIGINS`
  is intentionally left unset (= the API accepts all origins for now).
- **Netlify settings:** import from GitHub, branch `main`, **no build command**,
  publish directory `.` (a single dot). It's plain static HTML.

---

## 9. Security to-dos — please handle these

1. **Revoke the GitHub token used during setup.** A personal access token was
   generated to push code and got shared in plaintext while setting up. Now that
   it's cached locally, revoke it: GitHub → Settings → Developer settings →
   Personal access tokens → delete it. (Pushing keeps working afterward.)
2. **Change the admin password** after your first login.
3. **Eventually rotate the Supabase database password** (Supabase → Settings →
   Database → Reset password), then update Railway's `DATABASE_URL` and your
   local `.env` to match. Lower urgency, but good hygiene since it was handled
   during a shared setup session.

---

## 10. What's left to do (roadmap)

None of this blocks the site being live — it's already live. These are the next
meaningful steps, roughly in order:

1. **Add real content** so the site isn't empty (Section 6).
2. **Payment credentials** — the PayFast/Ozow integration is real, tested code
   but has no live merchant credentials yet. Add `PAYFAST_PASSPHRASE` and
   `OZOW_PRIVATE_KEY` to Railway's variables when you're ready to accept real
   money. Until then, payment verification is skipped with a warning (safe for
   testing, not for real payments).
3. **Email sending** — signup codes and password resets currently log to the
   server console instead of emailing (no SMTP configured). Add `SMTP_HOST`,
   `SMTP_USER`, `SMTP_PASS` to Railway's variables to send real emails.
4. **Custom domain** — attach `unplugnews.com` (or a subdomain) to Netlify when
   you're ready to replace/point away from the current WordPress site. You'd also
   add that domain to `CORS_ORIGINS` on Railway at that point.
5. **The Arena competition dates** — currently a placeholder year-long window.
   Update `db/migrations/014_the_arena_competition.sql`'s dates (or update the
   row directly) once you decide the real schedule.
6. **Optional polish** — tighten CORS to only your real domain(s), rename the
   Netlify project from its random name, loading skeletons, etc.

See `PUNCH-LIST.md` for the full detail on any of these.

---

## 11. If something breaks

- **Site won't load:** check Netlify → Deploys for a failed build.
- **Site loads but shows errors / no data:** check the backend is up
  (`.../health`), then check Railway → Deploy Logs. Every request is logged
  (`METHOD /path STATUS time`), so you can see what's failing.
- **Backend won't start:** the app refuses to boot if `DATABASE_URL` or
  `JWT_SECRET` are missing — the logs will say exactly which. Check Railway's
  Variables.
- **Database questions:** Supabase has a built-in table viewer and SQL editor in
  its dashboard — handy for inspecting or fixing data directly.

---

*Built and wired up with Darius. Everything here is real, tested end-to-end, and
version-controlled. Welcome to your live website — it's yours to grow now.*
