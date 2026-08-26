# Backups

What is backed up, where it goes, and how to get it back.

**Nothing is being backed up until you do the two setup steps below.** The code
is deployed and the nightly job is running, but with no passphrase and no
bucket it logs one warning and stops. That is deliberate — see *Why it refuses
to run* below.

---

## What you need to do

### 1. Set a passphrase (five minutes, and nothing works without it)

A backup of this site contains every member's email address, every payment
reference, every private message sent through the contact form, and every
password hash. It gets uploaded to a bucket belonging to somebody else. So it
is encrypted, and there is no default passphrase — a default would mean every
deployment shares one key, which is the same as not encrypting while appearing
to.

Generate one and keep it somewhere that is **not** this repository and **not**
only in Render:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Add it in Render → your service → Environment as `UNPLUG_BACKUP_PASSPHRASE`.

**If you lose this, the backups are unreadable.** There is no recovery, by
design. Put a copy in a password manager and one somewhere physical.

### 2. Create the buckets

You asked for both R2 and Backblaze, which is the right instinct: a problem
with one account is then not a problem with the backups. Either alone works.

**Cloudflare R2** — same account as your Pages site:

1. Cloudflare dashboard → R2 → *Create bucket*, name it `unplug-backups`.
2. R2 → *Manage API tokens* → *Create API token*, permission **Object Read &
   Write**, scoped to that bucket.
3. In Render, set:

| Variable | Value |
|---|---|
| `R2_ACCOUNT_ID` | from the R2 overview page |
| `R2_BUCKET` | `unplug-backups` |
| `R2_ACCESS_KEY_ID` | from the token |
| `R2_SECRET_ACCESS_KEY` | from the token |

**Backblaze B2** — a separate company, which is the point:

1. Backblaze → *Buckets* → *Create a Bucket*, private, name it
   `unplug-backups`.
2. *Application Keys* → *Add a New Application Key*, restricted to that bucket,
   Read and Write.
3. Note the **endpoint** shown on the bucket page — it includes the region,
   e.g. `s3.eu-central-003.backblazeb2.com`.
4. In Render, set:

| Variable | Value |
|---|---|
| `B2_BUCKET` | `unplug-backups` |
| `B2_ENDPOINT` | `https://s3.eu-central-003.backblazeb2.com` |
| `B2_ACCESS_KEY_ID` | the keyID |
| `B2_SECRET_ACCESS_KEY` | the applicationKey |
| `B2_REGION` | `eu-central-003` |

### 3. Check it worked

As an admin, `GET /backups` reports what is configured and what is stored, or
press the button on the dashboard. It says plainly when it is writing to local
disk only.

Then take one immediately rather than waiting for the nightly run:

```bash
npm run backup
```

---

## Why it refuses to run

Without a passphrase, no backup is taken at all — rather than an unencrypted
one being written. A readable dump of this database sitting in a bucket is a
worse outcome than no backup, because the second one is at least obvious.

Without a bucket, backups go to the local disk and **say so every time**.
Render's filesystem is wiped on every deploy, so a backup written there
survives until the next deploy — which is exactly when it is most likely to be
needed. A backup nobody realises is temporary is worse than none: it produces
the belief in one.

---

## What is in a backup, and what is not

**Included:** every table, in dependency order, plus the position of every
sequence.

**Not included, on purpose:**

- **The schema.** It lives in `db/migrations`, which are idempotent and run on
  every deploy. Restoring means running them and then loading the data.
- **`analytics_events`, `page_views`, `content_views`.** One row per page view.
  They are rebuilt by traffic, the retention job already prunes them, and
  including them would multiply the size of every backup for nothing.
- **Images.** They live in Supabase Storage, already off this server. Streaming
  gigabytes of them through a 512 MB instance to build one archive is how an
  export becomes an outage. Copy the bucket directly with `rclone` if you need
  a second copy.

Everything that cannot be rebuilt — members, payments, votes, articles,
profiles, enquiries — is always included, and a test asserts it.

---

## Restoring

```bash
npm run backup:list                          # what exists
node scripts/restore-backup.js --dry-run <file>    # what is in one
node scripts/restore-backup.js --to-staging <file> # practise on staging
```

**Restoring is a command-line script, not a button, and that is deliberate.** A
one-click restore in the admin dashboard destroys the live site in one click,
and during this same work two stored cross-site scripting holes were found in
that dashboard — one reachable by anyone through the public contact form. A
hijacked session could have wiped the site. Restoring needs shell access, which
somebody borrowing a browser session does not have.

Against production it additionally requires an explicit flag **and** typing the
database host to confirm. It takes a snapshot of what is about to be replaced
first, always — restoring the wrong backup is a far more likely accident than
the disaster being restored from.

### Practise it before you need it

A backup that has never been restored is a file somebody hopes is a backup.
Restore one into staging now, while nothing is wrong:

```bash
npm run clone:staging -- --scrub
```

`--scrub` replaces emails with `@staging.invalid` addresses, which by RFC 2606
can never be delivered. Use it unless you specifically need real data —
staging environments get shared, screenshotted and left running.

---

## Retention

Fourteen backups per destination by default (`UNPLUG_BACKUP_KEEP`). Old ones
are deleted **only after** a new one has been verified and stored, so a failure
part-way never leaves fewer than there were before.

Every backup is decrypted again in memory and checked before it counts. An
encrypted file that cannot be opened looks identical to a good one until the
day somebody needs it, and that is not the day to find out.
