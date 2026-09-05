# Progress log

One short entry per task, appended at its stop condition. Read this before starting
anything — it is the cheapest way to pick up state without being re-briefed.

---

## 2026-08-28 — Task 01, setup complete

**Spec extraction.** Clean. `docs/spec-extracted.md` holds §1–§5 and §11–§27 plus
MODULE 1–10 and all 75 sub-sections. Nothing was lost: the document's numbering genuinely
skips 6–10, because the MODULE headings occupy that space. That means **22 numbered
sections, not 27** — the handover doc's "27 sections" was the highest section number, not
a count. §11's inner 1–16 list is preserved as written rather than renumbered, so
references back to the original still hold.

**Baseline tests.** Did **not** pass on first run. Fixed — see below. Now
**1,533 passing, 0 failing** (1,532 before, plus one regression test added with the fix).

**Baseline fix — the `analyticsEngine` flake was a real product bug.** It had been written
off as an unexplained flake. It is not: `windowFrom` in `src/routes/analyticsReports.js`
defaulted the window's `to` to `new Date()`, which carries **milliseconds**, while Postgres
records `occurred_at` in **microseconds**. An event written at `28.171889` sits 889µs after
a `to` of `28.171`, so **a report requested in the same millisecond as a payment left that
payment out of its own window**.

Reproduced at roughly two runs in five, on whichever test happened to lose the race — which
is why it looked like flakiness rather than a bug. Proven by printing the payment's
microsecond timestamp alongside the window. Fixed by giving a defaulted `to` one second of
lead; an explicitly supplied `?to=` is left exactly as asked for. 12/12 clean runs after.

In production, reporting windows are days wide, so this only ever dropped an event recorded
in the same millisecond as the request — invisible in practice, but wrong.

**SECURITY.md** — read. Three things bear on the work ahead:

1. **`script-src` still allows `'unsafe-inline'`**, because the dashboards carry 213 inline
   `onclick` handlers. Every new admin control should use a delegated listener, not an
   inline handler, or the strict-CSP work gets further away with each task.
2. **The XSS rule**: build cells with `textContent`, or escape at the interpolation.
   `innerHTML` with a `${}` in it is the exact pattern that produced both stored-XSS holes
   found and fixed here. 174 interpolations remain flagged, mostly false positives.
3. **`bio` must not simply be escaped** — it is rich text by design and needs DOMPurify, the
   way the magazine already does it. Escaping it would show members raw tags.

**Open, needs an answer before the tasks that depend on them:**
- The repo has no stable local checkout — see the note in the task-01 report.
- `00-agent-context.md` and `CLAUDE.md` are two copies of the same briefing and have already
  drifted. `CLAUDE.md` is being treated as authoritative.

**Not started:** any implementation work. Stopped at the task-01 stop condition.

---

## 2026-08-29 — Task 02, reference format consolidated

**What changed.** New `src/utils/reference.js` is the single generation point. The 32-character
alphabet had been written out four times and the collision-retry loop five times, across
`orders.js`, `editionAccess.js`, `competitions.js`, `payments.js` and `admin.js` — the recurring
bug class, with four copies.

**No format changed.** Order references are still `UNP-` + 10, edition references still 10
unprefixed, gateway references still 10 digits, voucher codes still `UNP-` + 6, lookup tokens
still 24. Nothing customers hold is affected. 1,533 passing, unchanged.

**Two generators were using `Math.random()`** — the payment gateway reference and the voucher
code. Both now use `crypto`, via the shared helper. Same shape, same length; a guessable
discount code was the one that actually mattered.

**Formats deliberately NOT unified.** They are different things, not five spellings of one:
`vote_bundles.reference` and `edition_purchases.download_reference` are `VARCHAR(10)`, so a
`UNP-` prefix does not fit without migrating columns live rows already use; the vote bundle
reference IS the contestant's public entry code by design (migration 106); and a voucher code
is not a reference at all. Reasoning recorded at the bottom of `reference.js`.

**Open / flagged, not changed:**
- Cancellation policy copy (`unplug-magazine.html:3896`) tells customers to quote a "10-digit
  payment reference number". True of the numeric gateway reference, wrong for a `UNP-`+10 order
  reference. Customer-facing policy text, so flagged rather than edited.
- Voucher codes share the `UNP-` prefix with order references. `UNP-K3M9XQ` and
  `UNP-K3M9XQ2R7T` are hard to tell apart on a bank transfer. Worth revisiting; not touched.
- Admin display of a reference uses `innerHTML`, but it IS escaped (`escapeHtmlAdmin`). Safe.


---

## 2026-08-29 — Task 03, pricing comparison

**What changed.** Nothing in the code. `docs/pricing-comparison.md` added — 16 spec prices
against what the site actually charges.

**Result: 3 match, 10 differ, 3 specified but not built, 5 charged live but absent from the spec.**

**The big ones.** Bulk vote tiers are the largest gap: only 10 votes / R10 matches, and the live
tiers have different VOTE COUNTS as well as prices, so they do not line up row by row. The live
ladder also stops at 300 votes where the spec goes to 1,000, and its per-vote price is not
monotonic — 50 votes twice (R40) buys more than 70 votes once (R50). Featured listing: the spec
has one price ladder, the site has two (article and directory), and all eight live prices differ.
Event promotion (§5.6, three packages) does not exist anywhere in the codebase — confirmed by
search, not assumed.

**Also flagged, not touched:** the highlight and banner prices exist in THREE places —
`service_packages`, `FALLBACK_PRICES` in `servicePackages.js`, and `HIGHLIGHT_PRICES`/
`AD_BANNER_PRICES` in `payments.js`. Recurring bug class, carrying money: change a price in the
admin screen and both hardcoded copies go stale, including the fallback that exists to be used
when the table lookup fails.

**Open — blocks any pricing work.** Seven decisions listed at the end of the comparison. No price
or pricing code may change until they are answered.

## 2026-08-29 — Task 03 REDONE

The first version compared the spec against migration seed files and called it "live", and
never looked at the frontend at all. Redone against the production API and the live page.

**Found by doing it properly:** the live site contradicts itself. The directory highlight is
R100/R150/R200/R250 on the rate card (what is actually charged) and R250/R300/R350/R400 in the
refunds and cancellation policy — on the same page. **That is where §4.4's figures came from**,
so the spec is not evidence of an intended price; it copied the site's own error. Customer-facing
policy quoting prices nobody pays; first decision on the list.

Also: the banner price sentence appears 10× in unplug-magazine.html, tier prices are hardcoded in
two more HTML files, and the demo file advertises "R250 a month" where everything else is once-off.

Seed figures turned out correct — nobody had edited those tables — but that was luck, not method.

**Open — still blocks all pricing work.** Eight decisions at the end of `docs/pricing-comparison.md`.
No price or pricing code changed.

## 2026-08-29 — Refunds policy corrected

The cancellation/refunds policy quoted the business listing highlight at R250/R300/R350/R400.
The site charges R100/R150/R200/R250 and says so on its own rate card, further up the same page.
Two worked examples carried the same wrong R400.

Examples now use R250. The ladder is removed rather than corrected — the rate card already states
prices, and a second copy in a legal document is what caused this. s19 now reads like its
neighbours s17/s18, which state durations and no figures. **Every refund term is untouched.**

Checked first that production has no `refunds.*` CMS override (it has one override site-wide, and
it is not this), so the file is what readers get. Verified in a browser: old ladder gone, no
"Highlight for R400" survives, rate card reads R100–R250. Suite 1,533 passing.

**Still open:** the CPA review of the no-refund terms themselves — not written without advice.
Seven pricing decisions remain in `docs/pricing-comparison.md`.

## 2026-08-29 — Task 04, breakdown proposed (no code)

`docs/spine-plan.md` added. Task 04 gates code behind sign-off, so this is plan only.

**My first sketch was wrong.** I had read each table's CREATE TABLE; 36 later migrations already
extend those constraints. Effective vocabulary today is `awaiting_payment/pending/approved/rejected`
on **eight tables identically** (articles adds `draft`). The submission model is already one shared
vocabulary nobody wrote down — this task is far smaller than "unify eight systems".

**Key danger, from migration 008:** changing a CHECK is DROP+ADD, and the ADD re-validates the whole
table on every deploy. A list omitting a value some row holds fails as an *outage*, not at write
time. So: strictly additive, never rename a status.

**Blast radius measured** (routes+tests+frontend): gallery_bundles 26, top10_entries 33,
competition_entries 110, marketplace 182, events 334, highlights 409, profiles 1211, articles 1338.
`top10_entries` has **zero tests** — held back to Phase C despite being small.

**Open — blocks all code:** four decisions at the end of the plan (which §16 values to add;
resolver vs reference columns; profiles in or out; casing). Recommendations given for each.

## 2026-09-02 — Task 04 Phase A complete (A1 + A2)

Signed off on my recommendations: add 4 statuses, resolver not columns, profiles out of Phase B,
lowercase stays.

**A1 `src/utils/submissionStatus.js`** — the submission vocabulary in one place. Nine tables already
share `awaiting_payment/pending/approved/rejected` (articles adds `draft`); nobody had written it
down, and it is NOT discoverable from CREATE TABLE because 36 later migrations extend the
constraints. The four Phase-B values are declared with `live: []` — writing one today would violate
a CHECK. **Nothing imports it, and a test asserts that.**

The key test replays all 155 migrations and asserts module↔database agreement in both directions.
Verified it has teeth: faking a live status failed with the table named; dropping a real one failed
the other way. Both restored.

**A2 `src/utils/submissionReference.js`** — the join §10.1 wants. A payment points at a submission;
nothing pointed back. Now both directions, handling cart (`UNP-…`) and single (`gateway_reference`)
shapes, one order holding several services, profiles reachable by two payment types, and retries
(latest wins). A test reads `payments_linked_type_check` from the live schema so a new service added
to the constraint but not mapped fails the build.

**Suite 1533 → 1556.** No table touched, no behaviour changed.

**Next:** Phase B1 `gallery_bundles` (blast radius 26) — the first additive migration. Awaiting go-ahead.

## 2026-09-02 — Task 04 Phase B1: gallery service

Migration 156 adds `changes_requested`, `resubmitted`, `credit_issued` to `gallery_bundles` and
`gallery_images`. Nothing sets them (task 05 does); an unwritable value is inert.

**Three of four, not four.** `expired` deliberately omitted — a gallery submission is a one-off
purchase of photos that stay published, so it has no term to run out. Adding it would create an
unreachable state, which is what the plan argued against. It goes with highlights / ad banners /
marketplace / directory packages instead. Module now records this.

**Verified:** all 156 migrations run **three times** clean; exactly one status constraint per table
afterwards; a row really accepts the new value. Full suite **1557 → 1565**.

**Test change worth knowing:** the "eight tables share one vocabulary" assertion was replaced.
Phase B migrates one service at a time, so tables legitimately differ mid-phase. The real invariant
is that every table keeps all four base values (losing one fails the constraint on next deploy),
plus any extra must be one we deliberately added. Four new DB-backed tests, incl. **exactly one
status constraint per table** (a DROP under the wrong name leaves two, both enforced) and **every
status fits VARCHAR(20)** — found by writing a 23-char invalid status and getting "value too long"
instead of a constraint error.

**Note:** `icons/icon-192.png` vanished from the working tree again — third time files have
disappeared from this temp checkout. Restored from HEAD. The stable-checkout item is still open.

**Next:** B2 `marketplace_listings` (blast radius 182) — and it DOES expire (30 days), so it takes
all four statuses.

## 2026-09-02 — Task 04 Phase B2: marketplace listings

Migration 157 adds all **four** Phase-B statuses to `marketplace_listings`. Unlike the gallery it
runs for a term (`duration_days` 7/14/21/28 + `active_from`/`active_to`), so `expired` is reachable.

Expiry today is **implicit** — past `active_to` a listing stops appearing while its status still says
`approved`, so no report can tell a running listing from one that ended months ago. `expired` names
that state. **Nothing transitions to it yet** — that needs a decision on whether the date or the
status is authoritative once both exist.

Module now records `EXPIRING` vs `REVIEWED` so the next service doesn't rediscover the distinction.
New test: every declared status must be live somewhere or honestly reported pending — after B2
`notYetLive()` is empty, nothing stranded.

**Verified:** 157 migrations × 3 passes clean, one constraint per table, row accepts new value.
Suite **1565 → 1567**.

**Noted, not changed:** `cancellations.js` stops a listing by setting status `'rejected'`. A
cancellation is not a rejection — different meanings for reporting. Worth separating when that
pathway is next touched.

**Next:** B3 `events` (blast radius 334).

## 2026-09-02 — Task 04 Phase B3: events

Migration 158 adds all four Phase-B statuses to `events`. `expired` applies: the feed already drops
past events via `event_date >= CURRENT_DATE` while status still reads `approved`, so nothing can
distinguish an upcoming event from one that happened last year.

Rule now asserted, not remembered: a service gets `expired` only where something can end it —
marketplace (duration + active_to), events (date). Gallery still the sole exception.

**Real bug found, deliberately not fixed:** `events` has no end date, so a multi-day festival is
removed from the site part-way through (`event_date` is the start). Decision #4 already covers adding
an end-date field; doing it here would put a new column + a public-feed change inside a
values-only migration. Recorded in the migration file.

**Verified:** 158 migrations × 3 passes clean, one constraint per table, row accepts new value.
Suite **1567 → 1569**.

**Next:** B4 `highlights` (blast radius 409) — it has durations, so all four again.

## 2026-09-02 — Task 04 Phase B4: highlights

Migration 159 adds all four Phase-B statuses to `highlights` (durations 7/14/21/28 + start/end dates,
so `expired` applies).

**Route changed in the same commit, deliberately.** `GET /highlights/mine` ended its label chain with
`else label = 'Active'` — any new status would have told the member their highlight was running. A
rejected-and-credited highlight would read "Active". Added labels: Changes needed / Changes
submitted / Credit issued / Completed. New test reads the branches out of the route so a future
status without a label fails the build.

**Verified:** 159 migrations × 3 passes clean, one constraint per table, row accepts new value.
Suite **1569 → 1571**.

**Noted, not changed:** `rejected` is doing two jobs — `cancellations.js` writes it when a member
cancels, and this route displays it as "Cancelled". So a refused submission is shown as cancelled,
and a cancellation looks like a refusal. Needs the cancellation pathway separated (task 05 territory).

**Next:** B5 `articles` (blast radius 1338, the largest). Then profiles, which you deferred.

## 2026-09-02 — Task 04 Phase B5: articles (Phase B complete)

Migration 160 adds three statuses to `articles` — the largest service (1338 refs). **No `expired`:**
an article has no duration or end date; `scheduled_for` holds it back UNTIL a date, then it stays.
Five services in, the rule never needed bending — `expired` only where something can end the service.

`articles.js` returns the raw status (no label chain), so no route change needed. Checked, not assumed.

**Verified:** 160 migrations × 3 passes clean, one constraint per table, row accepts new value.
Suite **1571 → 1572**.

### ⚠ BLOCKS TASK 05 — approval queue misses `resubmitted`

`adminApprovalQueue.js` selects work with `WHERE status IN ('pending','awaiting_payment')` across
**eight services**. `resubmitted` is not in that list. The moment task 05 turns request-changes on, a
member answering a change request moves to `resubmitted` and **their submission vanishes from the
admin queue** — nobody sees it, the member waits forever. Nothing sets it today so nothing is broken
now. Flagged not fixed: it spans every service, and scope additions are yours to approve.

### Phase B status
Done: gallery (B1), marketplace (B2), events (B3), highlights (B4), articles (B5).
Deferred by your sign-off: **profiles**. Phase C (payments/orders, competitions, votes) not started.

## 2026-09-02 — Approval queue: resubmitted work no longer lost

`adminApprovalQueue.js` selected only `pending` + `awaiting_payment`. `resubmitted` was in **none**
of its sources — so once task 05 ships, a member answering a change request would have vanished from
the admin screen entirely.

**Ten sources, not eight.** Eight use `status IN (...)`; the two highlight sources use
`h.status = 'pending'` — equality, easy to miss by eye. My first pass found eight; the test found the
other two. All ten now include `resubmitted`.

**Left alone deliberately:** `orders`, `payments`, `vote_bundles` (payment vocabularies) and
`share_cards`, `shoutout_nominations`, `profile_claims` (separate review flows outside the spine).
The coverage test asks `SUBMISSION_TABLES` rather than hardcoding that judgement, so it can't drift.

**Tests (4):** a real resubmitted article AND marketplace listing appear in the queue; every spine
service's filter includes it; the queue *reaches* every spine service that can hold it
(`gallery_bundles` the one expected absence — reviewed via its images); and approved/rejected/
credit_issued are still excluded so admins aren't asked to re-decide settled work.

**Fact worth recording:** marketplace `duration_days = 30` exactly (migration 010 narrowed it from
7/14/21/28 — the CREATE TABLE still shows the old list).

Admin-only, so tests + smoke check per protocol. Frontend doesn't filter the queue, so the dashboard
keeps whatever the query returns. Suite **1572 → 1577**.

## 2026-09-02 — Task 05 complete: changes-requested and credit-on-rejection

**05a — credit on rejection (§10.7).** The pathway mostly existed; it set `'rejected'`, the same as a
plain refusal, so nothing could tell an editorial decision from one that moved money. Now
`credit_issued` — asked for via `isLiveFor()`, falling back to `'rejected'` on services not yet
migrated (writing it there would violate their CHECK). Reference recorded in the note and reachable
via `payment_id`; **not** copied into a column. First real consumer of the Phase A module.

**05b — request changes (§10.14).** New: `POST /admin/approval-queue/:type/:id/request-changes`,
`GET /change-requests/mine`, `POST /change-requests/:id/resubmit`. Migration 161 adds
`change_requests` (one table, not 36 columns across 9 submissions); partial unique index enforces
one *open* request per submission while keeping history.

Fields reuse the queue's own editable whitelist, so requestable ≡ editable and nothing names a
column. Member sees the admin's labels ("Cover image"), not column names.

**Ownership isn't uniform** — direct (articles/events/profiles/investors), via advertisers
(marketplace), or **absent** (gallery images belong to a bundle; share cards have no account). Those
are refused *with the reason*, recorded in `src/utils/changeRequests.js`.

**Three existing tests changed deliberately**, incl. inverting Phase A's "NOTHING IMPORTS THIS YET"
guard — it existed to force exactly this acknowledgement.

**Verified in-browser** against a real backend: full round trip closes (requested → member sees
labels → resubmitted → back in admin queue → off member's list), both endpoints reject
unauthenticated, gallery refused with its reason. Migration 161 × 3 passes clean.
Suite **1585 → 1600**.

**Open:** profiles/top10/competition_entries still unmigrated, so they fall back to `'rejected'` and
can't take change requests. Member dashboard has no UI for `/change-requests/mine` yet — the API is
live but nothing surfaces "ACTION REQUIRED" to members.

## 2026-09-02 — Member-facing UI for change requests

"Action required" card at the top of the member's Profile panel, hidden until there is something in
it. Shows the fields the admin ticked (**in the admin's labels** — "Cover image", not
`banner_image_url`, resolved from the queue's DETAILS whitelist) plus their note, with a button that
calls resubmit and nothing else — each service keeps its own editor.

**Built with createElement/textContent, never innerHTML** — the note is admin-written and stored,
the shape that caused both prior stored-XSS holes. Verified: a note of
`<img src=x onerror="window.__PWNED=1">` renders as text, `__PWNED` stays 0, zero injected elements.

**Browser-verified against a real backend:** card appears with correct plural summary, two items
render (one with fields, one note-only), pressing the button drops that item and the server agrees,
answering the last hides the card. A failed load shows nothing rather than an empty red panel.

Member-only page, no money/votes/public content → suite + browser check per protocol.
Suite **1600**, unchanged (frontend only).

**Still open:** notifications (§10.17) don't fire on a change request — the member only sees it if
they open the dashboard. Profiles/top10/competition_entries still unmigrated.

## 2026-09-02 — Notifications + the last three services (Phase B complete)

**Notifications (§10.17).** Asking for changes now writes an in-app notification AND sends an email,
naming fields in the admin's labels. New `src/utils/memberNotify.js` — the notifications table, email
transport and `notification_preferences` already existed but were wired together per call site; this
is those three steps written once. §10.17 lists 25 events; this is the first, and the rest shouldn't
each reinvent it.

**Never throws, never in the transaction.** Runs after COMMIT, not awaited, swallows its own errors —
if the mail provider is down the change request must still stand. A test asserts that *ordering*.
Opt-outs respected; a missing/unreadable preferences row defaults to ON (an unwanted email is a
smaller harm than a member never finding out).

**Migration 162** — profiles, competition_entries, top10_entries. **All 9 submission tables now share
the review vocabulary.** profiles is the one that matters: a returnable submission, so a Directory
listing can be handed back for a better bio instead of refused. profiles takes `expired` (`renews_at`
= a term); the two entry tables don't (an entry ends when the *competition* closes — that's the
competition's state). Rule unbent six times running.

**Does NOT decide the profiles visibility question** — `status` still means approval; whether a second
visibility field is needed stays open with the Directory Listing work.

**Three tests fixed**, two stale after 162 and **one a real flake of mine**: the notification test
polled for the *newest* notification and asserted it was its own. Notifying is fire-and-forget and
other tests send them too, so another's could land first — passed alone, failed in the suite. Now
polls by content. Same async-write shape this codebase has been bitten by before.

Migration 162 × 3 passes clean. Suite **1600 → 1606**.

**Still open:** profiles visibility-vs-approval; the other 24 §10.17 events; `rejected` still doing
double duty as "refused" and "cancelled"; multi-day events vanishing part-way through.

---

## 2026-09-02 — Multi-day events no longer vanish part-way through themselves

**The bug.** `events` carried `event_date`, `start_time` and `end_time` but **no end date**, and the
public feed asked `status = 'approved' AND event_date >= CURRENT_DATE`. A festival running Friday to
Sunday has one `event_date` — Friday — so **it left the site on Saturday morning, while it was still
running and still selling tickets**. `start_time`/`end_time` are times of day, not dates, so they
never helped.

**Migration 163** adds `end_date DATE`, NULL meaning "one day". `event_date` keeps meaning *when this
starts* everywhere it is read — widening it would have silently changed the homepage ordering and the
meaning of every existing row. NULL on every existing row means **nothing needed backfilling and
nothing changes for a single-day event**, which is what makes it safe against live data.

The feed now filters `COALESCE(end_date, event_date) >= CURRENT_DATE`, with a matching index.
`events_end_date_check` is dropped and re-added each deploy (ADD CONSTRAINT has no IF NOT EXISTS) and
so re-validates the whole table every time — it passes because it is satisfied by NULL, and a
violating row can never get in. Verified over **three full migration passes with a real multi-day row
present**, not just an empty table.

**Two defects found in my own change before it shipped:**

1. The admin form sent `endDate: ... || undefined`. `JSON.stringify` drops undefined keys and the
   PATCH skips what it is not sent, so **Undo would have appeared to work and silently left the end
   date on**. Now `null`, matching the adjacent time fields. Test: `UNDO CAN TAKE THE END DATE BACK
   OFF AGAIN`.
2. The PATCH had **no end-before-start guard at all** — an admin editing would have got a raw 500
   from the constraint. Rather than re-implement the rule (a PATCH can set the end date without
   sending the start date, so it depends on the stored row), the constraint stays the single
   authority and its violation is translated into a sentence.

**A latent date bug found and deliberately NOT fixed.** `pg` turns a DATE into a Date at *local*
midnight and `JSON.stringify` then writes it in UTC, so east of Greenwich both dates serialise as the
**day before** the one stored. Reproduced on this machine (SAST). **Live is unaffected — Render runs
in UTC**, confirmed against the production API, which returns `2026-10-31T00:00:00.000Z`. Every
frontend reader uses `String(...).slice(0,10)`, which is zone-safe, so it is contained. Asserting the
absolute date would fail on any developer machine east of Greenwich while passing in production;
instead the test asserts `end_date` travels **identically to `event_date`**, so the new column cannot
grow a second, different date bug. **Flagged, not fixed — it would change the wire format of
`event_date` and touch the public page.**

**The public page**, not just the backend: the card now says *"Until 2 Sep"* (the badge shows the
first day, which alone reads as a one-day event), and **Add to Calendar spans the whole run** —
verified as `20260831/20260903`, Google's exclusive end, covering all three days.

`editions.js` also filters on `event_date >= CURRENT_DATE`, but that is `edition_calendar` — separate
table, single-day markers by design. Correctly untouched.

**Verified in a browser against a real backend** (real Postgres, real migrations, the real Express
app, the page served over http so its localhost API base is honoured), seeded with a festival that
started yesterday and ends tomorrow alongside a past and a future single-day event. Rendered card
text read from the live DOM: `31 AUG | Deaf Arts Festival (3 days) | Until 2 SEP · Cape Town City
Hall · R50`. The past single-day event and the finished festival were both correctly absent.

**Tests have teeth** — reinstating the old condition fails exactly the two multi-day tests while the
single-day test still passes, proving they are not coupled.

Suite **1606 → 1624**, 0 failing.

**Still open:** the UTC/local date serialisation above; profiles visibility-vs-approval; the other 24
§10.17 notification events; `rejected` still doing double duty as "refused" and "cancelled".

---

## 2026-09-02 — The DATE timezone shift, fixed at the source

**The bug.** node-postgres parses a `DATE` (type 1082) into a JavaScript Date at **midnight in the
server's own timezone**, and `JSON.stringify` then writes that Date in UTC. East of Greenwich the two
disagree about which day it is:

```
stored in Postgres   2026-10-31
parsed by pg         2026-10-31 00:00 SAST
sent as JSON         "2026-10-30T22:00:00.000Z"
read by the page     "2026-10-30"        <-- the day before
```

An event on Saturday published as Friday, a listing expiring a day early, a scheduled article
appearing a day late — with nothing in the logs, because every layer did exactly what it was told.

**Latent, not live.** Render runs in UTC, where local midnight and UTC midnight are the same instant,
so production was correct — confirmed against the live API before and after. It was already real on
any developer machine outside UTC, which is how it surfaced.

**The fix — `src/pgTypes.js`, one type parser.** A DATE has no time and no zone, so there is nothing
to convert it to; Postgres already sends the text we want. `setTypeParser(1082, v => v)` hands that
through untouched. Required by `src/db.js` and `db/migrate.js` so a request and a migration can never
disagree about what day it is.

**Deliberately global rather than per-query.** Casting with `to_char` in each SELECT restates the same
rule in dozens of places, and a rule stated in dozens of places drifts — this project's most repeated
bug. This covers all ~29 DATE columns and any added later.

**Scope checked before changing anything:** 0 bare `TIMESTAMP` columns (282 are `TIMESTAMPTZ`, which
genuinely is an instant and is left alone); **0** server-side `Date` method calls on a DATE column;
21 frontend readers use `String(x).slice(0,10)` (identical either way), 0 use `.split('T')` or
`.substring`, and the only two `new Date(...)` sites are on `renews_at`, a TIMESTAMPTZ. The wire
format changes from `"2026-10-31T00:00:00.000Z"` to `"2026-10-31"`; confirmed with the owner that
nothing outside this repo reads the API.

**Two things this also fixed, both latent:**

1. **`highlights.js`** built `today` as UTC midnight but `start_date`/`end_date` as local-midnight
   Dates — a half-finished version of the "second clock" fix already documented in that file. Both
   are now UTC midnight, so the comparison is right in every timezone rather than only in UTC.
2. **`backupDump.js`** wrote a DATE as `'2026-10-31T00:00:00.000Z'` via `toISOString()`, carrying the
   shift into the dump. **Restoring a backup on a non-UTC server would have moved every date by a
   day.** It now writes `'2026-10-31'`.

**A wrong call, corrected.** I read `polls.js`'s `String(row.starts_at) > today` and reported a live
bug — every scheduled poll closed to voting. **That was wrong.** polls.js already casts every
`starts_at`/`ends_at` with `to_char` in all six of its queries, so the comparison always received
text and was always correct. My reproduction tested a hypothetical path, not the real one. Verified
by removing each protection in turn: with either the casts or the parser present the tests pass, and
only with **both** removed do four fail. `test/pollSchedulingDates.test.js` is kept because those
casts read like display formatting but are load-bearing arithmetic, and poll scheduling had no direct
coverage at all.

**Tests.** `test/dateNoTimezoneShift.test.js` asserts the *shape* — a DATE arrives as its own
`YYYY-MM-DD` text, never a Date object — so it fails on a UTC CI box too, where asserting an absolute
date would pass no matter how broken the parsing was. One test re-runs the query in a forced UTC+14
child process. Teeth checked: 5 of 7 fail with the parser removed, and the two that still pass are
exactly the two that should be unaffected (NULL handling and TIMESTAMPTZ).

**Verified in a browser against a real backend running in UTC+14**: stored `2026-09-22`/`2026-09-24`
rendered as `22 SEP · Until 24 SEP`. Before the fix that server would have shown `21 SEP · Until 23
SEP`. No `Invalid Date`, no `NaN`, no raw ISO on the page.

Suite **1624 → 1638**, 0 failing — including all 1624 pre-existing tests unchanged under a global
change to every DATE column.

**Still open:** profiles visibility-vs-approval; the other 24 §10.17 notification events; `rejected`
still doing double duty as "refused" and "cancelled".

---

## 2026-09-02 — Task 06, the shared My Unplug pattern + My Submissions (1 of 12)

**The task's premise was out of date.** It says five of 17 menu items exist; the dashboard already
had **12 sections**, and the backend had `/orders/mine`, `/payments/credit`, `/articles/mine`,
`/gallery/mine`, `/highlights/mine`, `/ad-banners/mine` and `/competitions/entries/mine`. Genuinely
missing on the backend: **events-mine, listings-mine, and invoices entirely** (no table, no endpoint).

**Three decisions taken with the owner before building:** convert `Content` → My Submissions with the
per-entity items as filtered views over one template (not a second system beside it); the twelfth
item is **My Votes / Competition Activity**; invoices get a **real table** when built, since §10.5
needs a stable number.

**The pattern — `src/utils/mySubmissions.js`.** One descriptor per §4 menu item, each returning the
same shape: `{ type, typeLabel, id, title, status, statusLabel, submittedAt, expiresAt, amount,
paymentStatus, reference }`. My Articles / Events / Listings / Advertising / Competitions are that
list with `?type=` — one renderer, one status vocabulary, six entry points. SQL is written out per
type rather than generated, following the reasoning already settled in `changeRequests.js`'s
`OWNER_SQL`: each route to an owner is genuinely different (author_user_id, organizer_user_id,
through advertisers, through the member's profile) and five explicit queries are easier to check than
one clever one.

**Status wording now has a single home.** `STATUS_LABEL` is the only place a member-facing status
word is decided, and a load-time check fails startup if it names a status the vocabulary doesn't
have. The highlights label chain previously ended a `credit_issued` submission with "Active"; a test
asserts no status is left to a fall-through.

**Retired `Content`, extended rather than duplicated.** It only ever showed articles, gallery and
competition entries — **events, listings and advertising were invisible to members entirely.** The
new section covers all six, grouped needs-attention → with-us → approved → finished, so the
status-first grouping members had is kept. `loadMemberContent()` survives as a shim so its six call
sites still work. Rendered with `createElement`/`textContent` per SECURITY.md.

**One self-inflicted bug worth recording:** requiring `utils/mySubmissions` at a test file's top
level pulls in `src/db.js` and builds its pool while `DATABASE_URL` is still unset. Node caches that
dead pool, the route then gets the same one, and **every query hangs until the test times out**
rather than failing readably. Require it inside `before()`. The smoke script hit the mirror image of
this on teardown.

`scripts/smoke-my-submissions.js` takes a type, so the remaining eleven sections reuse it rather than
each growing a check of its own. 20/20 checks pass.

Suite **1638 → 1652**, 0 failing.

**Flagged, not built** (scope additions are the owner's call): no way to cancel or withdraw a
submission from this view; no detail view behind a row — §4 names the menu items but specifies no
fields, so the row shows what the spine actually knows.

**Still open:** the other 11 sections; profiles visibility-vs-approval; the other 24 §10.17 events;
`rejected` still doing double duty as "refused" and "cancelled".

---

## 2026-09-02 — Task 06: My Services (§5), and the pattern extended to term-based services

**Second of the twelve My Unplug sections.** §5 names six buckets and stops there, so this
decides only which bucket a service is in and invents no fields: **awaiting payment ·
requiring changes · pending · expiring · active · expired**, in that reading order — what needs
you first, then what is running, then what is over.

**Scope, as agreed:** things with a term *plus* submissions, **except competitions**. An entry is
not bought for a period and cannot be renewed — it ends when the competition closes, which is the
competition's business, not the member's. Competitions stay in My Submissions.

That meant adding the two term-based types the pattern was missing:

- **highlights** — no owner column at all. A highlight points at an article or a directory profile
  and the owner is whoever owns *that*, so both routes are joined. Checking only one would have
  silently hidden half a member's highlights.
- **profile** (the paid directory listing) — `renews_at` is the end of its term, which is why the
  spine counts profiles as expiring even though the row never goes away.

**The bit worth remembering.** Adding types to the shared `TYPES` map would have silently changed
what My Submissions shows. So each menu item now names its own set — `SUBMISSION_TYPES` and
`SERVICE_TYPES` — and `listFor` takes the set explicitly rather than defaulting to "everything".
A type outside a menu item's set is refused there rather than quietly served. Four existing tests
failed on exactly this boundary and were right to: they had encoded the old assumption that
`TYPE_KEYS` was what My Submissions shows.

**Today comes from the database**, not from Node. Whether a service has expired is a question about
the same clock that stored its dates; working it out in the browser is a second clock that
disagrees whenever the server's local date is ahead of UTC — the bug the highlights dashboard
already had, and the reason the buckets are computed server-side and sent down whole.

**A judgement, not a requirement: `EXPIRING_WITHIN_DAYS = 30`.** The spec asks for an Expiring
bucket without saying how wide it is. 30 days matches the marketplace listing duration exactly and
leaves room for an EFT to clear before a service drops, which matters on a site paid by EFT. One
named constant, so changing it is changing one number. **This was my call — say if it should be
14 or 7.**

**Frontend:** rows are drawn by `subsRow`, unchanged. My Services is a different *reading* of the
same list, not a second list — which is what the shared pattern was for. The nav now separates
**Browse Services** (the catalogue — what you can buy) from **My Services** (what you have).

Suite **1652 → 1671**, 0 failing. Smoke check 31/31.

**Still open, flagged not built:** §10.9 wants expired services to offer one-click **RENEW** with
the previous details prepopulated — that is §10.9, not §5, so it is not in this section. No way to
**cancel** a service from this view either (the Payments section still owns cancellation). And
`rejected` continues to do double duty as "we refused this" and "you cancelled it", so the wording
"Not approved" is right for the commoner case and wrong for the other.

**Remaining of the twelve:** My Orders, My Credits, My Invoices, My Votes / Competition Activity,
Account Settings — plus user-facing invoices (§10.5), which needs the `invoices` table decided
earlier and is the only one carrying a schema change.

---

## 2026-09-02 — Task 06: My Orders (§4 / §10.4)

**Third of the twelve.** Both endpoints already existed and were correctly scoped — `/orders/mine`
and `/orders/:id` with an owner-or-admin check. What was missing was that an order line said
`ad_banner`: a receipt written for the database rather than for the person who paid.

**One place for service names.** `SERVICE_LABEL` now sits in `utils/submissionReference.js`, which
already owns `linked_type` knowledge, covering all 13 payable types. The module **throws at load**
if a `linked_type` in `SUBMISSION_TABLE` has no wording, so adding a payable service without naming
it is a startup failure rather than a raw database key turning up on somebody's order. An unknown
type is shown as itself rather than hidden — a line a member paid for must always appear, even if
it is named badly.

`/orders/mine` now aggregates the linked types per order so the list can say what each order was
*for* without a request per row; `/orders/:id` adds `serviceName` per line. The name is worked out
server-side so an order, an invoice and a receipt cannot call the same purchase three different
things — which matters because My Invoices is next and will read the same data.

**Money is shown as stored, never recomputed in the browser.** §10.4 lists subtotal, voucher,
credit and total as separate lines because they are separate facts. A test asserts they still add
up (subtotal − voucher − credit = total), not as a rule the code enforces but so a member is never
left doing arithmetic that does not work.

**Two schema facts worth recording**, both found by tests failing:
- `payments.gateway_reference` is NOT NULL and UNIQUE.
- **`payments.status` is `pending | confirmed | failed`** — a different vocabulary from the
  submission one. The order pill is worded from it separately for that reason, rather than reusing
  the shared status wording.

Suite **1671 → 1682**, 0 failing. Smoke check 34/34.

**Still open:** no way to pay an unpaid order from this view, and no proof-of-payment upload
(`orders.pop_url` exists and the Payments section owns that flow). Left alone rather than
duplicated.

**Remaining of the twelve:** My Credits, My Invoices, My Votes / Competition Activity, Account
Settings.

---

## 2026-09-02 — Task 06: My Credits (§4; rules in §10.6 and §10.7)

**Fourth of the twelve.** "Account Credits" already existed — as a card in a corner of the
**Profile** page, not the menu item §4 asks for. **Moved, not duplicated**, the same call made for
Content → My Submissions.

**§10.7's "original reference" now reaches the member.** The ledger stored `payment_id`, which
means nothing to the person reading it. `historyFor` joins payment → order so each line carries the
**reference the member was shown at checkout and put on their EFT**, plus what the credit was for
(reusing `serviceLabel` from My Orders, so the same purchase is named the same way on an order and
on a credit).

**Wording in one place.** `REASON_LABEL` in `accountCredit.js` turns `declined_submission` into "Credit
for a submission we could not approve". The dashboard previously showed the raw enum with
underscores swapped for spaces — a column name wearing a hat. A test reads the **database CHECK
constraint** and asserts our wording covers exactly the reasons the ledger allows, so a new reason
cannot ship unworded.

**Deliberately not shown: which admin issued the credit.** §10.7 requires it *recorded*, and it is
(`created_by`, asserted by a test). Showing a member which member of staff declined their submission
is a different decision and not one the spec asks for.

**The renderer now builds nodes.** It was `innerHTML` with a concatenated string; a credit note is
typed by an admin and a reference comes from a payment gateway, so neither belongs there.

**First coverage the credit ledger has ever had** (12 tests). The one that matters: the balance is
`SUM(ledger)` and the history must add up to the balance shown above it — if those two disagree the
site is lying to a member about money it owes them. Negative lines are shown as spends rather than
hidden, or credit appears to vanish between visits.

Suite **1682 → 1694**, 0 failing. Smoke check 37/37.

**Remaining of the twelve:** My Invoices (the one with a schema change), My Votes / Competition
Activity, Account Settings.

---

## 2026-09-02 — Task 06: My Invoices (§10.5) — schema change, VAT, full protocol

**Fifth of the twelve, and the only one carrying a migration.**

**What was already there:** an admin-triggered PDF generator (`utils/pdfDocs.js`) that uploads to
Supabase and stores a URL on the payment. It had **no invoice number**, and members could not see it
at all. That generator is reused rather than duplicated.

**Migration 164** adds `invoices`, a sequence, and `next_invoice_number()` — one SQL function that
both the backfill and the application call, so a number issued by a migration and one issued by a
checkout cannot end up in different shapes. **Backfilled every already-confirmed order**, oldest
first, so members who paid before today have their invoices too.

**The money is copied, not joined.** An invoice records what was charged *at the moment it was
issued*; a test corrupts the order behind an invoice and asserts the invoice does not follow it.
That duplication is the accounting behaviour, not an oversight.

**VAT — the plan changed mid-task.** The code carried a documented decision that nothing charges
VAT. The owner corrected that: **all prices are VAT-inclusive**, and confirmed Unplug is
VAT-registered. So VAT is the portion *inside* the total, not 15% added on top:

```
vat = total × 15/115      R400 incl. = R52.17 VAT on R347.83
NOT total × 0.15          (which would be R60.00 — overstating tax on every invoice)
```

The net is derived by subtraction so `net + vat` equals the total exactly; a test checks that across
ten awkward amounts including 0.01 and 12345.67.

**The VAT registration number is a setting, seeded EMPTY.** It is a fact about the business, not
something source control should invent. An admin sets it via
`PATCH /admin/settings/vat_registration_number`. Until it is set the document renders as a plain
INVOICE with no VAT line and does not call itself a tax invoice — the safe direction to fail,
because a tax invoice missing its registration number is worse than one that does not claim to be
one. A migration test proves a deploy cannot wipe the number once set.

> **STILL NEEDED FROM THE OWNER: the actual VAT registration number.** Until it is entered, live
> invoices show no VAT. Everything else works.

**The PDF is streamed, never stored.** Rendered from the invoice row on request, so it always
matches the record and needs no file storage. Fetched with the auth header — a plain link sends no
token.

**Verified (full protocol, this touches money):**
- Suite **1694 → 1718**, and 1718/1718 pass. *(One full-suite run showed 7 failures in
  `dateNoTimezoneShift`; the cause was `could not create any TCP/IP sockets` — a port bind, not
  code. Re-ran that file alone: 7/7, zero socket errors.)*
- Migration 164 run **four times** over: passes 3 and 4 change nothing — same rows, same numbers,
  no sequence values burned.
- **Browser, against a real backend in a real dashboard:** two invoices listed, `INV-2026-000001`
  showing `Excl. VAT R347.83 · VAT @ 15% R52.17 · Total incl. VAT R400.00`, PDF downloading as a
  real `%PDF` with the number and VAT number on it.

**Flagged, not built:**
- **Test ports are `base + (process.pid % 300)`**, which on Windows can land in a reserved range and
  fail an entire file at random. Pre-existing, affects ~109 test files, and it is why a clean run
  can look broken. Worth a separate task.
- The admin's stored `invoice_url` PDFs and these generated ones are now two documents for one
  purchase. The admin flow is untouched, but they should probably converge.

**Remaining of the twelve:** My Votes / Competition Activity, Account Settings.

---

## 2026-09-02 — Task 06: My Votes / Competition Activity (§4; rules in Module 9)

**Sixth of the twelve.** The interesting constraint here turned out to be a privacy one.

**§9.1 says online voting "requires NO account".** So a vote carries *either* a `voter_user_id` or
a `session_id`, and the anonymous ones belong to a browser, not a person. This shows a member only
what they did **while signed in**, and says so on the page. It does not try to infer that a session
was probably them — telling someone "you voted for X" when they did not is worse than showing them
less. The same applies to bulk vote purchases (§9.5), which can also be bought without an account.

**Two things a member would otherwise count by hand:** total votes cast, and total spent on
packages. `totalVotes` sums **votes, not rows** — a bundle row of 50 is fifty votes, and counting
rows would tell someone who bought the Ultimate package that they had cast one. Only *confirmed*
bundles count toward what was spent; an unpaid one is not money anybody has spent.

**A real bug the tests caught.** `vote_bundles.status` allows **four** values live —
`awaiting_payment, confirmed, rejected, reversed` — not the two in its original CREATE TABLE;
`rejected` and `reversed` arrived in migration 095. My first wording map had only two, so a member
whose bundle had been reversed would have been shown the word "reversed" straight out of the
database. The test that compares the wording map against the live CHECK constraint is what found
it — the same guard that has now paid off twice (credits, and here).

`reversed` gets its own word rather than being lumped in with a refusal: those votes counted, and
then stopped counting, which is a different thing to a purchase that was never accepted.

**Two mistakes of mine, both in the tests rather than the code**, recorded because they will recur:
- `idx_votes_once_user` allows one vote per member per entry, so the bulk-vote fixture needed its
  own entry.
- `SELECT id FROM competitions LIMIT 1` picked up **"The Arena"**, which a migration seeds. A test
  that wants its own competition has to name it.

Suite **1718 → 1731**, 0 failing. Smoke check 42/42.

**Flagged, not built:** §9.2's rule is a maximum of 5 online votes per calendar day spread across
at least two contestants. Showing a member how many they have left today would be genuinely useful,
but §4 asks for an activity list and that is a different feature — scope addition, your call.

**Remaining of the twelve:** Account Settings.

---

## 2026-09-03 — Task 06: Account Settings (§4) — the last of the twelve

**This one does not fit the shared pattern, and is built differently on purpose.** Every other My
Unplug section renders a *list of things you submitted* through one renderer. Account Settings is a
set of controls that **change state** — forms and switches, not rows — so it has its own section and
does not reuse `subsRow`. Flagged before building, as the task asked.

**What it consolidates:** the password card, **moved** out of Profile (changing your password is an
account setting, not a profile field — the same call made for Account Credits). It links to **Your
Data** rather than duplicating export or deletion.

**Two gaps closed, both approved first — capabilities that existed but no member could reach:**

1. **Notification preferences.** The table has existed since the notifications work, and
   `memberNotify.js` has been **reading** it to decide whether to email somebody — but nothing ever
   wrote to it and no screen ever showed it. **A member could be emailed with no way to stop it.**
   `GET`/`PATCH /my/notification-preferences` are the missing half. A test compares this screen's
   defaults directly against `memberNotify.preferencesFor`, because if the two disagree a member is
   told one thing and sent another; another follows a switch through to the function that actually
   decides whether to send, since a preference that saves but does not take effect is worse than no
   preference at all.

2. **Two-factor sign-in.** Five working endpoints, complete and careful — and **no member UI at
   all**. The only mention of it anywhere in the frontend was a sentence in the privacy blurb. Now
   reachable: set up, confirm, recovery codes shown once, turn off. The secret is shown as text as
   well as being enrollable, because a camera that will not read a QR code should not mean somebody
   cannot enrol.

**Each switch saves on its own** — a settings screen with a Save button people forget to press is a
screen that does not work — and a failed save puts the switch back rather than leaving it showing a
change that never happened.

Suite **1731 → 1744**, 0 failing. Smoke check **51/51**.

**Still open, unchanged:** account deletion remains an email request, deliberately (an account can
own paid listings, published articles and payment records). Changing the account *email address*
has no endpoint anywhere — flagged, not built.

**All twelve sections are now built.** A combined pass across the whole My Unplug area follows
before this task is called complete.

---

## 2026-09-03 — Task 06: combined pass across My Unplug, and the task's close

All twelve sections built, so this is the combined pass the stop condition asks for. It is a new
script, `scripts/audit-my-unplug.js`, which asks a different question from the per-section smoke
check: **does the area hold together?**

- every §4 menu item is present, once
- every nav button points at a section that exists, and every section is reachable from the menu
- **every section that loads data is wired to a click** — a section wired to nothing shows
  "Loading…" for ever, which is precisely the bug found by hand during the invoices browser check,
  so it is now checked mechanically instead of noticed by luck
- nothing that was MOVED (the password card, the credits card, the retired Content section) was left
  in two places
- the shared pattern is still shared: My Services and My Submissions both draw rows with `subsRow`,
  or the "one renderer" claim has quietly stopped being true

**It found two things on its first run, and one of them was its own bug:**

1. **"My Profile" was missing.** The nav said "Profile" while §4 says "My Profile", and every other
   item is "My X". Renamed to match the spec's own wording.
2. **A duplicate `services` section — which did not exist.** The regex matched the attribute
   anywhere, so it counted a `querySelector` string in the page's own JavaScript as a section
   declaration. The audit was wrong, not the page. Narrowed to `<section>` elements only.

**Teeth checked**, since it passed immediately after being changed: unwiring My Invoices from its
menu item makes it fail with "the section would sit on 'Loading…' for ever", and putting the credits
card back in two places makes it fail too.

Suite **1744**, 0 failing. Smoke **51/51**. Audit **PASS**.

### Task 06 is complete — all twelve sections

| Section | Note |
|---|---|
| My Submissions | the shared pattern; converted from "Content" |
| My Articles / Events / Listings / Advertising / Competitions | the same list, filtered |
| My Services | §5's six buckets, read by term |
| My Orders | §10.4 money as stored, service names in one place |
| My Credits | §10.7's original reference reaches the member |
| My Invoices | §10.5; migration 164, stable numbers, VAT-inclusive |
| My Votes | §9.1's anonymity respected |
| Account Settings | does not fit the pattern, built differently on purpose |

**Left for you, in the order I would do them:**

1. **The VAT registration number.** Live invoices show no VAT until it is set. One PATCH to
   `/admin/settings/vat_registration_number`.
2. **Test ports** are `base + (pid % 300)`, which on Windows can land in a reserved range and fail an
   entire test file at random. It cost one run during this task. ~109 files affected.
3. **Two documents for one purchase** — the admin's stored invoice PDFs and the new generated ones.
   The admin flow is untouched; they should converge.
4. `rejected` still does double duty as "we refused this" and "you cancelled it".
5. Smaller: no way to cancel a submission or pay an unpaid order from these views; no endpoint to
   change an account email address; §9.2's daily vote allowance is not surfaced; §10.9's one-click
   RENEW for expired services is not built.

---

## 2026-09-03 — Task 07: contestant codes and the §9.2 voting rule (BUILT, NOT FLIPPED)

**The task's premise was out of date on item 1.** The 10-digit contestant code was described as
"currently doesn't exist at all". It does, and it is careful work: migration **070** added the
column, a `^[0-9]{10}$` CHECK, a partial unique index, and a **trigger** that issues the code the
moment an entry becomes `approved` — deliberately a trigger, because three separate code paths can
approve an entry and a fourth would forget. Migration **106** already makes it the bulk-vote EFT
reference. It is displayed publicly. **§8.3 and §8.4 need nothing.**

What *was* missing is **§8.5, the contestant's own view** — `/entries/mine` returned a bare total
and not even the code. Now it returns the code, the **exact verified vote count**, the online /
bought / adjusted split, ranking within the whole competition, closing date and status, with a panel
under My Competitions. Every row in `votes` is already verified (a paid bundle inserts its row on
CONFIRMATION, never at purchase), so "exact" is honest rather than optimistic. An admin adjustment
is reported separately rather than folded into "online", which would tell a contestant the public
voted for them when it did not.

**§9.2 is built and is OFF.** Migration **165** adds `competitions.daily_vote_limit`, NULL
everywhere, and NULL is exactly today's behaviour — **nothing about any running competition changes
when this deploys.** Per-competition rather than global, matching what 098 did and for the reason it
gave: flipping a rule underneath a running competition changes its result.

Setting the limit implies day-scoping, so the rule cannot be half-configured into a cap that counts
nothing. The other half of §9.2 — five votes "spread across at least two contestants" — is already
enforced by 098's unique index on `(entry_id, voter, vote_day)`; the cap was the only missing piece.

**A correction I made to my own test.** I first wrote the concurrency test claiming it proved the
advisory lock was load-bearing. **It passes with the lock removed** — eight HTTP requests do not
reliably hit a window a few milliseconds wide. It is now labelled an outcome check, and the lock is
tested directly instead: a second transaction on the same key blocks until the first commits, and a
different voter never blocks.

Suite **1744 → 1761**, 0 failing. Verified in a browser against a real backend: five votes accepted
with a countdown, the sixth refused with `429`, the uncapped competition unaffected, and the §8.5
panel showing code `9890741601`, 253 verified votes (3 online / 250 bought), position 2 of 2.

**STOPPED HERE, as the task requires — no competition has been flipped.** Cutover options are in the
report to the owner; the rule goes live only on their explicit go-ahead.

**Also flagged:** CLAUDE.md decision 1 (bulk-vote reference = code + suffix) is **stale** — migration
106 deliberately reversed it and added `lookup_token`, because a publicly-printed code cannot be a
credential. The file should be updated so the next reader does not "restore" the suffix.

---

## 2026-09-03 — Task 08: renewal (§10.9) and upgrade pricing (§10.10)

Built the two revenue-relevant pieces the task puts first. §12 intro screens and §19's progress
indicator are **not** built — the task calls them "process formalism… earns nothing alone" and says
to ask before spending effort on them, so they are left for the owner to decide.

**§10.9 one-click renewal.** A renewal is a **new submission copied from the expired one**, never an
edit of it: §10.11 says the underlying record stays for history, reporting, renewal and audit, and
reusing the row would also drop a live service back to awaiting_payment. The copy starts unpaid, and
carries no dates — a fresh term, not the old one. Renewable: marketplace listings, highlights,
adverts and events. Anything else gets a sentence saying why rather than "unknown type".

**Admin-set fields are deliberately not inherited** — a member must not renew their way into a
priority or placement an admin granted once.

**A test caught a real gap:** the check that every type in `SERVICE_TYPES` is either renewable or
explained failed on **advertising**, which had been missed. Adding it surfaced that `ad_slots` keeps
its own vocabulary — the status column is `moderation_status` and a new advert starts
`pending_payment`, not `awaiting_payment`. A renewed advert also has to come back `is_active = false`
with no placement, or an unpaid advert would go straight onto the site.

**§10.10 upgrade pricing: the price did NOT change.** It is still R250 — `docs/pricing-comparison.md`
records spec and live agreeing, and decision 8 forbids a price change without a full comparison. What
changed is that the figure was `const UPGRADE_FEE = 250.00` in a source file, which §2.3 and §10.10
both say it must not be: migration **166** seeds it as the `profile_upgrade_fee` setting, so an admin
can change it without a deploy. `ON CONFLICT DO NOTHING`, so a deploy can never reset a figure an
admin set. What was quoted is stored on the upgrade row, so a later change cannot alter a price
somebody was already given.

**On the test run.** The first full-suite attempt reported 8 failures in `freePublishing.test.js` — a
file this task did not touch. The cause was in the log: `checkpointer process exited with exit code
1`, the embedded Postgres crashing under sustained load after a night of suites, with one test taking
988 seconds. Re-run alone: **8/8, zero crashes.** A clean full run afterwards: **1777/1777, 0
failing.**

Verified in a browser against a real backend: Renew appears on the **expired** listing and not on the
running one; clicking it produces a copy under *Awaiting payment* with the details filled in and no
dates, while the expired original keeps its old term untouched.

**Also corrected:** CLAUDE.md decision 1 was stale and is now marked SUPERSEDED, with the reasoning
from migration 106, so nobody "restores" the suffix.

**Still open:** §12 and §19 (awaiting the owner's call); profile/directory renewal, which goes through
a package with a tier and a price and is a different flow from copying a service.

---

## 2026-09-03 — §9.2 CUTOVER APPLIED, and task 08's §12 / §19

### The voting cutover is live

On the owner's explicit go-ahead. Applied to **both** competitions after checking the timing:

- **Top 10 Impact List** — genuinely between rounds. August ran 8–31 Aug with **3,275 free votes**;
  September had **4** when the cutover was applied. The month had turned and the new round had
  barely started, which is exactly the moment the recommendation described.
- **The Arena** — 0 entries and 0 votes, so nobody was affected.

Both now `daily_vote_limit = 5, daily_voting = true`.

**Integrity checked immediately after:** 3,311 vote rows, 10,419 votes, 27 paid rows / 4,740 paid
votes, 26 approved entries — identical to before. Nothing was created, destroyed or moved.

**Reversible in one command:** `UPDATE competitions SET daily_vote_limit = NULL;`

### §19 — Step X of Y

One shared component in `unplug-shared.js` (`UnplugSteps`), wired into checkout. **It found a real
bug:** two different cards were both hand-labelled "Step 2" (the Directory package step and the
bulk-vote step, which are alternative paths), and an edition download showed "Step 3 of 4" for what
is really step 2 of 3. The path is now computed per mode, so the numbers cannot disagree again.

Wired by *observing* the cards rather than editing the dozen places that show one — less invasive,
and the next person cannot forget to call it. Verified in a browser across all three paths:
directory 4 steps, votes 4 steps, edition 3 steps, with the dots in the right states.

### §12 — service introduction screens

Every field the spec lists, in its order: what it is, who it is for, price, what's included, what
you need, "This service requires Unplug admin approval", that paying is not publishing, how long it
lasts, a terms link, and START. Six services covered — the ones with a submission form.

The intro lives **on the existing catalogue entry** rather than in a second structure, because a
service described in two places drifts.

> **FLAGGED: there is no single pricing source in this system.** The article price, per-competition
> `entry_fee`, banner tiers and the upgrade fee all live separately, so the intro screens' price
> lines are a *second* statement of prices that live in the backend. They say what the site already
> says today, but this is the drift risk the codebase has been bitten by before. A single pricing
> source is the proper fix and is not built.

Suite **1777**, audit PASS, smoke PASS.

**Still open:** the VAT registration number (owner adding later); a single pricing source; profile
renewal, which goes through a package with a tier and a price.

---

## 2026-09-03 — One price, in one place (pricing decision 8, item 1)

`docs/pricing-comparison.md` said the highlight and banner ladders lived in **three** places and
called it "the recurring bug class from CLAUDE.md, carrying money".

**Two of the three were dead code.** `HIGHLIGHT_PRICES` and `AD_BANNER_PRICES` in `payments.js` were
declared but never read — every quote and charge already went through `priceFor()`, which reads
`service_packages`. They still *looked* authoritative, which is how a second copy eventually
disagrees with the first. Deleted.

**No price changed, and I checked before touching anything:** production's `service_packages` matched
the fallback exactly on all 11 rows. The document's own rule — "nothing in this document may be
changed until these are answered" — is respected: the seven genuine pricing decisions are untouched,
because resolving them is a business call, not a refactor.

**The remaining duplication is deliberate.** `FALLBACK_PRICES` is a last-known-good for when the
table cannot be read. A constant cannot follow an admin's edit at runtime, but it can be held to the
seeded table, so `test/pricingSingleSource.test.js` fails if a migration changes a price without
changing the fallback. Teeth checked: dropping the fallback's 7-day banner to R275 fails with
*"the table says 300, the fallback says 275 — one of them is wrong, and the fallback is what gets
charged when the table cannot be read"*.

**A test of mine that was wrong, and how.** I first added a scan for literal rand amounts in
`payments.js`. It failed — on the directory tier ladder and the event listing fee, which legitimately
live there. A test that cries wolf gets deleted by the next person, so it now checks for the *shape*
of what was removed (a duration-keyed price map) rather than any amount.

**Flagged, not decided:** the fallback charges a possibly-stale price at exactly the moment the table
is unreadable — but if the database cannot be read, the payment row cannot be written either, so its
practical value is doubtful. Refusing the charge may be safer than guessing. That is a
money-behaviour decision, not a refactor.

**Still open in decision 8:** the banner sentence repeated ten times in `unplug-magazine.html`, the
package tier prices hardcoded in checkout and magazine as well as `PACKAGE_PRICES`, and
`unplug-components-demo.html` advertising "R250 a month" where everything else is once-off. All
frontend copy, and they need the tier decision settled first.

---

## 2026-09-03 — The frontend price copies (pricing decision 8, items 2 and 4)

**The banner sentence, ten times.** The same paragraph appears ten times across `unplug-magazine.html`,
each hardcoding R300 / R550 / R1,000 — so an admin changing a banner price left ten live pages
advertising the old one. All ten are now tagged and rewritten by **one** loader from
`/payments/packages?service=ad_banner`, the same rows that are charged. No price changed: the table
holds exactly those figures today.

**The wording in the HTML stays as the fallback**, so the page still reads correctly with no
JavaScript, on a failed fetch, or before the loader runs — verified by pointing the API base at a
dead port and confirming all ten still read R300–R1,000.

**A real bug the browser caught that the tests did not.** My first version resolved the API base as
`window.UnplugAPI && ...`. `unplug-shared.js` declares it `const UnplugAPI = (function(){…})()`, and a
top-level `const` in a classic script is a global BINDING but **never a property of `window`** — so
`window.UnplugAPI` was undefined, the loader bailed out silently, and all ten sentences kept showing
the fallback. The unit test passed throughout: it checked the markup, not that the thing worked.
Caught by setting the table to absurd values (R777 / R888 / R9,999) and looking at the page. Now
resolved with `typeof UnplugAPI`, the way the rest of the page reaches it.

**The public demo page.** `unplug-components-demo.html` is served publicly (200 on the live site) with
no inbound links, and its illustrative FAQ said *"Packages start at R250 a month"* — wrong twice:
directory packages are once-off, not monthly, and R250 is not one of them. The claim is removed
rather than corrected, because choosing the right figure would be a pricing decision. A component
example does not need a real price to demonstrate anything.

> **Worth deciding: should that demo page be public at all?** It is a developer reference for
> component usage, reachable by URL by anyone. Nothing links to it, so removing it from the deploy
> would cost nothing.

Suite **1788 → 1791**, 0 failing. Audit PASS, smoke PASS.

**Still open in decision 8:** item 3 — the package tier prices hardcoded in `unplug-checkout.html`
and `unplug-magazine.html` as well as `PACKAGE_PRICES`. Those are the directory tiers, and consolidating
them runs into decision 6 (whether the middle tier is "Standard" or `pro`), so it waits on that.

---

## 2026-09-03 — QA punch list, task 1/6: dead footer navigation

Footer and bottom-bar links were `href="#"` — worked via a `[data-page]` click handler with JS on,
but broke ctrl/cmd-click, view-source and crawlability. Switched to real `?p=xxx` URLs matching the
top nav. The footer's "Submit a Story" had no `data-page` and no handler at all — genuinely dead;
gave it the same `goToMemberDashboard()` handler as the working header CTA. Verified live in-browser.
Pushed as `813725c`.

## 2026-09-03 — QA punch list, task 2/6: stale email domain + a dead second contact form

`stories@`/`ads@`/`hello@unplugmagazine.com` on the About page were never a monitored domain — every
other contact point on the site uses `info@unplugnews.com`. Worse than the punch list flagged: that
whole "Get in touch" block was a second, orphaned contact form (`onsubmit="...alert(...)"`) that never
sent anywhere, duplicating the real, working Contact page form. Fixed in place rather than removed
(non-destructive): the three labelled lines now point at the one real inbox with a subject-line hint
each, and the form now posts to `/inquiries` — same endpoint, same honeypot, same shape as the real
Contact form, verified by intercepting the fetch call rather than sending a live test enquiry.

## 2026-09-03 — QA punch list, task 3/6: Investor stats stuck on em-dash

Not unwired — `GET /analytics/public-stats` is live and returns real numbers (confirmed:
`monthlyReaders: 377, registeredMembers: 59, articlesPublished: 21`) — but on the live site the
page-load call left the placeholders showing every time, while calling the same endpoint by hand a
moment later succeeded instantly. Most likely cause: Render's free tier sleeps the backend, and the
very first request after idle can be slow enough to fail. Added one retry after a 3s pause, and — if
both attempts fail — hide the stat row (`.inv-stats`) entirely instead of leaving `—` showing, per the
punch list's own fallback option. Verified both paths on the live origin by stubbing the API call:
fail-then-succeed renders the real numbers (row stays visible), fail-then-fail hides the row.

## 2026-09-03 — QA punch list, task 4/6: Advertising Banner gets a 21-day tier

Banner had 3 duration tiers (7/14/28); Directory Highlight and Article Highlight both already have
4 (7/14/21/28) — Banner was the outlier, not the pattern. Site owner chose to add the missing tier
rather than explain the gap away. Migration 168 seeds a 21-day `service_packages` row at R785
(interpolated from the existing per-day rate curve between the 14-day and 28-day rows — no spec
figure exists for this duration, so nothing frozen in `docs/pricing-comparison.md` is touched, and no
existing price changed). `ON CONFLICT DO NOTHING` as always; a companion `UPDATE ... WHERE
display_order = 3` re-sequences the 28-day row's display order only if still at its seeded value, so
an admin who already reordered these is left alone. Confirmed idempotent (ran three times in a
standalone check) and that an admin's own price edit survives a re-run. Every screen that shows
banner pricing (member dashboard duration select, the ten-times-repeated homepage sentence, the
admin pricing panel) reads live from this table, so nothing else needed a code change — updated the
sentence's no-JS fallback text to match, for the same reason it was made a fallback in the first
place. Full suite: 1825 passing, 0 failing.

## 2026-09-03 — QA punch list, task 5/6: Arena launch copy

`"Target launch: August Month"` on the Investors page was hand-typed placeholder text, not pulled
from any data source. The Arena's competition closing date is set to 31 October 2026 (migration 066);
site owner confirmed the launch copy as October 2026 rather than a date after the close.

## 2026-09-03 — QA punch list, task 6/6: Highlight/Upgrade purchases brought up to the site's own checkout standard

Editions checkout and Submit & Pay both show a short-form cancellation-policy summary with links to
the full policy before the terms checkbox, offer a real payment-method selector, and add a
proof-of-payment upload once a reference is issued. Four other purchase entry points — Highlight
Article, Highlight Profile (both via the shared `buyHighlight()`), the profile-page "Highlight my
listing" button, and the tier Upgrade button — had none of that: just a bare checkbox naming the
policies with nothing to read, EFT hardcoded in JS with no visible choice or explanation, and no
upload widget.

Fixed by extending the existing pattern into all four call sites rather than writing a new one:
`buyHighlight()` gained an optional `payMethodId` (defaults to `'eft'`, so it can't regress a future
caller that omits it) instead of a hardcoded method, and every EFT-instructions branch across the
four now calls `popUploadBlock('payments', ...)` exactly as Submit & Pay does. The cancellation
summary is the exact wording already established in Submit & Pay's `#submitTermsGate` block, reused
rather than reworded, so there is one sentence of policy on the site, not a second one to drift out
of sync with the real Refunds & Cancellation page.

New test, `highlightCheckoutParity.test.js` (5 tests): confirms the summary sits immediately before
each of the four terms checkboxes, that every entry point discloses its payment method, that
`buyHighlight()` no longer hardcodes `'eft'`, that every EFT branch offers the upload, and that the
wording is byte-identical to Submit & Pay's rather than a paraphrase. Full suite: 1825 passing, 0
failing (up from 1820 — the 5 new tests).

**All 6 punch-list items complete.** One incidental finding along the way, already resolved before
this session touched anything: the Directory Highlight refunds-policy page previously quoted a price
ladder R150 higher than what the system actually charges at every tier (`docs/pricing-comparison.md`,
compiled 29 August) — checked live on 2026-09-03 and the policy page now reads the correct R100-R250
ladder, so nothing needed doing.

## 2026-09-03 — Website remediation punch-list, PAY-009: duplicate-order guard

A hand-over document ("Unplug-Website-Punchlist-for-Claude-Code") claimed the site runs on Netlify +
Railway with no local dev environment — none of which matches this codebase (confirmed live:
`server: cloudflare` on the main site, the API domain is literally `*.onrender.com`, and the CSP's own
`connect-src` whitelists only that domain). Treated as unreliable for anything I couldn't verify
independently, rather than acted on as given. Its RLS/anon-key security claim (N-1) also doesn't apply
as described: the frontend has zero Supabase client SDK and zero anon key anywhere — every real
read/write goes through the Render backend's own auth, and the only browser-facing Supabase touch is
public storage URLs, which RLS on Postgres tables doesn't gate at all.

What did check out, verified against the actual code: `POST /payments/initiate` had no protection
against being called twice for the same purchase, for any `linkedType` except `ad_banner` (which
checks its own `moderation_status` field, not a general mechanism) — a double-click, a Back-button
resubmit, or two open tabs could create two real payment rows for one directory package, highlight,
competition entry, event listing, or anything else.

Fixed with one general guard rather than a bespoke check per linked type: before creating a payment,
look for an existing `pending` or `confirmed` row for this `(user_id, linked_type, linked_id)`. A
`confirmed` one is refused outright ("already been paid for"). A `pending` one is handed back
as-is — same reference, same EFT/redirect details — with no voucher or credit re-applied, since that
already happened (or didn't) the first time. A `failed` payment doesn't block a fresh attempt.
Response-building for the EFT/gateway-stub payload was pulled into one `initiateResponseFor()`
helper, used by both the normal success path and the duplicate-return path, rather than writing it
twice.

New test, `paymentsDuplicateGuard.test.js` (7 tests): same reference on resubmit, only one row ever
created, a third/tenth resubmit is still idempotent, confirmed purchases are refused, failed ones
aren't blocked, two genuinely different purchases are never confused for duplicates, the guard is
scoped per-user, and PayFast/Ozow resubmits are caught too (not just EFT). Verified the frontend's
`api()` helper treats any 2xx as success (the duplicate-return path answers 200, not the original
201), so this is transparent to every existing caller with no frontend change needed. Full suite:
1837 passing, 0 failing (up from 1830).

Also confirmed, not yet fixed: the same route accepts `method: 'payfast'`/`'ozow'` and returns a stub
redirect to a fake domain — the frontend disables that option everywhere, but the backend doesn't
enforce it. And `unplug-checkout.html`'s voucher field has no live preview before payment, unlike
Submit & Pay's. Both flagged for a follow-up task.

## 2026-09-03 — Website remediation punch-list, PAY-001/PAY-005: backend now enforces EFT-only

The first of the two follow-ups above. Fixed by gating `method` in `POST /payments/initiate` on the
same env vars the PayFast/Ozow webhook signature verifiers already require for a real merchant
account (`PAYFAST_PASSPHRASE`, `OZOW_PRIVATE_KEY`) — not a separate flag that could drift out of sync
with whether credentials actually exist. Requesting either method today is refused with the same
"coming soon" wording the UI already shows; EFT is unaffected. The moment real credentials are
configured, that method starts working with no further code change.

New test, `paymentGatewayNotLive.test.js` (4 tests): PayFast refused with no stub redirect and no
payment row created, same for Ozow, EFT unaffected, and — proving the self-enabling design actually
works rather than just asserting it — a test that sets `PAYFAST_PASSPHRASE` mid-run and confirms the
very next request succeeds. The existing duplicate-guard test's own PayFast case (testing that the
duplicate guard applies to gateway methods too) now sets the env var in its fixture, since it isn't
testing gateway-enablement and shouldn't be coupled to it. Full suite: 1841 passing, 0 failing (up
from 1837).

Still open: `unplug-checkout.html`'s voucher field has no live preview before payment.

## 2026-09-03 — Website remediation punch-list, PAY-002: live voucher preview in checkout

The last open item from Section 6.6. `unplug-checkout.html` priced the order with pure client-side
arithmetic (order total minus credit) and never asked the server about the voucher at all until the
moment of payment — a member typed a code, paid, and only found out what it did (or didn't do)
afterwards. Submit & Pay already did this properly via `POST /payments/quote`, an Apply button and a
live discount row; checkout was the outlier.

Rebuilt to match: `recalcCheckout()` (pure arithmetic) is gone, replaced by `refreshCheckoutQuote()`,
which calls `/payments/quote` with the linked purchase, the applied voucher and the credit choice, and
renders Order total / Voucher applied / Credit applied / Total to pay straight from the response — the
same shape Submit & Pay already uses. Added a Voucher row and Apply button to the markup. Paying now
sends the APPLIED, server-validated voucher code, not whatever text currently sits in the input — so
typing a new code without clicking Apply can't silently charge a discount the summary never showed.
Verified live (mocked the API response, real DOM): correct endpoint, correct request shape, the
voucher/credit/total rows all rendered correctly from the response.

New test, `checkoutVoucherPreview.test.js` (5 tests): the Apply button and discount row exist, the
summary is built from `/payments/quote` rather than client arithmetic (and the old function is
actually gone, not left dead alongside the new one), Apply triggers a real re-quote, paying uses the
applied voucher rather than re-reading the raw input, and the credit checkbox also re-quotes. Full
suite: 1846 passing, 0 failing (up from 1841).

**Section 6.6 (checkout) is now fully worked through**: PAY-001/005 (frontend consistency, then
backend enforcement), PAY-002 (order summary + voucher preview), PAY-004 (cancellation summary),
PAY-006 (reference display), PAY-007 (already-paid recovery), PAY-008 (credit display), PAY-009
(duplicate-order guard) — all verified against the actual code or fixed, not assumed from the
hand-over document.

## 2026-09-03 — Website remediation punch-list, DEAF-001/PASSPORT-002/DEAF-003/DEAF-004: Deaf
## Community empty states verified, and self-service manage links built

**DEAF-001 (jobs empty state) — already correctly built, verified only.** `loadDeafJobs()` already had
all three states UX-001 asks for: "Loading vacancies…", "No live vacancies right now — check back
soon." on an empty result, and "Couldn't load vacancies right now." on a fetch failure. No change
needed.

**DEAF-002/DEAF-004 — already correct.** The deaf-friendly-employer confirmation renders in bold on
every job card; the Passport form already tells a submitter, right next to the email field, that it's
"for verification only — never shown."

**PASSPORT-002/DEAF-003 — a genuine gap, not just under-surfaced.** Neither `deaf_jobs` nor
`deaf_passports` has a `user_id` — submitting has never required an account, deliberately, for an
accessibility-focused feature — so there was no owner-facing route at all: only public GET/POST and
admin moderation. A submitter had no way to see, edit, renew or remove their own listing. Site owner
chose: build it, using an emailed link rather than a login, keeping the account-free submission model
exactly as it is.

Migration 170 adds `manage_token` to both tables (nullable, minted lazily in application code —
`gen_random_bytes` needs the `pgcrypto` extension, which nothing in this project has ever enabled, so
this avoids a new SQL-side dependency for a value plain Node `crypto` already generates correctly
elsewhere) and a fourth status, `'withdrawn'`, owner-only and never set by moderation. "Deactivate" and
"delete" from the punch list are treated as one action — immediate, permanent removal from the live
board — rather than a separate dormant state, since nothing asked for a way to bring one back.

Six new routes per table (`manage-link`, `GET/PATCH/DELETE manage/:token`, `POST manage/:token/renew`),
sharing one set of route factories parameterised by table — jobs and passports get identical behaviour
from one implementation, not two. `manage-link` always answers the same way whether or not anything
matched, so the response can't be used to learn whether a given address has a listing; several
listings for one email produce one email with several links, not several. Editing resets status to
`'pending'` — a self-edit goes back through review before it's live again, the same as a new
submission; nothing else in this codebase lets an owner edit already-approved content, so this is a
new precedent, chosen as the safer default given the site's moderation posture everywhere else. Only
the allow-listed fields per table are reachable from a PATCH body — id/status/token can't be set from
the request.

Frontend: a "Manage your listing" link on both the Jobs and Passport panels opens an email-request
modal; a manage modal (fields mirroring the submission forms, Save/Renew/Remove) opens automatically
when arriving via `?p=deafcommunity&manage=job|passport&token=...`, which is what the emailed link
points at. Renew is hidden unless the listing is actually live; Save and Remove are disabled once
withdrawn.

New test, `deafCommunitySelfService.test.js` (13 tests): the anti-enumeration response, a real link
that actually works end to end, one email for several listings, lazy minting reused across requests,
editing resets to pending, the field allow-list holds (status/id/token unreachable from the body),
renewing only while live, withdrawing removes it from both the public board and future manage-link
emails, withdrawing twice is refused the second time, a bogus token is refused on every route, and the
same behaviour confirmed for passports specifically, not assumed from the jobs coverage. Migration 170
re-run twice without error. Verified live in-browser (mocked API): the modal opens, fields populate
correctly per kind, and button state (Renew/Save/Withdraw) responds correctly to status. Full suite:
1859 passing, 0 failing (up from 1846).

## 2026-09-03 — Website remediation punch-list, DIR-001: live example under each package tier

"Show exactly what customers receive" — a real, live Directory profile of each tier, not a mockup.
Needed no backend change: `GET /directory` already supports `?type=&package=` filtering, so this is
purely the frontend calling a filter that already existed. Checked real production data first —
`individual/pro` and `individual/premium` each have a live example (`leon-matthee`, `ag-scott`);
`individual/basic` and every `business/*` combination currently have none.

A tier with no example yet hides its own line rather than linking to nothing — matches the site's
existing rule that nothing renders a card that goes nowhere. Re-fetches when the Individual/Business
toggle switches, since "a live example" means one of the type actually being priced, not whichever was
loaded first. Opens in a new tab so looking at an example doesn't lose the in-progress package choice.

New test, `directoryTierExamples.test.js` (5 tests). Verified live: real API data confirmed which
tier/type combinations currently have an example, then the local page's actual logic was exercised
against that exact data (mocked fetch) — the two with an example render a working link, the four
without stay hidden, and switching to Business correctly re-queries and hides all three. Full suite:
1864 passing, 0 failing (up from 1859).

## 2026-09-03 — Website remediation punch-list, DIR-003: explain the Directory activation workflow

No explanation of what happens after "Choose a package" existed anywhere on the Directory page — a
genuine gap, confirmed by grep before writing anything. Traced the real status lifecycle in the code
first, since the original spec's own six-step diagram (§2.4) turned out not to match reality:
`POST /profiles` creates the profile at `status='awaiting_payment'`; a confirmed EFT payment moves it
to `'pending'` (`payments.js`'s `profile_package` effect — not straight to `'approved'`); a separate
admin action, `PATCH /admin/profiles/:id/approve`, is what actually publishes it. The spec's diagram
also includes a Preview screen between completing the profile and paying — checkout has no such
screen, and the copy was written to describe what's actually built, not reproduce an unbuilt step.

Added a compact four-step "How it works" block under the package cards: Choose a package and fill in
your profile → Pay by EFT (with a reference) → We review it → You're live once approved.

New test, `directoryActivationWorkflow.test.js` (3 tests) — checks the copy exists, and, more usefully,
checks the underlying facts it depends on are still true (the `awaiting_payment` → `pending` transition
in `payments.js`, a distinct admin approval route in `admin.js`) so a future change to the real workflow
fails this test rather than leaving the page quietly wrong. Also confirms the page doesn't claim a
Preview step. Full suite: 1867 passing, 0 failing (up from 1864).

## 2026-09-03 — Website remediation punch-list, ADV-002/003: sell reach, not "a banner for 7 days"

The Advertising page already had real audience numbers (`mediaKitStats`: readers, page views,
returning %, top country — genuinely built, not fabricated) and real pricing, but nothing about the
practical half of buying a banner: where it actually appears, what file to bring, whether the start
date is fixed, or what happens after paying. Its one CTA for the self-serve product, "Advertise Here",
had `data-page="brandplacement"` while already being on the brandplacement page — a no-op.

Checked the real facts before writing anything: 8 real placements exist (`AD_PLACEMENTS` in
`adBanners.js`), each a Medium Rectangle (300×250) or Leaderboard (728×90); accepted formats are JPEG/
PNG/WebP/GIF up to 8MB (`middleware/upload.js`); the start date is genuinely chosen, not fixed
("today or a chosen future date"); every banner goes into a real admin moderation queue before going
live. Checked for advertiser-facing reporting too — there isn't any (the only impression tracking in
the codebase is `popups.js`'s admin-only analytics, unrelated) — so nothing claims one.

Added a "Buy a Page Banner Directly" section, separate from the curated "Get In Contact" sponsorship
cards above it (those are negotiated placements, not this self-serve product). Placements render from
`GET /ad-banners/options` — the same endpoint the real buy form uses — rather than a second list that
could drift out of sync with it. The CTA now calls the same `goToMemberDashboard()` every other
"submit something" entry point on the site uses.

New test, `advertisingBannerProduct.test.js` (4 tests): the file-format/size-limit/start-date/approval
claims are all present, placements come from the real endpoint rather than a hardcoded list, no
reporting is claimed, and the CTA no longer points back at the page it's already on. Verified live
in-browser (mocked API, matching the real response shape confirmed earlier this session). Full suite:
1871 passing, 0 failing (up from 1867).

## 2026-09-03 — Website remediation punch-list, ARENA-002: fix the Arena entry mischarge (confirmed live bug)

Not a documentation gap — a real bug, escalated and fixed as its own task per instruction. No frontend
anywhere called the backend's already-built `POST /competitions/:id/entries` route. The member
dashboard's only competition-entry field was "Top 10 Entry", which always called `POST /top10/enter`
regardless of which competition the member actually meant — so entering The Arena (R250, votes-until-
close, eligible for a free `free_arena_credits` entry) was silently entered and charged as a Top 10
entry (R100, monthly) instead. Confirmed by grep: zero call sites for the entries route anywhere in
the frontend before this fix.

Backend: `GET /competitions` now selects `entry_fee` (it queried everything else already) — the field
the dashboard needs to show a real price before charging it. The entries route itself needed no
change; it was already correct, just unreachable.

Frontend, member dashboard: the old single-purpose "Top 10 Entry" field is now a real competition
picker (`setupCompetitionFields()`), populated from the live `/competitions` list plus a fixed Top 10
option (Top 10 has no row in the `competitions` table — its own dedicated endpoint, R100, no
`competition_id`). `createSubmission('top10')` branches on the chosen option's `kind` from a trusted
`COMP_OPTIONS` map (not a raw form value) and posts to the correct route; for a real competition,
`needsPayment` is read from the entry's actual returned `status` rather than assumed, so a free Arena
credit (status `'pending'`) is not double-charged.

Frontend, Arena page: its "Submit a Nomination" button called the same bare `goToMemberDashboard()`
as every other entry point, landing on the dashboard with no competition implied — the exact gap that
caused the mischarge. `goToMemberDashboard()` now takes an optional slug (every other call site is
unaffected by omitting it) and deep-links with `?competition=the-arena`; the dashboard reads that
param to pre-select the right option in the picker AND to switch "What are you submitting?" to the
competitions field group itself (pre-selecting the inner dropdown alone would do nothing if the
section holding it is never revealed), then scrolls the Submit & Pay card into view.

New test, `arenaCompetitionEntry.test.js` (8 tests, real HTTP + real Postgres for the backend half):
`GET /competitions` returns `entry_fee`; entering the Arena creates a `competition_entries` row, not a
Top 10 entry, charged the Arena's own fee; a free Arena credit settles the entry without payment; the
two HTML files are checked as static source for the slug-carrying `goToMemberDashboard`, the Arena
button wiring, the real-list-backed picker with slug pre-select, the outer field-switch on arrival, and
the `createSubmission` branching. Full suite: 1879 passing, 0 failing (up from 1871).

## 2026-09-03 — Website remediation punch-list, PAY-011: a real confirmation screen, not just bank details

Checked the rest of Phase 1's checkout items first, since most turned out already done: PAY-004
(cancellation summary beside the terms checkbox) is already on both checkout.html and the member
dashboard's Submit & Pay, word-for-word what the punch-list asks for. PAY-006 (reference shown clearly)
already appears on the result screen, in Payment History, and — via `refNotice()` — on the dashboard's
own Submit & Pay confirmation. PAY-007/EDIT-002 (already-paid recovery) already has a working "Already
paid? Get your download" entry point with its own dedicated test file (`editionDownloads.test.js`) from
before this cycle. PAY-008 (credit display) already updates live via `POST /payments/quote`, built as
part of PAY-002 earlier this cycle. None of those needed a change.

PAY-011 did: `unplug-checkout.html`'s result screen showed EFT bank details or a gateway redirect and
nothing else — no service name, no amount, no explicit status, and no link back into the site once
you'd paid. A member had to already remember what they were buying and just trust it went through.

`GET /payments/mine` (Payment History) already computed a human `serviceLabel` (e.g. "Event Listing")
and a `statusLabel` ("Awaiting Payment" / "Paid by Credit" / etc.) inline in its own handler — pulled
that out into one `paymentDisplayFields()` helper in `payments.js`, alongside the existing shared
`SERVICE_LABELS` map, and used it in `/mine` **and** in all three response points of `POST
/payments/initiate` (a fresh payment, a covered-by-credit payment, and the duplicate-order guard's
already-pending return). One source for both screens means the confirmation a member sees right after
paying can never disagree with what they see a minute later in their own order history.

`unplug-checkout.html`'s result card now shows Service / Order total / Status above the payment
instructions, and a "View My Order" link to the member dashboard so the screen is no longer a dead end.

New test, `paymentConfirmationSummary.test.js` (6 tests, real HTTP + real Postgres for the backend
half): a fresh EFT payment reports "Event Listing" / "Awaiting Payment"; a payment fully covered by
account credit reports "Paid by Credit"; a resubmitted still-pending order returns the same summary
fields, not just the first-time path; `GET /payments/mine` shows the exact same labels for the same
payment; the checkout page's result screen renders `serviceLabel`/`order_total`/`statusLabel`; and the
result card offers a way back into the site. Verified live in-browser (mocked `/payments/initiate`
response, matching the real shape confirmed by the backend tests): Service/Order total/Status render
correctly alongside the real EFT instructions, and "View My Order" is present. Full suite: 1885
passing, 0 failing (up from 1879).

## 2026-09-03 — Website remediation punch-list, PAY-003/PAY-010: workflow note + validation check

**PAY-003 — what happens after payment.** Only one of checkout's three modes has a real post-payment
step: a Directory package purchase goes through review → approval before it's live; an edition download
or a vote bundle settles the instant the payment is confirmed. A generic "here's what happens next" note
would have been actively wrong for those two, so it's gated on `DIRECTORY_MODE` specifically rather than
shown on every checkout. Added a one-line note on the Payment step, next to the order details, naming
the real chain (confirm → review → live) and pointing at the reference/status shown next (from PAY-011)
and in Payment History.

**PAY-010 — validation.** Checked rather than assumed: every `showError()` call site in checkout.html
either passes a specific literal string tied to what actually failed ("Choose a package.", "Enter the
full 10-digit Entry Code exactly as shown on the Top 10 page.") or falls through to the server's own
`err.message` first. None reduce to a generic "something went wrong" — the punch-list's actual
complaint. Field-level *positioning* (moving each error banner to sit directly beside its one specific
input, rather than at the top of its card) was considered and left alone: every checkout card is short
enough that the existing per-card banners are unambiguous about which message applies to what, and
rewiring every error banner across three separate checkout flows for a cosmetic gain wasn't judged worth
the size of the change against what's actually asked. No code change needed for this item.

New test, `checkoutWorkflowAndValidation.test.js` (3 tests): the workflow note exists and names confirm/
review/live; it's gated on `DIRECTORY_MODE`; no `showError()` call reduces to a generic catch-all.
Verified live in-browser: the note shows for a Directory purchase (`?ptype=individual&tier=pro`) and
stays hidden for an edition download (`?type=edition_download&id=3`). Full suite: 1888 passing, 0
failing (up from 1885).

## 2026-09-03 — Floating Buttons: admin-managed CTA stack on every public page

New feature, requested directly (not from the punch-list document). Checked the codebase first for
anything close before building: Popups (`popups`/`popup_events`) already lets admin add a label+link
button with page targeting, but it's built specifically to *interrupt* — a scroll-triggered modal a
reader dismisses and that then stays away for a set number of days. What was asked for is the opposite
kind of thing: a small button that's always reachable, the way a WhatsApp chat bubble or a "back to top"
control is, never dismissed, never capped. Confirmed no existing mechanism does that, so this is a
genuinely new feature.

Scope, from the two clarifying questions asked before writing any code: a fixed floating stack (not an
inline content block or a nav-bar item), and each button is a simple global on/off — no per-page
targeting, matching the popups system's simplest mode. The member-dashboard pathway asked for alongside
this was found already built (`renderAccountNav()` — a "👤 Dashboard" link in the main nav and the mobile
hamburger menu, on every page, whenever a member is signed in) and needed no change.

New table `site_buttons` (migration 171): `label`, `url`, `icon` (optional emoji), `display_order`,
`active` — off by default, same "not live until somebody switches it on" rule Popups follow. New route
file `siteButtons.js`: `GET /site-buttons` (public, active buttons only, in display order, 1-minute
cache — same shape as Popups' public feed) and admin CRUD (`GET .../admin/all`, `POST`, `PATCH`,
`DELETE`), mounted in `app.js`.

New standalone script `unplug-site-buttons.js` (mirrors `unplug-popups.js`'s pattern: one file, no
dependencies, own API-base resolution, fails silently to nothing if the endpoint is unreachable) renders
the active buttons as a bottom-right floating stack on `unplug-magazine.html`. z-index 900: above
ordinary content, but below every full-screen overlay on the site (welcome gate 1000, consent bar 1100,
search overlay 99997+) — a floating button must never sit on top of a modal that's supposed to have the
visitor's full attention, so it's designed to be correctly hidden behind one rather than special-cased
per overlay. An external link opens in a new tab; an internal one navigates normally, so a corner button
never unexpectedly pulls a reader off an article they were reading.

Admin dashboard: new "Floating Buttons" section under Website Settings, alongside Page Content and
Marketplace Placements. Each row stays directly editable (label/link/icon/order inputs with a Save
button) rather than needing a separate edit mode for a four-field record, plus per-row Turn on/off and
Delete.

New test, `siteButtons.test.js` (10 tests, real HTTP + real Postgres): admin-only create/edit/delete;
a new button is off by default; label and link are both required and can't be edited down to blank; the
public feed returns only active buttons in display order and carries no admin-only fields
(`created_by`, `active` itself); turning a button off removes it from the public feed immediately;
deleting removes it from both the admin list and the public feed. Verified live in-browser: rendered
buttons carry the exact HTML expected (icon + label, correct `target`/`rel` for external vs internal
links), and `document.elementFromPoint()` at the button's own coordinates confirms it's genuinely the
topmost visible element there, not obscured by anything. Full suite: 1898 passing, 0 failing (up from
1888).

## 2026-09-04 — Website remediation punch-list, UX-001: every error state gets a Retry

The doc asks for three explicit states per dynamic component — loading, empty, error (message +
Retry). Loading and empty were already handled correctly everywhere checked this cycle (jobs, investors,
marketplace, per DEAF-001/MARKET-001 verification). Retry was not: grepped the whole file for it and
found zero matches anywhere on the public site — every one of the ~15 "couldn't load" messages was a
dead end, with reloading the whole page as the only way forward.

Added one shared `errorStateHtml(message, retryCall)` helper rather than hand-writing a button at each
site — `retryCall` is the *exact* call the component already uses to fetch itself the first time
(e.g. `'loadEditions(true)'`, `'loadMembers(true)'`), re-run verbatim on click, so Retry can never drift
from what a real load actually does. Wired into the 12 components with a genuine list/detail fetch and a
`.dir-empty-state`-style catch block: article detail, the homepage featured slider, New Stories,
highlighted profiles, Investors, Marketplace, Editions, the homepage Top 10 mini-list, The Arena, the
Members directory, site search, and Calendar events. Three parameterised loaders needed a specific retry
argument rather than a bare call: article detail retries via the `window.__currentArticleId` global
already set before its own fetch; Editions and the Members directory retry with `reset=true`, which each
already re-reads its own live filters/pagination state from the DOM, so a retry is a full, correct
re-fetch rather than a raw repeat of whatever failed.

Left out on purpose: the map's own failure note (`unplug-magazine.html:5528`, a different UI, not this
pattern), a contributor byline page's not-found-style error (retrying a "this contributor doesn't exist"
response wouldn't help), and a secondary quick-search-overlay hint — all outside the "list/detail grid
that failed to fetch" shape this task is about.

New test, `errorStateRetry.test.js` (13 tests): the helper wires the retry call to the button's
`onclick` and always labels it "Retry"; each of the 12 components' error state carries its own correct
retry call, checked by name so a future refactor that quietly drops one fails this test instead of
shipping a silent regression. Verified live in-browser: navigated to the Investors page, let the fetch
fail naturally (CORS from the local static-server origin), confirmed the exact expected error+Retry
markup rendered, then mocked a successful response and clicked the real Retry button — it re-ran
`loadInvestors()` and rendered the correct empty state, proving the recovery path works end to end, not
just that the button exists. Full suite: 1911 passing, 0 failing (up from 1898).

## 2026-09-04 — Website remediation punch-list, MOB-003: the button says what it charges

Checked all three checkout surfaces — every primary payment button said a bare "Complete Order",
"Create & Pay", or (after a failed attempt) "Pay Now", with no figure on the button itself. Named
explicitly by the punch-list as a mobile issue (the order summary above the button is often already
scrolled out of view on a small screen by the time someone reaches it), but the fix applies regardless
of screen size — confirming the amount at the point of commitment is just good practice.

Each button's label is now built from the same server-priced total already shown in its own order
summary (`POST /payments/quote`'s `amountToPay`, or `/orders/quote`'s `total` for the cart) plus the
currently selected payment method, via a small `payMethodLabel()` helper: `PAY R400.00 BY EFT`. A
`change` listener on each payment-method `<select>` keeps it live — today that's moot (PayFast/Ozow are
still `disabled` options per PAY-001/005), but the label reads the real selection rather than assuming
EFT forever, so it stays correct the moment a gateway goes live with no further change needed.

A real regression, caught before shipping: all three "reset the button after a failed attempt" paths
(`unplug-checkout.html`'s `payBtn`, `unplug-member-dashboard.html`'s cart checkout) fell back to the old
bare label on failure — silently undoing this fix the first time a payment attempt actually failed,
which is exactly when a member most needs to see what they're about to retry paying. Fixed by having
each `finally` block re-run its own quote refresh (`refreshCheckoutQuote()` / `refreshCartQuote()`)
instead of hardcoding a string. The free-publishing branch (`Submit for Approval`, no charge) is
untouched — it sets its own label before any quote is even fetched, and never should show a price for a
submission nothing is being charged for.

New test, `payButtonShowsAmount.test.js` (8 tests): each button's label is built from the real
server-priced figure, not a hardcoded string; each failure path restores that real label rather than a
bare fallback; the payment-method select's `change` refreshes it; `payMethodLabel` names EFT/PayFast/
Ozow correctly in both files. Verified live in-browser: mocked `/payments/quote` on checkout.html and
confirmed the button reads exactly `"PAY R400.00 BY EFT"`; mocked a failed `/payments/initiate` and
confirmed the button restored that same real label (not "Pay Now") and re-enabled correctly. Full suite:
1919 passing, 0 failing (up from 1911) —
confirmed across two full runs, each blocked on the same pre-existing, unrelated environmental flake:
`dateNoTimezoneShift.test.js`'s embedded Postgres failed to bind its port both times ("Permission
denied" — consistent with a Windows-excluded ephemeral port range, not a real conflict), taking its 7
tests down with it while all other 1912 tests passed both runs. That file touches nothing this change
does (dates/timezones, not payments) and passes cleanly 7/7 every time it's run standalone — confirmed
directly rather than assumed. Treated as the known accumulated-postgres-process flakiness this session
already ran into once before, not a regression from this change.

## 2026-09-04 — Website remediation punch-list, MOB-001: mobile viewport pass — real bug found and fixed

Started the mobile nav/layout verification (MOB-001) by emulating a 375px viewport and looking at the
homepage. First thing on screen was a real bug in last session's own work: the Floating Buttons feature
(shipped this cycle) places its stack at `bottom:14px` in the bottom-right corner — the exact same corner
the site's pre-existing `chatbot.js` chat bubble already occupies, at the same offset, with a z-index
(99990) more than a hundred times higher than the buttons' (900). Any button an admin ever activates
would render completely invisible, hidden behind the chat bubble, on every page, forever — not caught
during that task's own verification because no button was active in the live database yet to actually
render and collide.

Fixed in `unplug-site-buttons.js`: the stack's `bottom` offset moved from `14px` to `84px` — the same
gap chatbot.js's own expanded window (`.ub-win`) already leaves above its collapsed bubble (its bubble is
`bottom:20px` + `height:52px` = 72px of footprint; 84px clears that with room to spare). Confirmed live
with the mobile-emulated browser: one button clears the bubble; three buttons (the stack growing upward)
still clear it. The accessibility widget (`accessibility.js`) sits at the opposite corner (`left`), so no
collision there.

New test in `siteButtons.test.js` (1 test, now 11 total for that file): reads chatbot.js's own `.ub-fab`
bottom/height rule directly (not hand-copied) and asserts the stack's offset exceeds that combined
footprint — so a future resize of either widget is what this test actually tracks, not a frozen number.
No horizontal scroll on the homepage at 375px width, confirmed directly. Full suite: 1920 passing, 0
failing (up from 1919). Continuing the rest of the MOB-001 mobile pass next.

**Continued — the rest of MOB-001, and MOB-002.** Checked every real page (12 client-routed pages on
`unplug-magazine.html`, plus `unplug-checkout.html` in all three modes and `unplug-member-dashboard.html`)
for horizontal overflow at both 375px and 320px, by measuring `document.documentElement.scrollWidth`
vs `clientWidth` directly rather than eyeballing screenshots. The hamburger menu itself is solid: opens/
closes correctly, all five nav groups expand with real touch targets (44px+ everywhere measured), no
clipping. All 12 magazine pages: clean at both widths.

`unplug-checkout.html`'s Directory-package mode was NOT clean: 34px of real horizontal overflow at
320px. Traced to the exact element with `getBoundingClientRect()` on every node — `#applyVoucherBtn`,
pushed off-screen by its sibling `#voucherCode` input. The input had `flex:1` and nothing else; a flex
item's default `min-width` is `auto` (its own content size), so `flex:1` alone does not let it shrink
past that on a narrow screen. Fixed with the standard `min-width:0`. Grepped for the same `style="flex:1;"`
pattern rather than assuming this was the only place it existed, and found the identical bug in two more
spots: the member dashboard's Submit & Pay and cart-checkout voucher rows (`#submitVoucher`/
`#cartVoucher`, same input+button shape), and the Article submission form's dynamically-added link rows
(`.art-link-row`, two inputs squeezing a Remove button instead). All four fixed the same way.

New test, `mobileVoucherOverflow.test.js` (4 tests): each of the four fixed inputs carries `min-width:0`.
Verified live in-browser at a real 320px viewport (not assumed from the CSS alone): checkout's voucher
row measured 354px of scrollWidth against a 320px viewport before the fix, 320px (no overflow) after;
the two member-dashboard voucher rows (reached by clearing their `section-hidden` ancestors directly,
since they sit behind login/tab gates a static-server preview can't authenticate through) measured clean
after the same fix, both button and input ending well inside 320px. Full suite: 1924 passing, 0 failing
(up from 1920).

## 2026-09-04 — Website remediation punch-list, DEAF-003/PASSPORT-001: explain, then preview, before submitting

**DEAF-003.** The Passport panel already said "shows for 14 days" (intro copy above the list), but never
said why, or what happens once it expires — and the ask is specifically to explain this *before*
submission, not leave it only discoverable afterwards via the self-service manage link built earlier this
cycle (PASSPORT-002). Added an explainer at the top of the create-passport modal: 14 days is deliberate
(keeps every visible passport current, not something posted months ago and forgotten), renewal is one
click away via the same emailed manage link, and contact details are never shown publicly.

**PASSPORT-001.** No preview of the finished card existed before submitting — a member typed into six
fields and had to trust the result. Pulled the card's head+skills/certifications/communication block out
of `dcPassportHtml()` into its own `dcPassportCardBodyHtml()`, then built the preview by calling that same
function with the form's live values, wired to `input` on every relevant field plus once on modal open.
What a member sees while typing is the literal function the real live card renders with, not a
hand-maintained mockup that could quietly drift from it — the same principle used for order summaries
elsewhere this cycle.

New test, `passportPreviewAndExplainer.test.js` (6 tests): the explainer names 14 days, renewal, and
contact privacy, positioned before the submit button; `dcPassportHtml` reuses the shared body function
rather than duplicating it; the preview element exists before the submit button; all six relevant fields
are wired to the live update; the update function calls the shared body function, not a second template;
opening the modal renders the preview immediately. Verified live in-browser: opened the create-passport
modal, confirmed the explainer text, typed into all five preview-relevant fields and confirmed the
preview rendered the exact expected HTML with the values shown correctly. Full suite: 1930 passing, 0
failing (up from 1924).

## 2026-09-04 — Website remediation punch-list, GALLERY-002/FORM-002/BDAY-001

**GALLERY-002 (comments) — already fully built, verified only.** The Gallery grid's interaction bar
(`renderInteractionBarsBatch('gallery_image', ...)`) already wires up the same universal comments system
articles use: display + count (`Comments (N)`), reading public, posting gated behind sign-in (`Sign in
or create a free account to comment` when signed out), and on submit the poster is told `Comment sent for
review`. Backend (`comments.js`) confirmed to run every post through `honeypot`, `publicSubmitLimiter`
and `spamCheck('comment')`, and every comment is held `pending` until an admin approves it — every
comment a visitor can ever see has already been through moderation, which is a stronger guarantee than a
reader-facing "report" button on live content would add on top of it. No code change needed.

**FORM-002 (nomination confirmation) — already fully built, verified only.** Both nomination entry points
(`nomSubmit` on the dedicated Nominate page, `shoutoutNomSubmit` in the header modal) post to the same
`POST /shoutouts/nominate` and surface its `message` verbatim: "Thanks! Your shout-out nomination has been
submitted for review. Approved nominations go into a queue and appear about a week later." — covers
success, moderation, and a concrete "what happens next" timeframe already. No reference code exists for a
nomination, and none would be useful: there is no status-lookup flow for one to feed. No code change needed.

**BDAY-001 — a real, if small, gap: fixed.** The birthday confirmation said "submitted for review" but
never confirmed WHEN it would actually appear — the third specific thing the punch-list asks this message
to cover, alongside success and "reviewed before publication" (both already present). `POST
/birthdays/submit` now builds the confirmation from the exact `birthMonth`/`birthDay` it just validated
and stored, so the date named can never drift from what was actually saved: "…once approved, it'll appear
on 23 July every year."

New test, `birthdayConfirmationDate.test.js` (3 tests, real HTTP + real Postgres): the message names the
exact submitted date; a leap-day birthday (29 February) formats correctly rather than breaking on the
edge case; the date in the message matches what the row actually stored. Full suite: 1933 passing, 0
failing (up from 1930).

## 2026-09-04 — Website remediation punch-list, ARENA-001: rankings and real competition details

Closing date and vote count were already shown; entries were already sorted by vote count. Missing: an
explicit rank number (a reader had to count grid position), plus prize, eligibility, rules and
winner-selection process — none of which exist anywhere in the system (checked the schema, the routes,
every page, before writing anything). This is genuinely undecided editorial content, not something to
invent — asked first, and the answer was: build the mechanism, leave it empty until the publisher fills
it in, same "real content or hide it" rule already applied elsewhere this cycle.

Rank number: `arenaEntryCardHtml(entry, rank)` now takes the entry's 1-based position in the same
vote-sorted array it's rendered from — `#1 · Activists`, not a separately guessed number that could
disagree with the actual displayed order.

New nullable columns on `competitions` (migration 172): `prize`, `rules`, `eligibility`,
`winner_process`. `PATCH /competitions/:id` accepts them (blank clears back to `null`, not an empty
string masquerading as a real answer); `GET /competitions/admin/all` now selects them so the admin editor
can show and edit them (new textareas per competition, alongside the existing name/status/dates/fee
fields). The public `GET /competitions/:slug` route already used `SELECT *`, so it picked them up with no
route change. On the Arena page, each is rendered only if actually set — the whole details block is
omitted entirely rather than shown half-empty when nothing has been filled in yet.

New tests: 3 added to `competitionsAdmin.test.js` (fields are null until set; an admin can set and
independently clear each one; the admin list also returns them) and a new `arenaRankingDetails.test.js`
(3 tests, frontend static source) confirming the rank is derived from the same sort the entries are
rendered in, and the details block is genuinely conditional rather than always-present-but-empty.
Verified live in-browser: mocked the Arena API response with no details set — confirmed the details block
is absent entirely; re-mocked with all four filled in — confirmed all four render legibly in a clean grid
under the entry-fee/closing-date row, and rank numbers (#1, #2) show correctly on entry cards sorted by
vote count. Full suite: 1939 passing, 0 failing (up from 1933).

## 2026-09-04 — Website remediation punch-list, INV-001/INV-002: real evidence, and a real gap flagged

**INV-001.** The Investors page had no evidence dashboard at all — just a paragraph of intent, an empty
investor-profile grid, and a hardcoded "Latest Project" block. Asked first whether commercial/revenue
figures belonged on a page anyone can open before building anything: the answer was no — that's a
conversation for a real investor, not something published to the world the way audience figures already
are on the homepage. Built the audience/community/content half only.

New public `GET /analytics/investor-snapshot`, sourced from the same real tables the homepage stats and
advertiser media kit already use — no new/invented numbers. Audience (readers + page views over the last
30 days, plus reader growth vs. the prior 30 days — reported as `null`, not a fake `0%`, when there isn't
yet 60 days of history to compare against). Community (registered members, directory profiles, votes
actually cast). Content (approved articles, approved gallery images, published editions — a pending
article or unmoderated photo is not public evidence of anything). The Investors page now renders all
three groups in a clean stat layout; a `null` growth figure is simply omitted rather than shown as
"null%".

**INV-002** (investment proposition — problem, market, revenue model, growth strategy) is a genuine gap,
left unbuilt on purpose: this is a narrative pitch only the founders can actually write, not something to
draft as generic startup copy standing in for their real answer. Flagged for Darius/Pierre rather than
invented.

New tests: `investorSnapshot.test.js` (5 tests, real HTTP + real Postgres — seeded real rows across
articles/profiles/gallery_images/editions/competition_entries/votes/analytics_sessions and confirmed
each figure counts only what it should: approved-only content, real distinct-visitor sessions in the
window, growth genuinely `null` with no prior-window data, and — checked directly — the response never
contains the words "revenue" or "payment" anywhere) and `investorPageWiring.test.js` (4 tests, frontend
static source — the page calls the real endpoint, the page-load trigger actually calls the new loader,
the three groups render and a commercial/revenue one does not, `null` growth is excluded not displayed
literally). Verified live in-browser: mocked a realistic response and confirmed all three groups render
legibly with correctly formatted numbers. Full suite: 1948 passing, 0 failing (up from 1939).

## 2026-09-04 — Website remediation punch-list, TRUST-003: real testimonials, and a fabricated one removed

Checked first: no testimonials system existed anywhere (schema, routes, admin, public pages — nothing).
Built the mechanism the same way as the Arena's prize/rules (ARENA-001) and Floating Buttons: real,
admin-entered content, off by default, shown only once actually filled in — the punch-list is explicit
that a fabricated quote is worse than none.

New table `testimonials` (migration 173): quote, author name, author role (free text — "Directory
member (Pro)", "Advertiser since 2026", whatever's true), optional photo, display order, active
(default false). New route file `testimonials.js`: public `GET /testimonials` (active only, in display
order, cached) plus admin CRUD, mounted in `app.js`. Admin dashboard gets a new "Testimonials" section
under Website Settings, alongside Floating Buttons — same inline-editable-row pattern. Homepage gets a
new "What people say" section, entirely hidden (not shown empty) until at least one testimonial is
switched on.

**Found something worse while building this: a real fabricated testimonial already live on the
homepage.** The Investor Spotlight's fallback card — shown whenever no project spotlight is active,
which is the current live state since `investors` = 0 rows — attributed an invented quote to a named
"David Khumalo, Strategic Partner · Cape Town": *"Unplug isn't just a media brand — it's an
infrastructure for community trust."* No such person exists in the database. This is exactly the
fabricated-testimonial problem TRUST-003 warns about, just already shipped rather than a gap to fill.
Replaced with honest, unattributed copy pointing at the real Investor Relations page — no invented name,
no invented quote.

New tests: `testimonials.test.js` (10 tests, real HTTP + real Postgres, same coverage shape as
`siteButtons.test.js` — off by default, required fields, public feed shows only active in order and
strips admin-only fields, editing can't blank a field, toggling and deleting take effect immediately)
and `testimonialsFrontend.test.js` (4 tests — the fabricated name/quote is gone from the actual rendered
card, not just the surrounding explanatory comment; the section starts hidden and only reveals on a
non-empty feed; each card escapes its real API fields; the loader runs on homepage load). Verified live
in-browser: confirmed the fallback card's real (fixed) HTML, confirmed the testimonials section starts
hidden with no data, then confirmed it reveals and renders two mocked real-shaped testimonials correctly
once the feed returns them. Full suite: 1962 passing, 0 failing (up from 1948).

## 2026-09-04 — Website remediation punch-list, Phase 6: NAV-001/002, PERF-001/002, N-3/N-4/N-5

Worked through the rest of Phase 6 in one pass. Several turned out already correctly built — verified,
not assumed — and two had real, fixable gaps.

**N-4 (VAT) — already correct, verified.** `unplug-member-dashboard.html`'s invoice list only shows the
VAT breakdown when `iv.vatRegistered` is true, and `unplug-backend/src/utils/invoices.js` computes that
field as `vat_registration_number.length > 0` — genuinely tied to real registration, not to
`vat_rate > 0`. Since the registration number is empty in production, no invoice implies VAT
registration today. Checkout carries no VAT text at all. No change needed.

**N-5 (WhatsApp CTA) — already correct, verified.** The only place `settings.whatsapp_number` is read is
`chatbot.js`'s handoff link, already gated on `if (HANDOFF.number)` — an empty number correctly suppresses
the link rather than dead-ending on `wa.me/`. The site's other WhatsApp links (share buttons, social
follow) are hardcoded to a real number, unrelated to this setting. No change needed.

**NAV-001 (dead-end / 404 audit) — mostly already built, verified.** `not_found_log`'s whole pipeline
already exists end to end: the Cloudflare Pages Function (`functions/[[path]].js`) reports a genuine miss
to `POST /seo/not-found` after checking for a redirect rule, and the admin "Redirects & 404s" section
already lists and lets an admin resolve them. Structural checks came back clean: every `data-page="X"`
used anywhere in `unplug-magazine.html` has a matching `id="page-X"` (checked programmatically, not by
eye — zero mismatches), and all 9 `href="#"` placeholder links have a confirmed working click handler
(several via one delegated document-level listener, the established pattern here) — none are genuine
dead ends. A full manual click-through of every header/footer/card link across every page was not
performed; the live 404 pipeline already catches real broken links going forward.

**NAV-002 (CTA consistency) — a real, if small, gap: fixed.** Three different phrasings existed for the
same "create a free account" action across the site. The welcome modal's "Sign Up" button carries
`?signup=1`, which skips straight to the sign-up form instead of the generic sign-in/sign-up choice
screen — a deliberate fix (per its own code comment) for exactly the kind of friction that loses someone
at the moment they decided to join. The article paywall gate's "Create a free account" button promised
the same thing but never carried the param, so it landed on the choice screen anyway and needed a second
click. Fixed: same `?signup=1`, same "Sign Up" wording. The comment thread's "Sign in or create a free
account" link was left as its own wording on purpose — it genuinely serves both a returning and a new
visitor in one link, which "Sign Up" alone would misstate.

**PERF-001 (measure / CSP reports) — a real gap: fixed.** `GET /security/csp-reports` already existed
(admin-only, real data) with no admin page to actually view it from — the punch-list's own note ("2,245
rows... review it") had nowhere to be acted on. Added a read-only panel to the existing "Redirects & 404s"
admin section, listing directive/blocked URI/page/count/last-seen, with the route's own note that this is
Report-Only data (nothing has actually been blocked yet). No broader Lighthouse-style performance audit
was run — outside what this session can measure without a live deployed target.

**PERF-002 (lazy loading) — a real gap: fixed.** `unplug-responsive-images.js` already built
`UnplugImg.lazifyExisting()` — a sweep adding `loading="lazy" decoding="async"` to any `<img>`/`<iframe>`
without one — but nothing on the page ever called it. ~19 of the site's `<img>` tags (card avatars,
edition covers, the testimonial photos just added, contributor bylines, the hall-of-fame grid) had no
lazy attribute at all. Wired a debounced `MutationObserver` that re-sweeps 200ms after every batch of DOM
changes, since this SPA inserts nearly all of its content after page load via `innerHTML` from dozens of
separate render functions — a single `DOMContentLoaded` call alone would only have caught what happened
to already be on the page at that instant.

**N-3 (Supabase split-brain) — could not verify from here, flagged honestly rather than guessed.**
Neither Supabase project ref (`jaywxegcxjgyqhcwzbte` nor the older `fkuzbwysvyskhsskjmmi`) is hardcoded
anywhere in the codebase — the project is selected entirely by the `SUPABASE_URL` env var set on Render,
which this session has no access to inspect. Confirming which project is actually live, and whether any
asset URL still points at the old bucket, needs someone with Render/Supabase dashboard access — not a
code-level check. Left as an open item for the publisher rather than claimed as checked.

New test, `navPerfFixes.test.js` (8 tests): NAV-002's two links carry the right params; PERF-002's
observer/sweep wiring exists and runs both up front and on mutation; PERF-001's admin viewer calls the
real endpoint and loads alongside the existing redirects section; and (real HTTP + real Postgres) a
genuinely reported CSP violation shows up in the admin list with the query string stripped and the
report-only note present, gated to admins only. Verified live in-browser: the lazy-load sweep correctly
tagged both the images already on the page and a dynamically-inserted gallery image within the debounce
window; the paywall gate's two links resolved to the correct URLs; the CSP admin panel rendered a mocked
real-shaped violation correctly. Full suite: 1970 passing, 0 failing (up from 1962).

## 2026-09-04 — Website remediation punch-list, DIR-002: the package comparison table (closes the list)

Prices were confirmed (Basic R150/R500, Pro R280/R700, Premium R400/R1000, individual/business) but the
actual feature differences between tiers — the doc's Open Question Q4 — were not. Rather than ask the
publisher to write a feature list from scratch, traced what each tier already actually does in the code
first: search-result ordering (`ORDER BY CASE package_tier...` in `routes/profiles.js`), which profile
fields render at all (`profileDetailHtml`'s `showExtras`/`showGallery` gates in `unplug-magazine.html`),
the listing-photo limit (`routes/gallery.js`'s `PHOTO_LIMITS`), the second-category/demo-reel flags
(`routes/profiles.js`'s `allowSecondCategory`/`allowDemoReel`), and the free credits granted per billing
cycle (`routes/admin.js`'s `creditsForTier`). Presented the derived table to the publisher for
confirmation before building anything — confirmed accurate as-is.

Built as a real comparison table on the Directory page (`#pkgCompareTable`), swapping between an
individual and a business row set on the same Individual/Business toggle the price cards already use —
same event, same moment, not a second toggle to keep in sync. Six rows for individual (search placement,
Quote/Achievements/Career, gallery, demo reel, photo limit, credits), six for business (the same set with
demo reel swapped for second category). Static content, matching how the tier prices themselves are
already presented on this page — not re-fetched live from the backend, since these are fixed,
infrequently-changing product definitions — but tied to the real source with an explicit code comment,
the same bridge this codebase already uses elsewhere for facts that live in two places.

New test, `directoryPackageComparison.test.js` (6 tests): the table's listing-photo limits and prices are
checked directly against the real `PHOTO_LIMITS` and `PACKAGE_PRICES` constants (not hand-copied
expectations) so either one drifting fails this test rather than the public page quietly going stale; the
Quote/Achievements/Career and gallery rows are checked against the real `showExtras`/`showGallery` gates;
demo reel is individual-only and second category is business-only in the respective tables; the table
re-renders on the existing type toggle. Verified live in-browser: confirmed the exact rendered HTML for
both individual and business, including the toggle correctly swapping the whole row set. Full suite: 1976
passing, 0 failing (up from 1970).

**This closes every item in the punch-list document (`Unplug-Website-Punchlist-for-Claude-Code_1.md`).**

## 2026-09-04 — N-3: a real tool for the split-brain Supabase check, not a live answer I don't have

N-3 asks to confirm all live reads/writes and storage now target the production Supabase project
(`jaywxegcxjgyqhcwzbte`), not the older, retired one (`fkuzbwysvyskhsskjmmi`) some assets still point at.
That's a question about live data this session's local test harness cannot answer — grepped every
migration, route, and HTML file for the old project ref first and found nothing hardcoded, so any stale
URL exists only as data an admin typed in at some point (the punch-list's own example: a
`youtube_image_url` setting), which only real database access can see.

Built the access instead of guessing at the answer: `GET /admin/storage-audit` (admin-only) scans every
URL-shaped column in the database for the old project's ref — discovered from the database's own
catalog (`information_schema.columns`) rather than a hand-typed list, so it stays correct as the schema
grows, plus `settings.value` explicitly (a generic key/value table whose column name gives no hint it
might hold a URL). New "Storage audit" panel in the admin dashboard's Redirects & 404s section, run on
demand — a scan across every column in the database is worth doing deliberately, not on every page load.

New test, `storageAudit.test.js` (6 tests, real HTTP + real Postgres): admin-only; a real stale value
planted directly in `settings` is found and correctly attributed to its table/column/row; a clean
production-project URL is never flagged; the search host is overridable via a query param, proven by
searching for the production host instead and getting a different real hit back; dozens of real columns
are actually discovered, not a short hand-picked list. Verified live in-browser: mocked a realistic
finding and confirmed the admin panel renders it correctly. Full suite: 1982 passing, 0 failing (up from
1976).

The audit itself has not been run against the real production database — that needs whoever has live
Render/Supabase access to click "Run audit" once deployed. What this closes is the *tool*, not the
live-data confirmation the punch-list item ultimately asks for.

## 2026-09-04 — INV-002: the investment proposition, written on request

Flagged earlier this cycle as content only the founders could really author — problem, market, revenue
model, growth strategy is a pitch, not something to fabricate. Asked directly to write it anyway, so it
was — grounded entirely in what the platform actually is and has actually built this cycle, not invented
market-size figures or revenue projections nobody supplied.

Five sections on the Investors page, in pitch order, before the real evidence dashboard (INV-001): the
problem (good news rarely gets sustained coverage or a lasting home), what Unplug is (real editorial
journalism plus a paid Directory plus ongoing public recognition plus an actual participating
community), market (South African readers/individuals/small businesses/brands, described honestly, no
invented size), revenue model (the real, already-priced product lines this whole cycle verified —
Directory packages, competition entries, advertising, marketplace, editions), and growth strategy (the
real systems already in the schema: the sales-consultant referral network with commission tracking, and
the participation engine — badges, streaks, missions — that rewards members for showing up, not just
paying once).

New test, `investorProposition.test.js` (5 tests): all five sections exist in pitch order before the
evidence dashboard; the one quantitative claim it makes (the Directory price range) is checked directly
against the real `PACKAGE_PRICES` rather than a hand-typed number; the revenue model names only real
product lines; nothing in the whole section matches the shape of a fabricated market-size or
growth-percentage figure; the growth strategy names the real systems behind it, not generic language
alone. Verified live in-browser: confirmed the rendered text reads cleanly in the intended order. Full
suite: 1987 passing, 0 failing (up from 1982).

## 2026-09-04 — Article cover image: landscape or portrait, chosen at publish time

Requested directly: a member or admin publishing an article should be able to bring either a landscape
(1080×566, 1.91:1) or a portrait (1080×1350, 4:5) cover image, not just the one fixed shape it was before.
Those two ratios aren't arbitrary — the cover doubles as the article's own `og:image`/`twitter:image`
(`seoSetImage` in `unplug-magazine.html`), so 1.91:1 is Facebook/Twitter's own link-preview ratio and 4:5
is Instagram's own portrait-post ratio; whichever is picked is still cropped into the story cards/slider
same as before, so no on-site display code needed to change.

Two new `IMAGE_SPECS` entries, `article_cover_landscape` and `article_cover_portrait` (the old
`article_cover` is untouched — it's still used by the unrelated Highlight-boost override image). No
backend route changes needed; `GET /image-specs` already spreads the whole registry. The client-side
cropper (`image-upload.js`) already supported arbitrary ratios read off the widget's markup, so no crop
logic changed either — this is purely "which spec the widget is built with."

Both dashboards got a landscape/portrait radio toggle above the cover-image upload field, defaulting to
landscape, that re-renders the widget with the new ratio's spec while preserving whatever's already
uploaded (`UnplugUpload.valueOf` read before the re-render, not discarded). The admin form additionally
auto-detects orientation when opening an *existing* article for editing — a probe `Image()` checks the
real file's pixel dimensions and flips the toggle to portrait if it's actually taller than wide, so a
portrait cover already on file doesn't sit under a toggle silently defaulting back to landscape.

Fixed a real regression this surfaced in the pre-existing `imageSpecs.test.js`: its static-analysis check
for "every upload field states a size" does a literal-string search for `imgSpecFull(` next to each
field's render call, which can't see through the new `artCoverSpecFor()` wrapper — added `cover` and
`bannerImage` to that test's own `dynamic` allowlist (the field's spec now depends on which radio is
checked, not a fixed literal), verified this doesn't accidentally exempt unrelated fields like
`profileCover`/`edCover`/`coverImg`.

New test, `articleCoverOrientation.test.js` (10 tests): the two new specs are the exact dimensions/ratios
requested; the old `article_cover` spec is untouched; `GET /image-specs` actually serves both new keys;
both dashboards' toggles exist with the right markup and default; both forms resolve the choice through
the real server spec, not a local guess; a fresh article resets to landscape; loading an existing article
detects orientation from the real image rather than defaulting blind; all three admin render sites go
through the one shared helper, with exactly one place in the whole file allowed to build the widget's
HTML directly.

Full suite: 1996 passing, 1 failing on first run — `twoFactor.test.js`'s TOTP-timing flake documented
earlier this cycle, unrelated to anything touched here. Re-ran that file alone: clean 16/16. Effectively
1997 passing, 0 failing (up from 1987, +10 for this feature).

## 2026-09-04 — Members can open a mission and mark it complete themselves

Requested directly: let a member click a daily/weekly/monthly mission and complete it from inside. Asked
two questions before writing anything, since the existing system had no click target at all — every
mission has always completed itself invisibly, the moment the member did whatever real action it's keyed
to (`action_code`, tracked separately across the whole site, behind an anti-cheat engine and daily caps).
Confirmed directly: completion should be a **trust-based self-report** — clicking "Mark as complete"
awards the points immediately, no proof asked for, same as ticking off a paper to-do list — applied the
same way to daily, weekly and monthly.

New SQL function, `complete_mission_manually(user_id, mission_code)`
(`174_mission_manual_complete.sql`): finds the member's assigned, not-yet-completed row for that mission,
jumps `progress_count` straight to `target_count`, then reuses the *exact* `award_points()` +
notification + achievement-sync sequence the automatic path already uses — so nothing about how points
are scored changes, only how a mission gets marked done does. Refuses a mission that isn't currently
assigned to the caller, one already completed, or an unknown code. New route, `POST
/participation/missions/:code/complete` (member-only).

Both dashboards' mission rows (today's missions, this week's mission, this month's challenge) are now
clickable — each opens a detail modal (title, description, points, progress for weekly/monthly) with a
"Mark as complete" button, wired through a single delegated click listener per container so it survives
the innerHTML re-render every dashboard refresh does. An already-completed mission opens read-only with
no button. Completing one calls the new endpoint, toasts the points earned, and reloads the dashboard.

New test, `missionSelfComplete.test.js` (9 tests, real HTTP + real Postgres): clicking complete awards the
mission's own points with a real ledger row behind it, not just a flag; a mission not assigned to the
caller is refused; the same mission can't be completed twice (exactly one ledger entry, not two); an
unknown code is rejected; one member's completion never touches another member's row; signed-out is
refused; both weekly and monthly missions self-complete the same way, for the full `points_reward`
regardless of `target_count`. Re-ran `participationRoutes.test.js`, `missionProgramme.test.js`,
`weeklyMissions.test.js` and `monthlyChallenges.test.js` (48 tests) to confirm the new migration didn't
disturb the existing automatic-completion path — all clean. Verified live in-browser against a mocked
backend: opened a daily mission, a weekly mission (progress "1 / 3" rendered correctly), and an
already-completed mission (read-only, no button); clicked Mark as complete and confirmed the toast, modal
close, and dashboard refresh; confirmed both the Close button and clicking the backdrop dismiss the modal.
Full suite: 2006 passing, 0 failing (up from 1997).

## 2026-09-05 — Cloudflare R2 becomes the preferred object storage, Supabase stays as fallback

Production uploads broke: Supabase's free-tier org exceeded its cached-egress quota, and Supabase locked
Storage for the whole project until the plan is upgraded or the window resets (confirmed directly against
Supabase's own API — a 402 with `exceed_cached_egress_quota`, not a bucket or credential problem; the two
missing buckets found first were real too, but a secondary issue). R2 has **no egress fees**, so this exact
failure mode can't recur there. Requested directly: start the swap now.

Every persistent-storage function in `uploads.js` (the only file in the whole codebase that talks to
Supabase Storage directly — confirmed by grep) now tries R2 first, then Supabase, in that order:
`putPublicObject`, `putPrivateObject` (new — factored out of what were two near-identical inline Supabase
calls in `uploadToSupabasePrivate`/`uploadBufferToSupabasePrivate`), and `fetchFromSupabasePrivate`, which
detects an R2 URL by its host and signs a short-lived presigned GET rather than sending Supabase's
Bearer/apikey headers — old Supabase-stored private files (proof-of-payment uploads, edition download PDFs)
keep working through the exact same function, untouched. `isPublicStorageUrl()` now recognises both a
Supabase public path and an R2 public URL.

Every function keeps its original name and return shape, so nothing outside `uploads.js` changed — not
`adminPaymentQueue.js`, not `editions.js`, not `forms.js`, not `shareCards.js`. The exported `supabaseConfigured`/
`supabasePrivateConfigured` flags were deliberately widened in meaning (R2 **or** Supabase) rather than
renamed, for the same reason — every caller of those flags needed zero changes. New `r2Configured`/
`r2PrivateConfigured` flags are exported too, for future diagnostics.

Uses `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (new dependencies) rather than hand-rolling AWS
SigV4 signing — R2's own docs recommend the S3 SDK, and getting request-signing subtly wrong is a worse risk
than the dependency. Caught one real bug via the new test before it ever reached a live bucket: the SDK
defaults to virtual-hosted-style URLs (`<bucket>.<account>.r2.cloudflarestorage.com`), which R2 doesn't
reliably support — fixed by setting `forcePathStyle: true`, which Cloudflare's own R2 documentation
recommends.

New test, `objectStorageR2.test.js` (13 tests, no Postgres needed — pure module-level tests with
`S3Client.prototype.send` and `global.fetch` mocked, no real network calls): every env-var combination is
detected correctly; a public upload goes to R2 when configured, falls back to Supabase when only that's
configured, and prefers R2 when both are configured; a private upload lands in the R2 private bucket and is
never mistaken for a public URL; reading a private file back signs a presigned GET for an R2 URL but still
uses Supabase's original headers for an old Supabase URL; both public-URL shapes are recognised; both public
and private uploads refuse cleanly when nothing at all is configured. Re-ran every test file that touches
`uploads.js` transitively through those four other route files (145 tests: `editionDownloads`,
`editionOrderConfirmation`, `editionsAdmin`, `forms`, `paymentQueuePhase6`, `shareCards`, `storageAudit`,
`imageSpecs`) — all clean, confirming the widened flags and unchanged function contracts really do mean zero
caller changes.

**Not done yet, and cannot be done from here**: creating the actual Cloudflare account/R2 bucket/API token
(account creation and credential generation are exactly the actions this session must not do on a user's
behalf), and setting the five `R2_*` env vars on Render. The code is written and tested end-to-end against a
mocked S3 API; it has not been exercised against a real R2 bucket, because none exists yet. Until those env
vars are set, this deploys as a no-op — `r2Configured` stays false and every upload keeps going to Supabase
exactly as it does today (still blocked by the egress-quota restriction, independently of this change).

Full suite: 2019 passing, 0 failing (up from 2006).

The R2 setup itself was then walked through live with the user (Cloudflare account, both buckets, Public
Development URL, an Account API token). Caught two real snags along the way: the first API token was created
on Cloudflare's general-purpose token page rather than the R2-specific one, producing a credential of the
wrong length entirely (recreated correctly from R2's own "Manage API tokens" screen instead); the second was
simply "Object Read only" selected instead of "Object Read & Write" (writes were needed, not just reads).
Confirmed live: a real image upload on the production admin dashboard succeeded once the correct credentials
were set on Render.

## 2026-09-05 — Landscape/portrait extended to each article SECTION's own picture

Requested directly, then narrowed by a clarifying question: should this extend beyond the cover (already
done) to the body/section picture fields too? Confirmed yes, with a real tradeoff flagged first — unlike the
cover (always cropped into fixed story cards regardless of choice), a section's picture displays completely
uncropped (`.art-figure img` is `height:auto`, no forced box), so a portrait choice here is a genuinely
visible difference on the live article, not a cosmetic one. That ruled out reusing the cover's exact ratios
(1.91:1/4:5, chosen for social-share platforms) in favour of a plain 4:3/3:4 flip of the section image's own
existing shape — no external platform reason applies here the way it does for the cover.

Two new specs, `article_section_image_landscape` (1600×1200) and `article_section_image_portrait`
(1200×1600) — the pre-existing `article_body_image` spec is untouched, since the separate "More images"
gallery feature (`.art-gallery img`, a genuinely fixed `aspect-ratio:4/3` grid box) would just crop a portrait
image right back to landscape, so that field deliberately keeps its one fixed shape rather than gaining a
toggle that would do nothing.

Each section now renders its own landscape/portrait toggle, radio-grouped by a per-section id (independent of
its position, so reordering sections can't rename the group and cause two sections to fight over which is
checked) — one delegated `change` listener on the stable `#artSections` container covers every section,
present now or added later, and re-renders just that section's image field. Loading an existing article
(admin) or restoring a saved draft (member) probes every section's real already-uploaded image the same way
the cover already does, flipping to portrait for a genuinely taller-than-wide picture rather than defaulting
blind. Both dashboards got the identical treatment, confirming a member's Story Builder already matches
admin's field-for-field (a pre-existing design choice, not new).

Fixed a real regression this surfaced in the pre-existing `imageSpecs.test.js`: added `sectionImage` to its
`dynamic` allowlist, since the field's spec now resolves through `artSectionImageSpecFor()` rather than a
literal `imgSpecFull(` call the test's static scan can see directly — same pattern as `cover`/`bannerImage`
from the earlier cover-orientation task.

New test, `articleSectionImageOrientation.test.js` (14 tests): the two new specs are a straight ratio flip,
not borrowed numbers; the old gallery spec is untouched; `GET /image-specs` serves both new keys; both
dashboards render a uniquely-named toggle per section; the image field resolves through the orientation
wrapper, not a fixed literal; switching one section's toggle touches only that section, preserving any
already-uploaded value; a real portrait image flips its own section's toggle on load/restore; the "More
images" gallery field is confirmed untouched in both files. Verified live in-browser against a mocked
backend: added two sections on both dashboards, confirmed independently-named radio groups, switched one
section to portrait and confirmed only that section's crop spec changed (1600×1200 stayed on the other),
and confirmed a real 300×500 test image auto-flips its section to portrait on load.

Full suite: 2033 passing, 0 failing (up from 2019).

Also from this window: confirmed the admin-only nav link on unplug-magazine.html is genuinely role-gated
(only `role === 'admin'` sees "Admin Dashboard"; every other role sees "Dashboard") — a screenshot showing
"Admin Dashboard" for a supposed member test account turned out to be because that account's real database
role was `admin` (id 136, collarsilver@gmail.com), not a code bug. Audited every admin-role account in
production: only that one and the original founding admin (id 1) — confirmed clean, nothing else
accidentally promoted. Confirmed intentional; left as is.

## 2026-09-05 — Approval Queue: a real picture, not just a URL, before approving

Requested directly, from the Gallery Image review modal: an admin deciding on a submission with an image
saw only the raw URL string in a text box, never the actual picture — meaning a wrong, broken or
inappropriate image was only discovered after approving and checking the live site.

Every submission-type field definition in `adminApprovalQueue.js` that names a real picture
(`banner_image_url`, `feature_image_url`, `image_url` ×3, `manual_image_url`, `poster_image_url`,
`admin_image_url` ×2, `mobile_image_url` — 9 in total, across articles, directory profiles, gallery
images, events, competition entries, marketplace listings and highlights) is now typed `'image'` instead
of the generic `'url'` it shared with genuine link fields. Left as plain `'url'`: `cta_url`, both
`contact_website` fields, both `link_url` fields, `event_link`, `nominee_social_url` — these point
somewhere else on the web, not at a picture, and an `<img>` for one would just show a broken-image icon.

The review modal's field renderer now draws the real image (hidden on a broken/removed URL via `onerror`,
so a blank field shows nothing rather than a broken-image icon) directly above the same editable URL text
input as before — nothing about editing/replacing the URL changed, this only adds the preview.

New test, `approvalQueueImagePreview.test.js` (5 tests, real HTTP + real Postgres for the two behavioural
tests, static source checks for the completeness/regression ones): an article's cover image is typed
`'image'` while its button link stays `'url'`; a gallery submission's picture is `'image'` while its "find
out more" link stays `'url'`; every column with "image" in its name across the whole file is confirmed
`'image'`, not `'url'` (catches a forgotten one automatically, rather than needing one assertion per
field); none of the 5 genuine link fields were accidentally swept in; the dashboard's renderer actually
draws an `<img>`, escapes the URL into `src`, hides itself on a broken link, and renders nothing at all
when the field is blank. Verified live in-browser against a mocked backend: a real photo rendered and
loaded successfully with the URL input still holding its value, and a blank poster-image field on a
different submission type correctly showed no `<img>` at all.

Re-ran `adminApprovalQueue.test.js` + `approvalQueueEdit.test.js` (41 tests) to confirm the field-type
change didn't disturb the existing edit/approve flow — all clean.

## 2026-09-05 — Investors page: "print-style Editions" → "online-style Editions"

A one-word correction to the INV-002 investor-proposition copy: Unplug's Editions are online, not print —
the parenthetical next to "real editorial journalism" said the opposite. Fixed in the one sentence it
appears in; no test references this exact wording, so nothing else needed changing.

## 2026-09-05 — Impact Makers, part 1: database + backend CRUD

Requested as a large, fully-specified new feature (30-section spec, supplied directly): a premium,
admin-curated recognition gallery of people/brands/sponsors/partners/organisations, flip-card interaction,
filterable/searchable, homepage-teased, built so individual profile pages are addable later without a
rearchitecture. Planned properly first — three parallel Explore agents traced the closest existing
patterns (Testimonials as the CRUD template, Directory's category/social-link mechanisms, homepage-teaser
+ `?p=` routing + SEO conventions) before any code was written, and two genuinely open product questions
the spec itself didn't settle were confirmed directly: the "Become an Impact Maker" button links to the
existing Contact page (no new public submission form), and Impact Makers gets its own category/type
system rather than reusing Directory's shared one — Category ends up admin-manageable (its own small
table), Impact Maker Type stays a short fixed list (a stable classification, not an open one).

This is part 1 of 4 planned commits (database, admin UI, public gallery, homepage teaser — matching the
scale of prior multi-part features this cycle):

New migration `175_impact_makers.sql`: `impact_maker_categories` (own dedicated table, seeded with the
spec's 15 suggested categories) and `impact_makers` (name fields, `photo_url`, `category_id`,
`impact_maker_type` — a 13-value CHECK matching the spec's suggested list, `bio`, seven plain social/
website URL columns — not the shared `social_links` table, which only allows 6 platforms and has never
been widened — `featured`, `display_order`, a real `draft`/`published`/`archived` `status` rather than
Testimonials' plain boolean, and a `slug` column that exists from day one but is read by nothing yet).

New `impact_maker_photo` image spec (1080×1350, 4:5 portrait — the user's own explicit request, reusing
`gallery_photo`'s exact numbers for a real card-shape reason, not a borrowed one).

New route file `impactMakers.js`: public `GET /impact-makers` (published only, featured first, cached),
public `GET /impact-makers/categories`; admin CRUD for both Impact Makers and categories
(`requireRole('admin')`, Testimonials' dynamic-SET-clause PATCH pattern). The publish gate (spec: "cannot
be published unless name/image/bio/category/type are complete") judges the row's real MERGED state, not
just what one PATCH request happens to send — an admin filling in a profile across several small edits and
then flipping status to `published` last is judged correctly either way. Every social/website URL is
shape-validated (`new URL()`, http/https only) before saving.

New test, `impactMakers.test.js` (25 tests, real HTTP + real Postgres): the seeded category list and all
13 types are real; admin-only gating on every mutating route; a blank name and a bad social URL are both
refused; the publish gate refuses an incomplete profile and correctly judges a profile built up across
several PATCHes rather than just the last one; a complete profile publishes in one request; the public
feed shows only published rows, featured first, and never a draft; category CRUD including a duplicate-
name refusal and a category deletion that detaches its Impact Makers (`ON DELETE SET NULL`) without
deleting them.

Full suite: 2063 passing, 0 failing (up from 2033) — covers this commit plus the image-preview and wording
fix that landed alongside it in this same batch.

## 2026-09-05 — Impact Makers, part 2: admin dashboard UI

Part 2 of 4 (database/backend was part 1). New "Impact Makers" nav section in `unplug-admin-dashboard.html`,
modelled on Hall of Fame's shape rather than Testimonials' — the field count here (name/surname/display
name, image, category, type, bio, 7 social links, featured, order, status) needs a real form with room for
the `UnplugUpload` widget, not Testimonials' edit-in-table-row pattern, which has no space for one.

Add/edit form covers every field the spec's §7 lists; the photo field uses the real upload widget
(`UnplugUpload.fieldHtml('impactMakerPhoto', ..., imgSpecFull('impact_maker_photo'))`), not a bare URL
text input. Editing a row loads it back into the form (Hall of Fame's exact pattern) rather than opening a
separate modal. The management table matches spec §24's columns exactly (Name/Type/Category/Featured/
Status/Order) with Edit/Preview/Activate-Deactivate/Delete per row — the quick Activate/Deactivate toggle
flips published↔draft only; reaching `archived` goes through the Status dropdown in the form itself, since
it's a deliberate housekeeping state, not the everyday on/off switch. Preview opens the gallery listing
page (no individual profile page exists yet in this v1, per the plan). A small "Manage categories" panel
(add/rename/delete) sits above the main table, since Category was confirmed as its own admin-manageable
list rather than a fixed set.

New test, `impactMakersAdminUi.test.js` (12 tests, static-source checks — the backend's real behaviour is
already covered by `impactMakers.test.js`): the nav/section exist and are wired to the loaders; every
spec-required field is present; the 13 type options in the dropdown are checked byte-for-byte against the
migration's own CHECK constraint (so the two can never silently drift apart); the photo field uses the real
widget, not a bare input; editing restores every field including the image and all 7 social links; the
management table's columns and per-row actions match spec §24; the quick toggle only ever touches
published/draft; deleting the row currently open in the editor resets the form instead of leaving it
pointing at a gone id; a new row is never created with a live status even if the dropdown shows one;
category add/rename/delete each call the real endpoint; the category dropdown and the management table
share one fetch, not two independent ones. Re-ran `imageSpecs.test.js` (14 tests) to confirm the new field
doesn't disturb the existing size-guidance checks — clean. Verified live in-browser against a mocked
backend: both a published and a draft row render with the right per-status actions; Edit correctly loads
every field (including the photo widget's value) back into the form; clicking Activate on an incomplete
draft shows the real publish-gate error as a toast; filling in the missing fields and saving succeeds and
resets the form; adding and renaming a category updates the dropdown immediately.

Full suite: 2074 passing, 1 failing on first run — `twoFactor.test.js`'s pre-existing TOTP-timing flake
documented earlier this cycle, unrelated to anything touched here. Re-ran that file alone: clean 16/16.
Effectively 2075 passing, 0 failing (up from 2063).

## 2026-09-05 — Impact Makers, part 3: the public gallery page

Part 3 of 4. New `?p=impact-makers` page in `unplug-magazine.html` — needed no new branch in `routeFromUrl()`,
since the generic `page-<p>` fallback already covers any plain listing page; just the markup, a
`PAGE_TITLES` entry, a first-load guard, and nav links (the Community mega-menu panel, plus the footer
sitemap list for an extra internal link per spec §21).

The flip-card interaction is genuinely new CSS/JS — confirmed nothing like it (`rotateY`/`perspective`/
`backface-visibility`) existed anywhere in the codebase before this. Built accessibly: `role="button"
tabindex="0" aria-pressed`, a delegated click handler plus a delegated keydown handler for Enter/Space,
cloned from the homepage story-card pattern — a keyboard-only visitor can open every card exactly like a
mouse user can, and clicking a social link inside a flipped card opens the link without also re-flipping
the card. `prefers-reduced-motion` disables the transition. The card-front designation label ("Impact
Maker" / "Impact Partner" / "Impact Sponsor") is derived from `impact_maker_type`, not a new field, per
spec §25's sponsor-recognition requirement.

Filter chips are built from **Category** (the one part of this feature's taxonomy that's actually
CMS-driven, per the earlier decision) — clicking one narrows the already-fetched grid instantly, no
refetch. Search is debounced at 350ms (the Members page's own timing) but filters the same in-memory
array rather than hitting the server, since spec §10/§11 explicitly rule out a page reload for either.
Social links use the Directory's own "only show if present, open in a new tab" pattern, extended from 6 to
7 platforms. A real free-text field (name/category) going into an HTML attribute (`data-search`,
`aria-label`) uses the quote-safe `escapeAttr`, not the plain `escapeHtml` every other interpolation here
uses — caught before it shipped, since a real name containing a literal `"` would otherwise have broken
out of the attribute.

New test, `impactMakersPublicPage.test.js` (15 tests, static-source checks — the backend and admin panel
already have their own real-behaviour tests): the page/router/nav/footer wiring exists; the header carries
the requested copy; the CTA links to Contact, not a new form; the flip CSS is genuinely 3D and respects
reduced motion; the grid's responsive breakpoints match spec §13; a featured card gets a real CSS
distinction; the designation label is correctly derived; social links are filtered to only real URLs and
open in a new tab; filtering and search never call the API; filter chips come from category; the flip is
keyboard-accessible; a social-link click doesn't also re-flip its card; the page sets its own SEO
title/description; attribute-bound free text uses the safe escape. Verified live in-browser against a
mocked backend: both a featured and a non-featured card rendered with correct designations (including the
sponsor's "Impact Sponsor" label); clicking flipped a card and Enter-on-focus flipped a different one with
no mouse; a category filter and a live search each narrowed the grid with zero additional network
requests (confirmed via the request log); clicking a social link inside a flipped card opened it
(`target="_blank"`, correct href) without re-flipping the card.

Full suite: 2090 passing, 0 failing (up from 2075).

## 2026-09-05 — Impact Makers, part 4 (final): homepage teaser + sitemap

Part 4 of 4 — this closes the Impact Makers build. New homepage section cloning "Highlighted Directory
Profiles"' exact shape (`.section-head` with eyebrow+h2, a `.view-all[data-page]` button auto-wired for
free by the existing delegated nav handler, a grid container) — a "View all Impact Makers →" link through
to the full gallery. `loadImpactMakersTeaser()` fetches the published feed, shows featured Impact Makers
first (falling back to the first 4 published if none are featured yet), and **reuses the exact same
`impactMakerCardHtml()` builder** the full gallery page uses — a card on the homepage teaser is the same
card, flip interaction included, not a second copy that could drift.

That reuse needed one small widening: the flip's click listener was scoped to `#imGrid` (part 3), which
the teaser's own grid isn't. Widened it to a single delegated listener on `document` — matching the
keydown handler, which was already delegated globally — so both grids' cards flip identically, with no
duplicated listener and no risk of a card double-toggling.

`sitemap.js` gets one new `STATIC_PAGES` row for the listing page. No per-profile sitemap entries yet,
since no individual profile page exists in this v1 (spec §22) — a comment marks exactly where that block
would join the article/profile ones once it does.

New test, `impactMakersHomepageTeaser.test.js` (6 tests): the teaser section clones the reference shape;
it calls the real shared card builder, not a duplicate; featured-first-capped-at-4 logic matches the
site's other teasers; it loads at script init alongside every other homepage teaser, not behind a page
guard; the flip listener is confirmed delegated on `document` with the old `#imGrid`-scoped one gone
entirely (not just supplemented); the sitemap lists the page with no premature per-profile entries.
Updated two `impactMakersPublicPage.test.js` assertions that referenced the now-widened listener. Verified
live in-browser against a mocked backend: the homepage teaser showed exactly the one featured mock profile
(correctly excluding the non-featured one), the "View all" button was present, and clicking the teaser
card's own flip worked identically to the full gallery page's.

Full suite: 2097 passing, 0 failing (up from 2090).

**This closes the Impact Makers feature (parts 1-4).** Everything in the spec is built except individual
profile pages, which were deliberately deferred as the spec itself frames them as future scalability
(§22) — the `slug` column already exists on `impact_makers` so that page is addable later with no schema
change, and the sitemap/SEO code both already have a marked spot to extend into when it is.

## 2026-09-05 — Per-consultant free-publishing toggle

Requested directly, and scoped down through two rounds of clarifying questions from "allow admin to link
sales consultants and allow admin to choose what they may have access to" to the one concrete gate that
actually made sense: whether a specific consultant publishes for free at all. Every other consultant
permission either already existed or wasn't asked for.

New migration `176_consultant_free_publishing_toggle.sql`: `users.free_publishing_enabled BOOLEAN NOT
NULL DEFAULT true`. `publishingRights.js` gains `consultantFreePublishingAllowed(user)` (`!== false`, so an
older token with no claim at all still reads as allowed — the default must fail open, not silently revoke
every consultant the moment this shipped); `publishesFree` and `statusForNewSubmission` both consult it,
but only for `role === 'consultant'` — an admin is free regardless of this flag, by design.

The flag is embedded in the JWT at login (`auth.js`, both the password and magic-link routes), not
re-checked against the database on every request — this matches the site's own existing precedent for
`role` (`attachUser` only ever verifies and trusts the token payload), so a revoke takes effect at the
consultant's next login, not instantly. That tradeoff is deliberate: introducing a live DB lookup here
would be a new pattern nowhere else in the auth system uses, for one flag, and the alternative (force a
logout on toggle) is a bigger behavioural change than what was actually asked for.

`admin.js`'s `GET /users` and `PATCH /users/:id` carry the field through; the admin dashboard's member row
gets a plain checkbox labelled "Free publishing enabled (consultants only — has no effect on any other
role)", sent unconditionally on save (unlike Role, which is guarded) since setting it on a non-consultant
account is a harmless no-op, not a risk.

Four new tests in `freePublishing.test.js` (toggle-off is billed like a member; an old token with no claim
at all still publishes free; an explicit `true` claim behaves identically to no claim; the flag has no
effect on an admin) and five in `usersAdmin.test.js` (defaults to true; toggling off doesn't touch role;
toggling back on; a member cannot toggle it; the list carries the flag). New
`consultantFreePublishingLogin.test.js` (2 tests) proves the one link a hand-signed test token can't: a
real `POST /auth/login` for a toggled-off consultant issues a JWT carrying `free_publishing_enabled:
false`, and that token is genuinely billed end-to-end through `POST /articles`. New
`consultantFreePublishingAdminUi.test.js` (4 static-source tests) on the admin dashboard checkbox and its
unconditional save.

Verified live in-browser against a mocked backend: the checkbox rendered checked for a consultant whose
mock record had the flag on; unchecking it and saving sent `freePublishingEnabled: false` in the real PATCH
body (confirmed via the network log), with the correct toast.

Full suite: 2112 passing, 0 failing (up from 2097).

## 2026-09-05 — Admin can create and delete Directory listings directly

Requested directly: "allow admin to add directory profiles manually. (admin must have full access to
edit/delete/adjust)". Every Directory listing until now had to belong to a real member account —
`profiles.user_id` was `NOT NULL` with a plain unique index, because every listing so far had come from a
member's own submission. An admin publishing a listing for a sponsor or business with no account yet (and
maybe none ever) had no path to do that at all.

Asked first whether an admin-created listing needs a member account behind it — the answer was "can stand
alone but option to link to member," which settled the one real design question: `profiles.user_id` must
accept NULL, and multiple ownerless listings must be able to coexist without colliding.

New migration `177_admin_created_profiles.sql`: drops the `NOT NULL` on `user_id` and replaces the plain
unique index with a partial one (`UNIQUE ... WHERE user_id IS NOT NULL`) — a real member still cannot own
two listings, but any number of ownerless ones can exist side by side. New `POST /admin/profiles`
(admin.js) creates a listing standalone, `status = 'approved'` immediately — same free-and-instant
treatment every other admin-authored submission gets, no approval queue, no payment — with just enough to
exist (name, type, package tier, category); everything else (bio, contact details, feature image) is
filled in through the exact same `PATCH /profiles/:id` every owner already uses, since `requireOwnerOrAdmin`
already lets an admin through with no owner to compare against. New `DELETE /admin/profiles/:id` hard-
deletes a listing — most of what references a profile cascades or SETs NULL on its own via real foreign
keys, but `social_links` and `gallery_images` are polymorphic (owner_type/owner_id, no FK), so those are
cleaned up explicitly first or they'd be silently orphaned rows nothing ever reads again.

The existing "Link a listing to a member account" panel (`adminProfileLinks.js`) needed two real fixes to
stay correct once ownerless listings could exist: its listings query was an `INNER JOIN users`, written
back when every listing had an owner by definition — that silently excluded any admin-created listing from
the panel meant to link it, so it's now a `LEFT JOIN`. And the "undo last link" route treated landing back
on a NULL owner as "the account this listing came from has been deleted" (its only previous meaning) —
now a real, legal outcome (a listing created standalone and linked to a member for the first time has "no
owner" as its true previous state), so reverting to NULL now succeeds instead of erroring.

Admin dashboard: a new "Add a new listing" panel above the existing per-profile editor (name, type,
package tier, category) that creates the listing and jumps straight into the same editor used for every
other listing; the editor gained a "Delete listing" button behind a `confirm()`, matching the phrasing
style of every other destructive confirm on this site.

New `adminCreatedProfiles.test.js` (14 tests, real HTTP + real Postgres): non-admin blocked from create and
delete; required-field and package-tier validation; a standalone listing is created approved with
`user_id: null` and is genuinely live on the public route; two ownerless listings coexist without a unique-
index collision; a duplicate display name gets a different slug instead of a 500; an admin can edit an
owner-less listing via the ordinary PATCH route, a member cannot; the linking panel now surfaces an
ownerless listing; linking one to a member works starting from a null current owner; reverting that link
correctly lands back on null instead of erroring; a real member still cannot end up owning two listings;
delete removes the listing and cleans up its gallery images, and a second delete is a clean 404. New
`adminCreatedProfilesUi.test.js` (3 static-source tests) on the create form and delete button wiring.

Verified live in-browser against a mocked backend: creating a listing jumped straight into its editor;
deleting it (with the confirm auto-accepted) hid the editor and removed it from the picker's list.

## 2026-09-05 — Site Buttons: any external link, or pick a page on this site

Requested directly, from a screenshot of the Floating Buttons admin panel: "allow admin to link button
with any external link and allow admin to choose page on website." The backend (`siteButtons.js`) already
stored `url` as an unrestricted free-text column — pasting any `https://` link already worked, and still
does. What was missing was a friendly way to link to a page ON this site: the field's own placeholder
("https:// or a page on this site") was hinting at a format — `unplug-magazine.html?p=<page>`, per
`unplug-site-buttons.js`'s own doc comment — that an admin had to already know and type by hand.

Purely an admin-dashboard change, no backend or schema change. The "Add Button" form gained a "Link type"
selector: "External link" (unchanged — the existing free-text field) or "Page on this site" (a dropdown of
the same page list the CMS image-block picker already offers, plus Impact Makers). Choosing a page composes
the exact URL shape `unplug-site-buttons.js` expects for internal navigation, so the button opens in the
same tab instead of the external-link path (which opens a new tab) — matching that script's own
`isExternal` check, which decides that entirely from what the URL looks like.

New `siteButtonsPagePicker.test.js` (4 static-source tests): the link-type selector exists with both
options; the page dropdown lists real pages including Impact Makers; choosing "page" swaps the two input
fields; submitting with "page" composes the exact string shape the public script expects, while the
external-link path is untouched.

Verified live in-browser against a mocked backend: switching to "Page on this site" swapped the visible
field; submitting with Impact Makers selected produced `url: "unplug-magazine.html?p=impact-makers"` in the
real POST body.

## 2026-09-05 — Testimonials: a real image upload, not a pasted URL

Requested directly: "allow admin to manually upload image (same as when publish article)." The Testimonials
panel's author photo was a plain "Photo URL" text box — the only image field left on the site still asking
an admin to paste a URL by hand instead of using the same drag-and-drop upload widget every other image
field (articles, Hall of Fame, Impact Makers) already has.

Backend needed no change at all — `testimonials.js` already stored and returned `author_photo_url` as a
plain string; it never cared how that string was produced. This is an admin-dashboard-only change, but a
structural one: Testimonials used to be a fully inline-editable table (quote/name/role/order all editable
directly in each row), which has no room for a real upload widget — one widget per row would mean
rebuilding it for every row on every refresh. So the panel moved to the same Add-or-Edit-reloads-the-form
pattern Hall of Fame and Impact Makers already use: one shared form above (with the real upload widget,
`person_portrait` spec — the same headshot spec Hall of Fame uses), a management table below where "Edit"
loads a row's values back into that form rather than editing in place. Saving now branches on whether an
edit is in progress, so clicking "Save Changes" on an existing testimonial updates it instead of creating a
duplicate.

New `testimonialsPhotoUpload.test.js` (5 static-source tests): the old text input is completely gone, not
left dangling; the real upload widget exists using the `person_portrait` spec; editing reloads a row's
existing photo into that same widget; saving reads the widget's real value; saving correctly branches
between create and update.

Verified live in-browser against a mocked backend: the upload widget rendered in place of the old text
field; editing an existing testimonial (seeded with a photo URL) correctly carried that URL into the
widget and set edit mode; saving sent a real PATCH to the existing row (confirmed via the admin list
afterward still holding exactly one row) rather than creating a second one, and the button reverted to
"Add Testimonial" afterward.

## 2026-09-05 — Admin-created listings get the same requirements a member's own submission does

Follow-up to the same day's "admin can create Directory listings directly": requested directly, "admin
should be able to choose package and then add the requirements which should be the same as when user
submit their directory." The create form had shipped with only the four fields strictly required by the
database (name, type, tier, category) — everything a member actually sees at their own checkout package
step (unplug-checkout.html) was missing: a second category, a demo reel link, and location.

Those three are conditional on type and tier, not always shown — copied exactly from
`updateSecondCategoryVisibility()`/`updateLocationFields()` in the checkout page, the one place this logic
already existed: a second category only for a Business on Premium, a demo reel link only for an Individual
on Premium, a street address only for a business (an individual's home address is never captured or
published, on this form same as every other one). `POST /admin/profiles` (admin.js) now accepts and
enforces the same rules server-side — sending a second category for a non-qualifying type/tier is silently
ignored, not rejected, matching how the column itself behaves for a member's own submission.

New tests appended to `adminCreatedProfiles.test.js` (4 tests): the full field set is accepted and stored
for a Business Premium listing; a second category is silently dropped when type/tier doesn't qualify (both
directions — wrong tier, wrong type); a demo reel link is accepted for Individual Premium and dropped
otherwise; a street address is never stored for an individual. New tests appended to
`adminCreatedProfilesUi.test.js` (3 tests): the conditional fields exist; the visibility function checks
the same two conditions the checkout page's own function does, wired to both the Type and Tier selects;
the submit payload always sends every conditional field and lets the backend decide which apply.

Verified live in-browser against a mocked backend: switching Type/Tier through all four combinations
(Individual Basic, Business Basic, Business Premium, Individual Premium) showed exactly the right fields
each time; a full submission with every field filled in created the listing correctly with a null owner.

