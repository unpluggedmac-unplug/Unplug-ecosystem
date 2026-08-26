# Security

What protects this site, where each layer sits, and what is deliberately not
built. Deployment steps and environment variables are in
[OPERATIONS.md](OPERATIONS.md).

---

## The front layer: Cloudflare

**The brief for this work said to put Cloudflare's free plan in front of
unplugnews.com. That is already done, and has been since the site launched** —
the site is hosted on Cloudflare Pages, so it is served from Cloudflare's
network by definition. Confirmed on the live site:

```
Server: cloudflare
CF-RAY: a2f60874df43816a-JNB
```

The frontend therefore already has the CDN, the DDoS protection, the free TLS
and the free-tier WAF rules.

### The gap that is worth closing

**The API does not sit behind your Cloudflare.**
`unplug-ecosystem.onrender.com` returns `Server: cloudflare` too, but that is
*Render's* Cloudflare account, not yours. You cannot write firewall rules for
it, see its traffic, or rate-limit it from your dashboard.

Everything that matters — sign-in, payments, admin actions — happens on that
host.

To put it behind your own zone:

1. In Cloudflare DNS for `unplugnews.com`, add a `CNAME` record:
   `api` → `unplug-ecosystem.onrender.com`, **proxy status: Proxied** (the
   orange cloud). The orange cloud is the entire point; grey means DNS only and
   changes nothing.
2. In Render → your service → Settings → Custom Domains, add
   `api.unplugnews.com` and wait for it to verify.
3. Set `CORS_ORIGINS` to include `https://www.unplugnews.com`.
4. Change the frontend's API base to `https://api.unplugnews.com`. It is one
   constant, `LIVE_API_BASE` in `unplug-shared.js`.
5. Leave the old `.onrender.com` address working. Anything cached — a service
   worker, a bookmarked admin page — will keep using it for a while.

**Do steps 1–3 before step 4**, and check `https://api.unplugnews.com/health`
returns `{"status":"ok"}` before changing anything in the frontend.

Once it is proxied you can, from the Cloudflare dashboard and at no cost: rate
limit `/auth/login` at the edge so brute-force attempts never reach the
instance; block or challenge by country; and see the API's traffic alongside
the site's.

---

## The application layer

Everything below runs in this codebase and complements the above. Cloudflare
handles volume; these handle intent.

| Layer | Where | What it does |
|---|---|---|
| Access rules | `middleware/accessControl.js` | IP, CIDR and account allow/block lists, held in the database so a block does not need a deploy |
| Request filter | `middleware/wafLite.js` | Refuses injection and traversal shapes in URLs, bounds request size |
| Rate limits | `middleware/rateLimit.js` | Per-IP caps on login, registration, email actions and public submissions |
| Sign-in backoff | `utils/loginAttempts.js` | Per-account exponential delay, which the per-IP limiter cannot provide |
| Two-factor | `utils/twoFactor.js` | TOTP plus hashed recovery codes, for admins |
| Bot defence | `utils/altcha.js` | Self-hosted proof-of-work; no third party, no tracking |
| Upload checks | `utils/fileSignature.js` | Magic-byte verification — the declared type comes from the browser |
| Audit trail | `routes/activityLog.js` | Who, what, when, from which address; searchable |
| Response headers | `_headers`, `middleware/securityHeaders.js` | CSP, HSTS, nosniff, frame-ancestors, referrer and permissions policy |

### Allow beats block, always

The access list checks allow rules first, and a block that would catch the
connection you are using is refused outright with an explanation.

This is not caution for its own sake. The realistic accident is not an attacker
slipping past a rule — Cloudflare catches most of that. It is an admin blocking
a range that turns out to contain their own office, or a large slice of a South
African mobile network, and losing the screen they would use to undo it.

### The request filter does not read bodies

This is a magazine that publishes articles about technology. An article about
SQL injection contains `OR 1=1`. A tutorial contains `<script>`. A comment
quoting a path contains `../`.

A filter that scanned bodies would block writers from publishing and readers
from commenting — intermittently, which is worse, because nobody would work out
why an article saved on Tuesday and not on Wednesday. It would be switched off
within a week, leaving the site less protected than if it had never been added.

So the patterns apply only to URLs, query strings and a couple of headers,
where those strings are never legitimate. Bodies are bounded in size and
defended the way content must be: parameterised queries going in, escaping
coming out.

---

## Content Security Policy: what is enforced and what is not

Everything except inline script is **enforced**. `script-src` still permits
`'unsafe-inline'`, and it is worth being plain about why.

These pages carry **213 inline event handlers** — `onclick="save()"` and
relatives — written into the markup. CSP cannot allow those except with
`'unsafe-inline'`. Nonces do not help: a nonce applies to a `<script>` element,
not to an attribute, and adding one would make things *worse*, because a policy
containing a nonce causes browsers to ignore `'unsafe-inline'` altogether —
every handler would stop working at the first click.

What **is** enforced still carries most of the value:

- **`connect-src`** — the important one. A stored XSS was found in the admin
  activity log during this work and fixed. Script on the page could read an
  admin's token; `connect-src` is what stops it being *sent* anywhere.
  Exfiltration is blocked even when script runs.
- **`object-src 'none'`** — no plugin content, a classic injection route.
- **`base-uri 'self'`** — an injected `<base>` tag can otherwise repoint every
  relative URL on the page, including script sources.
- **`form-action 'self'`** — an injected form cannot post credentials elsewhere.
- **`frame-ancestors 'none'`** — clickjacking.

### Getting to a strict `script-src`

1. Enable the Pages build (OPERATIONS.md step 2). It already moves the large
   inline `<script>` blocks into hashed files.
2. Convert the 213 `onclick` attributes to delegated listeners. The pattern is
   already used for story cards in `unplug-magazine.html`.
3. Remove `'unsafe-inline'` from `script-src`.

A **Report-Only** header already carries the strict policy and posts violations
to `/security/csp-report`. Nothing is blocked by it. Read the collected
evidence at `GET /security/csp-reports` (admin) — it says which handlers real
readers actually trigger, so step 2 can be done in order of what matters rather
than alphabetically.

---

## The two unauthenticated endpoints that change state

Most of this API either needs a session or only reads. Two routes accept a
request from a stranger and change something, and both are deliberate.

### `POST /email/unsubscribe/:token`

Somebody unsubscribing is holding a link from an email, not a password.
Requiring a login to unsubscribe is the same as not letting them unsubscribe,
and they press the spam button instead. The token is random per message and
stored, so it identifies one send without being guessable from an address, and
the only thing it can do is stop mail.

### `POST /email/webhooks/resend`

Unauthenticated but **not unverified**, and the distinction is the whole
control. Resend cannot log in; it can sign. Every request is verified against
`RESEND_WEBHOOK_SECRET` — HMAC-SHA256 over the raw bytes, compared in constant
time, with a five-minute timestamp window to stop replay. There is no
"verify only if a secret is set" path: with no secret the endpoint refuses
everything.

That strictness is not ceremony. **This endpoint suppresses email addresses.**
An unsigned version would be a remote denial-of-mail: anybody who found the URL
could POST `bounced` for every subscriber in turn and silently destroy the
mailing list — and it would look like a deliverability problem for weeks rather
than an attack.

The signature is over the **raw request bytes**, so `src/app.js` exempts this
one path from the global `express.json()` and the router parses its own body.
Exempting the parser rather than mounting the route above it keeps the webhook
behind the access-control and WAF middleware: it skips one parser, not every
guard on the server.

Verified by test, not by inspection: unsigned, forged and replayed requests all
return 401 and change nothing (`test/emailWebhooks.test.js`).

## Deliberately not built

**Role-based permissions.** Every protected route uses `requireRole('admin')`.
There is no case yet where two admins should be able to do different things. A
permissions matrix would add a table, a screen and a lookup on every request to
express a distinction nobody has made. Worth building the day two admins should
see different things — not before.

**ClamAV virus scanning.** It wants around a gigabyte of RAM for its signature
database. The instance has 512 MB. Installing it would trade the site being up
for the appearance of scanning. Uploads are defended by magic-byte checks, an
extension allow-list, size caps and random filenames.

**Country blocking.** The rules are accepted and stored, but nothing matches
them until a GeoIP lookup exists, which needs a MaxMind GeoLite2 licence key.
An inert rule is honest; one that guesses would block the wrong people.

**A separate mobile cache.** See OPERATIONS.md — a phone is slow because it
receives desktop-sized images, and a second cache would halve the hit rate
while delivering the same oversized picture.

---

## Spam filtering

Every public form is scored on submission: the honeypot, how long the form was
open, whether the page's JavaScript ran, link counts, a short phrase list,
disposable-email domains, and a classifier that learns from what moderators
decide.

**It does not block anything, and that is the design.** Every submission on
this site already goes to a moderation queue — spam was never reaching readers.
What it was doing was burying a nomination from somebody's grandmother behind
forty casino adverts. So the scorer sorts and explains; a moderator still sees
everything.

Auto-rejection exists and is **off**. Turning it on is a deliberate choice in
the admin screen, and even then the row is kept and reviewable. On a site this
size a person can read everything that arrives, and a genuine entry vanishing
unseen costs more than a moment's reading.

### What it must never do

The tests are mostly about traffic that must NOT be flagged, because that is
the failure nobody finds out about:

- a nomination written in Afrikaans or isiZulu
- somebody typing entirely in capitals, which is common among older readers
- a two-word comment — "Beautiful." is a real comment
- an advertiser saying they are a loan company and asking for a rate card,
  which is a customer, not spam
- a nomination containing two links, to a Facebook page and a shop

`loan`, `insurance`, `crypto` and `casino` are deliberately **absent** from the
phrase list. This site sells advertising.

### The classifier

It learns this site's spam — and, more usefully, this site's ordinary language —
from moderator decisions. It starts silent, ignores any word seen fewer than
five times, and can never move a score by more than 30 points, so it can nudge
a submission towards review but never condemn one alone. What it has learned is
visible at `GET /spam/vocabulary`, which is how somebody notices it has decided
"Soweto" is a spam word before that costs anything.

### The number to watch

The admin screen puts **wrongly flagged** at the top: submissions the filter
called spam that a moderator then approved. Those are the readers it is
failing. A spam filter nobody checks for false positives is one quietly losing
people.

Sensitivity lives in the `settings` table (`spam_suspect_threshold`,
`spam_reject_threshold`, `spam_autoreject_enabled`) and is adjustable from the
dashboard without a deploy.

---

## The cross-site scripting audit

Two stored XSS holes were found and fixed, both proven to execute before the
fix and proven not to afterwards.

**The enquiry inbox — the serious one.** `POST /inquiries` is the public
contact form: no account, no sign-in, anyone on the internet. Its `name`,
`email`, `subject` and `message` were interpolated straight into `innerHTML` on
the admin's screen. A stranger putting `<img src=x onerror=...>` in the name
field got script running with an admin's session. Demonstrated with a real
payload: it executed. After the fix, the same payload is displayed as text.

**The activity log.** Same shape, via `details`, which carries member-supplied
values such as profile display names. Fixed by building every cell with
`createElement` and `textContent`.

Also escaped while in there: pending EFT payment references, consultant names,
and the leaderboard status emoji.

### What was checked and found already safe

The **public profile page** — the one place a member's text is shown to every
reader, and therefore the highest-value target — was never exposed.
`display_name` goes through `escapeHtml`, and `bio` through
`DOMPurify.sanitize` with a tag and attribute allow-list, because a bio is
meant to be rich text.

### What is left, and why it is not urgent

The scan reports 174 remaining interpolations across five files. They break
down as:

- **Mostly false positives.** The scanner cannot resolve a variable, so
  `${rows}`, `${bars}` and `${summary}` are flagged even though they hold HTML
  that was built and escaped elsewhere. So are numbers, enum values and
  ternaries between fixed strings.
- **Self-XSS in the member dashboard.** It renders the member's OWN profile
  from `/profiles/me` without escaping. You can only attack your own page with
  it — there is no other victim and no privilege gained. Worth tidying; not a
  vulnerability in the usual sense.
- **`bio` in the member dashboard must NOT simply be escaped.** It is rich text
  by design. Escaping it would show a member raw HTML tags where their
  formatting used to be. It needs the same DOMPurify treatment the magazine
  uses, which is a change worth making deliberately rather than in a sweep.

The rule for anything added from here: **build cells with `textContent`, or
escape at the interpolation.** `innerHTML` with a `${}` in it is the pattern
that produced both of the holes above.

`connect-src` in the CSP is the backstop. Even where script does run, it cannot
send what it reads to anywhere but this site's own origins.
