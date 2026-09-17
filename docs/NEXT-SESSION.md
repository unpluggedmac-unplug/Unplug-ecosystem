# Next session — kickoff

Paste the block below to start the next Unplug Ecosystem session (after the Sept 23 usage reset).
Prepared 2026-09-17.

---

New session — Unplug Ecosystem build. First, read the latest entry (dated 2026-09-17) in
`docs/progress-log.md` in my connected GitHub folder (`~/OneDrive/Documents/GitHub/Unplug-ecosystem`)
— it's the handover from our last session with the full state, the delivery pipeline, and what's queued.

All the frontend-safe work is done (Batches A, B, C, E, F). Now that my usage has reset, I want to start
the held backend work: Batch D (money & schema) plus My Analytics real data, Growth "visible status",
custom interests, and the My Orders approval-status split.

Work the same way as before — review and question before building, one task at a time. These are
backend + database changes, so this is higher-risk than last session: show me a short plan and get my OK
before writing anything, especially anything touching money or the schema. Deliver through GitHub Desktop
like last time (you edit and commit into my folder, I commit + push; backend also needs my manual Render
deploy). Note the backend test suite can't run in the cloud, so rely on the repo's CI. At the end, append
an updated handover to `docs/progress-log.md`.

Let's start with [pick one: Batch D / My Analytics / whichever you recommend].

---

## Before you open it
- Start the session from the **Claude desktop app on this same computer**, linked like last time, so it can
  reach this GitHub folder (otherwise it can't read the handover — you'd have to paste it).
- Swap the last line for whichever item you want first; leave it as "whichever you recommend" if unsure.

## What's held for this backend session
- **Batch D** — money & schema (high-risk; full test + your sign-off before anything ships).
- **My Analytics** — real data (needs backend).
- **Growth "visible status"** (needs backend).
- **Custom interests** + public/private per-field toggle on the My Unplug profile (needs backend/schema).
- **My Orders** waiting-vs-approved split — `order.status` is payment vocabulary (confirmed/failed/awaiting),
  not approval status, so this needs a backend clarification before building.
