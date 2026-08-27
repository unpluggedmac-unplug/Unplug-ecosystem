# Membership and the free-account gate

An article can be marked as needing an account to read in full. The account is
**free**. There is no subscription, no recurring billing, and nothing to
cancel.

That was a deliberate choice over paid tiers. Recurring billing is not a
feature, it is an ongoing obligation — renewals, failed payments, expiries,
refunds, and a promise to subscribers that the site keeps working. Render's
free tier sleeps and has no cron. A free gate captures the same thing the
magazine actually wants at this stage (who is reading, and an email address to
reach them at) and can be reversed in a day if it costs more traffic than it
earns.

## The rule that makes it real

**The gate is in the server.** By the time a gated article reaches the browser,
`body` contains only the preview and `sections` is empty. Nothing is hidden
with CSS.

This matters because the obvious way to build a gate — render the whole
article, cover the end with a gradient — is not a gate at all. The text sits in
the page source, and Ctrl+U defeats it. Every endpoint that returns an article
body goes through `src/utils/accountGate.js`.

## The hole that was found while building it

`GET /articles` — the ordinary public list — selects `a.body` **in full**.
Gating only `GET /articles/:id` would have been decoration: one request to the
list and you have every article on the site, gated or not. `most-viewed` had
the same problem.

Both are gated now, and `accountGate.test.js` has a test named after it so it
cannot quietly come back.

## And the one in search

`ts_headline` returns the text surrounding a match, from anywhere in the
article. On a gated piece that is a way to read it a fragment at a time, by
searching for word after word.

So a gated article never gets a body snippet. It shows the summary it was
published with — the same text a share card and a search engine already see.
It is still findable, by title, tag and summary; gating hides the text, not
the existence of the piece.

## What a signed-out reader gets

- The first **120 words** (`gate_preview_words` in settings, read server-side
  only — the browser never learns the number, because the truncation has
  already happened).
- Title, standfirst, summary, photo, category, byline and date. Those are kept
  **on purpose**: withholding them would hide the article from exactly the
  people most likely to make an account in order to read it, and would break
  every share card.
- Nothing else. Conclusion, key takeaways, gallery, links, video and CTA are
  all withheld — leaving any of them behind would make the gate ornamental.

The preview is **plain text**. Bodies are HTML, and cutting HTML at the 120th
word lands inside a tag as often as not; "repair the markup afterwards" is a
worse bug waiting to happen than not emitting markup at all. The reader already
knows how to render a plain-text body, because `body_format = 'text'` has
always been a supported value.

## Who can gate

**Admins only**, on create and on edit. Whether a piece is gated is a decision
about the publication, not a property of the submission — a member paying to
place an article must not be able to decide who may read it.

A non-admin sending `requiresAccount` is **ignored, not refused**. Erroring
would tell them the field exists.

## Off by default, one piece at a time

`requires_account` defaults to false, so migration 151 changes the behaviour of
nothing already published. Gating is an editorial act, not something that
happens to the archive because a column was added. Same seed-don't-surprise
rule as popups, automations and forms — and there is a test asserting the
migration gates nothing on its own.

## Coming back to the article after signing in

The gate links to the member dashboard with `?next=?p=article&id=…`, and the
dashboard returns there after a password or magic-link sign-in.

`next` is validated hard, because a `next` parameter on a link we invite people
to click is the exact shape of an **open redirect**: if it accepted
`https://evil.example`, the Unplug sign-in page would become a credible way to
send a member somewhere else. It must match a magazine query string and nothing
else, and it is appended to a fixed relative page rather than used as a URL.
Verified against absolute URLs, protocol-relative `//host`, and `javascript:` —
all rejected.

## What was deliberately not built

**Paid subscriptions.** See above. If they are ever wanted, they use the
payment system that already exists — PayFast, Ozow and EFT, in rand, through
the portal with its admin queue, refunds and account credits. Not Stripe: this
is a South African business and Stripe has historically not supported South
African merchants, and a second money path to reconcile against the working one
would be a mistake.

**Gating anything other than articles.** Directory listings, the gallery and
editions are untouched.

## Files

| | |
|---|---|
| `unplug-backend/src/utils/accountGate.js` | The only place truncation happens. |
| `unplug-backend/db/migrations/151_account_gate.sql` | The column, the index and the setting. |
| `unplug-backend/src/routes/articles.js` | List, most-viewed and detail all gated; admin-only write. |
| `unplug-backend/src/routes/search.js` | Gated pieces get a summary, never a body snippet. |
| `unplug-backend/test/accountGate.test.js` | 20 tests against a real PostgreSQL. |
| `unplug-magazine.html` | The gate panel and the card badge. |
| `unplug-member-dashboard.html` | The validated post-sign-in return. |
| `unplug-admin-dashboard.html` | The checkbox in the article editor. |

## Rolling back

Set every `requires_account` back to false and the gate is inert with no
deploy. To remove it entirely: drop the column, revert the three route files,
and remove the gate panel. The wording is CMS-editable via `gate.title`,
`gate.body` and `gate.note`, so it can be reworded without a deploy either.
