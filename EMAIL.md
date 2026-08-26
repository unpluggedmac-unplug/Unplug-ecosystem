# Email marketing

Campaigns, the block composer, drip sequences, and the parts that make all of
it legal to send.

## What was here before

`routes/bulkEmail.js` selected every member matching a segment and mailed them.
There was no unsubscribe link in the message, no check of any opt-out, no
suppression list, and no record of consent. `newsletter_subscribers` was an
address and a timestamp. **Nowhere in this codebase could somebody stop
receiving mail.**

That was three problems at once: POPIA §69 requires an opt-out for direct
marketing to a South African audience and GDPR Art. 21 requires one for any EU
reader; somebody who cannot unsubscribe presses the spam button instead, and
enough of those takes the sending domain down along with the password resets
and invoices; and somebody asked a magazine to stop writing to them and it
could not.

`bulkEmail.js` still exists and still works, but it now sends through the same
path as everything else, so it carries an unsubscribe link and checks
suppression per address at send time.

## The two halves

| | Path | Auth |
|---|---|---|
| Public | `/email/*` | **None, deliberately.** Somebody unsubscribing is holding a link from an email, not a password. |
| Admin | `/admin/email/*` | `requireRole('admin')` on every route. |

They are separate files (`routes/email.js`, `routes/emailCampaigns.js`) so
neither can be misread. Everything in the first is public on purpose;
everything in the second needs an admin; there is no line in either where that
changes.

## Suppression is absolute

An address in `email_suppressions` is never sent to again — not by a campaign,
not by a sequence, not by a test send, not by an admin who is sure it is fine.

It is checked **at the moment of sending**, in `sendOne()`, not when a
campaign's recipient list is built. A send to four hundred people takes
minutes; somebody who unsubscribes during minute two must not receive minute
three.

**Transactional mail does not go through any of this.** A password reset, an
invoice, a download link — `utils/email.js` keeps doing that job directly.
Somebody who unsubscribed from the newsletter still needs their receipt, and
routing receipts through a marketing suppression list would strand people out
of their own accounts.

Removing an address from the suppression list requires a written reason and
writes an audit entry. "They asked to come back" is a reason. "The numbers
looked low" is not.

## Why the renderer is hand-written

MJML was the obvious candidate. It was installed to measure rather than guess:

```
227 packages, 197 top-level directories, 47 MB in node_modules
```

This instance has 512 MB of RAM and runs the whole magazine in it. Six block
types are not worth a tenth of that plus a dependency tree of that size on the
security-patch treadmill — the same reasoning that gave this codebase a
hand-written SigV4 signer rather than the AWS SDK.

**What that costs, plainly:** MJML's real value is years of absorbed Outlook
bug reports. Outlook on Windows renders with Word — no flexbox, no grid, no
reliable padding on block elements, no `max-width`. `utils/emailRenderer.js`
works around the ones that matter (tables for layout, VML for buttons, explicit
widths, `mso-line-height-rule`), but it has not been through what MJML has.

If Outlook rendering turns out to be a real problem for this audience, swapping
the renderer is a contained change: blocks are stored as JSON and rendered at
send time, so a different renderer improves every future send rather than only
new drafts.

## Nothing is sent twice

The scheduler is the only part of this system that sends mail with nobody
watching. Every unit of work is **claimed by moving its status forward in the
same statement that finds it**:

```sql
UPDATE email_campaigns SET status = 'sending'
 WHERE id = (SELECT id FROM email_campaigns
              WHERE status = 'scheduled' AND scheduled_for <= now()
              FOR UPDATE SKIP LOCKED LIMIT 1)
```

If two ticks overlap — and they will, because a send takes longer than the
five-minute interval — the second finds nothing. The naive version (select the
due ones, send, then mark them sent) sends everything twice the first time a
send runs long.

**Which means a crash mid-send loses mail rather than duplicating it, and that
is the deliberate choice.** A campaign stuck in `sending` is put back into
drafts after an hour and is visible to a person. Four hundred duplicate emails
cannot be taken back.

Drip steps work the same way: the enrolment is moved to the next position
*before* the mail goes out, and the claim decides in the same statement whether
there is a next step at all — otherwise the end of every sequence would re-send
its final email every five minutes, for ever.

## Drip sequences

One enrolment per person per automation, enforced by a unique index rather than
by an application check a second code path can forget. Subscribe, unsubscribe,
subscribe again is an ordinary thing to do and must not produce two welcome
sequences.

Unsubscribing **cancels** enrolments rather than leaving them running to be
skipped step by step. The mail would be suppressed either way, but "the mail
was suppressed" and "the sequence stopped" are different states and only the
second is honest about what was asked for. Cancelled enrolments are kept, not
deleted, so re-subscribing does not restart a welcome somebody has already
half-had.

Automations are **off by default**. One created by mistake, or half-written and
left overnight, must not start mailing anybody.

Step positions are never renumbered. People part-way through a sequence record
the position they have reached; shifting positions underneath them would move
them backwards or skip them entirely. Deleting a step leaves a gap on purpose.

## Reporting, and what it is worth

Opens are counted **once per send**, not once per pixel fetch. Mail clients
refetch images constantly — on scroll, on reopen, on prefetch — and counting
each would turn one reader into forty.

Even so, the open rate is a floor with noise on top: image blocking hides real
opens, and Apple Mail Privacy Protection fetches every pixel whether or not the
message was read. **Clicks are measured directly and are the number worth
acting on.** The report endpoint says this in its own payload rather than
leaving somebody to work it out from a disappointing figure.

## The tick

`utils/emailScheduler.js` runs in-process every five minutes, the same shape as
the birthday mailer and the backup runner — and with the same caveat, since
Render's free tier sleeps when idle.

The consequence is different from those two and worth saying plainly: **a
missed tick delays a send, it never loses one and it never sends twice.** The
next tick picks up whatever is still due.

For sends that happen at the minute they were set for, point an external
scheduler at:

```bash
curl -X POST https://unplug-ecosystem.onrender.com/admin/email/tick -H "X-Cron-Secret: $UNPLUG_CLEANUP_SECRET"
```

## Bounces and complaints

Nothing in this codebase used to write a `bounced` or `complained` suppression.
Both values existed in the schema and the reporting counted them, and both were
always zero. A dead address was retried by every campaign, for ever — and
mailbox providers read repeated delivery attempts to addresses that do not
exist as the behaviour of a list nobody opted into. The reputation erodes
quietly, and the first visible symptom is legitimate mail landing in spam,
including the password resets.

`POST /email/webhooks/resend` closes that. Three things about it are worth
knowing:

**It is unauthenticated but not unverified.** Resend cannot log in; it can
sign. Every request is checked against a shared secret and unsigned requests
are refused outright — there is no "verify if a secret is configured" path.
An unsigned version of this endpoint would be a *remote denial-of-mail*:
anybody who found the URL could POST `bounced` for every subscriber in turn and
silently destroy the list, and it would look like a deliverability problem for
weeks rather than an attack.

**A soft bounce does not suppress anybody.** A full mailbox, a server having a
bad afternoon, a greylisting delay — all report as bounces, and all are
temporary. Only a permanent failure suppresses. When the payload carries no
bounce type at all, it is treated as soft: being wrong in that direction costs
one wasted send, and being wrong in the other loses a real reader for good.

**A complaint always suppresses, with no second chance.** Somebody pressed the
spam button. Mailing them again is both the rudest thing this system could do
and the fastest way to lose the domain.

Neither a bounce nor a complaint is cleared by re-subscribing. Re-subscribing
clears a previous *unsubscribe*, because the person has just asked; a bounce is
a fact about whether mail can be delivered at all.

### Setting it up (one manual step)

In the Resend dashboard → Webhooks → Add endpoint:

- URL: `https://unplug-ecosystem.onrender.com/email/webhooks/resend`
- Events: `email.delivered`, `email.bounced`, `email.complained`

Resend shows a signing secret beginning `whsec_`. Put it in Render as
`RESEND_WEBHOOK_SECRET`. Until that is set the endpoint returns 503 and logs
one warning — deliberately once, not on every request, because an error on
every webhook is a log nobody reads.

`email.opened` and `email.clicked` are deliberately **not** subscribed to. This
system measures both itself, through its own pixel and redirect, and recording
the provider's version as well would double every number in the reporting.

## Environment variables

| Name | Default | What it does |
|---|---|---|
| `SITE_URL` | `https://www.unplugnews.com` | Where the preference-centre links in email footers point. |
| `PUBLIC_API_URL` | `https://unplug-ecosystem.onrender.com` | Where unsubscribe, open-tracking and click-tracking links point. **If this is wrong, every unsubscribe link in every email is broken** — which is the failure that becomes spam complaints. |
| `UNPLUG_CLEANUP_SECRET` | *(unset)* | Shared with the cleanup and backup endpoints; lets an external scheduler call `POST /admin/email/tick`. |
| `RESEND_WEBHOOK_SECRET` | *(unset)* | The `whsec_…` signing secret from the Resend dashboard. **Unset means bounce and complaint webhooks are refused**, so dead addresses keep being retried. |

Only `RESEND_WEBHOOK_SECRET` needs adding, and only to record bounces. The mail transport itself is whatever
`utils/email.js` is already configured with (`RESEND_API_KEY` today).

## Testing locally

```bash
cd unplug-backend && node --test --test-concurrency=1 test/emailComposer.test.js
```

Runs against a real embedded PostgreSQL and covers the claim-and-send SQL
directly, because "two ticks cannot claim the same campaign" is not something
that can be asserted by reading the code.

## Rolling back

Drop the tables from migrations `141` and `142`, remove the
`app.use('/admin/email', …)` line and the `emailScheduler.start()` call. The
site keeps working; `bulkEmail.js` reverts to the behaviour described at the
top of this file, which is why the send path was changed to **require** the
suppression check rather than to use it when present.

## Still open

- **The webhook needs pointing at us once.** The endpoint is built and tested,
  but until the Resend dashboard is configured (see below) nothing arrives and
  bounces go unrecorded.
- **The `signup` and `purchase` automation triggers exist in the schema but
  nothing emits them.** Only `subscribe` and `manual` actually enrol anybody.
- **No A/B testing on subject lines.** Deliberately left out: with this list
  size the result would not reach significance, and a split test that reports a
  winner from forty recipients is worse than not testing.
