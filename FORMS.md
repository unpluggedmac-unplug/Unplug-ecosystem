# Forms

Forms you build in the admin, without a deploy: a bursary application, a
survey, an event RSVP, a call for submissions that runs six weeks and stops.

**What this is not.** It does not replace the contact form, the newsletter box
or the nomination form. Those are load-bearing, they work, and they stay
exactly where they are.

## Two placements, one definition

| | |
|---|---|
| Its own address | `unplugnews.com/form/bursary-2026` — a link you send, put in a bio, or print |
| Embedded | `<div data-unplug-form="bursary-2026"></div>` in any Page Content block |

Both render from the same definition, so there is one form to keep correct
rather than two that drift.

## What it reuses

Nothing here reimplements what already existed. The honeypot and form token
come from `unplug-spam-forms.js`, submissions go through the same spam scorer,
rate limiter and admin notifications as every other public write, and anybody
who leaves an email address is captured as a CRM contact with the submission on
their timeline — the same way the contact form already behaves. One person
stays one contact instead of becoming a stranger every time they fill something
in.

## The answers are validated against the form

A submission is a public POST of arbitrary JSON from a stranger, so:

- **Unknown keys are dropped.** Only the questions the form actually asks are
  stored. Otherwise this endpoint is a way to write arbitrary JSON into the
  database.
- **Required questions are enforced**, server-side. The page's `required`
  attribute is a courtesy, not a control.
- **A dropdown may only answer with something it offers.**
- **An email field is checked as one.**
- **Lengths are cut to what the column holds.**

## Editing a live form does not destroy what you have collected

Answers are keyed on a **stable key** derived once from the label and then
never changed. Renaming "Your school" to "School attended" keeps every answer
already given. Deleting a question keeps them too — what somebody told you is
not yours to delete because you changed your mind about the wording.

A form with responses **refuses to be deleted** until you confirm you mean to
take the answers with it.

## Opening and closing

**Off when created**, the same rule as popups, automations and social posts —
and it cannot be switched on until it has at least one question.

A closing date makes it stop on its own, and **the date is checked again at
submit**, not only when the page loaded. A deadline that applies only while
somebody has the tab open is not a deadline.

A closed form still answers, with your closing message. A 404 would tell
somebody following a link from an email that the page is broken, when what
actually happened is that they are a week late.

## Files need a member account

Same decision as the share card photo, for the same reason: an unauthenticated
upload that becomes a publicly readable file is free image hosting for whoever
finds the endpoint, and there is no account to suspend when it is abused.

A form that asks for a file says so **before** anybody fills it in, rather than
at the submit button after nine fields.

Uploads go through `POST /uploads`, which already requires a login and checks
the actual bytes rather than the filename. The stored URL is validated against
our own storage on submit — accepting an arbitrary address would let anyone
attach any file on the internet to a submission.

## The export

`Download CSV` on the responses screen. Values that begin `=`, `+`, `-` or `@`
are prefixed with an apostrophe: a spreadsheet treats those as **formulas**,
and the value came from a public form. That is a real way to attack whoever
opens the export.

## Paid forms — the schema is there, the flow is not

`forms.amount`, `form_submissions.payment_id` and the `form_payment` value on
`payments.linked_type` all exist. **Nothing charges anybody yet**, and the
admin screen deliberately does not offer an amount field.

That is a deliberate stop, not an oversight. Wiring a form to take money means
touching `resolveAmount` and `applyPaymentEffect` in the live payment path, and
that deserves its own change and its own review rather than riding along with a
form builder.

The groundwork is here now because `payments_linked_type_check` is **dropped
and rebuilt** whenever a type is added — every existing value has to be
restated, and each time that happens is a chance to lose one. Doing it once,
carefully, is safer than doing it twice.

**When paid forms are built, they use the payment system that already exists** —
PayFast, Ozow and EFT, in rand, through the portal with the admin queue,
refunds and account credits. Not Stripe: the brief suggested abstracting it,
but this is a South African business and Stripe has historically not supported
South African merchants. A second money path to reconcile against the one that
works would be a mistake.

## Files

| | |
|---|---|
| `unplug-form-render.js` | The public renderer. **Named `UnplugFormRender`, not `UnplugForms`** — that name already belongs to the spam-protection helper, and taking it would have silently disabled the honeypot on every form on the site. |
| `unplug-backend/src/routes/forms.js` | Definition, submission, admin CRUD, CSV. |
| `unplug-backend/db/migrations/149_forms.sql` | `forms`, `form_fields`, `form_submissions`. |
| `unplug-backend/test/forms.test.js` | 20 tests against a real PostgreSQL. |

## Rolling back

Drop the three tables and remove the `/forms` mount and the script tag. Restore
`payments_linked_type_check` to its definition in `060_self_serve_banners.sql`.
Nothing else references any of it.
