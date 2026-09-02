# Pricing — the specification against the live site

Compiled 29 August 2026, task 03. **Nothing here has been changed.** This is a comparison so
the differences can be decided one at a time.

Neither column is assumed correct. The spec calls several of its figures "current configured
price", which suggests they were read off the site at the time of writing — so where they
differ now, either the site changed afterwards or the spec was never right.

Sources — spec: `docs/spec-extracted.md`. Live: `service_packages` and `vote_bundle_tiers`
(seeded by migrations 065 and 010, admin-editable after that), plus the constants in
`src/routes/payments.js`, `src/utils/servicePackages.js`, `src/routes/competitions.js`,
`src/routes/profiles.js`, `src/routes/marketplace.js` and `src/routes/editions.js`.

---

## Summary

| | |
|---|---|
| Prices stated in the spec | 16 |
| Match the live site | **3** |
| Differ | **10** |
| Named in the spec, not built | **3** (event promotion packages) |
| Charged live, absent from the spec | **5** |

---

## 1. Where they agree

| Service | Spec | Live | Where live |
|---|---|---|---|
| Membership | Free | Free — registration takes no payment | `auth.js` |
| Publish an article | R95 | R95.00 | `payments.js` `ARTICLE_PUBLISH_FEE` |
| Gallery submission, 3 images | R100 | R100.00 | `payments.js` `GALLERY_BUNDLE_PRICE` |

---

## 2. Where they differ

### 2.1 Featured / Highlighted Listing — §4.4

The spec has **one** product with one price ladder. The site has **two**, priced differently
from each other and from the spec. Deciding this needs the product question answered first:
is "Featured Listing" one thing, or is a highlighted article a different purchase from a
highlighted Directory profile?

| Duration | Spec §4.4 | Live — article highlight | Live — directory highlight |
|---|---|---|---|
| 7 days | R250 | R150 | R100 |
| 14 days | R300 | R250 | R150 |
| 21 days | R350 | R300 | R200 |
| 28 days | R400 | R450 | R250 |

Live values from `service_packages` (`highlight_article`, `highlight_directory`).
**Every one of the eight live prices differs from the spec.** Note the ladders cross: at 28
days the article highlight is *more* than the spec (R450 vs R400) while the directory
highlight is much *less* (R250 vs R400).

### 2.2 Bulk vote packages — §9.5

The largest gap in the document. The spec names six tiers; the live table has six rows with
**different vote counts as well as different prices**, so they cannot be lined up row by row.

| Spec tier | Spec votes | Spec price | Spec per vote | Live votes | Live price | Live per vote |
|---|---|---|---|---|---|---|
| Starter | 10 | R10 | R1.00 | 10 | R10 | R1.00 |
| Supporter | 50 | R45 | R0.90 | 50 | **R20** | R0.40 |
| Champion | 100 | R80 | R0.80 | **70** | R50 | R0.71 |
| Power | 250 | R175 | R0.70 | **150** | R100 | R0.67 |
| Dominator | 500 | R300 | R0.60 | **200** | R150 | R0.75 |
| Ultimate | 1,000 | R500 | R0.50 | **300** | R200 | R0.67 |

Only the first tier matches. Two things worth noticing beyond the numbers:

- **The live ladder stops at 300 votes; the spec goes to 1,000.** A supporter who wants to
  buy a thousand votes currently cannot, in one purchase.
- **The live ladder is not monotonic.** Per-vote cost falls from R1.00 to R0.40, then rises
  to R0.75, then falls again. Buying 50 votes twice (R40) is cheaper than buying 70 once
  (R50), and buying 150 + 50 (R120) beats 200 (R150). Whatever is decided about the figures,
  the shape is worth a look — a customer who spots this pays less for more.
- The live tiers have **no names**. The spec's Starter/Supporter/Champion/Power/Dominator/
  Ultimate do not exist in the database.

### 2.3 Homepage Banner — §6.1

| | Spec | Live |
|---|---|---|
| Homepage banner | R1,000, no duration stated | R300 (7 days) · R550 (14) · R1,000 (28) |

Live from `service_packages` (`ad_banner`). The spec's R1,000 matches the **28-day** price
exactly, so this may be agreement with the duration left unsaid — or it may be that the spec
intends a flat R1,000 whatever the term. It cannot be settled from the document.

### 2.4 Directory / profile packages — §2.3

The spec names three tiers and no prices. The live site has three tiers under **different
names**, priced separately for individuals and businesses.

| Spec tier | Live tier | Individual | Business |
|---|---|---|---|
| Basic | `basic` | R150 | R500 |
| Standard | **`pro`** | R280 | R700 |
| Premium | `premium` | R400 | R1,000 |

Live from `PACKAGE_PRICES` in `payments.js`. No price conflict — the spec states none — but
the middle tier is called **Standard** in the spec and **pro** in the code and database.

---

## 3. In the spec, not built

| Service | Spec | Live |
|---|---|---|
| Event Boost | R350 | — |
| Event Feature | R650 | — |
| Event Dominator | R1,000 | — |

§5.6 Event Promotion has no equivalent anywhere in the codebase. There is no
`event_promotion` service key, no packages, and no price. **These three cannot be bought.**

---

## 4. Charged live, absent from the spec

Not mismatches — the spec simply does not mention them. Listed so the decision covers
everything that takes money.

| Service | Live price | Where |
|---|---|---|
| Event listing | R300.00 | `payments.js` `EVENT_LISTING_FEE` |
| Marketplace listing | R500.00, 30 days | `payments.js` `MARKETPLACE_LISTING_PRICE` |
| Profile package upgrade | R250.00 flat, whatever the tier gap | `profiles.js` `UPGRADE_FEE` |
| Edition download | R50.00 default, per edition | `editions.js` |
| Competition entry | R50.00 default · Top 10 R100.00 · The Arena R250.00 | `competitions.js` |

§8.1 says competition entry is "ALWAYS PAID" but names no figure, so the three live values
are neither confirmed nor contradicted.

---

## 5. One thing worth fixing whatever is decided

**The highlight and banner prices are written out twice.**

`src/utils/servicePackages.js` holds `FALLBACK_PRICES`, and `src/routes/payments.js` holds
`HIGHLIGHT_PRICES` and `AD_BANNER_PRICES`. The numbers are currently identical, and the
comment in `servicePackages.js` says the fallback matches what migration 065 seeds — so there
are **three** copies of these figures: the table, the fallback, and the constants in
`payments.js`.

This is the recurring bug class named in `CLAUDE.md`, and it is carrying prices. If a price is
changed in the admin screen, `service_packages` updates and both hardcoded copies silently
become wrong — and the fallback exists precisely to be used when the table lookup fails, which
is the moment it would charge the old amount.

Not touched: task 03 says change no pricing code. Flagged for a decision.

---

## What is needed from you

A decision on each of these. Nothing in section 2 or 3 can be built or corrected until then.

1. **Featured listing** — one product or two? And which ladder is right?
2. **Bulk votes** — the spec's six tiers, the live six, or a new set? The non-monotonic
   pricing is worth resolving regardless.
3. **Homepage banner** — does the spec's R1,000 mean the 28-day package, or a flat price?
4. **Event promotion** — build the three packages at the spec's prices, or drop them?
5. **Directory middle tier** — "Standard" per the spec, or `pro` as built?
6. **The five live-only services** — confirm the prices, or add them to the spec.
7. **The triplicated price constants** — consolidate, and if so, in which task.
