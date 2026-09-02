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
