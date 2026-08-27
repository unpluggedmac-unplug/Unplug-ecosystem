# Checkout recovery, and the social feed

## It is switched off

`UNPLUG_CHECKOUT_RECOVERY` is unset, so no reminder is ever sent. That is the
default and it is deliberate: everything this feature sends goes to somebody
who was about to give the magazine money, and a half-configured version of it
running unattended does not produce a bug report — it produces a customer who
got a strange email about their order.

To watch what it would do without handing it to a timer:

```bash
curl -X POST https://unplug-ecosystem.onrender.com/orders/recovery-run -H "X-Cron-Secret: $UNPLUG_CLEANUP_SECRET"
```

That really sends — there is no dry-run mode on purpose, because a dry run is a
second code path and the one that never runs is the one that is wrong. Set
`UNPLUG_CHECKOUT_RECOVERY=on` when you are happy with it.

## Two things get recovered, and they are not the same

### A saved cart

Somebody chose services and never checked out.

**This is new data about members.** The cart lives in the browser's
`localStorage`; before this it never reached the server at all. The site now
keeps what a signed-in member intended to buy and did not. The privacy policy
says so, under "Your cart".

The browser stays the source of truth. `localStorage` is written first and
always; the server copy is a mirror, sent afterwards, allowed to fail silently.
A cart you could not add to because the API was asleep would be worse than one
that only lived in the browser.

On sign-in the two are **merged**, not overwritten. Somebody who added one thing
on their phone and another on a laptop finds both — picking a winner silently
throws away a choice they made.

### A pending order

Somebody did check out. And `pending` means two opposite things:

| Method | What pending means | What we send |
|---|---|---|
| `payfast`, `ozow` | They bounced off the payment gateway. Genuinely abandoned. | "Your order is still waiting — nothing has been charged." |
| `eft` | **The correct, expected state.** They have a reference and are going to their bank, possibly on payday. | "Here is your payment reference again." |

Telling an EFT customer they failed to finish is wrong and slightly insulting.
The most useful thing you can send them is the reference, because the usual way
an EFT order dies is the reference being lost.

## Restraint

- **Two reminders, then it stops.** 24 hours, then 72. A third is the one that
  gets the sender marked as spam, and that costs the password resets too.
- **Nothing under a day old is chased.** An hour catches somebody who stepped
  away for lunch and reads as surveillance.
- **Nothing over 30 days old is chased.** A cart from six weeks ago is not a
  live intention; an email about it is a surprise, not a nudge.
- **Nobody is chased twice about one intention.** Somebody with a pending order
  is not also emailed about the cart that became it.
- **Editing a cart resets the count** — a cart just changed is a live intention
  again, not the one they already ignored.
- **Every reminder carries an unsubscribe link**, because they go out through
  the marketing sender. Following it stops reminders along with everything else.
- **`POST /orders/:id/stop-reminders` stops the chasing on ONE order** without
  unsubscribing from anything else. It needs the member to be signed in, and
  **there is no button for it yet** — nothing in the emails or the dashboard
  links to it, so today it is reachable only for support ("stop chasing me
  about that one order") rather than by the customer themselves. A control in
  the member dashboard beside a pending order is the missing piece; until it
  exists, the honest description is that a customer's self-service option is
  the unsubscribe link.

## Everything goes through the marketing sender

So the suppression list is checked and every message carries an unsubscribe
link.

That is a deliberately conservative reading. A reasonable person could argue an
EFT reference is transactional — the customer is mid-purchase and asked for it.
But the purpose of all of these is to produce a sale, and POPIA §69 is about
purpose rather than about how the sender feels about it. Somebody who opted out
of marketing and still wants their reference can see it in their dashboard,
where it has always been.

## Nothing is sent twice

Each due order or cart is **claimed** by moving its reminder count forward in
the same statement that finds it (`FOR UPDATE SKIP LOCKED`) — the same rule the
campaign scheduler follows. Two overlapping runs cannot both send, and a crash
loses a reminder rather than sending two.

## The social feed

Admin-entered posts, shown on the homepage. **No Meta API is called anywhere.**

Instagram's Basic Display API — which every widget of this kind was built on —
was switched off on **4 December 2024**. Its replacement, the Instagram Graph
API, needs a Business or Creator account linked to a Facebook Page, a Meta app,
Meta's app review, and a token that expires every sixty days.

The token is what decided it. When it lapses the feed empties itself one
morning, nothing errors, nothing is logged, and the homepage quietly looks like
an abandoned site. A feed you type into cannot fail that way.

**Admin → Social Feed.** Paste the link, the image URL, the caption and the
account. Posts are **off until switched on**, and the strip is hidden on the
site until at least one is showing — an empty "Follow us" band with nothing
under it reads as broken rather than unused.

If an automatic feed is wanted later, `social_posts.source` exists for exactly
that: a fetcher would write the same rows on a schedule and neither this route
nor the frontend would change.

## Environment variables

| Name | Default | What it does |
|---|---|---|
| `UNPLUG_CHECKOUT_RECOVERY` | *(unset)* | `on` starts the hourly reminder runner. **Unset means no reminder is ever sent.** |
| `UNPLUG_CLEANUP_SECRET` | *(unset)* | Shared with the other scheduled endpoints; lets a cron service call `POST /orders/recovery-run`. |

## Rolling back

Drop `saved_carts` and `social_posts`, drop the three columns added to `orders`
(`reminders_sent`, `last_reminded_at`, `recovery_opted_out`), and remove the
`/social` mount. The cart keeps working from `localStorage` exactly as it did
before, because that was never taken away.

## Not built

- **A dry-run mode.** See above.
- **Discount codes in recovery emails.** The standard trick, and it teaches
  people to abandon a cart to get money off.
- **Recovering anonymous carts.** Checkout requires an account, so there is no
  address to send anything to and nothing to tie a cart to.
