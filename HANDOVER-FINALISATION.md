# UNPLUGNEWS — FINALISATION HANDOVER

**Date:** 13 August 2026
**Commits:** `894712b` … `a72150b` (7 commits, on `main`, all deployed)
**Baseline:** `4f22948`

Everything below is live on www.unplugnews.com and
`https://unplug-ecosystem.onrender.com`. Read section 3 first — it is the one
item that is **not** fully closed.

---

## 1. Every issue fixed

| # | Issue | Fix |
|---|---|---|
| 1 | Admin sections showed "Could not load: Authentication required" and left you on a dead dashboard | 401s now end the session and return you to sign-in with a reason (`F1`) |
| 2 | Signing in as a member in another tab silently killed the admin session | Admin session moved to its own browser storage key (`F1`) |
| 3 | Publish reported an auth refusal as "Could not reach the server" | Refusals and unreachable servers are labelled apart (`F1`) |
| 4 | No way to diagnose an auth failure without DevTools | Permanent **Session & connection check** panel added under Publish (`F1`) |
| 5 | **Top 10 entries added by an admin were invisible in the Approval Queue** | The old query inner-joined `profiles`; entries with `manual_name` and no profile row never appeared. Now a LEFT JOIN (`F2`) |
| 6 | No reference codes anywhere in the Approval Queue | Every row now carries its Reference Code (`F2`) |
| 7 | Page banners, edition purchases and listing claims could not be approved from any queue | All now in the unified queue (`F2`) |
| 8 | Second buyer for the same Top 10 contestant would have hit a duplicate-key error at checkout | `vote_bundles.reference` UNIQUE dropped (`F3`, migration 106) |
| 9 | **Entry codes are public, so making them the Reference Code would have let anyone open or attach files to a stranger's vote order** | Orders now carry a private `lookup_token`; the public entry code is never accepted as a credential (`F3`) |
| 10 | Business Management profile loading | Same root cause as #1–#3; fixed by `F1` |
| 11 | **Paid edition downloads served from a public bucket URL** | Admin screen now names the affected editions and offers a one-click move to private storage (`F7`) |
| 12 | Assignment UPDATE used a bare `$2` inside a SQL `CASE` — Postgres rejects this outright, so **every consultant assignment would have failed** | Explicit cast (`F9`); caught because the test asserts the history row, not the HTTP status |

## 2. Every feature added

- **One Approval Queue** merging 18 sources, with reference code, payment status, customer, supporting files and actions per row (`F2`)
- **Top 10 section** (renamed from Bulk Votes, label-only) showing every entry with photo, entry code, live vote total and status (`F3`)
- **Admin vote adjustment** with mandatory reason, floor at zero, before/after in the audit log (`F3`)
- **Reference Code = entry code** for bulk vote purchases (`F3`)
- **Directory listing ↔ member account linking**, with history and a working undo (`F4`)
- **Sales consultant ↔ member account linking**, with unlink (`F5`)
- **Service cancellation requests** — member asks, admin decides, service stops immediately, admin-chosen refund (`F6`)
- **Edition order confirmation PDF** + payment procedure + sales@ instruction (`F7`)
- **Acquisition source at signup**, reusing the existing consultant roster (`F9`)
- **Admin consultant assignment that drives commission** (`F9`)
- **Referral click tracking** and **share event tracking** (`F9`)

## 3. Root cause of the authentication errors — PARTIALLY ESTABLISHED

**Read this honestly: I fixed three proven defects but did not confirm which one you were hitting.**

What I proved by testing, not assumption:
- The server is up (`/health` → 200 in 0.37s)
- The deployed frontend matches the repository byte for byte
- CORS correctly allows the `Authorization` header from `www.unplugnews.com`
- Every admin endpoint returns 401 **only** when no valid token is presented

So the server side was clean. The three defects found in the frontend, any of
which produces exactly the symptom you described:

1. **No 401 handling after sign-in.** `api()` threw a plain error and each
   section printed it inline. Once a token stopped being accepted, every
   section failed forever with no route back to the login screen.
2. **One shared browser storage key** across admin, member dashboard and
   checkout on the same origin. Signing in or out as a member in another tab
   replaced or deleted the admin's session.
3. **An auth refusal mislabelled as a connectivity failure** in the Publish
   panel — which is what sent the investigation looking for a network fault
   that did not exist.

**Outstanding:** you reported that a fresh sign-in also failed, which none of
the three fully explains. The **Session & connection check** panel (Publish →
Run session check) exists to settle it: it probes three levels — server
reachable, sign-in accepted, admin access accepted — and states which failed.
**If the errors recur, run it and send the output.**

## 4. Root cause of the server/email connection problem

Not a server problem. `https://unplug-ecosystem.onrender.com` was reachable
throughout. The Publish panel wrapped a **401 authentication refusal** in the
same catch block as a network failure and printed "Could not reach the
server". Fixed: the two are now reported separately, and only a genuine
connectivity failure offers the "Reset server address" button.

Note: the Render instance sleeps when idle, so the **first** request after a
quiet period can take up to ~50 seconds. That is normal and the panel says so.

## 5. All files changed

**Backend — new:** `routes/adminApprovalQueue.js`, `routes/adminProfileLinks.js`,
`routes/cancellations.js`, `routes/acquisition.js`, `utils/consultantAttribution.js`

**Backend — modified:** `app.js`, `routes/competitions.js`, `routes/editions.js`,
`routes/orders.js`, `routes/payments.js`, `routes/uploads.js`

**Frontend — modified:** `unplug-admin-dashboard.html`, `unplug-magazine.html`,
`unplug-member-dashboard.html`, `unplug-vote.html`

**Tests — new:** `adminApprovalQueue`, `voteReferenceAndAdjust`, `adminProfileLinks`,
`serviceCancellations`, `editionOrderConfirmation`, `acquisitionAttribution`
**Tests — modified:** `voteBundleStandalone` (three cases asserted the old
reference design and were rewritten to the new rule)

27 files, +5,445 / −243 lines.

## 6 & 7. Database changes and migrations

All five are **additive**. No column was dropped, no data rewritten.

| Migration | What it does |
|---|---|
| `106_vote_reference_is_entry_code.sql` | Adds `vote_bundles.lookup_token` (backfilled from existing references, so old links keep working); **drops the UNIQUE constraint on `reference`** so two buyers can quote the same entry code |
| `107_profile_link_history.sql` | New `profile_link_history` — makes a Directory re-link reversible |
| `108_service_cancellations.sql` | New `service_cancellations`; adds `cancelled_at` to the nine cancellable service tables |
| `109_edition_order_confirmation.sql` | `edition_purchases.confirmation_url`, `editions.download_secured_at` |
| `110_acquisition_and_attribution.sql` | Acquisition + assignment columns on `users`, new `consultant_assignment_history`, `referral_clicks`, `share_events`; `consultant_source` on `payments` and `orders` |

**The one destructive-shaped change** is dropping `vote_bundles_reference_key`
in 106. It is required — without it the second person to buy votes for a
contestant cannot check out. No rows were changed.

Every migration is idempotent and each is covered by a re-run test, because
this deployment re-runs all migrations on every deploy with no tracking table.

## 8. Endpoints added or changed

**Added**
```
GET    /admin/approval-queue
GET    /admin/links/directory | /members | /directory/:id/history | /consultants
POST   /admin/links/directory/:profileId  (+ /revert)   POST /admin/links/consultants/:id
POST   /admin/entries/:id/adjust-votes
POST   /cancellations              GET /cancellations/mine | /services
GET    /cancellations/admin        PATCH /cancellations/admin/:id
POST   /editions/purchases/confirmation
POST   /editions/admin/:id/secure-download
GET    /acquisition/options        PUT|GET /acquisition/me
GET    /acquisition/admin/members | /admin/analytics | /admin/shares
POST   /acquisition/admin/assign/:userId   GET /acquisition/admin/assign/:userId/history
POST   /acquisition/referral-clicks        GET /acquisition/referral-clicks/mine
POST   /acquisition/shares
```

**Changed (backward compatible)**
- `POST /entries/:id/vote-bundle` — now also returns `lookupToken` and `procedure`
- `GET /vote-bundles/status/:ref` and `PATCH /vote-bundles/:ref/proof` — accept the
  lookup token or a legacy reference; **reject a bare entry code**
- `POST /editions/:id/purchase` — now returns `procedure` and `confirmationAvailable`
- `GET /editions/admin/all` — adds `downloadFileIsPublic`, `hasPrivateDownloadCopy`
- `GET /competitions/:id/entries/admin` — adds `entry_code`
- `POST /payments/initiate`, `POST /orders` — commission consultant now resolved
  by rule rather than taken straight from the checkout selection

## 9. Environment variables

**No new required variables.** One new optional:

| Variable | Default | Purpose |
|---|---|---|
| `SALES_EMAIL` | `sales@unplugnews.com` | Where edition buyers send proof of payment |

Existing and unchanged: `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGINS`, `SITE_URL`,
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_BUCKET`, `SUPABASE_PRIVATE_BUCKET`,
`RESEND_API_KEY` / `BREVO_API_KEY`, `BIRTHDAY_CRON_SECRET`.

## 10. Deployment changes

None. Same pipeline: push to `main` → Cloudflare Pages (frontend) + Render
(backend, migrations run on deploy). All seven commits are deployed and were
verified live after the fact.

## 11. Manual configuration still required — YOUR ACTIONS

1. **Secure the edition downloads.** Admin → Editions. Any edition with a red
   warning is serving its paid download from a publicly readable link. Press
   **"Secure this download file"** on each. Your free view-online copies are
   untouched. *(Until you do this, paid editions can be downloaded by anyone
   who has the file URL.)*
2. **Run the session check** if the auth errors recur, and send the output.
3. **Check the first few consultant payouts by hand.** Commission attribution
   changed — see section 15.
4. Pre-existing and still open: Supabase database backups, Google Workspace,
   the mobile consent-bar horizontal scroll.

## 12. The Approval Queue

One queue, everything awaiting a decision, at **Approval Queue** in the admin.

**20 categories:** Article · Directory Listing · Gallery Image · Event ·
Competition Entry · Top 10 Entry · Top 10 Vote Purchase · Investor ·
Marketplace Poster · Article Highlight · Directory Highlight · Page Banner ·
Shoutout · Listing Claim · Cancellation Request · Cart Order · Service
Payment · Edition Purchase · **Comment** · **Passport Comment**.

Each row shows type, item, customer, **Reference Code**, payment status,
service status, date submitted, supporting files (proof of payment, invoice),
and Approve / Reject. Filter by type, search by reference/name/email, filter
by date. Bulk approve/reject runs items **one at a time**, so you get an
accurate "X succeeded, Y failed" rather than a half-applied batch.

**How it is built, and why it matters to you:** the queue is read-only. It
never reimplements approving anything — each row carries the endpoint that
already knows how to approve that kind of item, and the queue calls it. That
is what stops a second approval path existing that could double-charge or
double-publish. If one category ever fails to load, the queue names it and
still shows the rest.

Below the queue, **Directory management** keeps the two views that were never
approval decisions: Approved Listings and Renewals Due.

## 13. Passport Profile vs Directory Listing

**They are separate and stay separate.**

- A **Passport Profile** is the member's own account and dashboard.
- A **Directory Listing** (`profiles` table) is a paid service — package tier,
  slug, category, approval status.

Verified in code, not assumed:
- Registering **does not** create a Directory listing. Only `POST /profiles` does.
- Nothing requires a Directory listing to buy any other service.
- Linking is a **relationship between two records**, never a merge. The test
  suite asserts that linking leaves the member's account untouched, creates no
  second profile, and does not create a My Unplug profile.

**Linking (admin → Directory Profiles → "Link a listing to a member account"):**
use it when a listing you captured before someone had an account should now
belong to them. One account holds one listing at a time — the limit is
enforced, and if the account already has one you are told which. Every link is
recorded with who did it and where it came from, and **"Undo last link"** puts
it back.

**One thing to know:** your leaderboards and rankings currently join Directory
listings to members, so a listing doubles as a member's public identity in
those views. That is pre-existing, not introduced here, and worth revisiting
if you ever want members ranked without a Directory presence.

## 14. Top 10 and vote approval

Admin → **Top 10** (formerly Bulk Votes; label-only rename — no tables,
routes or URLs were renamed, so existing payments and history are intact).

**Entries** — every contestant with photo, entry code, live vote total, status.
Entry codes are assigned on approval. **Adjust votes** requires a reason,
cannot push a total below zero, and writes before/after to the audit log.

**Vote purchases:**
1. Buyer picks a contestant and a package (no account needed)
2. They get the **Reference Code — the contestant's entry code** — and banking details
3. They EFT, optionally uploading proof
4. The purchase appears in the Approval Queue and in Top 10
5. You approve → the votes are added to that entry
6. Approving twice is impossible; reversing removes exactly that bundle

Vote totals are never stored — every count is the sum of the vote rows, so an
adjustment is a correction row, not an overwrite, and stays reversible.

## 15. Reference Code handling — READ THIS

**One name everywhere: "Reference Code".**

| Purchase | Reference Code |
|---|---|
| Service payment | `payments.gateway_reference` |
| Cart order | `orders.reference` |
| Top 10 votes | **the contestant's entry code** |
| Edition | `edition_purchases.download_reference` |

**The change that affects your bank reconciliation:** two people buying votes
for the same contestant now send the **same** Reference Code. That is the
direct consequence of "one visible code". Match them on **amount, date and
buyer** in the queue instead. Existing references issued before this change
were **not** rewritten.

**Because the Reference Code is now a public entry code**, it can no longer
prove an order is yours. Vote orders carry a separate private lookup token for
the buyer's status page and proof upload. A bare entry code is refused —
verified live.

**Commission attribution (new).** Resolution order, highest first:
1. **Admin assignment** — you assigned the member to a consultant
2. **Signup choice** — the consultant the member named when they joined
3. **Checkout selection** — what was picked at that individual checkout

Every payment records **which** rule credited the consultant, so a disputed
payout is answerable. Safeguards: an inactive consultant is never credited; a
cart resolves once so one basket cannot credit two consultants; the member's
answer is write-once; **nothing already recorded was re-attributed.**

⚠️ **Check your first few payouts by hand.** This changes who gets paid on new
payments.

## 16. Editions purchase and fulfilment

1. Reader views an edition free, or buys it
2. Checkout issues a **Reference Code**, an **order confirmation PDF**
   (downloadable and emailed), and the payment procedure
3. Buyer pays and emails proof + Reference Code to **sales@unplugnews.com**
4. You approve in the Approval Queue or Editions
5. The system emails a **single-use claim code**
6. Buyer enters claim code + email → the PDF downloads once

A failed transfer releases the download so a dropped connection does not cost
the customer their copy. Approval is idempotent — approving twice cannot
re-send or reset it.

The document is deliberately an **order confirmation, not a receipt**: nothing
has been paid at that point. It needs the Reference Code **and** the email to
open, because it carries the buyer's name and amount.

Payment methods: **EFT, account credit, voucher** now; **Ozow and PayFast**
shown as coming soon (no accounts yet).

## 17. Test results

**Automated: 565 passing, 0 failing** (up from 481). 84 new cases, plus 3
existing cases rewritten to the new Reference Code rule.

| Suite | Cases |
|---|---|
| `adminApprovalQueue` | 11 — incl. all 18 source queries validated against the real schema |
| `voteReferenceAndAdjust` | 14 |
| `adminProfileLinks` | 12 |
| `serviceCancellations` | 16 |
| `editionOrderConfirmation` | 11 |
| `acquisitionAttribution` | 20 — all six commission precedence combinations |

Windows temp-directory flakes appeared on some full-suite runs; every flagged
file was re-run in isolation and passed. Not a code issue.

**Live verification after deploy:**
- All new endpoints respond correctly (401 where auth required; `/acquisition/options` returns real data)
- Migration 106 confirmed applied in production
- The new security rule confirmed enforced live: a bare entry code is refused
- All three frontends confirmed byte-identical to the repository

**NOT tested by me — these need an admin login I do not have:**
approving each item type end-to-end from the queue; linking a real listing;
approving a real cancellation with a refund; securing a real edition download;
a real EFT reconciliation. **Each is a two-minute manual check, and I would do
those before relying on them.**

## 18. Known limitations

1. **The auth root cause is not fully confirmed** — see section 3.
2. **Paid editions remain publicly readable until you press "Secure this
   download file"** on each affected edition. The fallback was left in place
   deliberately: removing it would have instantly broken customers who already
   paid for an edition with no private copy.
3. **Two EFTs for the same Top 10 contestant share a Reference Code** — an
   accepted consequence of the design you chose.
4. Approving a cancellation **from the queue** sets no refund; use the
   Cancellations screen to give money back.
5. Comments and reviews keep their own moderation screens rather than the
   unified queue — they are moderation, not approval, and would bury it.
6. Cancelling sets a service's status to `rejected` plus `cancelled_at`; the
   admin distinguishes them, but a raw database query would need to check both.
7. The Render instance sleeps; the first request after idle can take ~50s.
8. Referral **click→signup attribution** needs the frontend to call
   `POST /acquisition/referral-clicks` when a referral link is opened. The
   endpoint is live; the call site is not yet wired.

## 19. Recommended next steps

**This week**
1. Secure every flagged edition download (section 11).
2. Walk the six untested workflows in section 17 — two minutes each.
3. Check the first consultant payout run by hand.

**Soon**
4. Wire the referral-click call so the funnel populates.
5. Turn on Supabase database backups. Still the largest single risk to the
   business, and unrelated to anything in this programme.
6. Email notifications for profile/community events (parked since July).

**When there is time**
7. Revisit leaderboards joining Directory listings to members (section 13).
8. Ozow and PayFast, once the accounts exist — the checkout already has slots.

---

### What was deliberately NOT done

The `my-unplug-backend` package was **not** deployed. It is a second Prisma
backend whose 47 models are almost entirely duplicates of live tables holding
real data, and its own handover says to treat it as a spec. Its
`Representative` roster is, name for name, the `sales_consultants` already
driving commission — adopting it would have meant the same person holding two
ids and referral answers landing where the commission calculation never looks.
The four genuinely new ideas were ported instead (`F9`).
