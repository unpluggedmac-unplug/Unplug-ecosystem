# Pricing — the specification, the system, and what customers are shown

Compiled 29 August 2026, task 03. Rewritten after the first version was found wanting.
**Nothing here has been changed in the code.**

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

**Directory package tiers (§2.3)** — no price conflict, the spec states none. But the middle
tier is **"Standard"** in the spec and **`pro`** in the system, on the checkout page and the
rate card.

| Spec | System | Individual | Business |
|---|---|---|---|
| Basic | `basic` | R150 | R500 |
| Standard | **`pro`** | R280 | R700 |
| Premium | `premium` | R400 | R1,000 |

### In the spec, not built

| Service | Spec |
|---|---|
| Event Boost | R350 |
| Event Feature | R650 |
| Event Dominator | R1,000 |

§5.6 Event Promotion has no equivalent anywhere: no `event_promotion` service key, no
packages, no price. Confirmed by search. **These cannot be bought.**

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

---

## Where a price lives more than once

Beyond the policy-page contradiction above:

1. **Highlight and banner prices exist in three places** — the `service_packages` table,
   `FALLBACK_PRICES` in `servicePackages.js`, and `HIGHLIGHT_PRICES` / `AD_BANNER_PRICES` in
   `payments.js`. Identical today. Change a price in the admin screen and both hardcoded
   copies go stale — including the fallback, which exists to be used at exactly the moment
   the table lookup fails, and would then charge the old amount.
2. **The banner sentence, ten times** in `unplug-magazine.html`.
3. **Package tier prices** are hardcoded in `unplug-checkout.html` and `unplug-magazine.html`
   as well as in `PACKAGE_PRICES`.
4. **`unplug-components-demo.html`** says *"Packages start at R250 a month"* — monthly, where
   everything else is once-off. Worth checking whether that file is deployed.

This is the recurring bug class from `CLAUDE.md`, carrying money.

---

## Decisions needed

Nothing in this document may be changed until these are answered.

1. **The refunds policy ladder** — correct the page to R100–R250, or raise the system's prices
   to R250–R400? This is live customer-facing policy either way.
2. **Featured listing** — one product or two, and which ladder is right?
3. **Bulk votes** — the spec's six tiers, the system's six, or a new set? The non-monotonic
   pricing needs resolving regardless.
4. **Homepage banner** — does §6.1's R1,000 mean the 28-day package, or a flat price?
5. **Event promotion** — build the three packages, or drop them from the spec?
6. **Directory middle tier** — "Standard" per the spec, or `pro` as built?
7. **The five live-only services** — confirm their prices, or add them to the spec.
8. **The duplicated prices** — consolidate, and in which task.
