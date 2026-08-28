# Progress log

One short entry per task, appended at its stop condition. Read this before starting
anything — it is the cheapest way to pick up state without being re-briefed.

---

## 2026-08-28 — Task 01, setup complete

**Spec extraction.** Clean. `docs/spec-extracted.md` holds §1–§5 and §11–§27 plus
MODULE 1–10 and all 75 sub-sections. Nothing was lost: the document's numbering genuinely
skips 6–10, because the MODULE headings occupy that space. That means **22 numbered
sections, not 27** — the handover doc's "27 sections" was the highest section number, not
a count. §11's inner 1–16 list is preserved as written rather than renumbered, so
references back to the original still hold.

**Baseline tests.** Did **not** pass on first run. Fixed — see below. Now
**1,533 passing, 0 failing** (1,532 before, plus one regression test added with the fix).

**Baseline fix — the `analyticsEngine` flake was a real product bug.** It had been written
off as an unexplained flake. It is not: `windowFrom` in `src/routes/analyticsReports.js`
defaulted the window's `to` to `new Date()`, which carries **milliseconds**, while Postgres
records `occurred_at` in **microseconds**. An event written at `28.171889` sits 889µs after
a `to` of `28.171`, so **a report requested in the same millisecond as a payment left that
payment out of its own window**.

Reproduced at roughly two runs in five, on whichever test happened to lose the race — which
is why it looked like flakiness rather than a bug. Proven by printing the payment's
microsecond timestamp alongside the window. Fixed by giving a defaulted `to` one second of
lead; an explicitly supplied `?to=` is left exactly as asked for. 12/12 clean runs after.

In production, reporting windows are days wide, so this only ever dropped an event recorded
in the same millisecond as the request — invisible in practice, but wrong.

**SECURITY.md** — read. Three things bear on the work ahead:

1. **`script-src` still allows `'unsafe-inline'`**, because the dashboards carry 213 inline
   `onclick` handlers. Every new admin control should use a delegated listener, not an
   inline handler, or the strict-CSP work gets further away with each task.
2. **The XSS rule**: build cells with `textContent`, or escape at the interpolation.
   `innerHTML` with a `${}` in it is the exact pattern that produced both stored-XSS holes
   found and fixed here. 174 interpolations remain flagged, mostly false positives.
3. **`bio` must not simply be escaped** — it is rich text by design and needs DOMPurify, the
   way the magazine already does it. Escaping it would show members raw tags.

**Open, needs an answer before the tasks that depend on them:**
- The repo has no stable local checkout — see the note in the task-01 report.
- `00-agent-context.md` and `CLAUDE.md` are two copies of the same briefing and have already
  drifted. `CLAUDE.md` is being treated as authoritative.

**Not started:** any implementation work. Stopped at the task-01 stop condition.
