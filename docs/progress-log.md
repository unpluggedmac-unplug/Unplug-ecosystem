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
