# Privacy: the consent record and the data export

Analytics has been consent-gated since migration 029, and that part worked.
Two things were missing.

## 1. There was no record of consent

"The browser has a localStorage key set to `accepted`" is not evidence of
anything. It lives on somebody else's device, we cannot see it, and it says
nothing about **which version of the policy** was on screen when they agreed.

`consent_records` now holds one row per decision: the choice, the policy
version, when, and which browser. The localStorage key stays — the two answer
different questions. localStorage answers *"may I count this page view"*, on
the next page load, with no round trip. The table answers *"can you show that
they agreed, and to what"*.

**A withdrawal is a new row**, never an update or a delete. That somebody once
consented and later changed their mind is exactly the history this table exists
to hold.

**No IP address is stored.** An IP is personal information under POPIA, and
storing one to prove consent to collect *anonymous* analytics would collect
more about the person than the thing they were consenting to. There is a test
asserting the column does not exist.

**Declining sends no visitor key.** `guestSessionId()` *mints* an id and writes
it to localStorage, and the standing rule is that declining leaves nothing
behind on the device. Calling it to label a refusal would break that rule at
the exact moment somebody exercised it. The row is still recorded, with the
version and the time.

Recording is fire-and-forget. The reader has made their choice and the
interface has already acted on it; a failed request must never undo it.

## 2. Nobody could see what was held about them

Member dashboard → **Your Data** → *Download my data*.

### The table list is discovered, not written down

There are about 180 tables. A hand-maintained list of the ones holding member
data would be correct on the day it was written and wrong within a month — and
**an export that silently omits data is worse than no export**, because it is
offered as a complete answer.

So every table with a `user_id` or `author_user_id` column is included
automatically. A feature added next month that stores something against a
member appears in the export without anybody remembering to add it. There is a
test that creates a table, puts a row in it, and asserts it turns up.

### What is deliberately excluded

The file is something a member can hand to anybody, so **it must not be a way
to take over their account**:

- password hash, sign-in tokens, magic-link tokens, verification codes,
  two-factor recovery codes
- login attempts and the admin activity log — security records, and the latter
  would leak moderation notes about other people
- the anonymous analytics: `analytics_events`, `analytics_sessions`,
  `page_views`, `content_views`. Including them would rebuild, keyed to a
  person, the browsing history we deliberately never linked to one.

The file says all of this in its own `notes.excluded`, so somebody reading it
does not have to ask why it is not everything.

Each section is capped at 1000 rows so one member with a lot of history cannot
ask the API to assemble an unbounded response and take a 512 MB instance down.
The file names any section that was cut.

## Deletion goes through a request

There is no self-service delete button, and that is a decision rather than an
omission. An account can own paid directory listings, published articles,
payment records and refunds. What happens to each of those is a judgement, not
a button — and the deletion is irreversible.

The dashboard says so plainly and gives the address to write to.

## What was not built

**Granular consent categories.** The site has one genuine category of its own
tracking. Offering a row of toggles that all control the same thing would be
theatre.

There is a real second category — embedded YouTube and map tiles, which are
third-party requests — but gating those behind consent changes what readers see
on pages that already work, so it should be a decision made deliberately rather
than folded into this change.

## Files

| | |
|---|---|
| `unplug-backend/db/migrations/152_privacy.sql` | `consent_records`, `privacy_policy_version`. |
| `unplug-backend/src/routes/privacy.js` | Consent recording and the export. |
| `unplug-backend/test/privacy.test.js` | 14 tests against a real PostgreSQL. |
| `unplug-magazine.html` | Records the choice when it is made. |
| `unplug-member-dashboard.html` | The Your Data screen. |

## Rolling back

Drop `consent_records` and remove the `/privacy` mount. The consent bar keeps
working exactly as it did — it never depended on the server.
