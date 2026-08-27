# Reviewing a submission before approving it

## The bug this fixed

The approval queue only ever returned a **summary**: an article's title, who
sent it, what was paid. Not the body. Not the bio. Not the message.

So an admin approving from the queue was deciding on a headline and a name, and
found out what they had just published by reading the live site. Every row
offered exactly two buttons — Approve and Reject — and no way to look first.

## What there is now

Every row has a **Review** button, to the left of Approve, and it is the
leftmost on purpose.

Review opens the whole submission:

- **every field**, including the body
- **editable**, for the fields that should be
- **View as the public** — a link to the real page, which works on something
  still pending

## Saving does not approve

Two separate acts, deliberately. A save that also published would mean an admin
could never fix a typo without committing to the whole thing in the same
motion. Approve and Reject stay on the queue row.

## What is deliberately NOT editable

**Status, on anything.** Approving is what the Approve button is for. A status
writable from two places ends up disagreeing with itself.

**Money.** Amounts, prices, entry fees, order totals, payment status, gateway
references. Those record what actually happened at a payment gateway — an
editable amount is how the books stop matching the bank. An admin who needs to
change what somebody paid should refund and re-take it, so there is a trail.

So `cart_order`, `service_payment` and `top10_votes` have **nothing** editable
and say so on screen. `edition_purchase` lets you fix a misspelled customer
name, because that is a typo rather than a financial record — but not the
amount.

**Anything identifying the submitter.** Correcting somebody's own email to a
different address, on a record they own, is not an edit.

## How the whitelist works

The editable columns are a per-type list of constants in
`routes/adminApprovalQueue.js`. **The table name and every column name are
constants in that file** — nothing in a request can name a table or a column,
and values are parameterised. A column not on the list is ignored rather than
refused, so a stale client cannot break, and there is a test that throws
`body"; DROP TABLE articles; --` at it.

The admin page asks the **server** for the field list rather than keeping its
own copy. A second list in the browser would drift from the one that actually
enforces anything, and the browser's copy would be the wrong one.

There is also a test that walks every declared type and checks the table and
every column genuinely exist — otherwise a typo in a column name would only
surface as a 500 the first time an admin opened that type.

## Previewing something that is not published yet

`GET /articles/:id` already let an admin through to a pending article.
`GET /profiles/:slug` now does the same, in the same shape:

```js
const isAdmin = req.user && req.user.role === 'admin';
... WHERE p.slug = $1 AND ($2::boolean OR p.status = 'approved')
```

Gated on the role in a **verified token**, never on a query parameter — that
line is the only thing between a pending listing and the public, and it is
covered by tests for signed-out, ordinary member, forged query string and
unverifiable token.

It works in the browser because the admin dashboard and the magazine share an
origin and a token, so the tab that opens is already signed in as the same
admin.

### Types with no public page of their own

Gallery images, events, shoutouts, competition entries and marketplace posters
appear in **lists**, and those lists filter to approved. There is no per-item
page to preview, so the panel says so plainly rather than offering a button
that opens the homepage and looks broken. For those, the Review panel *is* the
preview — which is why it shows every field.

Opening those list endpoints to admins was considered and rejected: it would
make an admin's view of the public site quietly different from everyone
else's, which is a worse problem than the one it solves.

## Audit

Every edit writes `submission_edited` to the admin activity log, naming the
type, the id and which columns changed. An admin changing somebody else's
submission before publishing it under the magazine's name is exactly what an
audit trail is for.

## Files

| | |
|---|---|
| `unplug-backend/src/routes/adminApprovalQueue.js` | `DETAILS` whitelist, `GET`/`PATCH /:type/:id`. |
| `unplug-backend/src/routes/profiles.js` | Admin can open a pending listing. |
| `unplug-backend/test/approvalQueueEdit.test.js` | 20 tests against a real PostgreSQL. |
| `unplug-admin-dashboard.html` | The Review button and panel. |

## Rolling back

Remove the two `/:type/:id` routes and the Review button; the queue returns to
approve/reject only. The `profiles.js` change is three lines and independent —
reverting it only removes the ability to preview a pending listing.
