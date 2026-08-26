# Popups

The only feature on this site whose purpose is to get in a reader's way. Most
of what follows is about not showing them.

## What an admin controls

**Admin → Popups.** Create one, write the heading and message, choose what it is
for, pick how far down the page it appears, choose which pages, set a start and
end date, and switch it on.

Three kinds:

| Kind | What it does |
|---|---|
| Newsletter sign-up | An email field. Feeds the consent system — list, source, IP — not the legacy subscribers table. |
| Announcement | A message and a button. A new edition, a competition closing. |
| Nominate prompt | Points at `/nominate`, which is out of the main nav and needs ways in. |

## The rules it obeys, and why

**It is off when created.** One half-written on a Tuesday must not be
interrupting readers on Wednesday morning. Switching it on asks for
confirmation, because that is the moment readers start being interrupted.

**It takes its turn.** This site already has two things that claim the whole
screen — the POPIA consent bar and the welcome gate — and they have collided
before. There is a comment left over from fixing it: *"getting that wrong puts
BOTH dialogs on screen at once — which is exactly what it did."* A popup never
opens while either is up, never before the cookie bar has actually been
answered, and never while anything else has locked page scroll.

Note the distinction: it waits for consent to be **answered**, not accepted.
Somebody who declined analytics has not declined the magazine, and a newsletter
offer is not tracking.

**It can never fire on arrival.** The scroll threshold is clamped to a minimum
of 5% and defaults to 50%. A popup that appears the moment somebody arrives has
interrupted them before they have seen anything worth staying for, which is the
most reliable way to make a reader leave.

**Scroll depth, not exit intent.** There is no cursor to leave the viewport on a
phone, so an exit-intent popup reaches none of the mobile readers who are most
of this audience — while looking perfectly functional on the laptop it was
tested on.

**One popup per page view, one at a time.** Two in a session is the point where
a reader stops reading and starts closing things.

**Some pages are permanently excluded and cannot be switched on**: checkout,
privacy, terms, refunds. Interrupting somebody mid-payment costs money, and
somebody reading the privacy policy is very often there to find out how to get
their data removed — they should not be sold a newsletter on the way.

**A dismissal is an answer.** Remembered on that reader's device for as long as
the popup says; the default is thirty days, not the length of a tab.

## What is stored about a reader

Nothing, anywhere but their own browser.

Which popups somebody has seen or closed lives in their `localStorage` and is
never sent anywhere. The server counts how many people closed a thing; it does
not record who. That is why `GET /popups/active` is identical for everybody and
can be cached — which also matters on a free instance that sleeps, for an
endpoint every page view calls.

## Reading the numbers

The admin list shows, for every popup:

> Shown 2 × · 1 signed up (50%) · **1 closed it (50%)**

**The dismissal count is never shown without the conversion count and never the
other way round.** Impressions and conversions alone make every popup look like
a success — seen a thousand times, signed up twelve people, which reads as
twelve people gained. The number that decides whether it should exist is how
many were interrupted to get those twelve. A dismissal rate above 60% is shown
in red.

## Files

| | |
|---|---|
| `unplug-popups.js` | The reader-facing script. No dependencies, no build step. |
| `unplug-backend/src/routes/popups.js` | Public feed + event counter, admin CRUD, report. |
| `unplug-backend/db/migrations/143_popups.sql` | `popups`, `popup_events`. |
| `unplug-backend/test/popups.test.js` | 20 tests against a real PostgreSQL. |

If `unplug-popups.js` fails to load, or the endpoint is unreachable, or the
reader is offline, nothing appears and the magazine is unaffected. That is the
correct failure for the least important thing on the page.

## Rolling back

Drop `popups` and `popup_events`, remove the `app.use('/popups', …)` line and
the `<script src="unplug-popups.js">` tag. Nothing else references them.

## Not built, deliberately

- **Exit intent.** See above — it cannot fire on a phone.
- **A/B testing two versions of a popup.** With this audience size the result
  would not reach significance, and a test that reports a winner from forty
  impressions is worse than not testing.
- **Per-reader targeting** (seen this article, from this campaign). It would
  mean the server holding a profile of each reader to decide what to show them,
  which is a much larger privacy commitment than a magazine needs for a
  newsletter box.
