# Unplug Magazine — Project Context

This file is loaded automatically at the start of every Claude Code session in this repo —
you don't need to be told to read it. Don't re-derive any of this from the master handover
doc; it's summarized here so you never have to re-read that whole document.

## Before starting any task
Check `docs/progress-log.md` for a short record of what's already done and any open items
from the last session, before asking me or re-deriving state.

## Reading large files
`unplug-admin-dashboard.html` (~15,000 lines) and `docs/spec-extracted.md` are both large.
Grep/search for the section or function you need rather than viewing either file in full.

## Platform
www.unplugnews.com — live South African community magazine platform. Static HTML/vanilla JS
frontend (Cloudflare Pages) · Express + raw `pg` backend (Render free tier) · Postgres +
Storage on Supabase · Resend email · `node --test` (1,532 passing, embedded-postgres per
file) · 155 numbered SQL migrations, all re-run on every deploy. Repo:
`github.com/unpluggedmac-unplug/Unplug-ecosystem`, branch `main`, auto-deploys on push.

## Hard rules
- Free/self-built only — no paid SaaS or dependency without my explicit sign-off.
- Additive and non-breaking — extend, don't duplicate or replace, without saying why first.
- Live production data — no destructive DB op without a reversible migration + backup step.
- SASL is never machine-translated.
- Sanitise/validate/escape server-side, always.
- Never `git add -A` — stage named paths only.
- Migrations must be `IF NOT EXISTS`/`ON CONFLICT` safe (`ADD CONSTRAINT` has no
  `IF NOT EXISTS` — enforce in app code, as `popupBuilder.js` already does).
- Before pushing any migration: `node scripts/sweep-test-postgres.js && npm test`.
- Before anything touching money/votes/a public page: full test suite → verify in browser
  against a real backend → confirm live deploy.
- For internal, member/admin-only pages that touch none of the above: automated test suite
  plus a scripted smoke check (curl/API call confirming the endpoint responds and the page
  renders) is enough — don't default to the full money/votes protocol out of caution, it's
  reserved for where the cost of being wrong is actually high. When genuinely unsure which
  tier a piece of work falls into, ask rather than guessing either direction.
- Definition of done is what the relevant spec section describes — no unrequested extra
  fields, columns, or polish. Flag anything that looks like a real gap instead of building it
  unasked; scope additions are my call, not yours.

## Known traps (check before you rediscover these)
- `embedded-postgres` has no `english.stop` — use `test/helpers/textSearch.js`.
- `pg_trgm` unavailable in tests — skip with diagnostic where needed.
- Test port bases must be 400 apart.
- Never fixed-sleep for a write — use `test/helpers/waitFor.js`.
- `COALESCE` doesn't fall through on `''`, only `NULL`.
- Bare `$n` inside `CASE…ELSE NULL END` needs an explicit cast (`$1::varchar`).
- `ts_headline` doesn't escape input — use `chr(2)`/`chr(3)`, escape client-side.
- `websearch_to_tsquery` never throws; `to_tsquery` does.
- Redefining a SQL function drops anything added to it later.
- Admin token key: `unplug_admin_token`. Member/magazine: `unplug_auth_token`.
- `CORS_ORIGINS='*'` matches nothing literally — set properly.
- Browser preview pane HTTP-caches on the same port — use a fresh port.
- `python` not `python3`; write patch scripts to a file, not a heredoc.
- **Recurring bug class**: a value stated in two places will drift (image sizes, ad sizes,
  prices have all done this). If you find a second copy of a value, consolidate it.

## Decisions already made — implement as-is, do not re-ask
1. Bulk vote EFT reference = contestant code + unique suffix (`1234567890-K3M9`), not the
   bare code (bare code can't distinguish two buyers).
2. Voting moves to spec §9.2: 5 votes/person/day, across ≥2 contestants. This is a
   live-behaviour change — implement it, but flag before flipping it live so cutover timing
   can be chosen.
3. Rejected paid submissions → Unplug Credit by default, admin override to cash. Don't write
   public-facing no-refund copy yourself — flag it for a Consumer Protection Act check.
4. Events get an end-date field; expire after end date, not start date.
5. Notifications: email + in-app only, no WhatsApp (paid, breaks free-only rule). All 25
   spec'd events (§10.17) still fire via email/in-app.
6. One profile per user. Publishing own profile = no approval. Buying a Directory Listing
   against it = separate paid service, does need approval. No data migration.
7. Marketplace "businesses only" applies to new listings only; existing stay as-is.
8. No price changes without a full spec-vs-live comparison done first (see task 03).
9. Reference format stays the live non-sequential `UNP-`+10-char format — the spec's
   sequential example (§15) is not used; spec states format is admin-configurable, and
   sequential exposes order volume to customers.

## Open questions — flag to me, don't assume
- How much of the six status vocabularies (§16) to build in full vs. only-what's-used.
- Whether one-profile-per-user (§1.5) forcing a business/individual choice is intentional.

## Full source docs (only open these if a task file below tells you to)
- Master handover doc (already summarized above — shouldn't need to reopen it).
- `vers UNPLUG MAGAZINE.wps` — the full spec. Extract once per task-01 and reuse the
  extracted text (`docs/spec-extracted.md`) for every later task — don't re-extract it.
