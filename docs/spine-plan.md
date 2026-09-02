# Task 04 — the spine: proposed breakdown

For sign-off. **No code has been written.** Task 04 gates implementation behind approval of
this breakdown and an answer on the status vocabularies, so this document is the deliverable.

---

## What the survey found, and where my first sketch was wrong

I initially read each table's `CREATE TABLE` and reported eight services with drifting status
vocabularies. That was wrong: **36 later migrations already extend those constraints**, and
reading only the create statement misses them.

The effective vocabulary today, after all 155 migrations:

| Table | Effective `status` values | Last set by |
|---|---|---|
| `articles` | `draft, awaiting_payment, pending, approved, rejected` | 049 |
| `events` | `awaiting_payment, pending, approved, rejected` | 010 |
| `profiles` | `awaiting_payment, pending, approved, rejected` | 003 |
| `gallery_bundles` | `awaiting_payment, pending, approved, rejected` | 010 |
| `gallery_images` | `awaiting_payment, pending, approved, rejected` | 016 |
| `marketplace_listings` | `awaiting_payment, pending, approved, rejected` | 006 |
| `highlights` | `awaiting_payment, pending, approved, rejected` | 006 |
| `top10_entries` | `awaiting_payment, pending, approved, rejected` | 010 |
| `competition_entries` | `awaiting_payment, pending, approved, rejected` | 005 |

**Eight of nine are already identical; articles adds `draft`.** The submission vocabulary is
not fragmented — it is already one shared model that nobody wrote down. That makes this task
considerably smaller than "unify eight systems": it is *extend one vocabulary, in one place,
and give it a name*.

Payment-side is a separate, smaller story:

| Table | Effective values |
|---|---|
| `payments` | `pending, confirmed, failed` |
| `orders` | `pending, confirmed, failed` |
| `vote_bundles` | `awaiting_payment, confirmed, rejected, reversed` |
| `competitions` | `draft, open, closed` |

`users` and `votes` have **no status column at all**, and there is no `services` table — a
"service" is a row with an expiry date. Three of §16's six vocabularies therefore have nothing
to migrate.

---

## The safety rule this whole task turns on

Migration 008 already documents it, and it is the thing most likely to take the site down:

> *"This constraint is re-added on every deploy, so it must allow every type any existing row
> could hold — otherwise a redeploy fails validation once a newer type is in the data."*

Changing a `CHECK` means `DROP CONSTRAINT IF EXISTS` then `ADD CONSTRAINT`, and **the ADD
re-validates the entire table on every single deploy**. So:

- **Every change must be strictly additive.** A value is never removed from the list while any
  row could still hold it, and rows are never renamed in the same migration that narrows the
  constraint.
- A migration that adds a value is safe forever. A migration that removes one is a time bomb
  that goes off on the next deploy after the first row uses it.

This is why the plan below never renames a status. `approved` stays `approved`.

---

## Blast radius, measured

References to each service across routes, tests and frontend — this sets the order:

| Service | routes | tests | frontend | total |
|---|---|---|---|---|
| `gallery_bundles` | 17 | 5 | 4 | **26** |
| `top10_entries` | 25 | **0** | 8 | **33** |
| `competition_entries` | 53 | 50 | 7 | 110 |
| `marketplace_listings` | 77 | 22 | 83 | 182 |
| `events` | 105 | 101 | 128 | 334 |
| `highlights` | 106 | 148 | 155 | 409 |
| `profiles` | 461 | 371 | 379 | 1211 |
| `articles` | 341 | 606 | 391 | **1338** |

**`top10_entries` has zero tests.** It is small, but the suite cannot tell me if I break it —
a different kind of risk from `articles`, which is large but heavily covered.

---

## Proposed breakdown

### Phase A — foundations. No table touched, no behaviour changed.

- **A1 · `src/utils/status.js`** — the submission vocabulary and its legal transitions, in one
  place, with tests. Same pattern as `reference.js` (task 02) and `imageSpecs.js`. Nothing
  imports it yet; this commit only writes down what is already true.
- **A2 · Reference reachability** — a documented way to get from a submission to its
  reference. Shape depends on decision 2 below.

Phase A is reviewable in one sitting and cannot break anything.

### Phase B — extend the vocabulary, one service per commit.

Each commit: one additive migration, the route updated, admin filter updated, full suite,
report. Order is smallest blast radius first, so the pattern is proven on quiet tables before
it reaches `articles`.

**B1** `gallery_bundles` → **B2** `marketplace_listings` → **B3** `events` →
**B4** `highlights` → **B5** `profiles` → **B6** `articles`

`top10_entries` is deliberately **not** in Phase B: with no tests, it belongs with the
competition work in Phase C where it can be covered first.

### Phase C — money and votes. Full stop and report before each.

**C1** `payments` / `orders` · **C2** `competitions`, `competition_entries`, `top10_entries` ·
**C3** `votes` (no status column today)

Per `CLAUDE.md`, these get the full protocol: suite → browser against a real backend → live
deploy confirmation.

### Explicitly out of scope for task 04

Phase B adds status **values**. The **workflow** that uses them — request-changes,
resubmission, credit-on-rejection — is task 05. Adding a value nothing can set yet is safe and
cheap; building the pathway is a separate piece of work with its own tests.

---

## Decisions needed before code

### 1. How much of §16 to build

Mapping the spec's Submission vocabulary onto what exists:

| Spec | Live today | Needed? |
|---|---|---|
| `DRAFT` | `draft` (articles only) | extend to others, or leave |
| `SUBMITTED` | covered by `pending` | probably not |
| `AWAITING_PAYMENT` | `awaiting_payment` | have it |
| `PAYMENT_RECEIVED` | — | gap |
| `UNDER_REVIEW` | ≈ `pending` | probably not |
| `CHANGES_REQUESTED` | — | **task 05 needs it** |
| `RESUBMITTED` | — | **task 05 needs it** |
| `APPROVED` | `approved` | have it |
| `PUBLISHED` | `approved` doubles as this | gap, arguably |
| `REJECTED` | `rejected` | have it |
| `CREDIT_ISSUED` | — | **task 05 needs it** |
| `EXPIRED` | — | renewal needs it |
| `CANCELLED` | `service_cancellations` handles it separately | probably not |

**My recommendation:** add `changes_requested`, `resubmitted`, `credit_issued` and `expired`.
Four values, each with a real pathway coming. Skip `submitted`, `under_review`, `cancelled`
and `payment_received` — each duplicates a state that already exists, and an unreachable
status is one more branch every filter and report has to handle for nothing.

### 2. Reference reachability

No submission table carries a reference; only `orders` and `payments` do. §10.1 wants the
reference to link submission → payment → approval → invoice.

**My recommendation:** a resolver, not new columns. The link already exists through
`payments.linked_type` / `linked_id`; a `reference` column on each of nine tables would be a
second copy of a value that can drift from the order's — the recurring bug class, applied to
the one identifier that must never be ambiguous.

### 3. Profiles

The spec's Profile vocabulary (`DRAFT/PRIVATE/PUBLISHED/SUSPENDED/ARCHIVED`) describes
*visibility*; `profiles.status` describes *approval*. Decision #6 already separates these —
publishing your own profile needs no approval, buying a Directory Listing does.

**My recommendation:** leave profiles out of Phase B and handle it with the Directory Listing
work, so approval-versus-visibility is designed once with that feature in front of us. It is
also the second-largest blast radius on the board.

### 4. Casing

The spec writes statuses uppercase; the code uses lowercase. **I propose keeping lowercase.**
Renaming would touch all 1,338 article references and every test, break the frontend, and
violate the additive-only rule above — for no functional gain.

---

## What I need from you

Sign-off on the phasing, and answers to 1–3 (4 is an assumption you can simply reject).
Nothing is written until then.
