# Pricing — the specification, the system, and what customers are shown

Compiled 29 August 2026, task 03. Rewritten after the first version was found wanting.

**2026-09-03 — all 8 decisions below answered by the site owner.** See "Decisions needed" at the
bottom for each answer and what it changed. `spec-extracted.md` is a faithful extraction and is not
edited to match these — this document is the reconciliation, and stays the record of record for what
was decided and why.

## How this was checked, and what was wrong the first time

The first version of this document compared the spec against **migration seed files** and
called that "live". Those tables are admin-editable, so a seed is what a price *started* as,
not what is charged. It also never looked at the **frontend**, where the prices customers
actually read are written by hand.

This version uses three sources:

| Column | Source | How |
|---|---|---|
| **Spec** | `docs/spec-extracted.md` | as written |
| **System** | production API | `GET /vote-bundle-tiers`, `/highlights/packages`, `/ad-banners/options` on `unplug-ecosystem.onrender.com`, plus the constants in `payments.js`, `profiles.js`, `marketplace.js`, `editions.js`, `competitions.js` |
| **Shown** | `https://www.unplugnews.com` | the live page, fetched and searched |

The seed-based figures turned out to be correct — nobody has edited those tables — but that
was luck rather than method, and checking properly is what surfaced the finding below.

---

## The headline: the site contradicts itself, and the spec copied the wrong half

**RESOLVED, before this session touched anything.** Checked live again on 2026-09-03: the refunds
policy page now reads the correct R100/R150/R200/R250 ladder and the worked example says "28-Day
Business Highlight for R250" — someone corrected the page between 29 August and now. Left as
historical record below since it explains where the spec's wrong §4.4 figures came from.

**Directory / business listing highlight, all four durations.**

| Duration | Rate card (live page) | Refunds policy (live page) | System charges | Spec §4.4 |
|---|---|---|---|---|
| 7 days | **R100** | **R250** | R100 | R250 |
| 14 days | **R150** | **R300** | R150 | R300 |
| 21 days | **R200** | **R350** | R200 | R350 |
| 28 days | **R250** | **R400** | R250 | R400 |

Both of those are on **the same live page**. The rate card agrees with what the system
charges. The refunds and cancellation policy quotes a ladder that is **R150 higher at every
duration** and that the system has never charged.

That policy text reads: *"Business listing highlighting may be purchased for available
durations. Current pricing may include 7 days — R250, 14 days — R300, 21 days — R350,
28 days — R400."* Verified live on 29 August 2026.

**This is where the spec's §4.4 figures came from.** They are not a proposal that the site
drifted away from — they are a transcription of the site's own policy page, which was already
wrong. So §4.4 is not evidence of an intended price; it is a copy of an error.

The same wrong ladder appears in two worked examples in the policy:

- *"A customer purchases a 28-Day Business Highlight for R400"* — the system charges R250.
- *"If a customer purchases a Directory Highlight for R400 with R400 available credit…"*

This is customer-facing cancellation and refunds copy quoting prices nobody is charged. It is
the one item here I would treat as urgent regardless of what is decided about the rest.

---

## Everything else, spec against system

### Agrees

| Service | Spec | System | Shown |
|---|---|---|---|
| Membership | Free | Free | — |
| Publish an article | R95 | R95.00 | R95 (member dashboard) |
| Gallery, 3 images | R100 | R100.00 | R100 (member dashboard) |
| Homepage/page banner 28d | R1,000 | R1,000 | R1,000 (magazine, ×10 copies) |

The banner line agrees everywhere, but the sentence *"Advertising banners run from R300
(7 days) to R1,000 (28 days) — R550 for 14 days"* is **written out ten times** in
`unplug-magazine.html`. Correct today; ten places to miss when a price changes.

§6.1 names R1,000 with no duration. It matches the 28-day package exactly, so this may be
agreement with the term unsaid, or may mean a flat price. The document cannot settle it.

**RESOLVED 2026-09-03: §6.1's R1,000 means the 28-day banner package.** No system change — there is
no duration-independent flat-price mechanism today, and none was requested.

### Differs

**Article highlight** — the spec has one "Featured Listing" product; the system has two.

| Duration | Spec §4.4 | System — article | System — directory |
|---|---|---|---|
| 7 | R250 | R150 | R100 |
| 14 | R300 | R250 | R150 |
| 21 | R350 | R300 | R200 |
| 28 | R400 | R450 | R250 |

At 28 days the article highlight is *above* the spec, the directory highlight well *below*.
Deciding this needs the product question first: is a highlighted article the same purchase as
a highlighted Directory profile?

**RESOLVED 2026-09-03: two products, not one.** No price changed — this was a documentation
question, not a pricing one. `spec-extracted.md` is not edited (see the note at the top); this
paragraph is the record that Article Highlight and Directory Highlight are two separate, deliberately
different-priced products, and the spec's single "Featured Listing" figure does not describe either
of them precisely.

**Bulk votes (§9.5)** — verified live via `GET /vote-bundle-tiers`.

| Spec tier | Spec | Spec/vote | System | System/vote |
|---|---|---|---|---|
| Starter | 10 → R10 | R1.00 | 10 → R10 | R1.00 |
| Supporter | 50 → R45 | R0.90 | 50 → R20 | R0.40 |
| Champion | 100 → R80 | R0.80 | **70** → R50 | R0.71 |
| Power | 250 → R175 | R0.70 | **150** → R100 | R0.67 |
| Dominator | 500 → R300 | R0.60 | **200** → R150 | R0.75 |
| Ultimate | 1,000 → R500 | R0.50 | **300** → R200 | R0.67 |

Only the first tier matches, and the vote counts differ as well as the prices, so the ladders
cannot be compared row by row. Two things stand independently of which list is chosen:

- **The system stops at 300 votes; the spec reaches 1,000.** Nobody can buy a thousand votes
  in one purchase today.
- **The system's per-vote price is not monotonic** — R1.00, R0.40, R0.71, R0.67, R0.75,
  R0.67. So 50 votes bought twice gives 100 votes for R40, while 70 votes costs R50; and
  150 + 50 gives 200 votes for R120 against R150 for the 200 tier. A customer who notices
  pays less for more.
- The system's tiers have **no names**; Starter/Supporter/Champion/Power/Dominator/Ultimate
  do not exist in the database.

**RESOLVED 2026-09-03: kept the system's 6 tiers and 300-vote cap; fixed the non-monotonic
pricing.** Migration `169_vote_bundle_monotonic_pricing.sql`. 10 and 50 votes are unchanged
(R10.00, R20.00) — the site owner chose to correct by lowering the tiers above them rather than
raising these two. 70/150/200/300 are now a flat R0.40/vote (the rate 50 votes already charged):
70 → R28.00 (was R50.00), 150 → R60.00 (was R100.00), 200 → R80.00 (was R150.00), 300 → R120.00
(was R200.00). Held in place by `test/voteBundleMonotonic.test.js`, which checks the actual property
that was missing — that no combination of smaller tiers ever beats a larger one — not just that six
numbers match.

**Directory package tiers (§2.3)** — no price conflict, the spec states none. But the middle
tier is **"Standard"** in the spec and **`pro`** in the system, on the checkout page and the
rate card.

| Spec | System | Individual | Business |
|---|---|---|---|
| Basic | `basic` | R150 | R500 |
| Standard | **`pro`** | R280 | R700 |
| Premium | `premium` | R400 | R1,000 |

**RESOLVED 2026-09-03: keep `pro` as built.** No live change — this is what customers already see
in the database, checkout and rate card everywhere. The spec's "Standard" is the one that doesn't
match reality, not the system.

### In the spec, not built

| Service | Spec |
|---|---|
| Event Boost | R350 |
| Event Feature | R650 |
| Event Dominator | R1,000 |

§5.6 Event Promotion has no equivalent anywhere: no `event_promotion` service key, no
packages, no price. Confirmed by search. **These cannot be bought.**

**RESOLVED 2026-09-03: dropped, not built.** No code change — there was none to make. This document
is the record that Event Promotion is not a live product; `spec-extracted.md` is left as the
faithful extraction it is (see the note at the top) and is not edited to remove it.

### Charged live, absent from the spec

| Service | System | Shown |
|---|---|---|
| Event listing | R300.00 | R300 (member dashboard) |
| Marketplace listing | R500.00 / 30 days | R500 (member dashboard) |
| Profile upgrade | R250.00 flat | R250 (checkout, magazine, member dashboard) |
| Edition download | R50.00 default, per edition | per edition |
| Competition entry | R50.00 default · Top 10 R100 · The Arena R250 | R100 (member dashboard) |

§8.1 says entry is "ALWAYS PAID" but names no figure, so these are neither confirmed nor
contradicted.

**RESOLVED 2026-09-03: confirmed correct, as-is.** No price changed. These five are documented
here as the record of the intended, live prices — `spec-extracted.md` itself is not edited (see the
note at the top of this document).

---

## Where a price lives more than once

Beyond the policy-page contradiction above:

1. ~~**Highlight and banner prices exist in three places**~~ — **RESOLVED 2026-09-03, without
   changing any price.** `HIGHLIGHT_PRICES` and `AD_BANNER_PRICES` in `payments.js` turned out
   to be **dead code**: every quote and charge already went through `priceFor()`, which reads
   `service_packages`. They were deleted. Production was checked first and matched the fallback
   exactly on all 11 rows, so nothing moved.

   Two copies remain and the second is deliberate: `FALLBACK_PRICES` is a last-known-good for
   when the table cannot be read. A constant cannot follow an admin's edit at runtime, but it
   CAN be held to the seeded table — `test/pricingSingleSource.test.js` fails if a migration
   changes a price and the fallback is not changed with it, which is the drift that would
   otherwise reach production silently.

   **Still worth deciding:** the fallback charges a possibly-stale price at exactly the moment
   the table is unreadable — but if the database cannot be read, the payment row cannot be
   written either, so its practical value is questionable. Refusing the charge instead may be
   safer than guessing at it. That is a money-behaviour call, not a refactor.
2. ~~**The banner sentence, ten times**~~ — **RESOLVED 2026-09-03.** All ten are rendered by one loader from `/payments/packages?service=ad_banner`; the HTML wording remains as a no-JS fallback. No price changed.
3. **Package tier prices** are hardcoded in `unplug-checkout.html` and `unplug-magazine.html`
   as well as in `PACKAGE_PRICES`. Was waiting on decision 6 (the tier-naming question below),
   which is now answered — **unblocked, but not done.** Consolidating three hardcoded copies
   into one source, matching how the ad-banner sentence was resolved, is a real task of its own
   and was not part of what was asked for on 2026-09-03.
4. ~~**`unplug-components-demo.html`**~~ — **RESOLVED 2026-09-03.** It IS deployed (200, no inbound links). The price claim is removed rather than corrected, since picking the right figure is a pricing decision. Open question — should the page be public at all? — **also resolved 2026-09-03: no.** Blocked in `functions/[[path]].js`'s `NOT_THE_SITE` list; confirmed 404 live.

This is the recurring bug class from `CLAUDE.md`, carrying money.

---

## Decisions needed

**All 8 answered by the site owner, 2026-09-03.** `spec-extracted.md` is not touched by any of
these — it is a faithful extraction and stays one (see the note at the top of this document); this
section, and the resolution notes inline above, are the record of what was decided.

1. ~~**The refunds policy ladder**~~ — turned out to be moot: checked live on 2026-09-03 and the
   page already reads the correct R100–R250 ladder. Someone fixed it between 29 August and now,
   before this document's re-check found anything to decide.
2. ~~**Featured listing**~~ — **kept as two products** (Article Highlight, Directory Highlight).
   No price changed.
3. ~~**Bulk votes**~~ — **kept the system's 6 tiers and 300-vote cap; fixed the non-monotonic
   pricing.** 10 and 50 votes unchanged; 70/150/200/300 lowered to a flat R0.40/vote. Migration
   `169_vote_bundle_monotonic_pricing.sql`.
4. ~~**Homepage banner**~~ — **§6.1's R1,000 means the 28-day package.** No system change.
5. ~~**Event promotion**~~ — **dropped, not built.** No code change — there was none to make.
6. ~~**Directory middle tier**~~ — **kept `pro` as built.** No live change.
7. ~~**The five live-only services**~~ — **confirmed correct, as-is.** No price changed.
8. **The duplicated prices** — referring to the numbered list under "Where a price lives more than
   once" above: item 1 (the dead `payments.js` copies) is **done**, deleted 2026-09-03 with no
   price change. Item 2 (the banner sentence, ten times) is **done** (`f2c3501`, resolved alongside
   adding the 21-day banner tier). Item 4 (`unplug-components-demo.html`) is **done** — the page is
   blocked entirely, so its stale price claim is no longer reachable either way. **Item 3 remains:
   package tier prices are still hardcoded in `unplug-checkout.html`, `unplug-magazine.html` and
   `PACKAGE_PRICES`.** It was waiting on decision 6, which is now settled — unblocked, but
   consolidating three hardcoded copies into one source is a task of its own and was not part of
   what was asked for today.
