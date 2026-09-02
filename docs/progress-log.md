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
